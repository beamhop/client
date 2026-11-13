/**
 * Hosted-mode transport (PLAN §4 control plane, §9 Hosting): the `@beamhop/client` Transport over the
 * encrypted Nostr control plane. Screens never import this; the runtime (provider.tsx) does.
 *
 *  - **Requests** are JSON-RPC calls through a `ControlClient` (`createControlClient` for device keys,
 *    signer-client.ts for NIP-07). Pushed `{"method":"event"}` notifications feed `subscribe`.
 *  - **Reconnect**: the RelayPool reconnects each relay with backoff + jitter and resubscribes; going back
 *    online (`online` event) kicks every relay immediately.
 *  - **Offline queue**: while the browser is offline, the signer is loading, or no relay is up, requests
 *    wait in a FIFO (bounded by `maxQueue`, each for at most `queueTimeoutMs`) and go out on reconnect.
 *    Nothing is re-sent once it reached a relay (control calls are not idempotent).
 *  - **Timeouts**: `timeoutMs` per call once sent. Transport failures reject with `RpcError(-32000)`
 *    (`data.code`: `timeout` | `unavailable` | `offline` | `signer_unavailable`) so TanStack Query retries
 *    them like a dropped WebSocket; daemon errors keep their own code/data.
 *  - **Status**: `connecting` (never reached a relay yet) → `open` (≥1 relay up) → `closed` (offline, all
 *    relays down after being up, signer failed, or closed). `health()` adds per-relay state and whether the
 *    daemon answers — the shell's relay/daemon indicator.
 */
import { RelayPool, type WebSocketCtor } from '@beamhop/channel-nostr';
import type { ControlClient } from '@beamhop/channel-nostr/control-client';
import { npubEncode } from '@beamhop/channel-nostr/keys';
import { RpcError, type Transport } from '@beamhop/client';
import type { ServerEvent } from '@beamhop/core';
import type { ConnectionStatus } from './connection.ts';
import type { HostedIdentity } from './identity.ts';

export interface RelayState {
  url: string;
  connected: boolean;
  lastError?: string;
}

export interface HostedHealth {
  relays: RelayState[];
  up: number;
  total: number;
  /**
   * `reachable` after any answer or pushed event; `unreachable` after a call timed out; `unpaired` when
   * the daemon answered "this device is not paired" (removed in Settings → Devices, or never confirmed):
   * show "Pair again".
   */
  daemon: 'unknown' | 'reachable' | 'unreachable' | 'unpaired';
  /** ms epoch of the daemon's last answer/event. */
  daemonSeenAt?: number;
  /** Requests waiting for a connection. */
  queued: number;
  /** The key this browser signs with (npub), once loaded. */
  identity?: { kind: HostedIdentity['kind']; npub: string };
  daemonNpub: string;
  /** Why the transport cannot work at all (e.g. the NIP-07 extension disappeared). */
  error?: string;
}

export interface NostrTransportOptions {
  /** Daemon control pubkey (hex or npub accepted by the control client). */
  daemonPubkey: string;
  relays: string[];
  /** The signing identity, or a loader (device key from IndexedDB, NIP-07 extension…). */
  identity: HostedIdentity | (() => Promise<HostedIdentity>);
  /** Per-call timeout once the request is on a relay (default 20 s). */
  timeoutMs?: number;
  /** How long a request may wait for a connection (default 30 s). */
  queueTimeoutMs?: number;
  /** Max queued requests; beyond that new calls fail fast (default 200). */
  maxQueue?: number;
  WebSocket?: WebSocketCtor;
  /** Relay reconnect backoff (default 1 s → 30 s). */
  backoff?: { initialMs?: number; maxMs?: number };
  connectTimeoutMs?: number;
  /** Relay health poll interval (default 1 s). */
  pollMs?: number;
  /** Browser online state (default navigator.onLine). */
  isOnline?: () => boolean;
  onStatus?: (s: ConnectionStatus) => void;
  onHealth?: (h: HostedHealth) => void;
  now?: () => number;
}

export interface NostrTransport extends Transport {
  subscribe(fn: (e: ServerEvent) => void): () => void;
  close(): void;
  status(): ConnectionStatus;
  health(): HostedHealth;
  onHealth(fn: (h: HostedHealth) => void): () => void;
  /** Reconnect every relay now (also done on the browser `online` event). */
  reconnect(): void;
}

interface Queued {
  method: string;
  params: unknown;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

const transportError = (code: string, message: string) => new RpcError(-32000, message, { code });

/** The control server's answer to a key that is not on its allowlist. */
export const isUnpairedError = (e: unknown): boolean => {
  const x = e as { message?: string; data?: { code?: string } } | undefined;
  return x?.data?.code === 'unauthorized' && /not paired/i.test(x.message ?? '');
};

const toNpub = (pk: string) => (/^[0-9a-f]{64}$/i.test(pk) ? npubEncode(pk.toLowerCase()) : pk);

export const nostrTransport = (opts: NostrTransportOptions): NostrTransport => {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const queueTimeoutMs = opts.queueTimeoutMs ?? 30_000;
  const maxQueue = opts.maxQueue ?? 200;
  const now = opts.now ?? Date.now;
  const isOnline =
    opts.isOnline ?? (() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));

  const pool = new RelayPool({
    relays: opts.relays,
    WebSocket: opts.WebSocket,
    backoff: { initialMs: 1000, maxMs: 30_000, ...opts.backoff },
    connectTimeoutMs: opts.connectTimeoutMs ?? 8000,
  });
  const relayUrls = opts.relays.map((r) => pool.addRelay(r));

