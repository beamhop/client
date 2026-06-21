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
  // NIP-09: client-side deletion registry. Persists for the session so that
  // relay results (from relays that don't honour deletion) are filtered out.
  private deletedIds = new Set<string>();          // specific event IDs (e tags)
  private deletedAddrs = new Set<string>();        // "kind:pubkey:d-tag" (a tags)

  /** One-shot query: collect events matching a filter until EOSE, deduped by id. */
  async list(relays: string[], filter: Filter): Promise<NostrEvent[]> {
    const relayEvents = relays.length === 0
      ? []
      : await this.pool.querySync(relays, filter, { maxWait: 4000 });
    const events = dedupe([...relayEvents, ...this.localMatching(filter)])
      .filter((ev) => !this.isDeleted(ev))
      .sort((a, b) => b.created_at - a.created_at);
    return typeof filter.limit === "number" ? events.slice(0, filter.limit) : events;
  }

  /** Fetch the single newest event matching a filter (e.g. a profile). */
  async get(relays: string[], filter: Filter): Promise<NostrEvent | null> {
    const relayEvent = relays.length === 0
      ? null
      : await this.pool.get(relays, filter, { maxWait: 4000 });
    return [relayEvent, ...this.localMatching(filter)]
      .filter((event): event is NostrEvent => event !== null && !this.isDeleted(event))
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
        if (!this.isDeleted(event)) onEvent(event);
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
    if (event.kind === 5) this.recordDeletion(event.tags);
    if (this.localEvents.size > 500) {
      const oldest = this.localEvents.keys().next().value
      if (oldest !== undefined) this.localEvents.delete(oldest)
    }
    return event;
  }

  close(relays: string[]): void {
    this.pool.close(relays);
  }

  destroy(): void {
    this.pool.destroy()
  }

  private isDeleted(event: NostrEvent): boolean {
    if (this.deletedIds.has(event.id)) return true;
    const dTag = event.tags.find((t) => t[0] === "d")?.[1];
    if (dTag !== undefined && this.deletedAddrs.has(`${event.kind}:${event.pubkey}:${dTag}`)) return true;
    return false;
  }

  // Register deleted event IDs and addresses, and evict from localEvents.
  private recordDeletion(tags: string[][]): void {
    for (const tag of tags) {
      const tagName = tag[0];
      const val = tag[1];
      if (!tagName || !val) continue;
      if (tagName === "e") {
        this.deletedIds.add(val);
        this.localEvents.delete(val);
      } else if (tagName === "a") {
        this.deletedAddrs.add(val);
        // evict matching addressable events from localEvents
        const sep0 = val.indexOf(":");
        const sep1 = val.indexOf(":", sep0 + 1);
        if (sep0 < 0 || sep1 < 0) continue;
        const kind = Number(val.slice(0, sep0));
        const pubkey = val.slice(sep0 + 1, sep1);
        const dTag = val.slice(sep1 + 1);
        for (const [id, ev] of this.localEvents) {
          if (ev.kind === kind && ev.pubkey === pubkey && ev.tags.some((t) => t[0] === "d" && t[1] === dTag)) {
            this.localEvents.delete(id);
          }
        }
      }
    }
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
