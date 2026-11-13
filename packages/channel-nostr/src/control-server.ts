// Control-plane server for the daemon (§4): JSON-RPC over NIP-44 encrypted ephemeral events.
import {
  isBeamhopError,
  type Logger,
  type RpcNotification,
  RpcRequest,
  type RpcResponse,
  type ServerEvent,
} from '@beamhop/core';
import type { Event } from 'nostr-tools/core';
import { getPublicKey } from 'nostr-tools/pure';
import {
  buildControlEvents,
  CONTROL_KIND,
  ControlDecoder,
  REPLAY_WINDOW_S,
  ReplayGuard,
} from './control-protocol.ts';
import { decodePubkey, decodeSecretKey, npubEncode } from './keys.ts';
import { LruMap, RateLimiter } from './lru.ts';
import { RelayPool, type WebSocketCtor } from './pool.ts';
import { tagValue } from './tags.ts';

export interface ControlRequestContext {
  /** Sender hex pubkey (already checked against the allowlist). */
  sender: string;
  senderNpub: string;
  eventId: string;
  /** False for a not-yet-paired sender calling one of `publicMethods` (e.g. device.pairComplete). */
  allowlisted: boolean;
}

export interface ControlServerOptions {
  /** Daemon key: nsec, hex or bytes. */
  key: string | Uint8Array;
  /** Allowed sender pubkeys (npub or hex): paired devices / owner. */
  allowlist: string[];
  relays: string[];
  handle: (req: RpcRequest, ctx: ControlRequestContext) => Promise<RpcResponse> | RpcResponse;
  WebSocket?: WebSocketCtor;
  log?: Logger;
  pool?: RelayPool;
  /**
   * Methods a sender NOT on the allowlist may call (pairing). Everything else from such senders is
   * dropped. Unknown senders are rate-limited per sender and globally before any decryption work.
   */
  publicMethods?: string[];
  /** Limits for unknown senders (defaults: 5 per sender and 30 overall per minute). */
  publicRateLimit?: { perSender: number; global: number; windowMs: number };
  /** ms clock (tests). */
  now?: () => number;
}

export interface ControlServer {
  readonly pubkey: string;
  readonly npub: string;
  /** Resolves once the request subscription has EOSE'd on all relays (or failed). */
  ready(): Promise<void>;
  /** Replace the allowlist (e.g. a device was removed in the PWA, §7A). */
  setAllowlist(pubkeys: string[]): void;
  allowlist(): string[];
  /** Push a server event to `to` (default: everyone on the allowlist). */
  notify(event: ServerEvent, to?: string[]): Promise<void>;
  close(): void;
}

const ERR = { parse: -32700, invalidRequest: -32600, internal: -32603, app: -32000 } as const;

/** A JSON-RPC 2.0 response (`result`/`error`, no `method`) or a notification (`method`, no `id`). */
export const isResponseOrNotification = (m: unknown): boolean => {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return false;
  const o = m as Record<string, unknown>;
  if (o.jsonrpc !== '2.0') return false;
  if (!('method' in o)) return 'result' in o || 'error' in o;
  return !('id' in o) || o.id === null;
};

