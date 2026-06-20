import { SimplePool } from "nostr-tools";
import type { Filter, Event as NostrEvent } from "nostr-tools";
import type { Identity } from "./keys.ts";
import { signWith } from "./keys.ts";
import type { EventTemplate } from "nostr-tools";

/**
 * Thin wrapper over nostr-tools SimplePool: one place to query, subscribe, and
 * publish. Local-first in spirit — publishing fans out to every write relay and
 * resolves as soon as any relay accepts.
 */
export class NostrClient {
  private pool = new SimplePool();

  /** One-shot query: collect events matching a filter until EOSE, deduped by id. */
  async list(relays: string[], filter: Filter): Promise<NostrEvent[]> {
    if (relays.length === 0) return [];
    const events = await this.pool.querySync(relays, filter, { maxWait: 4000 });
    return dedupe(events).sort((a, b) => b.created_at - a.created_at);
  }

  /** Fetch the single newest event matching a filter (e.g. a profile). */
  async get(relays: string[], filter: Filter): Promise<NostrEvent | null> {
    if (relays.length === 0) return null;
    return this.pool.get(relays, filter, { maxWait: 4000 });
  }

  /** Live subscription. Returns an unsubscribe function. */
  subscribe(
    relays: string[],
    filter: Filter,
    onEvent: (event: NostrEvent) => void,
    onEose?: () => void,
  ): () => void {
    if (relays.length === 0) return () => {};
    const seen = new Set<string>();
    const sub = this.pool.subscribeMany(relays, filter, {
      onevent: (event) => {
        if (seen.has(event.id)) return;
        seen.add(event.id);
        onEvent(event);
      },
      oneose: () => onEose?.(),
    });
    return () => sub.close();
  }

  /** Sign with the active identity and publish to all write relays. */
  async publish(
    relays: string[],
    identity: Identity,
    template: EventTemplate,
  ): Promise<NostrEvent> {
    const event = await signWith(identity, template);
    const results = this.pool.publish(relays, event);
    // Resolve once at least one relay accepts; ignore the rest (best-effort fan-out).
    await Promise.any(results).catch(() => {
      throw new Error("No relay accepted the event");
    });
    return event;
  }

  close(relays: string[]): void {
    this.pool.close(relays);
  }
}

const dedupe = (events: NostrEvent[]): NostrEvent[] => {
  const byId = new Map<string, NostrEvent>();
  for (const e of events) if (!byId.has(e.id)) byId.set(e.id, e);
  return [...byId.values()];
};

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);
