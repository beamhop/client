import { randomBytes } from 'node:crypto';
import {
  type Agent,
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import { type Logger, type SecretStore, silentLogger } from '@beamhop/core';

export interface LlmRoute {
  /** Route id, e.g. "anthropic". */
  id: string;
  /** Path prefix on the proxy, e.g. "/anthropic". */
  prefix: string;
  /** Upstream origin (+ optional base path), e.g. "https://api.anthropic.com". */
  upstream: string;
  /** Vault secret holding the real key. */
  secretName: string;
  auth: 'x-api-key' | 'bearer';
  /** Ask OpenAI-compatible streams for a final usage chunk (stream_options.include_usage). */
  injectStreamUsage?: boolean;
}

export const DEFAULT_ROUTES: LlmRoute[] = [
  {
    id: 'anthropic',
    prefix: '/anthropic',
    upstream: 'https://api.anthropic.com',
    secretName: 'ANTHROPIC_API_KEY',
    auth: 'x-api-key',
  },
  {
    id: 'openai',
    prefix: '/openai',
    upstream: 'https://api.openai.com',
    secretName: 'OPENAI_API_KEY',
    auth: 'bearer',
    injectStreamUsage: true,
  },
  {
    id: 'openrouter',
    prefix: '/openrouter',
    upstream: 'https://openrouter.ai',
    secretName: 'OPENROUTER_API_KEY',
    auth: 'bearer',
    injectStreamUsage: true,
  },
];

export interface UsageEvent {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  session: string;
  route: string;
  model?: string;
}

export interface LlmProxyOptions {
  secrets: SecretStore;
  routes?: LlmRoute[];
  onUsage?: (u: UsageEvent) => void;
  /** Return false to deny with 429 (budget exhausted). */
  checkBudget?: (sessionToken: string) => boolean | Promise<boolean>;
  /** Compute cost when the upstream doesn't report it. */
  priceFor?: (u: Omit<UsageEvent, 'costUsd'>) => number | undefined;
  log?: Logger;
  host?: string;
  port?: number;
  /** HTTP(S) agent for upstream requests (e.g. a corporate proxy agent). */
  upstreamAgent?: Agent;
  maxRequestBytes?: number;
  /**
   * Allow provider-side tools that make the *provider* fetch URLs or connect to remote servers
   * (Anthropic `mcp_servers` / `web_fetch` / `web_search`, OpenAI `web_search*` / `mcp`, OpenRouter
   * `:online` / web plugin). Default false: with the owner's key they are an exfiltration channel
   * around the sandbox egress allowlist (§7A).
   */
  allowServerSideTools?: boolean;
}

export interface LlmProxy {
  readonly url: string;
  readonly port: number;
  /** Mint a per-session placeholder token; the harness sends it instead of a real key. */
  createSession(label?: string): string;
  revokeSession(token: string): void;
  close(): Promise<void>;
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'host',
]);
/** Credentials the client might send; never forwarded. */
const AUTH_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'api-key',
  'x-goog-api-key',
  'x-beamhop-session',
  'cookie',
  'openai-organization',
  'openai-project',
]);

export const SESSION_HEADER = 'x-beamhop-session';
const TOKEN_PREFIX = 'bh-sess-';

const json = (res: ServerResponse, status: number, body: unknown) => {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
};

const errorBody = (type: string, message: string) => ({ type: 'error', error: { type, message } });

/** Tool `type`s that run on the provider and reach the network (URL fetch, search, remote MCP). */
const SERVER_TOOL_TYPE = /^(web_fetch|web_search|mcp|url_context)/i;

/** Reason a request body asks the provider to reach the network on our key, or undefined. */
export const serverSideToolUse = (body: unknown): string | undefined => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const o = body as Record<string, unknown>;
  if (o.mcp_servers !== undefined) return 'mcp_servers';
  if (o.web_search_options !== undefined) return 'web_search_options';
  if (o.plugins !== undefined) return 'plugins';
  const models = [o.model, ...(Array.isArray(o.models) ? o.models : [])];
  if (models.some((m) => typeof m === 'string' && /:online$/i.test(m))) return ':online model';
  const tools = Array.isArray(o.tools) ? o.tools : [];
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    const type = (t as Record<string, unknown>).type;
    if (typeof type === 'string' && SERVER_TOOL_TYPE.test(type)) return `tool ${type}`;
  }
  return undefined;
};

const presentedToken = (h: IncomingHttpHeaders): string | undefined => {
  const s = h[SESSION_HEADER];
  if (typeof s === 'string' && s) return s.trim();
  const auth = h.authorization;
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(\S+)$/i.exec(auth.trim());
    if (m?.[1]?.startsWith(TOKEN_PREFIX)) return m[1];
  }
  const k = h['x-api-key'];
  if (typeof k === 'string' && k.startsWith(TOKEN_PREFIX)) return k.trim();
  return undefined;
};

// ───────────────────────────── usage parsing ─────────────────────────────