export const createControlServer = (opts: ControlServerOptions): ControlServer => {
  const sk = decodeSecretKey(opts.key);
  const pubkey = getPublicKey(sk);
  const log = opts.log;
  const ownPool = !opts.pool;
  const pool = opts.pool ?? new RelayPool({ relays: opts.relays, WebSocket: opts.WebSocket, log });
  const relays = opts.relays.map((r) => pool.addRelay(r));
  let allow = new Set(opts.allowlist.map(decodePubkey));
  const guard = new ReplayGuard();
  const decoder = new ControlDecoder(sk);
  let closed = false;
  let rejectedLogged = 0;
  const publicMethods = new Set(opts.publicMethods ?? []);
  const rl = opts.publicRateLimit ?? { perSender: 5, global: 30, windowMs: 60_000 };
  const clock = opts.now ?? Date.now;
  const globalLimiter = new RateLimiter(rl.global, rl.windowMs, clock);
  const senderLimiters = new LruMap<string, RateLimiter>(1024);
  /** Unknown senders may only reach `publicMethods`, within the rate limits. */
  const admitUnknown = (sender: string): boolean => {
    if (!publicMethods.size) return false;
    let l = senderLimiters.get(sender);
    if (!l) {
      l = new RateLimiter(rl.perSender, rl.windowMs, clock);
      senderLimiters.set(sender, l);
    }
    return l.take() && globalLimiter.take();
  };

  let readyResolve!: () => void;
  const readyP = new Promise<void>((r) => {
    readyResolve = r;
  });

  const send = async (to: string, payload: unknown, replyTo?: string) => {
    const events = buildControlEvents(sk, to, payload, replyTo ? { replyTo } : {});
    for (const e of events) {
      const r = await pool.publish(e, { relays, quorum: 1 });
      if (!r.ok.length) log?.warn('control: reply not delivered to any relay', { failed: r.failed });
    }
  };

  const onevent = async (ev: Event) => {
    if (closed || ev.kind !== CONTROL_KIND) return;
    if (tagValue(ev.tags, 'p') !== pubkey) return;
    // Allowlist (or the public-method rate limit) before any decryption work.
    const allowlisted = allow.has(ev.pubkey);
    if (!allowlisted && !admitUnknown(ev.pubkey)) {
      if (rejectedLogged++ < 20)
        log?.warn('control: sender not on allowlist', { sender: npubEncode(ev.pubkey) });
      return;
    }
    const why = guard.check(ev);
    if (why) {
      log?.warn('control: rejected event', { reason: why, sender: npubEncode(ev.pubkey) });
      return;
    }
    let text: string | undefined;
    try {
      text = decoder.decode(ev);
    } catch (err) {
      log?.warn('control: undecryptable request', { error: String(err) });
      return;
    }
    if (text === undefined) return; // waiting for more chunks
    // Reply to the first chunk's id: for chunked requests the client keys on events[0].id,
    // which is the event carrying index 0. Track it via the e-less chunk tag.
    const replyTo = firstChunkId(ev);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      await send(
        ev.pubkey,
        { jsonrpc: '2.0', id: null, error: { code: ERR.parse, message: 'parse error' } },
        replyTo,
      );
      return;
    }
    // JSON-RPC responses and notifications are never answered (a reply to a reply would let two
    // daemons that share relays ping-pong error frames forever).
    if (isResponseOrNotification(parsed)) return;
    const req = RpcRequest.safeParse(parsed);
    if (!req.success) {
      const id = (parsed as { id?: unknown })?.id;
      await send(
        ev.pubkey,
        {
          jsonrpc: '2.0',
          id: typeof id === 'string' || typeof id === 'number' ? id : null,
          error: { code: ERR.invalidRequest, message: 'invalid request' },
        },
        replyTo,
      );
      return;
    }
    if (!allowlisted && !publicMethods.has(req.data.method)) {
      await send(
        ev.pubkey,
        {
          jsonrpc: '2.0',
          id: req.data.id,
          error: { code: ERR.app, message: 'this device is not paired', data: { code: 'unauthorized' } },
        },
        replyTo,
      );
      return;
    }
    let res: RpcResponse;
    try {
      res = await opts.handle(req.data, {
        sender: ev.pubkey,
        senderNpub: npubEncode(ev.pubkey),
        eventId: ev.id,
        allowlisted,
      });
    } catch (err) {
      res = {
        jsonrpc: '2.0',
        id: req.data.id,
        error: isBeamhopError(err)
          ? { code: ERR.app, message: err.message, data: { code: err.code } }
          : { code: ERR.internal, message: 'internal error' },
      };
      if (!isBeamhopError(err))
        log?.error('control: handler threw', { method: req.data.method, error: String(err) });
    }
    // A sender removed while its call ran gets no reply; a public call always gets its answer.
    if (allow.has(ev.pubkey) || !allowlisted) await send(ev.pubkey, res, replyTo);
  };

  // Map chunk msgId → first chunk event id so replies reference events[0].id.
  const firstIds = new Map<string, string>();
  const firstChunkId = (ev: Event): string => {
    const m = ev.tags.find((t) => t[0] === 'm');
    if (!m) return ev.id;
    const key = `${ev.pubkey}:${m[1]}`;
    const id = firstIds.get(key) ?? ev.id;
    firstIds.delete(key);
    return id;
  };
  const trackChunk = (ev: Event) => {
    const m = ev.tags.find((t) => t[0] === 'm');
    if (m && m[2] === '0') {
      firstIds.set(`${ev.pubkey}:${m[1]}`, ev.id);
      if (firstIds.size > 256) firstIds.delete(firstIds.keys().next().value!);
    }
  };

  const sub = pool.subscribe(
    [{ kinds: [CONTROL_KIND], '#p': [pubkey], since: Math.floor(Date.now() / 1000) - REPLAY_WINDOW_S }],
    {
      onevent: (ev) => {
        if (allow.has(ev.pubkey) || publicMethods.size) trackChunk(ev);
        onevent(ev).catch((err) => log?.error('control: request failed', { error: String(err) }));
      },
      oneose: () => readyResolve(),
    },
    { relays },
  );
  setTimeout(() => readyResolve(), 5000);

  return {
    pubkey,
    npub: npubEncode(pubkey),
    ready: () => readyP,
    setAllowlist(list) {
      allow = new Set(list.map(decodePubkey));
    },
    allowlist: () => [...allow],
    async notify(event, to) {
      if (closed) return;
      const msg: RpcNotification = { jsonrpc: '2.0', method: 'event', params: event };
      const targets = (to ?? [...allow]).map(decodePubkey).filter((p) => allow.has(p));
      await Promise.all(targets.map((t) => send(t, msg)));
    },
    close() {
      if (closed) return;
      closed = true;
      sub.close();
      if (ownPool) pool.close();
    },
  };
};
