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
  private localEvents = new Map<string, NostrEvent>();

  /** One-shot query: collect events matching a filter until EOSE, deduped by id. */
  async list(relays: string[], filter: Filter): Promise<NostrEvent[]> {
    const relayEvents = relays.length === 0
      ? []
      : await this.pool.querySync(relays, filter, { maxWait: 4000 });
    const events = dedupe([...relayEvents, ...this.localMatching(filter)])
      .sort((a, b) => b.created_at - a.created_at);
    return typeof filter.limit === "number" ? events.slice(0, filter.limit) : events;
  }

  /** Fetch the single newest event matching a filter (e.g. a profile). */
  async get(relays: string[], filter: Filter): Promise<NostrEvent | null> {
    const relayEvent = relays.length === 0
      ? null
      : await this.pool.get(relays, filter, { maxWait: 4000 });
    return [relayEvent, ...this.localMatching(filter)]
      .filter((event): event is NostrEvent => event !== null)
      .sort((a, b) => b.created_at - a.created_at)[0] ?? null;
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
    this.localEvents.set(event.id, event);
    return event;
  }

  close(relays: string[]): void {
    this.pool.close(relays);
  }

  private localMatching(filter: Filter): NostrEvent[] {
    return [...this.localEvents.values()].filter((event) => matchesFilter(event, filter));
  }
}

const dedupe = (events: NostrEvent[]): NostrEvent[] => {
  const byId = new Map<string, NostrEvent>();
  for (const e of events) if (!byId.has(e.id)) byId.set(e.id, e);
  return [...byId.values()];
};

const matchesPrefix = (values: string[] | undefined, candidate: string): boolean => {
  if (values === undefined) return true;
  return values.some((value) => candidate.startsWith(value));
};

const matchesFilter = (event: NostrEvent, filter: Filter): boolean => {
  if (!matchesPrefix(filter.ids, event.id)) return false;
  if (filter.kinds !== undefined && !filter.kinds.includes(event.kind)) return false;
  if (!matchesPrefix(filter.authors, event.pubkey)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  if (filter.until !== undefined && event.created_at > filter.until) return false;
  if (filter.search !== undefined && !event.content.toLowerCase().includes(filter.search.toLowerCase())) {
    return false;
  }

  for (const [key, rawValues] of Object.entries(filter)) {
    if (!key.startsWith("#")) continue;
    const values = Array.isArray(rawValues)
      ? rawValues.filter((value): value is string => typeof value === "string")
      : [];
    if (values.length === 0) return false;
    const tagName = key.slice(1);
    const hasTag = event.tags.some((tag) => tag[0] === tagName && tag[1] !== undefined && values.includes(tag[1]));
    if (!hasTag) return false;
  }

  return true;
};

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);