interface UsageAcc {
  input?: number;
  output?: number;
  cost?: number;
  model?: string;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Fold one JSON object (SSE event or full body) into the accumulator. */
export const foldUsage = (acc: UsageAcc, obj: unknown): void => {
  if (!obj || typeof obj !== 'object') return;
  const o = obj as Record<string, unknown>;
  const candidates: unknown[] = [o.usage];
  const msg = o.message as Record<string, unknown> | undefined; // anthropic message_start
  if (msg && typeof msg === 'object') {
    candidates.push(msg.usage);
    if (typeof msg.model === 'string') acc.model ??= msg.model;
  }
  const resp = o.response as Record<string, unknown> | undefined; // openai responses API
  if (resp && typeof resp === 'object') {
    candidates.push(resp.usage);
    if (typeof resp.model === 'string') acc.model ??= resp.model;
  }
  if (typeof o.model === 'string') acc.model ??= o.model;
  for (const c of candidates) {
    if (!c || typeof c !== 'object') continue;
    const u = c as Record<string, unknown>;
    const input =
      num(u.input_tokens) !== undefined
        ? (num(u.input_tokens) ?? 0) +
          (num(u.cache_creation_input_tokens) ?? 0) +
          (num(u.cache_read_input_tokens) ?? 0)
        : num(u.prompt_tokens);
    const output = num(u.output_tokens) ?? num(u.completion_tokens);
    if (input !== undefined && input > 0) acc.input = Math.max(acc.input ?? 0, input);
    if (output !== undefined) acc.output = Math.max(acc.output ?? 0, output);
    const cost = num(u.cost) ?? num(u.total_cost);
    if (cost !== undefined) acc.cost = cost;
  }
};

/** Incremental SSE parser that feeds `data:` JSON payloads to `onData`. */
export const createSseParser = (onData: (obj: unknown) => void) => {
  let buf = '';
  let data: string[] = [];
  const dispatch = () => {
    if (data.length) {
      const payload = data.join('\n');
      data = [];
      if (payload !== '[DONE]') {
        try {
          onData(JSON.parse(payload));
        } catch {
          /* not JSON */
        }
      }
    }
  };
  return {
    push(chunk: string) {
      buf += chunk;
      let nl = buf.indexOf('\n');
      while (nl !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line === '') dispatch();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        nl = buf.indexOf('\n');
      }
      if (buf.length > 1024 * 1024) buf = ''; // runaway line; give up on it
    },
    end() {
      if (buf) this.push('\n');
      dispatch();
    },
  };
};

// ───────────────────────────── server ─────────────────────────────

