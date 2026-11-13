import type { Readable, Writable } from 'node:stream';
import { BeamhopError } from '@beamhop/core';
import { readJsonLines, writeJsonLine } from './jsonl.ts';

export type JsonRpcId = number | string;

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export class JsonRpcRemoteError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(err: JsonRpcError) {
    super(err.message);
    this.name = 'JsonRpcRemoteError';
    this.code = err.code;
    this.data = err.data;
  }
}

type RequestHandler = (method: string, params: unknown, id: JsonRpcId) => Promise<unknown> | unknown;
type NotificationHandler = (method: string, params: unknown) => void;

export interface JsonRpcPeerOptions {
  /** Codex app-server omits the `"jsonrpc":"2.0"` field on the wire. */
  omitVersion?: boolean;
  onRequest?: RequestHandler;
  onNotification?: NotificationHandler;
  onBadLine?: (line: string) => void;
}

/** Minimal newline-delimited JSON-RPC 2.0 peer (both directions). */
export class JsonRpcPeer {
  private nextId = 1;
  private pending = new Map<JsonRpcId, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  private closedErr: Error | undefined;

  constructor(
    input: Readable,
    private readonly output: Writable,
    private readonly opts: JsonRpcPeerOptions = {},
  ) {
    readJsonLines(input, (m) => this.dispatch(m), { onBadLine: (l) => opts.onBadLine?.(l) });
    input.on('close', () => this.close(new BeamhopError('unavailable', 'connection closed')));
    input.on('end', () => this.close(new BeamhopError('unavailable', 'connection closed')));
  }

  private frame(msg: Record<string, unknown>): Record<string, unknown> {
    return this.opts.omitVersion ? msg : { jsonrpc: '2.0', ...msg };
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (this.closedErr) return Promise.reject(this.closedErr);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      if (timeoutMs) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new BeamhopError('timeout', `${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this.pending.set(id, {
        resolve: (v) => {
          if (timer) clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          if (timer) clearTimeout(timer);
          reject(e);
        },
      });
      writeJsonLine(this.output, this.frame({ id, method, params })).catch((e) => {
        this.pending.delete(id);
        reject(e);
      });
    });
  }

  notify(method: string, params?: unknown): Promise<void> {
    if (this.closedErr) return Promise.reject(this.closedErr);
    return writeJsonLine(this.output, this.frame({ method, params }));
  }

  close(err: Error = new BeamhopError('unavailable', 'connection closed')): void {
    if (this.closedErr) return;
    this.closedErr = err;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private dispatch(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const m = raw as {
      id?: JsonRpcId;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: JsonRpcError;
    };
    if (m.method !== undefined && m.id !== undefined && m.id !== null) {
      void this.handleRequest(m.id, m.method, m.params);
    } else if (m.method !== undefined) {
      this.opts.onNotification?.(m.method, m.params);
    } else if (m.id !== undefined && m.id !== null) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new JsonRpcRemoteError(m.error));
      else p.resolve(m.result);
    }
  }

  private async handleRequest(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    let reply: Record<string, unknown>;
    try {
      if (!this.opts.onRequest)
        throw new JsonRpcRemoteError({ code: -32601, message: `method not found: ${method}` });
      const result = await this.opts.onRequest(method, params, id);
      reply = { id, result: result ?? null };
    } catch (e) {
      const code = e instanceof JsonRpcRemoteError ? e.code : -32603;
      reply = { id, error: { code, message: e instanceof Error ? e.message : String(e) } };
    }
    await writeJsonLine(this.output, this.frame(reply)).catch(() => {});
  }
}
