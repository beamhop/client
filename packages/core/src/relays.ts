import { SimplePool } from 'nostr-tools/pool';
import type { Filter } from 'nostr-tools/filter';
import type { NostrEvent } from './types.js';

/** A sensible default relay set with broad reach and good uptime. */
export const DEFAULT_RELAYS: readonly string[] = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://relay.primal.net',
  'wss://nostr.wine',
];

/** Relays that implement NIP-50 full-text search. */
export const SEARCH_RELAYS: readonly string[] = [
  'wss://relay.nostr.band',
  'wss://relay.noswhere.com',
  'wss://search.nos.today',
];

export interface Subscription {
  /** Stop receiving events and close the underlying relay subscriptions. */
  close(): void;
}

export interface SubscribeHandlers {
  onEvent(event: NostrEvent): void;
  onEose?(): void;
}

/**
 * Thin, typed wrapper around nostr-tools `SimplePool`. Centralizes the relay
 * list so callers subscribe/publish without repeating relay URLs everywhere.
 */
export class RelayPool {
  readonly #pool: SimplePool;
  #relays: string[];

  constructor(relays: readonly string[] = DEFAULT_RELAYS) {
    this.#pool = new SimplePool();
    this.#relays = [...relays];
  }

  get relays(): readonly string[] {
    return this.#relays;
  }

  /** Replace the active relay set used by future subscriptions/publishes. */
  setRelays(relays: readonly string[]): void {
    const next = [...relays];
    // Close sockets for relays that are being dropped to avoid connection leaks.
    const removed = this.#relays.filter((r) => !next.includes(r));
    if (removed.length > 0) this.#pool.close(removed);
    this.#relays = next;
  }

  /** Open a long-lived subscription across all relays. */
  subscribe(filters: Filter[], handlers: SubscribeHandlers, relays?: readonly string[]): Subscription {
    const sub = this.#pool.subscribeMany([...(relays ?? this.#relays)], mergeFilters(filters), {
      onevent: (event: NostrEvent) => handlers.onEvent(event),
      oneose: () => handlers.onEose?.(),
    });
    return { close: () => sub.close() };
  }

  /** One-shot query that resolves to all matching events after EOSE. */
  async list(filters: Filter[], relays?: readonly string[]): Promise<NostrEvent[]> {
    return this.#pool.querySync([...(relays ?? this.#relays)], mergeFilters(filters), {
      maxWait: 4000,
    });
  }

  /**
   * Collect events over a fixed time window (for NIP-50 search and similar,
   * where relays may stream results after EOSE). Unlike `list`, it does not
   * stop at EOSE — it waits `waitMs` (or until `limit` events arrive).
   */
  async collect(
    filter: Filter,
    options: { relays?: readonly string[]; waitMs?: number; limit?: number } = {},
  ): Promise<NostrEvent[]> {
    const waitMs = options.waitMs ?? 4000;
    const limit = options.limit ?? 50;
    const seen = new Map<string, NostrEvent>();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        sub.close();
        clearTimeout(timer);
        resolve([...seen.values()]);
      };
      const sub = this.#pool.subscribeMany([...(options.relays ?? this.#relays)], filter, {
        onevent: (event: NostrEvent) => {
          seen.set(event.id, event);
          if (seen.size >= limit) finish();
        },
        // Resolve early if every relay closes (e.g. all connections failed),
        // instead of always waiting out the full timeout.
        onclose: () => finish(),
      });
      const timer = setTimeout(finish, waitMs);
    });
  }

  /** Fetch the single newest event matching a filter, or null. */
  async getLatest(filter: Filter, relays?: readonly string[]): Promise<NostrEvent | null> {
    const event = await this.#pool.get([...(relays ?? this.#relays)], filter, { maxWait: 4000 });
    return event ?? null;
  }

  /** Publish an event to all relays; resolves with per-relay results. */
  async publish(event: NostrEvent, relays?: readonly string[]): Promise<PromiseSettledResult<string>[]> {
    const promises = this.#pool.publish([...(relays ?? this.#relays)], event);
    return Promise.allSettled(promises);
  }

  /** Close all relay connections. */
  destroy(): void {
    this.#pool.close([...this.#relays]);
  }
}

/**
 * querySync takes a single filter; when callers pass multiple we merge by
 * unioning kinds/authors so a single round-trip covers them.
 */
function mergeFilters(filters: Filter[]): Filter {
  if (filters.length === 1) return filters[0] as Filter;
  const merged: Filter = {};
  for (const f of filters) {
    for (const [key, value] of Object.entries(f)) {
      if (Array.isArray(value)) {
        const existing = (merged as Record<string, unknown[]>)[key] ?? [];
        (merged as Record<string, unknown[]>)[key] = [...new Set([...existing, ...value])];
      } else {
        (merged as Record<string, unknown>)[key] = value;
      }
    }
  }
  return merged;
}
