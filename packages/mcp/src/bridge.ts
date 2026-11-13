/**
 * Daemon side of the MCP bridge: a local HTTP server on 127.0.0.1 (random port) that the sandboxed
 * `beamhop-mcp` process calls back into. Each harness session gets its own random token; the
 * token maps to the daemon's session context, and calls are dispatched to daemon handlers.
 *
 * Security posture (§7A): the caller is untrusted. We only bind loopback, require a 256-bit
 * bearer token, refuse browser-originated requests (Origin header) and foreign Host headers
 * (DNS rebinding), cap the body size, and re-validate all input with the tool schemas.
 * Handlers still own the policy decisions (routes, path confinement, DLP, budgets, hops).
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BeamhopError, isBeamhopError, type Logger } from '@beamhop/core';
import { type McpServerSpec, mcpServerSpec } from './spec.ts';
import { isToolName, LIMITS, parseToolInput, type ToolInputs, type ToolName } from './tools.ts';
import { BRIDGE_PATH, type CallResult } from './wire.ts';

/** Handler results are text; objects/arrays are rendered as pretty JSON. */
export type HandlerResult = string | Record<string, unknown> | unknown[];

export interface HandlerMeta {
  /** Aborted when the MCP client cancels the call or the session is removed. */
  signal: AbortSignal;
  log: Logger;
}

/**
 * Functions the daemon provides. `ctx` is whatever the daemon registered for the session token
 * (agent, conversation, role, hops, …). Throw a `BeamhopError` to return a clean tool error, e.g.
 *  - `forbidden` for a channel_send target without a route, or a hop limit (`nextHop`),
 *  - `sandbox_violation` for a channel_send_file path outside the session dir/mounts,
 *  - `budget_exceeded`, `timeout`, `not_found`, ...
 * Other errors are reported to the model as a generic internal error (details only in the log).
 */
export type McpHandlers<C> = {
  [K in ToolName]: (ctx: C, input: ToolInputs[K], meta: HandlerMeta) => Promise<HandlerResult>;
};

export interface McpBridgeOptions<C> {
  handlers: McpHandlers<C>;
  log: Logger;
  /** Port to bind (default 0 = random). Always bound on 127.0.0.1. */
  port?: number;
}

export interface McpBridge<C> {
  /** e.g. "http://127.0.0.1:43123" */
  readonly url: string;
  readonly port: number;
  /** Register a session; returns its secret token (pass it to the MCP process only). */
  addSession(ctx: C): string;
  /** Revoke a token; in-flight calls for it are aborted. Returns false if unknown. */
  removeSession(token: string): boolean;
  /** `SessionSpec.mcpServers` entry for a token (see `mcpServerSpec`). */
  spec(token: string): McpServerSpec;
  readonly sessionCount: number;
  close(): Promise<void>;
}

interface Entry<C> {
  ctx: C;
  abort: AbortController;
}

const hashToken = (t: string): string => createHash('sha256').update(t).digest('hex');

const renderResult = (r: HandlerResult): string => {
  const text = typeof r === 'string' ? r : JSON.stringify(r, null, 2);
  if (text.length <= LIMITS.resultMaxChars) return text;
  return `${text.slice(0, LIMITS.resultMaxChars)}\n…[truncated ${text.length - LIMITS.resultMaxChars} chars]`;
};

const send = (res: ServerResponse, status: number, body: CallResult): void => {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
    'cache-control': 'no-store',
  });
  res.end(json);
};

const fail = (res: ServerResponse, status: number, code: BeamhopError['code'], message: string) =>
  send(res, status, { ok: false, error: { code, message } });

const readBody = (req: IncomingMessage, max: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new BeamhopError('invalid_input', `request body exceeds ${max} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

export const createMcpBridge = async <C>(opts: McpBridgeOptions<C>): Promise<McpBridge<C>> => {
  const log = opts.log.child({ component: 'mcp-bridge' });
  const sessions = new Map<string, Entry<C>>();
  let port = 0;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== BRIDGE_PATH) return fail(res, 404, 'not_found', 'unknown endpoint');
    if (req.method !== 'POST') return fail(res, 405, 'invalid_input', 'use POST');
    if (req.headers.origin !== undefined)
      return fail(res, 403, 'forbidden', 'browser requests are not allowed');
    const host = req.headers.host ?? '';
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)
      return fail(res, 403, 'forbidden', 'unexpected Host header');

    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const entry = token ? sessions.get(hashToken(token)) : undefined;
    if (!entry) {
      log.warn('rejected bridge call with invalid session token');
      return fail(res, 401, 'unauthorized', 'session token rejected (session ended or invalid)');
    }
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json'))
      return fail(res, 415, 'invalid_input', 'content-type must be application/json');

    let body: { tool?: unknown; input?: unknown };
    try {
      body = JSON.parse((await readBody(req, LIMITS.bridgeMaxBodyBytes)).toString('utf8'));
    } catch (e) {
      return fail(res, 400, 'invalid_input', isBeamhopError(e) ? e.message : 'body is not valid JSON');
    }
    if (typeof body !== 'object' || body === null || !isToolName(body.tool))
      return fail(res, 400, 'invalid_input', 'unknown tool');
    const tool = body.tool;

    // Abort the handler when the caller disconnects or the session is removed.
    const ac = new AbortController();
    const onSessionAbort = () => ac.abort(new BeamhopError('unavailable', 'session ended'));
    entry.abort.signal.addEventListener('abort', onSessionAbort, { once: true });
    res.on('close', () => {
      if (!res.writableFinished) ac.abort(new BeamhopError('timeout', 'caller went away'));
    });

    const started = Date.now();
    try {
      const input = parseToolInput(tool, body.input);
      const handler = opts.handlers[tool] as (c: C, i: unknown, m: HandlerMeta) => Promise<HandlerResult>;
      const out = await handler(entry.ctx, input, { signal: ac.signal, log: log.child({ tool }) });
      log.debug('tool call ok', { tool, ms: Date.now() - started });
      send(res, 200, { ok: true, text: renderResult(out) });
    } catch (e) {
      if (isBeamhopError(e)) {
        log.info('tool call failed', { tool, code: e.code, ms: Date.now() - started });
        send(res, e.code === 'invalid_input' ? 400 : 200, {
          ok: false,
          error: { code: e.code, message: e.message },
        });
      } else {
        log.error('tool handler crashed', { tool, error: e instanceof Error ? e.message : String(e) });
        send(res, 500, {
          ok: false,
          error: { code: 'internal', message: `internal error while running ${tool}` },
        });
      }
    } finally {
      entry.abort.signal.removeEventListener('abort', onSessionAbort);
    }
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      log.error('bridge request failed', { error: e instanceof Error ? e.message : String(e) });
      if (!res.headersSent) fail(res, 500, 'internal', 'internal error');
      else res.destroy();
    });
  });
  // Long-poll tools (mesh_ask_agent) may legitimately take minutes.
  server.requestTimeout = 0;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  log.info('mcp bridge listening', { url });

  return {
    url,
    port,
    addSession(ctx: C): string {
      const token = randomBytes(32).toString('base64url');
      sessions.set(hashToken(token), { ctx, abort: new AbortController() });
      return token;
    },
    removeSession(token: string): boolean {
      const k = hashToken(token);
      const e = sessions.get(k);
      if (!e) return false;
      sessions.delete(k);
      e.abort.abort();
      return true;
    },
    spec: (token: string) => mcpServerSpec(token, url),
    get sessionCount() {
      return sessions.size;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const e of sessions.values()) e.abort.abort();
        sessions.clear();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
};
