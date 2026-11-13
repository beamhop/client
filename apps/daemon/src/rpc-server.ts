import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve, sep } from 'node:path';
import {
  BeamhopError,
  isBeamhopError,
  isMethod,
  type Logger,
  type MethodName,
  methods,
  type ParsedParams,
  type Result,
  RpcRequest,
  type RpcResponse,
  type ServerEvent,
} from '@beamhop/core';
import { WebSocket, WebSocketServer } from 'ws';

export interface CallContext {
  /** Who is calling: 'local' for token-authenticated local clients, or a device/owner principal for remote calls. */
  caller: string;
  transport: 'http' | 'ws' | 'nostr' | 'direct';
}

export type Handler<M extends MethodName> = (params: ParsedParams<M>, ctx: CallContext) => Promise<Result<M>>;
export type Handlers = { [M in MethodName]?: Handler<M> };

const ERROR_CODES: Record<string, number> = {
  invalid_input: -32602,
  not_found: -32004,
  unauthorized: -32001,
  forbidden: -32003,
  conflict: -32009,
  unavailable: -32010,
  timeout: -32011,
  sandbox_violation: -32012,
  budget_exceeded: -32013,
  rate_limited: -32029,
  internal: -32603,
};

/** Transport-independent dispatcher: validates params with the contract and maps errors. */
export const createDispatcher = (handlers: Handlers, log: Logger) => {
  return async (raw: unknown, ctx: CallContext): Promise<RpcResponse> => {
    const parsed = RpcRequest.safeParse(raw);
    if (!parsed.success)
      return { jsonrpc: '2.0', id: 0, error: { code: -32600, message: 'Invalid request' } };
    const { id, method, params } = parsed.data;
    if (!isMethod(method))
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method ${method}` } };
    const handler = handlers[method] as Handler<typeof method> | undefined;
    if (!handler)
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method ${method} not implemented` } };
    const p = methods[method].params.safeParse(params ?? {});
    if (!p.success) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32602,
          message: `Invalid params: ${p.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
          data: { code: 'invalid_input' },
        },
      };
    }
    try {
      const result = await handler(p.data as never, ctx);
      return { jsonrpc: '2.0', id, result };
    } catch (err) {
      if (isBeamhopError(err)) {
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: ERROR_CODES[err.code] ?? -32603,
            message: err.message,
            data: { code: err.code, details: err.details },
          },
        };
      }
      log.error('rpc handler crashed', { method, error: String((err as Error)?.stack ?? err) });
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: 'Internal error', data: { code: 'internal' } },
      };
    }
  };
};

export const generateToken = (): string => randomBytes(32).toString('base64url');

const safeEqual = (a: string, b: string): boolean => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export interface ApiServerOptions {
  handlers: Handlers;
  token: string;
  log: Logger;
  host?: string;
  port?: number;
  /** Directory with the built PWA to serve at / (SPA fallback to index.html). */
  staticDir?: string;
  maxBodyBytes?: number;
  /** Extra HTTP routes (e.g. `POST /hooks/<id>` webhooks); return true when handled. Auth is theirs. */
  routes?: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;
}

export interface ApiServer {
  server: Server;
  url: string;
  broadcast(e: ServerEvent): void;
  dispatch: ReturnType<typeof createDispatcher>;
  close(): Promise<void>;
}

const readBody = (req: IncomingMessage, max: number): Promise<string> =>
  new Promise((res, rej) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        rej(new BeamhopError('invalid_input', 'body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => res(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rej);
  });

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' ws: wss: https:; font-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
};

export const startApiServer = async (opts: ApiServerOptions): Promise<ApiServer> => {
  const { token, log } = opts;
  const dispatch = createDispatcher(opts.handlers, log);
  const maxBody = opts.maxBodyBytes ?? 2 * 1024 * 1024;
  const authed = (req: IncomingMessage, url: URL): boolean => {
    const h = req.headers.authorization;
    if (h?.startsWith('Bearer ') && safeEqual(h.slice(7), token)) return true;
    const q = url.searchParams.get('token');
    return !!q && safeEqual(q, token);
  };

  const serveStatic = async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    if (!opts.staticDir || (req.method !== 'GET' && req.method !== 'HEAD')) return false;
    const root = resolve(opts.staticDir);
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    let file = normalize(join(root, rel));
    if (file !== root && !file.startsWith(root + sep)) return false; // path traversal
    let st = await stat(file).catch(() => undefined);
    if (!st?.isFile()) {
      // SPA fallback for client routes (no extension)
      if (extname(rel)) return false;
      file = join(root, 'index.html');
      st = await stat(file).catch(() => undefined);
      if (!st?.isFile()) return false;
    }
    const isHashed = /\/assets\//.test(file);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'content-length': st.size,
      'cache-control': isHashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    if (req.method === 'HEAD') res.end();
    else createReadStream(file).pipe(res);
    return true;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
        return;
      }
      if (url.pathname === '/rpc') {
        if (req.method !== 'POST') {
          res.writeHead(405).end();
          return;
        }
        if (!authed(req, url)) {
          res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}');
          return;
        }
        let body: unknown;
        try {
          body = JSON.parse(await readBody(req, maxBody));
        } catch {
          res
            .writeHead(400, { 'content-type': 'application/json' })
            .end(JSON.stringify({ jsonrpc: '2.0', id: 0, error: { code: -32700, message: 'Parse error' } }));
          return;
        }
        const out = await dispatch(body, { caller: 'local', transport: 'http' });
        res
          .writeHead(200, { 'content-type': 'application/json', ...SECURITY_HEADERS })
          .end(JSON.stringify(out));
        return;
      }
      if (opts.routes && (await opts.routes(req, res, url))) return;
      if (await serveStatic(req, res, url)) return;
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    } catch (err) {
      log.error('http error', { error: String(err) });
      if (!res.headersSent) res.writeHead(500).end();
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: maxBody });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws' || !authed(req, url)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws: WebSocket) => {
    ws.on('message', async (data) => {
      let body: unknown;
      try {
        body = JSON.parse(String(data));
      } catch {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: 0, error: { code: -32700, message: 'Parse error' } }));
        return;
      }
      const out = await dispatch(body, { caller: 'local', transport: 'ws' });
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(out));
    });
  });

  await new Promise<void>((res, rej) => {
    server.once('error', rej);
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => res());
  });
  const addr = server.address() as AddressInfo;
  const url = `http://${addr.address === '::1' ? '[::1]' : addr.address}:${addr.port}`;
  log.info('api listening', { url });

  return {
    server,
    url,
    dispatch,
    broadcast(e) {
      const msg = JSON.stringify({ jsonrpc: '2.0', method: 'event', params: e });
      for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(msg);
    },
    async close() {
      for (const c of wss.clients) c.terminate();
      wss.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
};
