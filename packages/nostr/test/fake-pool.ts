import type { Filter, Event as NostrEvent } from "nostr-tools";
import { NostrClient } from "../src/client.ts";

export class FakePool {
  readonly published: NostrEvent[] = [];
  readonly closed: string[][] = [];
  publishAccepts = true;
  querySyncResult: NostrEvent[] = [];
  queryResolver: ((filter: Filter) => NostrEvent[]) | null = null;
  getResult: NostrEvent | null = null;
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
    return { close: () => { sub.closed = true; } };
  }

  close(relays: string[]): void {
    this.closed.push(relays);
  }

  emit(event: NostrEvent): void {
    for (const sub of this.subs) if (!sub.closed) sub.onevent?.(event);
  }

  eose(): void {
    for (const sub of this.subs) if (!sub.closed) sub.oneose?.();
  }

  get openSubscriptions(): number {
    return this.subs.filter((s) => !s.closed).length;
  }
}

export const clientWithFakePool = (): { client: NostrClient; pool: FakePool } => {
  const client = new NostrClient();
  const pool = new FakePool();
  (client as unknown as { pool: FakePool }).pool = pool;
  return { client, pool };
};
