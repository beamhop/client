import type { Filter, Event as NostrEvent } from "nostr-tools";
import { NostrClient } from "@beamhop/nostr";

/**
 * A controllable stand-in for nostr-tools' `SimplePool`. It implements only the
 * surface `NostrClient` touches (`publish`/`querySync`/`get`/`subscribeMany`/
 * `close`) so tests can drive relay traffic deterministically — no network.
 *
 * This mirrors the seam the repo already uses (see `client.test.ts`): the network
 * boundary is the only thing faked; all business logic runs for real.
 */
export class FakePool {
  /** Events handed to `publish`, in order. */
  readonly published: NostrEvent[] = [];
  /** Relay URLs closed via `close`. */
  readonly closed: string[][] = [];
  /** When false, every relay rejects a publish (simulates total failure). */
  publishAccepts = true;
  /** Canned results returned by `querySync` (used when `queryResolver` is unset). */
  querySyncResult: NostrEvent[] = [];
  /** Per-filter resolver for `querySync`, when different filters need different results. */
  queryResolver: ((filter: Filter) => NostrEvent[]) | null = null;
  /** Canned result returned by `get` (used when `getResolver` is unset). */
  getResult: NostrEvent | null = null;
  /** Per-filter resolver for `get`. */
  getResolver: ((filter: Filter) => NostrEvent | null) | null = null;

  private subs: Array<{
    filter: Filter;
    onevent?: (event: NostrEvent) => void;
    oneose?: () => void;
    closed: boolean;
  }> = [];

  publish(relays: string[], event: NostrEvent): Promise<string>[] {
    this.published.push(event);
    return relays.map((url) =>
      this.publishAccepts ? Promise.resolve(url) : Promise.reject(new Error("rejected")),
    );
  }

  async querySync(_relays: string[], filter: Filter): Promise<NostrEvent[]> {
    return this.queryResolver ? this.queryResolver(filter) : this.querySyncResult;
  }

  async get(_relays: string[], filter: Filter): Promise<NostrEvent | null> {
    return this.getResolver ? this.getResolver(filter) : this.getResult;
  }

  subscribeMany(
    _relays: string[],
    filter: Filter,
    handlers: { onevent?: (event: NostrEvent) => void; oneose?: () => void },
  ): { close: () => void } {
    const sub = { filter, ...handlers, closed: false };
    this.subs.push(sub);
    return {
      close: () => {
        sub.closed = true;
      },
    };
  }

  close(relays: string[]): void {
    this.closed.push(relays);
  }

  // ---- test drivers ----

  /** Deliver an event to every open subscription. */
  emit(event: NostrEvent): void {
    for (const sub of this.subs) if (!sub.closed) sub.onevent?.(event);
  }

  /** Signal end-of-stored-events to every open subscription. */
  eose(): void {
    for (const sub of this.subs) if (!sub.closed) sub.oneose?.();
  }

  /** Number of subscriptions still open. */
  get openSubscriptions(): number {
    return this.subs.filter((s) => !s.closed).length;
  }
}

/** Build a `NostrClient` wired to a fresh `FakePool`, returning both. */
export const clientWithFakePool = (): { client: NostrClient; pool: FakePool } => {
  const client = new NostrClient();
  const pool = new FakePool();
  (client as unknown as { pool: FakePool }).pool = pool;
  return { client, pool };
};
