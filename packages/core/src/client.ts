import type { Filter } from 'nostr-tools/filter';
import { Kind } from './types.js';
import { RelayPool, DEFAULT_RELAYS, SEARCH_RELAYS } from './relays.js';
import {
  now,
  buildReplyTags,
  buildMentionTags,
  dedupeTags,
} from './events.js';
import { buildProfileContent, parseProfile } from './profile.js';
import { parseContacts, addFollow, removeFollow, buildContactTags } from './contacts.js';
import { parseBookmarks, addBookmark, removeBookmark, buildBookmarkTags } from './bookmarks.js';
import { buildReactionTags, buildRepostTags, buildDeletionTags } from './interactions.js';
import { sealDirectMessage, openGiftWrap, openLegacyDm } from './dms.js';
import type { Signer } from './signer.js';
import type { Subscription } from './relays.js';
import type {
  DirectMessage,
  NostrEvent,
  Profile,
  ProfileMetadata,
  Pubkey,
} from './types.js';
import type { ContactList } from './contacts.js';
import type { BookmarkList } from './bookmarks.js';

export interface ClientOptions {
  readonly signer: Signer;
  readonly pool?: RelayPool;
  readonly relays?: readonly string[];
}

export interface PublishResult {
  readonly event: NostrEvent;
  readonly results: PromiseSettledResult<string>[];
}

/**
 * High-level Nostr client: signs events with the provided Signer and routes
 * them through a RelayPool. Stateless beyond the signer + pool — callers own
 * feed/profile state, which keeps this layer easy to test and reuse.
 */
export class NostrClient {
  readonly #signer: Signer;
  readonly #pool: RelayPool;

  constructor(options: ClientOptions) {
    this.#signer = options.signer;
    this.#pool = options.pool ?? new RelayPool(options.relays ?? DEFAULT_RELAYS);
  }

  get pool(): RelayPool {
    return this.#pool;
  }

  get signer(): Signer {
    return this.#signer;
  }

  get relays(): readonly string[] {
    return this.#pool.relays;
  }

  /** Replace the active relay set used by future subscriptions/publishes. */
  setRelays(relays: readonly string[]): void {
    this.#pool.setRelays(relays);
  }

  pubkey(): Promise<Pubkey> {
    return this.#signer.getPublicKey();
  }

  // ---------- publishing ----------

  /** Publish a kind 1 text note, auto-tagging any `nostr:` mentions. */
  async publishNote(content: string, extraTags: string[][] = []): Promise<PublishResult> {
    const tags = dedupeTags([...buildMentionTags(content), ...extraTags]);
    return this.#signAndPublish({ kind: Kind.Text, created_at: now(), tags, content });
  }

  /** Publish a kind 1 reply to `parent` following NIP-10 threading. */
  async reply(parent: NostrEvent, content: string): Promise<PublishResult> {
    const tags = dedupeTags([...buildReplyTags(parent), ...buildMentionTags(content)]);
    return this.#signAndPublish({ kind: Kind.Text, created_at: now(), tags, content });
  }

