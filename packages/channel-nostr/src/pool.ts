// Browser-compatible relay pool: no node-only imports in this file.
import type { Logger } from '@beamhop/core';
import { AbstractRelay, type Subscription } from 'nostr-tools/abstract-relay';
import type { Event, EventTemplate, VerifiedEvent } from 'nostr-tools/core';
import type { Filter } from 'nostr-tools/filter';
import { verifyEvent } from 'nostr-tools/pure';
import { normalizeURL } from 'nostr-tools/utils';
import { SeenSet } from './lru.ts';

/** Minimal WebSocket constructor shape (browser WebSocket, Node 22 global, or `ws`). */
// biome-ignore lint/suspicious/noExplicitAny: WebSocket implementations differ in constructor typing.
export type WebSocketCtor = any;

export interface RelayPoolOptions {
  relays: string[];
  /** WebSocket implementation. Defaults to globalThis.WebSocket. */
  WebSocket?: WebSocketCtor;
  log?: Logger;
  /** NIP-42 signer. When set, the pool answers AUTH challenges. */
  signAuth?: (t: EventTemplate) => Promise<VerifiedEvent> | VerifiedEvent;
  /** Reconnect backoff. */
  backoff?: { initialMs?: number; maxMs?: number };
  connectTimeoutMs?: number;
  publishTimeoutMs?: number;
  /** Max ids remembered per subscription for de-duplication. */
  seenMax?: number;
  /** Enable websocket ping keepalive (default true). */
  ping?: boolean;
}

export interface PoolSubHandlers {
  onevent: (ev: Event, relay: string) => void;
  /** Called once, when every target relay has sent EOSE (or failed). */
  oneose?: () => void;
  /** Relay closed this subscription (non-auth reason). */
  onclosed?: (relay: string, reason: string) => void;
}

export interface PoolSub {
  close(): void;
}

export interface PublishResult {
  id: string;
  ok: string[];
  failed: { relay: string; reason: string }[];
}

interface PoolSubscription {
  id: number;
  filters: Filter[];
  relays: Set<string>;
  handlers: PoolSubHandlers;
  seen: SeenSet;
  eosed: Set<string>;
  eoseFired: boolean;
  live: Map<string, Subscription>;
  closed: boolean;
}

const guardedCache = new WeakMap<object, WebSocketCtor>();
/**
 * nostr-tools calls ws.close() from inside onerror; with undici's WebSocket (Node 22 global)
 * that re-enters onerror and recurses until the stack overflows. Make close() idempotent.
 */
const guardWebSocket = (Impl: WebSocketCtor): WebSocketCtor => {
  const hit = guardedCache.get(Impl);
  if (hit) return hit;
  const Guarded = class extends Impl {
    #closing = false;
    close(...args: unknown[]) {
      if (this.#closing) return;
      this.#closing = true;
      return super.close(...args);
    }
  };
  guardedCache.set(Impl, Guarded);
  return Guarded;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class ManagedRelay {
  relay: AbstractRelay | undefined;
  connecting: Promise<AbstractRelay> | undefined;
  attempts = 0;
  timer: ReturnType<typeof setTimeout> | undefined;
  closed = false;
  lastError: string | undefined;

  constructor(
    readonly url: string,
    private readonly pool: RelayPool,
  ) {}

  get connected(): boolean {
    return !!this.relay?.connected;
  }

  /** Connect (or return the live connection). Rejects on failure but keeps retrying in the background. */
  ensure(): Promise<AbstractRelay> {
    if (this.closed) return Promise.reject(new Error('relay closed'));
    if (this.relay?.connected) return Promise.resolve(this.relay);
    if (this.connecting) return this.connecting;
    const p = this.open();
    this.connecting = p;
    p.then(
      () => {
        this.connecting = undefined;
      },
      () => {
        this.connecting = undefined;
      },
    );
    return p;
  }

  private async open(): Promise<AbstractRelay> {
    const opts = this.pool.opts;
    const relay = new AbstractRelay(this.url, {
      verifyEvent: (e: Event) => verifyEvent(cleanEvent(e)),
      websocketImplementation: guardWebSocket(
        opts.WebSocket ?? (globalThis as { WebSocket?: unknown }).WebSocket,
      ),
      enablePing: opts.ping ?? true,
      enableReconnect: false,
    });
    relay.publishTimeout = opts.publishTimeoutMs ?? 8000;
    relay.onnotice = (msg) => this.pool.log?.debug('relay notice', { relay: this.url, msg });
    if (opts.signAuth) relay.onauth = async (t) => opts.signAuth!(t);
    relay.onclose = () => {
      if (this.relay === relay) this.relay = undefined;
      if (!this.closed) {
        this.pool.log?.info('relay disconnected', { relay: this.url });
        this.scheduleReconnect();
      }
    };
    try {
      await relay.connect({ timeout: opts.connectTimeoutMs ?? 8000 });
    } catch (err) {
      relay.onclose = null;
      this.lastError = String(err);
      this.pool.log?.debug('relay connect failed', { relay: this.url, error: this.lastError });
      this.scheduleReconnect();
      throw new Error(`connect ${this.url}: ${this.lastError}`);
    }
    if (this.closed) {
      relay.onclose = null;
      relay.close();
      throw new Error('relay closed');
    }
    this.relay = relay;
    this.attempts = 0;
    this.lastError = undefined;
    this.pool.log?.debug('relay connected', { relay: this.url });
    this.pool.onRelayConnected(this);
    return relay;
  }

  scheduleReconnect(): void {
    if (this.closed || this.timer) return;
    const { initialMs = 1000, maxMs = 60_000 } = this.pool.opts.backoff ?? {};
    const base = Math.min(maxMs, initialMs * 2 ** this.attempts);
    const delay = Math.round(base * (0.75 + Math.random() * 0.5));
    this.attempts++;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      // Only reconnect if something still needs this relay.
      if (!this.closed) this.ensure().catch(() => {});
    }, delay);
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const r = this.relay;
    this.relay = undefined;
    if (r) {
      r.onclose = null;
      try {
        r.close();
      } catch {
        // ignore
      }
    }
  }
}

