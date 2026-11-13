/**
 * Typed beamhop API client, transport-agnostic and browser-safe (no node: imports).
 * Used by the CLI (HTTP), the PWA (WebSocket locally, Nostr control plane when hosted) and tests.
 */
import type { MethodName, Params, Result, RpcResponse, ServerEvent } from '@beamhop/core';

export interface Transport {
  request(method: string, params: unknown): Promise<unknown>;
  /** Subscribe to pushed server events. Returns unsubscribe. Optional for request-only transports. */
  subscribe?(fn: (e: ServerEvent) => void): () => void;
  close?(): void;
}

export class RpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
  /** beamhop error code (e.g. 'not_found') when the server sent one. */
  get beamhopCode(): string | undefined {
    return (this.data as { code?: string } | undefined)?.code;
  }
}

export interface BeamhopClient {
  call<M extends MethodName>(
    method: M,
    ...params: Params<M> extends undefined ? [] : [Params<M>?]
  ): Promise<Result<M>>;
  on(fn: (e: ServerEvent) => void): () => void;
  close(): void;
}

export const createClient = (transport: Transport): BeamhopClient => ({
  call: (async (method: string, params?: unknown) =>
    transport.request(method, params ?? {})) as BeamhopClient['call'],
  on: (fn) => transport.subscribe?.(fn) ?? (() => {}),
  close: () => transport.close?.(),
});

let nextId = 1;

const unwrap = (res: RpcResponse): unknown => {
  if ('error' in res) throw new RpcError(res.error.code, res.error.message, res.error.data);
  return res.result;
};

/** HTTP POST transport: `POST {baseUrl}/rpc` with bearer token. */
export const httpTransport = (
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Transport => ({
  async request(method, params) {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
    });
    if (res.status === 401)
      throw new RpcError(401, 'Unauthorized: bad or missing API token', { code: 'unauthorized' });
    const body = (await res.json()) as RpcResponse;
    return unwrap(body);
  },
});

export interface WsTransportOptions {
  /** WebSocket constructor (globalThis.WebSocket in browsers and Node >= 22). */
  WebSocketImpl?: typeof WebSocket;
  /** Reconnect automatically (default true). */
  reconnect?: boolean;
  onStatus?: (s: 'connecting' | 'open' | 'closed') => void;
}

/** WebSocket transport: `{baseUrl}/ws?token=...`; carries requests and pushed events. */
export const wsTransport = (baseUrl: string, token: string, opts: WsTransportOptions = {}): Transport => {
  const WS = opts.WebSocketImpl ?? globalThis.WebSocket;
  const url = `${baseUrl.replace(/^http/, 'ws').replace(/\/$/, '')}/ws?token=${encodeURIComponent(token)}`;
  const pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  const listeners = new Set<(e: ServerEvent) => void>();
  const queue: string[] = [];
  let ws: WebSocket | undefined;
  let closed = false;
  let backoff = 250;

  const connect = () => {
    opts.onStatus?.('connecting');
    ws = new WS(url);
    ws.onopen = () => {
      backoff = 250;
      opts.onStatus?.('open');
      for (const m of queue.splice(0)) ws?.send(m);
    };
    ws.onmessage = (ev) => {
      let msg: RpcResponse | { method: 'event'; params: ServerEvent };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if ('method' in msg && msg.method === 'event') {
        for (const fn of listeners) fn(msg.params);
        return;
      }
      const res = msg as RpcResponse;
      const p = pending.get(res.id);
      if (!p) return;
      pending.delete(res.id);
      try {
        p.resolve(unwrap(res));
      } catch (e) {
        p.reject(e);
      }
    };
    ws.onclose = () => {
      opts.onStatus?.('closed');
      for (const [id, p] of pending) {
        p.reject(new RpcError(-32000, 'connection closed'));
        pending.delete(id);
      }
      if (!closed && opts.reconnect !== false) {
        setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 10_000);
      }
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  };
  connect();

  return {
    request(method, params) {
      const id = nextId++;
      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        if (ws?.readyState === 1) ws.send(payload);
        else queue.push(payload);
      });
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    close() {
      closed = true;
      ws?.close();
    },
  };
};

/** In-process transport for tests: wires a client straight to a handler function. */
export const directTransport = (
  handle: (method: string, params: unknown) => Promise<unknown>,
  events?: { subscribe(fn: (e: ServerEvent) => void): () => void },
): Transport => ({
  request: handle,
  subscribe: events ? (fn) => events.subscribe(fn) : undefined,
});