  let client: ControlClient | undefined;
  /** The response subscription is live: control events are ephemeral, so never publish before it. */
  let ready = false;
  let closed = false;
  let everOpen = false;
  let status: ConnectionStatus = 'connecting';
  const queue: Queued[] = [];
  const listeners = new Set<(e: ServerEvent) => void>();
  const healthListeners = new Set<(h: HostedHealth) => void>();
  let health: HostedHealth = {
    relays: relayUrls.map((url) => ({ url, connected: false })),
    up: 0,
    total: relayUrls.length,
    daemon: 'unknown',
    queued: 0,
    daemonNpub: toNpub(opts.daemonPubkey),
  };

  const emitHealth = (patch: Partial<HostedHealth>) => {
    const next = { ...health, ...patch, queued: queue.length };
    if (JSON.stringify(next) === JSON.stringify(health)) return;
    health = next;
    opts.onHealth?.(health);
    for (const fn of healthListeners) fn(health);
  };

  const setStatus = (s: ConnectionStatus) => {
    if (s === status) return;
    status = s;
    opts.onStatus?.(s);
  };

  const seen = () => emitHealth({ daemon: 'reachable', daemonSeenAt: now() });

  const computeStatus = () => {
    if (closed || health.error) return setStatus('closed');
    if (!isOnline()) return setStatus(everOpen ? 'closed' : 'connecting');
    if (health.up > 0) {
      everOpen = true;
      return setStatus('open');
    }
    setStatus(everOpen ? 'closed' : 'connecting');
  };

  const canSend = () => !!client && ready && !closed && isOnline() && health.up > 0;

  const send = (q: Queued) => {
    const c = client!;
    c.call(q.method, q.params, timeoutMs).then(
      (v) => {
        seen();
        q.resolve(v);
      },
      (err: unknown) => {
        const e = err as { code?: number; message?: string; data?: unknown };
        if (e.code === -32001) {
          emitHealth({ daemon: 'unreachable' });
          q.reject(transportError('timeout', 'The computer did not answer in time.'));
        } else if (e.code === -32002) {
          q.reject(transportError('unavailable', 'Could not reach any relay.'));
        } else if (e.code === -32003) {
          q.reject(transportError('closed', 'Connection closed.'));
        } else if (typeof e.code === 'number') {
          if (isUnpairedError(e)) emitHealth({ daemon: 'unpaired', daemonSeenAt: now() });
          else seen();
          q.reject(new RpcError(e.code, e.message ?? 'error', e.data));
        } else q.reject(err);
      },
    );
  };

  const flush = () => {
    while (queue.length && canSend()) {
      const q = queue.shift()!;
      clearTimeout(q.timer);
      send(q);
    }
    emitHealth({});
  };

  const poll = () => {
    if (closed) return;
    const st = pool.status();
    const relays = st.map((r) => ({
      url: r.relay,
      connected: r.connected,
      ...(r.lastError ? { lastError: r.lastError } : {}),
    }));
    emitHealth({ relays, up: relays.filter((r) => r.connected).length, total: relays.length });
    computeStatus();
    flush();
  };
  const pollTimer = setInterval(poll, opts.pollMs ?? 1000);

  const onOnline = () => {
    pool.connect().catch(() => {});
    poll();
  };
  const onOffline = () => poll();
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
  }

  const failAll = (err: RpcError) => {
    for (const q of queue.splice(0)) {
      clearTimeout(q.timer);
      q.reject(err);
    }
    emitHealth({});
  };

  void (async () => {
    try {
      const id = typeof opts.identity === 'function' ? await opts.identity() : opts.identity;
      if (closed) return;
      client = id.connect({ daemonPubkey: opts.daemonPubkey, relays: relayUrls, pool, timeoutMs });
      client.onEvent((e) => {
        seen();
        for (const fn of listeners) {
          try {
            fn(e);
          } catch {
            // a listener's bug must not break the transport
          }
        }
      });
      emitHealth({ identity: { kind: id.kind, npub: id.npub } });
      await client.ready();
      ready = true;
      poll();
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      emitHealth({ error: msg });
      computeStatus();
      failAll(transportError('signer_unavailable', msg));
    }
  })();

  return {
    request(method, params) {
      if (closed) return Promise.reject(transportError('closed', 'Connection closed.'));
      if (health.error) return Promise.reject(transportError('signer_unavailable', health.error));
      return new Promise((resolve, reject) => {
        const q: Queued = {
          method,
          params,
          resolve,
          reject,
          timer: setTimeout(() => {
            const i = queue.indexOf(q);
            if (i >= 0) queue.splice(i, 1);
            emitHealth({});
            reject(
              isOnline()
                ? transportError('unavailable', 'No relay is reachable right now.')
                : transportError('offline', 'You are offline.'),
            );
          }, queueTimeoutMs),
        };
        if (canSend()) {
          clearTimeout(q.timer);
          send(q);
          return;
        }
        if (queue.length >= maxQueue) {
          clearTimeout(q.timer);
          reject(transportError('unavailable', 'Too many requests are waiting for a connection.'));
          return;
        }
        queue.push(q);
        emitHealth({});
      });
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(pollTimer);
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('online', onOnline);
        window.removeEventListener('offline', onOffline);
      }
      failAll(transportError('closed', 'Connection closed.'));
      client?.close();
      pool.close();
      setStatus('closed');
    },
    status: () => status,
    health: () => health,
    onHealth(fn) {
      healthListeners.add(fn);
      return () => {
        healthListeners.delete(fn);
      };
    },
    reconnect: onOnline,
  };
};