/** Strip non-NIP-01 fields so verification sees a clean event object. */
const cleanEvent = (e: Event): Event => ({
  id: e.id,
  pubkey: e.pubkey,
  created_at: e.created_at,
  kind: e.kind,
  tags: e.tags,
  content: e.content,
  sig: e.sig,
});

/**
 * Multi-relay pool: reconnect with exponential backoff + jitter, resubscribe on reconnect,
 * per-subscription de-duplication by event id, NIP-42 auth, publish fan-out.
 */
export class RelayPool {
  readonly relays = new Map<string, ManagedRelay>();
  private readonly subs = new Map<number, PoolSubscription>();
  private nextSubId = 1;
  readonly log: Logger | undefined;
  private closed = false;

  constructor(readonly opts: RelayPoolOptions) {
    this.log = opts.log;
    for (const r of opts.relays) this.addRelay(r);
  }

  static normalize(url: string): string {
    return normalizeURL(url);
  }

  addRelay(url: string): string {
    const u = normalizeURL(url);
    if (!this.relays.has(u)) this.relays.set(u, new ManagedRelay(u, this));
    return u;
  }

  get relayUrls(): string[] {
    return [...this.relays.keys()];
  }

  status(): { relay: string; connected: boolean; attempts: number; lastError?: string }[] {
    return [...this.relays.values()].map((m) => ({
      relay: m.url,
      connected: m.connected,
      attempts: m.attempts,
      ...(m.lastError ? { lastError: m.lastError } : {}),
    }));
  }

  /** Connect to all relays; resolves once at least one is up (or all failed). */
  async connect(): Promise<{ connected: string[]; failed: string[] }> {
    const res = await Promise.allSettled([...this.relays.values()].map((m) => m.ensure()));
    const urls = [...this.relays.keys()];
    return {
      connected: urls.filter((_, i) => res[i]?.status === 'fulfilled'),
      failed: urls.filter((_, i) => res[i]?.status === 'rejected'),
    };
  }

  /** @internal */
  onRelayConnected(m: ManagedRelay): void {
    for (const sub of this.subs.values()) {
      if (!sub.closed && sub.relays.has(m.url)) this.openOn(sub, m);
    }
  }

  private openOn(sub: PoolSubscription, m: ManagedRelay): void {
    const relay = m.relay;
    if (!relay?.connected) return;
    sub.live.get(m.url)?.close();
    const markEose = () => {
      sub.eosed.add(m.url);
      this.maybeEose(sub);
    };
    const s = relay.subscribe(sub.filters, {
      onevent: (ev) => {
        if (sub.closed) return;
        if (!sub.seen.add(ev.id)) return;
        try {
          sub.handlers.onevent(ev, m.url);
        } catch (err) {
          this.log?.error('subscription handler threw', { error: String(err) });
        }
      },
      alreadyHaveEvent: (id) => sub.seen.has(id),
      oneose: markEose,
      onclose: (reason) => {
        if (sub.closed) return;
        if (sub.live.get(m.url) === s) sub.live.delete(m.url);
        if (reason.startsWith('auth-required') && this.opts.signAuth && relay.connected) {
          relay
            .auth(async (t) => this.opts.signAuth!(t))
            .then(() => this.openOn(sub, m))
            .catch((err) => this.log?.warn('relay auth failed', { relay: m.url, error: String(err) }));
          return;
        }
        markEose();
        if (relay.connected) sub.handlers.onclosed?.(m.url, reason);
      },
    });
    sub.live.set(m.url, s);
  }