const readBody = (req: IncomingMessage, max: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(Object.assign(new Error('request too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

/**
 * Local key-injecting LLM proxy (§7). Listens on 127.0.0.1:<random>. Harnesses use
 * `<url>/anthropic`, `<url>/openai/v1`, `<url>/openrouter/api/v1` as base URLs with a
 * per-session placeholder token; the proxy strips client credentials, injects the real key,
 * streams the response through and counts tokens itself.
 */
export const createLlmProxy = async (opts: LlmProxyOptions): Promise<LlmProxy> => {
  const log = opts.log ?? silentLogger;
  const routes = [...(opts.routes ?? DEFAULT_ROUTES)].sort((a, b) => b.prefix.length - a.prefix.length);
  const sessions = new Map<string, { label?: string }>();
  const maxBytes = opts.maxRequestBytes ?? 32 * 1024 * 1024;

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const rawUrl = req.url ?? '/';
    if (!rawUrl.startsWith('/') || rawUrl.startsWith('//')) {
      return json(res, 400, errorBody('invalid_request_error', 'bad request target'));
    }
    const token = presentedToken(req.headers);
    if (!token || !sessions.has(token)) {
      return json(res, 401, errorBody('authentication_error', 'missing or invalid beamhop session token'));
    }
    const qIdx = rawUrl.indexOf('?');
    const pathname = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx);
    const search = qIdx === -1 ? '' : rawUrl.slice(qIdx);
    const route = routes.find((r) => pathname === r.prefix || pathname.startsWith(`${r.prefix}/`));
    if (!route) return json(res, 404, errorBody('not_found_error', 'unknown upstream route'));
    const rest = pathname.slice(route.prefix.length);
    if (/(^|\/)\.\.?(\/|$)/.test(rest) || /%2e|%2f|\\/i.test(rest)) {
      return json(res, 400, errorBody('invalid_request_error', 'ambiguous path'));
    }

    if (opts.checkBudget && !(await opts.checkBudget(token))) {
      return json(res, 429, errorBody('rate_limit_error', 'beamhop budget exceeded for this session'));
    }

    const key = await opts.secrets.get(route.secretName);
    if (!key) {
      return json(res, 503, errorBody('api_error', `no secret "${route.secretName}" configured in beamhop`));
    }

    let body = await readBody(req, maxBytes);
    let model: string | undefined;
    const ctype = String(req.headers['content-type'] ?? '');
    if (body.length) {
      // Parse regardless of content-type: providers may accept JSON sent as text/plain.
      let parsed: Record<string, unknown> | undefined;
      try {
        const v = JSON.parse(body.toString('utf8')) as unknown;
        if (v && typeof v === 'object' && !Array.isArray(v)) parsed = v as Record<string, unknown>;
      } catch {
        if (ctype.includes('json')) {
          return json(res, 400, errorBody('invalid_request_error', 'request body is not valid JSON'));
        }
      }
      if (parsed) {
        const why = opts.allowServerSideTools ? undefined : serverSideToolUse(parsed);
        if (why) {
          log.warn('blocked provider-side network tool', { route: route.id, feature: why });
          return json(
            res,
            403,
            errorBody('permission_error', `beamhop blocks provider-side network tools (${why})`),
          );
        }
        if (typeof parsed.model === 'string') model = parsed.model;
        if (
          route.injectStreamUsage &&
          parsed.stream === true &&
          rest.endsWith('/chat/completions') &&
          parsed.stream_options === undefined
        ) {
          parsed.stream_options = { include_usage: true };
          body = Buffer.from(JSON.stringify(parsed), 'utf8');
        }
      }
    }

    const up = new URL(route.upstream);
    const basePath = up.pathname.replace(/\/$/, '');
    const headers: OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP_BY_HOP.has(k) || AUTH_HEADERS.has(k)) continue;
      headers[k] = v;
    }
    headers['accept-encoding'] = 'identity'; // we parse usage from the body
    headers['content-length'] = String(body.length);
    if (route.auth === 'x-api-key') headers['x-api-key'] = key;
    else headers.authorization = `Bearer ${key}`;

    const doRequest = up.protocol === 'https:' ? httpsRequest : httpRequest;
    const upReq = doRequest(
      {
        protocol: up.protocol,
        hostname: up.hostname,
        port: up.port || undefined,
        method: req.method,
        path: `${basePath}${rest}${search}`,
        headers,
        ...(opts.upstreamAgent ? { agent: opts.upstreamAgent } : {}),
      },
      (upRes) => {
        const outHeaders: OutgoingHttpHeaders = {};
        for (const [k, v] of Object.entries(upRes.headers)) {
          if (v === undefined || HOP_BY_HOP.has(k) || k === 'set-cookie') continue;
          outHeaders[k] = v;
        }
        res.writeHead(upRes.statusCode ?? 502, outHeaders);
        res.flushHeaders();

        const acc: UsageAcc = { ...(model ? { model } : {}) };
        const isSse = String(upRes.headers['content-type'] ?? '').includes('text/event-stream');
        const sse = isSse ? createSseParser((o) => foldUsage(acc, o)) : undefined;
        const jsonChunks: Buffer[] = [];
        let jsonSize = 0;
        upRes.on('data', (chunk: Buffer) => {
          res.write(chunk);
          if (sse) sse.push(chunk.toString('utf8'));
          else if (jsonSize < 16 * 1024 * 1024) {
            jsonChunks.push(chunk);
            jsonSize += chunk.length;
          }
        });
        upRes.on('end', () => {
          res.end();
          if (sse) sse.end();
          else {
            try {
              foldUsage(acc, JSON.parse(Buffer.concat(jsonChunks).toString('utf8')));
            } catch {
              /* not JSON */
            }
          }
          if (acc.input !== undefined || acc.output !== undefined) {
            const base = {
              inputTokens: acc.input ?? 0,
              outputTokens: acc.output ?? 0,
              session: token,
              route: route.id,
              ...(acc.model ? { model: acc.model } : {}),
            };
            const costUsd = acc.cost ?? opts.priceFor?.(base);
            try {
              opts.onUsage?.({ ...base, ...(costUsd !== undefined ? { costUsd } : {}) });
            } catch (e) {
              log.warn('onUsage failed', { error: String(e) });
            }
          }
        });
        upRes.on('error', () => res.destroy());
      },
    );
    upReq.on('error', (e) => {
      log.warn('upstream request failed', { route: route.id, error: e.message });
      json(res, 502, errorBody('api_error', `upstream error: ${e.message}`));
    });
    res.on('close', () => {
      if (!res.writableFinished) upReq.destroy();
    });
    upReq.end(body);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((e: Error & { status?: number }) => {
      log.warn('broker request failed', { error: e.message });
      json(
        res,
        e.status ?? 500,
        errorBody('api_error', e.status === 413 ? 'request too large' : 'internal error'),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  const host = addr.family === 'IPv6' ? `[${addr.address}]` : addr.address;

  return {
    url: `http://${host}:${addr.port}`,
    port: addr.port,
    createSession(label?: string) {
      const t = TOKEN_PREFIX + randomBytes(24).toString('base64url');
      sessions.set(t, label ? { label } : {});
      return t;
    },
    revokeSession(t: string) {
      sessions.delete(t);
    },
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
};