  /** Publish a kind 7 "+" reaction (like) to `target`. */
  async like(target: NostrEvent): Promise<PublishResult> {
    return this.#signAndPublish({
      kind: Kind.Reaction,
      created_at: now(),
      tags: buildReactionTags(target),
      content: '+',
    });
  }

  /** Publish a kind 6 repost of `target`. */
  async repost(target: NostrEvent): Promise<PublishResult> {
    return this.#signAndPublish({
      kind: Kind.Repost,
      created_at: now(),
      tags: buildRepostTags(target),
      content: JSON.stringify(target),
    });
  }

  /**
   * Request deletion of one or more of your own events (NIP-09 kind 5). This is
   * a request: relays and clients SHOULD honour it, but deletion isn't guaranteed.
   */
  async deleteEvents(events: readonly NostrEvent[], reason = ''): Promise<PublishResult> {
    return this.#signAndPublish({
      kind: Kind.Deletion,
      created_at: now(),
      tags: buildDeletionTags(events),
      content: reason,
    });
  }

  /** Publish kind 0 profile metadata. */
  async setProfile(metadata: ProfileMetadata): Promise<PublishResult> {
    return this.#signAndPublish({
      kind: Kind.Metadata,
      created_at: now(),
      tags: [],
      content: buildProfileContent(metadata),
    });
  }

  /** Follow a pubkey by updating the kind 3 contact list. */
  async follow(pubkey: Pubkey): Promise<PublishResult> {
    const current = await this.fetchContacts(await this.pubkey());
    return this.#publishContacts(addFollow(current, pubkey), current.content);
  }

  /** Unfollow a pubkey by updating the kind 3 contact list. */
  async unfollow(pubkey: Pubkey): Promise<PublishResult> {
    const current = await this.fetchContacts(await this.pubkey());
    return this.#publishContacts(removeFollow(current, pubkey), current.content);
  }

  async #publishContacts(follows: readonly Pubkey[], content: string): Promise<PublishResult> {
    return this.#signAndPublish({
      kind: Kind.Contacts,
      created_at: now(),
      tags: buildContactTags(follows),
      content,
    });
  }

  /** Bookmark an event id by updating the kind 10003 list. */
  async bookmark(eventId: string): Promise<PublishResult> {
    const current = await this.fetchBookmarks(await this.pubkey());
    return this.#publishBookmarks(addBookmark(current, eventId));
  }

  /** Remove a bookmark by updating the kind 10003 list. */
  async unbookmark(eventId: string): Promise<PublishResult> {
    const current = await this.fetchBookmarks(await this.pubkey());
    return this.#publishBookmarks(removeBookmark(current, eventId));
  }

  async #publishBookmarks(eventIds: readonly string[]): Promise<PublishResult> {
    return this.#signAndPublish({
      kind: Kind.BookmarkList,
      created_at: now(),
      tags: buildBookmarkTags(eventIds),
      content: '',
    });
  }

  /** Encrypt and publish a NIP-17 direct message to one or more recipients. */
  async sendDirectMessage(
    recipients: Pubkey | readonly Pubkey[],
    content: string,
    subject?: string,
  ): Promise<{ rumorId: string; wraps: readonly NostrEvent[] }> {
    const list = Array.isArray(recipients) ? recipients : [recipients as Pubkey];
    const { rumorId, wraps } = await sealDirectMessage(this.#signer, list, content, subject);
    await Promise.all(wraps.map((wrap) => this.#pool.publish(wrap)));
    return { rumorId, wraps };
  }

  async #signAndPublish(template: {
    kind: number;
    created_at: number;
    tags: string[][];
    content: string;
  }): Promise<PublishResult> {
    const event = await this.#signer.signEvent(template);
    const results = await this.#pool.publish(event);
    return { event, results };
  }

  // ---------- reading ----------

  /** Fetch the latest profile (kind 0) for a pubkey. */
  async fetchProfile(pubkey: Pubkey): Promise<Profile | null> {
    const event = await this.#pool.getLatest({ kinds: [Kind.Metadata], authors: [pubkey] });
    return event ? parseProfile(event) : null;
  }

  /** Fetch the latest contact list (kind 3) for a pubkey. */
  async fetchContacts(pubkey: Pubkey): Promise<ContactList> {
    const event = await this.#pool.getLatest({ kinds: [Kind.Contacts], authors: [pubkey] });
    return parseContacts(event);
  }

  /** Fetch the latest bookmark list (kind 10003) for a pubkey. */
  async fetchBookmarks(pubkey: Pubkey): Promise<BookmarkList> {
    const event = await this.#pool.getLatest({ kinds: [Kind.BookmarkList], authors: [pubkey] });
    return parseBookmarks(event);
  }

  /** One-shot fetch of recent text notes matching a filter. */
  async fetchNotes(filter: Filter): Promise<NostrEvent[]> {
    const events = await this.#pool.list([{ kinds: [Kind.Text], ...filter }]);
    return events.sort((a, b) => b.created_at - a.created_at);
  }

  /** Full-text search for notes via NIP-50 search relays. */
  async searchNotes(query: string, limit = 30): Promise<NostrEvent[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const events = await this.#pool.collect(
      { kinds: [Kind.Text], search: trimmed, limit },
      { relays: SEARCH_RELAYS, limit, waitMs: 4000 },
    );
    return events.sort((a, b) => b.created_at - a.created_at).slice(0, limit);
  }

  /** Full-text search for profiles via NIP-50 search relays. */
  async searchProfiles(query: string, limit = 20): Promise<Profile[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    // Kind 0 is replaceable: relays may return several revisions / cross-relay
    // copies per pubkey. Collect a larger pool so the id-based cap doesn't drop
    // distinct people, then dedup to the newest-per-pubkey and slice.
    const poolSize = limit * 4;
    const events = await this.#pool.collect(
      { kinds: [Kind.Metadata], search: trimmed, limit: poolSize },
      { relays: SEARCH_RELAYS, limit: poolSize, waitMs: 4000 },
    );
    const latest = new Map<string, NostrEvent>();
    for (const ev of events) {
      const prev = latest.get(ev.pubkey);
      if (!prev || ev.created_at > prev.created_at) latest.set(ev.pubkey, ev);
    }
    return [...latest.values()]
      .sort((a, b) => b.created_at - a.created_at)
      .map((ev) => parseProfile(ev))
      .filter((p): p is Profile => p !== null)
      .slice(0, limit);
  }

  /** Subscribe to a live feed of text notes (and reposts) from `authors`. */
  subscribeFeed(
    authors: readonly Pubkey[],
    onEvent: (event: NostrEvent) => void,
    options: { limit?: number; since?: number } = {},
  ): Subscription {
    const filter: Filter = { kinds: [Kind.Text, Kind.Repost], limit: options.limit ?? 50 };
    if (authors.length > 0) filter.authors = [...authors];
    if (options.since !== undefined) filter.since = options.since;
    return this.#pool.subscribe([filter], { onEvent });
  }

  /** Subscribe to replies/reactions/reposts referencing the given note ids. */
  subscribeEngagement(noteIds: readonly string[], onEvent: (event: NostrEvent) => void): Subscription {
    return this.#pool.subscribe(
      [{ kinds: [Kind.Text, Kind.Reaction, Kind.Repost], '#e': [...noteIds] }],
      { onEvent },
    );
  }

  /** Subscribe to incoming gift wraps and decrypt them into DirectMessages. */
  subscribeDirectMessages(onMessage: (message: DirectMessage) => void, since?: number): Subscription {
    const seen = new Set<string>();
    let inner: Subscription | undefined;
    let closed = false;

    void this.pubkey().then((self) => {
      if (closed) return;
      inner = this.#pool.subscribe(
        [{ kinds: [Kind.GiftWrap], '#p': [self], ...(since !== undefined ? { since } : {}) }],
        {
          onEvent: (event) => {
            void this.#handleGiftWrap(event, seen, onMessage);
          },
        },
      );
    });

    return {
      close: () => {
        closed = true;
        inner?.close();
      },
    };
  }

  async #handleGiftWrap(
    event: NostrEvent,
    seen: Set<string>,
    onMessage: (message: DirectMessage) => void,
  ): Promise<void> {
    if (seen.has(event.id)) return;
    seen.add(event.id);
    const message = await openGiftWrap(this.#signer, event);
    if (message) onMessage(message);
  }

  /** One-shot fetch + decrypt of direct messages addressed to the signer. */
  async fetchDirectMessages(since?: number): Promise<DirectMessage[]> {
    const self = await this.pubkey();
    const filter: Filter = { kinds: [Kind.GiftWrap], '#p': [self] };
    if (since !== undefined) filter.since = since;
    const wraps = await this.#pool.list([filter]);
    const decrypted = await Promise.all(wraps.map((wrap) => openGiftWrap(this.#signer, wrap)));
    return decrypted
      .filter((m): m is DirectMessage => m !== null)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * Subscribe to legacy (kind 4) encrypted DMs — both received (`#p` = us) and
   * sent (authored by us) — decrypting each into a DirectMessage flagged
   * `legacy: true`. Supported for interop with older clients; the scheme is less
   * secure than gift-wrapped messages.
   */
  subscribeLegacyDirectMessages(onMessage: (message: DirectMessage) => void, since?: number): Subscription {
    const seen = new Set<string>();
    let subs: Subscription[] = [];
    let closed = false;

    void this.pubkey().then((self) => {
      if (closed) return;
      const base = since !== undefined ? { since } : {};
      const handle = (event: NostrEvent): void => {
        void this.#handleLegacyDm(event, self, seen, onMessage);
      };
      // Two separate subscriptions: received (#p) OR sent (authors). They must
      // stay separate — the pool merges multiple filters into a single AND.
      subs = [
        this.#pool.subscribe([{ kinds: [Kind.LegacyDirectMessage], '#p': [self], ...base }], { onEvent: handle }),
        this.#pool.subscribe([{ kinds: [Kind.LegacyDirectMessage], authors: [self], ...base }], { onEvent: handle }),
      ];
    });

    return {
      close: () => {
        closed = true;
        for (const s of subs) s.close();
      },
    };
  }

  async #handleLegacyDm(
    event: NostrEvent,
    self: Pubkey,
    seen: Set<string>,
    onMessage: (message: DirectMessage) => void,
  ): Promise<void> {
    if (seen.has(event.id)) return;
    seen.add(event.id);
    const message = await openLegacyDm(this.#signer, event, self);
    if (message) onMessage(message);
  }

  /** One-shot fetch + decrypt of legacy (kind 4) DMs to/from the signer. */
  async fetchLegacyDirectMessages(since?: number): Promise<DirectMessage[]> {
    const self = await this.pubkey();
    const base = since !== undefined ? { since } : {};
    // Separate queries for received vs sent — merging them would AND the
    // `#p`/`authors` constraints and drop messages from other people.
    const [received, sent] = await Promise.all([
      this.#pool.list([{ kinds: [Kind.LegacyDirectMessage], '#p': [self], ...base }]),
      this.#pool.list([{ kinds: [Kind.LegacyDirectMessage], authors: [self], ...base }]),
    ]);
    const byId = new Map<string, NostrEvent>();
    for (const event of [...received, ...sent]) byId.set(event.id, event);
    const decrypted = await Promise.all([...byId.values()].map((event) => openLegacyDm(this.#signer, event, self)));
    return decrypted
      .filter((m): m is DirectMessage => m !== null)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  destroy(): void {
    this.#pool.destroy();
  }
}