  private maybeEose(sub: PoolSubscription): void {
    if (sub.eoseFired) return;
    for (const r of sub.relays) if (!sub.eosed.has(r)) return;
    sub.eoseFired = true;
    sub.handlers.oneose?.();
  }

  subscribe(filters: Filter[], handlers: PoolSubHandlers, opts: { relays?: string[] } = {}): PoolSub {
    if (this.closed) throw new Error('pool closed');
    const relays = new Set((opts.relays ?? this.relayUrls).map((r) => this.addRelay(r)));
    const sub: PoolSubscription = {
      id: this.nextSubId++,
      filters,
      relays,
      handlers,
      seen: new SeenSet(this.opts.seenMax ?? 5000),
      eosed: new Set(),
      eoseFired: false,
      live: new Map(),
      closed: false,
    };
    this.subs.set(sub.id, sub);
    for (const url of relays) {
      const m = this.relays.get(url)!;
      if (m.connected) this.openOn(sub, m);
      else
        m.ensure().catch(() => {
          // count a failed relay as EOSE'd so one-shot queries do not hang
          sub.eosed.add(url);
          this.maybeEose(sub);
        });
    }
    return {
      close: () => {
        if (sub.closed) return;
        sub.closed = true;
        this.subs.delete(sub.id);
        for (const s of sub.live.values()) {
          try {
            s.close();
          } catch {
            // ignore
          }
        }
        sub.live.clear();
      },
    };
  }

  /** One-shot query: collect events until all relays EOSE or the timeout passes. */
  query(filters: Filter[], opts: { relays?: string[]; timeoutMs?: number } = {}): Promise<Event[]> {
    return new Promise((resolve) => {
      const out: Event[] = [];
      let done = false;
      let sub: PoolSub | undefined;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        sub?.close();
        resolve(out);
      };
      const timer = setTimeout(finish, opts.timeoutMs ?? 8000);
      sub = this.subscribe(filters, { onevent: (ev) => out.push(ev), oneose: finish }, opts);
      if (done) sub.close();
    });
  }

  /** Publish to relays (default: all). Resolves with per-relay results; never rejects. */
  /**
   * Publish to relays (default: all). Never rejects.
   * With `quorum`, resolves as soon as that many relays accepted the event (the rest finish in the
   * background); otherwise waits for every relay.
   */
  publish(event: Event, opts: { relays?: string[]; quorum?: number } = {}): Promise<PublishResult> {
    const urls = (opts.relays ?? this.relayUrls).map((r) => this.addRelay(r));
    const res: PublishResult = { id: event.id, ok: [], failed: [] };
    const snapshot = (): PublishResult => ({ id: res.id, ok: [...res.ok], failed: [...res.failed] });
    return new Promise((resolve) => {
      let pending = urls.length;
      let done = false;
      const settle = () => {
        if (done) return;
        if ((opts.quorum && res.ok.length >= opts.quorum) || pending === 0) {
          done = true;
          if (!res.ok.length)
            this.log?.warn('publish failed on all relays', { kind: event.kind, failed: res.failed });
          resolve(snapshot());
        }
      };
      if (!urls.length) settle();
      for (const u of urls) {
        this.publishOne(u, event).then((r) => {
          pending--;
          if (r === true) res.ok.push(u);
          else res.failed.push({ relay: u, reason: r });
          settle();
        });
      }
    });
  }

  private async publishOne(url: string, event: Event): Promise<true | string> {
    const m = this.relays.get(url)!;
    let relay: AbstractRelay;
    try {
      relay = await m.ensure();
    } catch (err) {
      return String((err as Error).message ?? err);
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await relay.publish(event);
        return true;
      } catch (err) {
        const msg = String((err as Error).message ?? err);
        if (attempt === 0 && msg.startsWith('auth-required') && this.opts.signAuth) {
          try {
            // A challenge may arrive slightly after the rejection.
            await sleep(50);
            await relay.auth(async (t) => this.opts.signAuth!(t));
            continue;
          } catch (authErr) {
            return `${msg} (auth failed: ${String(authErr)})`;
          }
        }
        return msg;
      }
    }
    return 'publish failed';
  }

  close(): void {
    this.closed = true;
    for (const sub of this.subs.values()) sub.closed = true;
    this.subs.clear();
    for (const m of this.relays.values()) m.close();
  }
}
