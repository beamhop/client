// Control-plane client for the PWA / CLI (§4). Browser-compatible: keep node-only imports out
// of this file and everything it imports (enforced by test/browser-safe.test.ts).
import type { Logger, RpcNotification, RpcResponse, ServerEvent } from '@beamhop/core';
import type { Event } from 'nostr-tools/core';
import { getPublicKey } from 'nostr-tools/pure';
import {
  buildControlEvents,
  CONTROL_KIND,
  ControlDecoder,
  newRpcId,
  REPLAY_WINDOW_S,
  ReplayGuard,
} from './control-protocol.ts';
import { decodePubkey, decodeSecretKey } from './keys.ts';
import { RelayPool, type WebSocketCtor } from './pool.ts';
import { tagValue } from './tags.ts';

export interface ControlClientOptions {
  /** Client (device) key: nsec, hex or bytes. */
  key: string | Uint8Array;
  /** Daemon pubkey: npub or hex. */
  daemonPubkey: string;
  relays: string[];
  WebSocket?: WebSocketCtor;
  log?: Logger;
  /** Use an existing pool instead of creating one (not closed by the client). */
  pool?: RelayPool;
  /** Default call timeout (ms). */
  timeoutMs?: number;
}

export class ControlRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'ControlRpcError';
  }
}

export interface ControlClient {
  readonly pubkey: string;
  readonly daemonPubkey: string;
  /** Resolves once the response subscription is open on at least one relay (or all failed). */
  ready(): Promise<void>;
  call<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  /** Pushed server events (`{"method":"event"}` notifications). Returns an unsubscribe fn. */
  onEvent(handler: (ev: ServerEvent) => void): () => void;
  close(): void;
}

interface PendingCall {
  rpcId: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export const createControlClient = (opts: ControlClientOptions): ControlClient => {
  const sk = decodeSecretKey(opts.key);
  const pubkey = getPublicKey(sk);
  const daemon = decodePubkey(opts.daemonPubkey);
  const ownPool = !opts.pool;
  const pool = opts.pool ?? new RelayPool({ relays: opts.relays, WebSocket: opts.WebSocket, log: opts.log });
  const relays = opts.relays.map((r) => pool.addRelay(r));
  const guard = new ReplayGuard();
  const decoder = new ControlDecoder(sk);
  const pending = new Map<string, PendingCall>();
  const handlers = new Set<(ev: ServerEvent) => void>();
  let closed = false;

  let readyResolve!: () => void;
  const readyP = new Promise<void>((r) => {
    readyResolve = r;
  });

  const onevent = (ev: Event) => {
    if (ev.kind !== CONTROL_KIND || ev.pubkey !== daemon) return;
    if (tagValue(ev.tags, 'p') !== pubkey) return;
    const why = guard.check(ev);
    if (why) {
      opts.log?.debug('control: dropped event', { reason: why });
      return;
    }
    let text: string | undefined;
    try {
      text = decoder.decode(ev);
    } catch (err) {
      opts.log?.warn('control: undecryptable event', { error: String(err) });
      return;
    }
    if (text === undefined) return;
    let msg: RpcResponse | RpcNotification;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || (msg as { jsonrpc?: string }).jsonrpc !== '2.0') return;
    if ('method' in msg && msg.method === 'event') {
      for (const h of handlers) {
        try {
          h(msg.params);
        } catch (err) {
          opts.log?.error('control: event handler threw', { error: String(err) });
        }
      }
      return;
    }
    const reqId = tagValue(ev.tags, 'e');
    if (!reqId) return;
    const p = pending.get(reqId);
    if (!p || !('id' in msg) || msg.id !== p.rpcId) return;
    pending.delete(reqId);
    clearTimeout(p.timer);
    if ('error' in msg && msg.error)
      p.reject(new ControlRpcError(msg.error.code, msg.error.message, msg.error.data));
    else p.resolve((msg as { result?: unknown }).result);
  };

  const sub = pool.subscribe(
    [
      {
        kinds: [CONTROL_KIND],
        authors: [daemon],
        '#p': [pubkey],
        since: Math.floor(Date.now() / 1000) - REPLAY_WINDOW_S,
      },
    ],
    { onevent, oneose: () => readyResolve() },
    { relays },
  );
  // Do not block forever on a slow relay.
  setTimeout(() => readyResolve(), 5000);

  return {
    pubkey,
    daemonPubkey: daemon,
    ready: () => readyP,
    async call<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
      if (closed) throw new Error('control client closed');
      const rpcId = newRpcId();
      const req = { jsonrpc: '2.0' as const, id: rpcId, method, ...(params === undefined ? {} : { params }) };
      const events = buildControlEvents(sk, daemon, req);
      // The daemon replies to the first chunk's id.
      const reqEventId = events[0]!.id;
      const result = new Promise<T>((resolve, reject) => {
        const timer = setTimeout(
          () => {
            pending.delete(reqEventId);
            reject(new ControlRpcError(-32001, `control call ${method} timed out`));
          },
          timeoutMs ?? opts.timeoutMs ?? 15_000,
        );
        pending.set(reqEventId, { rpcId, resolve: resolve as (v: unknown) => void, reject, timer });
      });
      const pubs = await Promise.all(events.map((e) => pool.publish(e, { relays, quorum: 1 })));
      if (pubs.some((p) => p.ok.length === 0)) {
        const p = pending.get(reqEventId);
        if (p) {
          clearTimeout(p.timer);
          pending.delete(reqEventId);
          const reasons = pubs.flatMap((x) => x.failed.map((f) => `${f.relay}: ${f.reason}`)).join('; ');
          p.reject(new ControlRpcError(-32002, `could not reach any relay (${reasons})`));
        }
      }
      return result;
    },
    onEvent(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    close() {
      if (closed) return;
      closed = true;
      sub.close();
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(new ControlRpcError(-32003, 'control client closed'));
      }
      pending.clear();
      if (ownPool) pool.close();
    },
  };
};
