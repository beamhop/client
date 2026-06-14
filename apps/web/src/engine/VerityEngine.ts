import {
  NostrClient,
  RelayPool,
  parseProfile,
  parseContacts,
  parseBookmarks,
  reactionTargetId,
  repostTargetId,
  isLike,
  emptyEngagement,
  conversationPeer,
  encodeNpub,
  Kind,
  type NostrEvent,
  type Profile,
  type EngagementCounts,
  type DirectMessage,
  type Pubkey,
} from '@beamhop/core';
import type { Session } from '../lib/session.js';
import { loadReadState, saveReadState, saveRelays } from '../lib/session.js';
import { loadAudit, appendAudit, type AuditEntry, type AuditType } from '../lib/audit.js';
import type { Conversation, EngineSettings, EngineState, FeedItem } from './types.js';

const SETTINGS_KEY = 'verity:settings';

function loadSettings(): EngineSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<EngineSettings>;
      return { hardware: !!parsed.hardware, delegation: !!parsed.delegation };
    }
  } catch {
    // ignore
  }
  return { hardware: false, delegation: false };
}

/**
 * Owns the NostrClient, its live subscriptions, and an in-memory store that it
 * exposes to React as an immutable snapshot (via subscribe/getSnapshot, for
 * useSyncExternalStore). All Nostr side effects flow through here.
 */
export class VerityEngine {
  readonly #client: NostrClient;
  readonly #session: Session;
  readonly #pubkey: Pubkey;
  readonly #npub: string;

  readonly #listeners = new Set<() => void>();
  readonly #subs: Array<{ close(): void }> = [];

  readonly #profiles = new Map<string, Profile>();
  readonly #notes = new Map<string, NostrEvent>();
  readonly #reposts = new Map<string, string>(); // noteId -> reposterPubkey (latest)
  readonly #repostAt = new Map<string, number>(); // noteId -> repost created_at
  readonly #engagement = new Map<string, EngagementCounts>();
  readonly #countedEngagement = new Set<string>();
  readonly #liked = new Set<string>();
  readonly #reposted = new Set<string>();
  readonly #bookmarked = new Set<string>();
  readonly #deleted = new Set<string>(); // ids of notes we've requested deletion for
  readonly #messages = new Map<string, DirectMessage>();
  readonly #lastRead = new Map<string, number>(); // peer -> last-read unix ts
  readonly #pendingProfiles = new Set<string>();

  #follows: string[] = [];
  #audit: AuditEntry[];
  #settings: EngineSettings;
  #relays: string[];
  #loadingFeed = true;

  #feedSub: { close(): void } | undefined;
  #dmSub: { close(): void } | undefined;
  #legacyDmSub: { close(): void } | undefined;
  #engagementSub: { close(): void } | undefined;
  #engagementTimer: ReturnType<typeof setTimeout> | undefined;
  #profileTimer: ReturnType<typeof setTimeout> | undefined;
  #loadingTimer: ReturnType<typeof setTimeout> | undefined;
  #destroyed = false;
  #snapshot: EngineState;

  private constructor(session: Session, pubkey: Pubkey, npub: string, client: NostrClient) {
    this.#session = session;
    this.#pubkey = pubkey;
    this.#npub = npub;
    this.#client = client;
    this.#relays = [...client.pool.relays];
    this.#settings = loadSettings();
    this.#audit = loadAudit(pubkey);
    for (const [peer, ts] of Object.entries(loadReadState(pubkey))) {
      if (typeof ts === 'number') this.#lastRead.set(peer, ts);
    }
    this.#snapshot = this.#build();
  }

  static async create(session: Session, relays: readonly string[]): Promise<VerityEngine> {
    const pool = new RelayPool(relays);
    const client = new NostrClient({ signer: session.signer, pool });
    const pubkey = await session.signer.getPublicKey();
    const engine = new VerityEngine(session, pubkey, encodeNpub(pubkey), client);
    return engine;
  }

  get client(): NostrClient {
    return this.#client;
  }

  get pubkey(): Pubkey {
    return this.#pubkey;
  }

  // ---------- observable store interface ----------
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): EngineState => this.#snapshot;

  #emit(): void {
    if (this.#destroyed) return;
    this.#snapshot = this.#build();
    for (const l of this.#listeners) l();
  }

  #build(): EngineState {
    return {
      pubkey: this.#pubkey,
      npub: this.#npub,
      signerKind: this.#session.kind,
      profiles: Object.fromEntries(this.#profiles),
      feed: this.#buildFeed(),
      engagement: Object.fromEntries(this.#engagement),
      liked: [...this.#liked],
      reposted: [...this.#reposted],
      bookmarked: [...this.#bookmarked],
      deleted: [...this.#deleted],
      follows: [...this.#follows],
      conversations: this.#buildConversations(),
      audit: this.#audit,
      settings: this.#settings,
      relays: this.#relays,
      loadingFeed: this.#loadingFeed,
    };
  }

  #buildFeed(): FeedItem[] {
    const items: FeedItem[] = [];
    for (const note of this.#notes.values()) {
      if (this.#isReply(note)) continue;
      const reposter = this.#reposts.get(note.id);
      const repostAt = this.#repostAt.get(note.id);
      const sortAt = reposter && repostAt ? Math.max(repostAt, note.created_at) : note.created_at;
      items.push(reposter ? { note, repostedBy: reposter, sortAt } : { note, sortAt });
    }
    return items.sort((a, b) => b.sortAt - a.sortAt).slice(0, 100);
  }

  #isReply(note: NostrEvent): boolean {
    return note.kind === Kind.Text && note.tags.some((t) => t[0] === 'e');
  }

  #buildConversations(): Conversation[] {
    const byPeer = new Map<string, DirectMessage[]>();
    for (const msg of this.#messages.values()) {
      const peer = conversationPeer(msg, this.#pubkey);
      const list = byPeer.get(peer) ?? [];
      list.push(msg);
      byPeer.set(peer, list);
    }
    const conversations: Conversation[] = [];
    for (const [peer, msgs] of byPeer) {
      msgs.sort((a, b) => a.createdAt - b.createdAt);
      const last = msgs[msgs.length - 1];
      const readAt = this.#lastRead.get(peer) ?? 0;
      const unread = msgs.filter((m) => m.from !== this.#pubkey && m.createdAt > readAt).length;
      conversations.push({
        peer,
        messages: msgs,
        lastAt: last?.createdAt ?? 0,
        unread,
      });
    }
    return conversations.sort((a, b) => b.lastAt - a.lastAt);
  }

  // ---------- startup ----------
  async start(): Promise<void> {
    const [contacts, bookmarks] = await Promise.all([
      this.#client.fetchContacts(this.#pubkey),
      this.#client.fetchBookmarks(this.#pubkey),
    ]);
    this.#follows = [...contacts.follows];
    for (const id of bookmarks.eventIds) this.#bookmarked.add(id);

    // Load our own profile + the people we follow.
    this.#ensureProfiles([this.#pubkey, ...this.#follows]);

    // Seed the feed with recent notes, then keep it live.
    this.#startFeed();

    // Make sure our own recent notes are loaded (for the profile + home).
    void this.#client.fetchNotes({ authors: [this.#pubkey], limit: 50 }).then((mine) => {
      for (const n of mine) this.#addNote(n);
      this.#scheduleEngagementRefresh();
      this.#emit();
    });

    // Direct messages: history + live. Includes legacy (less-secure) DMs for
    // interop with older clients; those arrive flagged so the UI can mark them.
    void this.#loadDirectMessages();
    this.#startDmSub();

    this.#emit();
  }

  #startDmSub(): void {
    this.#dmSub?.close();
    this.#dmSub = this.#client.subscribeDirectMessages((m) => this.#onDirectMessage(m, true));
    this.#legacyDmSub?.close();
    this.#legacyDmSub = this.#client.subscribeLegacyDirectMessages((m) => this.#onDirectMessage(m, true));
  }

  #startFeed(): void {
    this.#feedSub?.close();
    const authors = this.#follows.length > 0 ? [...this.#follows, this.#pubkey] : [];
    this.#loadingFeed = true;
    this.#feedSub = this.#client.subscribeFeed(authors, (event) => this.#onFeedEvent(event), {
      limit: 80,
    });
    // Flip the loading flag shortly after subscribing.
    if (this.#loadingTimer) clearTimeout(this.#loadingTimer);
    this.#loadingTimer = setTimeout(() => {
      this.#loadingTimer = undefined;
      if (this.#destroyed) return;
      this.#loadingFeed = false;
      this.#emit();
    }, 2500);
  }

  #onFeedEvent(event: NostrEvent): void {
    if (event.kind === Kind.Text) {
      this.#addNote(event);
    } else if (event.kind === Kind.Repost) {
      this.#handleRepostEvent(event);
    }
    this.#scheduleEngagementRefresh();
    this.#emit();
  }

  #addNote(note: NostrEvent): void {
    if (this.#deleted.has(note.id) || this.#notes.has(note.id)) return;
    this.#notes.set(note.id, note);
    if (!this.#engagement.has(note.id)) this.#engagement.set(note.id, emptyEngagement());
    this.#ensureProfiles([note.pubkey]);
  }

  #handleRepostEvent(event: NostrEvent): void {
    const targetId = repostTargetId(event);
    if (!targetId) return;
    this.#reposts.set(targetId, event.pubkey);
    this.#repostAt.set(targetId, event.created_at);
    if (event.pubkey === this.#pubkey) this.#reposted.add(targetId);
    // The reposted note is embedded in content per NIP-18.
    const inner = this.#embeddedRepostNote(event, targetId);
    if (inner) {
      this.#addNote(inner);
    } else {
      // If not embedded, fetch the target by id.
      void this.#client.fetchNotes({ ids: [targetId] }).then((notes) => {
        const n = notes[0];
        if (n) {
          this.#addNote(n);
          this.#emit();
        }
      });
    }
  }

  // ---------- engagement ----------
  #scheduleEngagementRefresh(): void {
    if (this.#engagementTimer) return;
    this.#engagementTimer = setTimeout(() => {
      this.#engagementTimer = undefined;
      this.#refreshEngagementSub();
    }, 800);
  }

  #refreshEngagementSub(): void {
    const ids = [...this.#notes.keys()].slice(-100);
    if (ids.length === 0) return;
    this.#engagementSub?.close();
    this.#engagementSub = this.#client.subscribeEngagement(ids, (event) => this.#onEngagement(event));
  }

  #onEngagement(event: NostrEvent): void {
    if (this.#countedEngagement.has(event.id)) return;
    this.#countedEngagement.add(event.id);
    const mine = event.pubkey === this.#pubkey;

    if (event.kind === Kind.Reaction && isLike(event)) {
      const target = reactionTargetId(event);
      // Our own like was already counted optimistically — don't double count.
      if (target && !(mine && this.#liked.has(target))) {
        this.#bump(target, 'likes');
        if (mine) this.#liked.add(target);
      }
    } else if (event.kind === Kind.Repost) {
      const target = repostTargetId(event);
      if (target && !(mine && this.#reposted.has(target))) {
        this.#bump(target, 'reposts');
        if (mine) this.#reposted.add(target);
      }
    } else if (event.kind === Kind.Text) {
      const replyTo = event.tags.filter((t) => t[0] === 'e').pop()?.[1];
      if (replyTo) this.#bump(replyTo, 'replies');
    }
    this.#emit();
  }

  #bump(noteId: string, field: keyof EngagementCounts): void {
    const current = this.#engagement.get(noteId) ?? emptyEngagement();
    this.#engagement.set(noteId, { ...current, [field]: current[field] + 1 });
  }

  // ---------- profiles ----------
  #ensureProfiles(pubkeys: readonly string[]): void {
    let added = false;
    for (const pk of pubkeys) {
      if (!this.#profiles.has(pk) && !this.#pendingProfiles.has(pk)) {
        this.#pendingProfiles.add(pk);
        added = true;
      }
    }
    if (!added) return;
    if (this.#profileTimer) return;
    this.#profileTimer = setTimeout(() => {
      this.#profileTimer = undefined;
      void this.#flushProfiles();
    }, 300);
  }

  async #flushProfiles(): Promise<void> {
    const batch = [...this.#pendingProfiles];
    this.#pendingProfiles.clear();
    if (batch.length === 0) return;
    const events = await this.#client.pool.list([{ kinds: [Kind.Metadata], authors: batch }]);
    const latest = new Map<string, NostrEvent>();
    for (const ev of events) {
      const existing = latest.get(ev.pubkey);
      if (!existing || ev.created_at > existing.created_at) latest.set(ev.pubkey, ev);
    }
    for (const ev of latest.values()) {
      const profile = parseProfile(ev);
      if (profile) this.#profiles.set(profile.pubkey, profile);
    }
    this.#emit();
  }

  /** Public: fetch a profile on demand (e.g. when opening a conversation). */
  ensureProfiles(pubkeys: readonly string[]): void {
    this.#ensureProfiles(pubkeys);
  }

  // ---------- direct messages ----------
  async #loadDirectMessages(): Promise<void> {
    const [secure, legacy] = await Promise.all([
      this.#client.fetchDirectMessages(),
      this.#client.fetchLegacyDirectMessages(),
    ]);
    for (const m of [...secure, ...legacy]) this.#onDirectMessage(m, false);
    this.#emit();
  }

  #onDirectMessage(message: DirectMessage, live: boolean): void {
    if (this.#messages.has(message.id)) return;
    this.#messages.set(message.id, message);
    const peer = conversationPeer(message, this.#pubkey);
    this.#ensureProfiles([peer]);
    if (live && message.from !== this.#pubkey) {
      this.#logAudit('dm', 'Direct message decrypted', `Conversation with ${peer.slice(0, 8)}…`);
    }
    this.#emit();
  }

  // ---------- actions ----------
  async post(content: string): Promise<void> {
    const { event } = await this.#client.publishNote(content);
    this.#addNote(event);
    this.#logAudit('post', 'Note published', `${content.slice(0, 40)}${content.length > 40 ? '…' : ''}`);
    this.#scheduleEngagementRefresh();
    this.#emit();
  }

  async reply(parent: NostrEvent, content: string): Promise<void> {
    const { event } = await this.#client.reply(parent, content);
    this.#addNote(event);
    this.#bump(parent.id, 'replies');
    this.#countedEngagement.add(event.id);
    this.#logAudit('post', 'Reply published', `to ${parent.pubkey.slice(0, 8)}…`);
    this.#emit();
  }

  async like(note: NostrEvent): Promise<void> {
    if (this.#liked.has(note.id)) {
      // Optimistic un-like (local only; NIP-25 has no first-class unlike).
      this.#liked.delete(note.id);
      this.#bumpBy(note.id, 'likes', -1);
      this.#emit();
      return;
    }
    this.#liked.add(note.id);
    this.#bumpBy(note.id, 'likes', 1);
    this.#emit();
    const { event } = await this.#client.like(note);
    // Record our own reaction id so its relay echo is ignored — otherwise a
    // quick like→unlike could be reverted when the original like echoes back.
    this.#countedEngagement.add(event.id);
  }

  async repost(note: NostrEvent): Promise<void> {
    if (this.#reposted.has(note.id)) return;
    this.#reposted.add(note.id);
    this.#bumpBy(note.id, 'reposts', 1);
    this.#emit();
    const { event } = await this.#client.repost(note);
    this.#countedEngagement.add(event.id);
  }

  async toggleBookmark(note: NostrEvent): Promise<boolean> {
    if (this.#bookmarked.has(note.id)) {
      this.#bookmarked.delete(note.id);
      this.#emit();
      await this.#client.unbookmark(note.id);
      return false;
    }
    this.#bookmarked.add(note.id);
    this.#emit();
    await this.#client.bookmark(note.id);
    return true;
  }

  /** Request deletion (NIP-09) of one of our own notes and drop it locally. */
  async deletePost(note: NostrEvent): Promise<void> {
    if (note.pubkey !== this.#pubkey) throw new Error('You can only delete your own posts');
    // Optimistically remove from all local state so it disappears everywhere.
    this.#deleted.add(note.id);
    this.#notes.delete(note.id);
    this.#reposts.delete(note.id);
    this.#repostAt.delete(note.id);
    this.#engagement.delete(note.id);
    this.#liked.delete(note.id);
    this.#reposted.delete(note.id);
    this.#emit();
    await this.#client.deleteEvents([note]);
    this.#logAudit('post', 'Note deleted', `${note.content.slice(0, 40)}${note.content.length > 40 ? '…' : ''}`);
    this.#emit();
  }

  #bumpBy(noteId: string, field: keyof EngagementCounts, delta: number): void {
    const current = this.#engagement.get(noteId) ?? emptyEngagement();
    this.#engagement.set(noteId, { ...current, [field]: Math.max(0, current[field] + delta) });
  }

  async follow(pubkey: Pubkey): Promise<void> {
    if (this.#follows.includes(pubkey)) return;
    this.#follows = [...this.#follows, pubkey];
    this.#ensureProfiles([pubkey]);
    this.#emit();
    await this.#client.follow(pubkey);
    this.#startFeed();
  }

  async unfollow(pubkey: Pubkey): Promise<void> {
    if (!this.#follows.includes(pubkey)) return;
    this.#follows = this.#follows.filter((p) => p !== pubkey);
    this.#emit();
    await this.#client.unfollow(pubkey);
    this.#startFeed();
  }

  isFollowing(pubkey: Pubkey): boolean {
    return this.#follows.includes(pubkey);
  }

  async sendDirectMessage(peer: Pubkey, content: string): Promise<void> {
    const { rumorId, wraps } = await this.#client.sendDirectMessage(peer, content);
    // Reflect our own copy immediately, keyed by the rumor id so the relay
    // echo of our self-wrap dedups against it instead of duplicating.
    const selfWrap = wraps.find((w) => w.tags.some((t) => t[0] === 'p' && t[1] === this.#pubkey));
    const mirror: DirectMessage = {
      id: rumorId,
      from: this.#pubkey,
      to: [peer],
      content,
      createdAt: Math.floor(Date.now() / 1000),
      wrapId: selfWrap?.id ?? '',
      legacy: false,
    };
    this.#messages.set(mirror.id, mirror);
    this.#emit();
  }

  markConversationRead(peer: Pubkey): void {
    // Mark read up to the newest *message* timestamp in this conversation.
    // Seeding from 0 (not Date.now()) avoids recording a future baseline that
    // would mask later messages with earlier (sender-clock) timestamps.
    let newest = 0;
    for (const m of this.#messages.values()) {
      if (conversationPeer(m, this.#pubkey) === peer) newest = Math.max(newest, m.createdAt);
    }
    if (newest === 0 || (this.#lastRead.get(peer) ?? 0) >= newest) return;
    this.#lastRead.set(peer, newest);
    saveReadState(this.#pubkey, Object.fromEntries(this.#lastRead));
    this.#emit();
  }

  // ---------- relays ----------
  setRelays(relays: readonly string[]): void {
    const next = [...new Set(relays)];
    if (next.length === 0) return;
    this.#relays = next;
    this.#client.setRelays(next);
    saveRelays(next);
    // Re-establish live subscriptions against the new relay set.
    this.#startFeed();
    this.#refreshEngagementSub();
    this.#startDmSub();
    void this.#loadDirectMessages();
    this.#logAudit('device', 'Relay set updated', `${next.length} relays`);
    this.#emit();
  }

  // ---------- search ----------
  async searchNotes(query: string): Promise<NostrEvent[]> {
    const notes = await this.#client.searchNotes(query);
    for (const n of notes) this.#addNote(n);
    if (notes.length) this.#emit();
    return notes;
  }

  async searchProfiles(query: string): Promise<Profile[]> {
    const profiles = await this.#client.searchProfiles(query);
    // Only upgrade the cache to newer metadata; never downgrade with a stale
    // search hit (search relays can lag behind our primary relays).
    for (const p of profiles) {
      const existing = this.#profiles.get(p.pubkey);
      if (!existing || p.createdAt > existing.createdAt) this.#profiles.set(p.pubkey, p);
    }
    if (profiles.length) this.#emit();
    return profiles;
  }

  /**
   * Fetch a single user's recent notes and reposts (for their profile view).
   * Reposts (kind 6) are surfaced as the reposted note tagged with `repostedBy`,
   * mirroring the home feed. The NIP-18 repost embeds its target in `content`;
   * any that don't are fetched by id in a single follow-up query.
   */
  async fetchUserNotes(pubkey: Pubkey, limit = 100): Promise<FeedItem[]> {
    this.#ensureProfiles([pubkey]);
    const events = await this.#client.fetchNotes({
      authors: [pubkey],
      kinds: [Kind.Text, Kind.Repost],
      limit,
    });
    const items: FeedItem[] = [];
    const pendingReposts = new Map<string, number>(); // targetId -> repost created_at
    for (const ev of events) {
      if (ev.kind === Kind.Repost) {
        const targetId = repostTargetId(ev);
        if (!targetId) continue;
        const inner = this.#embeddedRepostNote(ev, targetId);
        if (inner) {
          this.#addNote(inner);
          items.push({ note: inner, repostedBy: pubkey, sortAt: ev.created_at });
        } else {
          // Keep the newest repost timestamp if the same note was reposted twice.
          pendingReposts.set(targetId, Math.max(ev.created_at, pendingReposts.get(targetId) ?? 0));
        }
      } else {
        this.#addNote(ev);
        items.push({ note: ev, sortAt: ev.created_at });
      }
    }
    if (pendingReposts.size > 0) {
      const fetched = await this.#client.fetchNotes({ ids: [...pendingReposts.keys()] });
      for (const note of fetched) {
        const at = pendingReposts.get(note.id);
        if (at === undefined) continue;
        this.#addNote(note);
        items.push({ note, repostedBy: pubkey, sortAt: at });
      }
    }
    return items.sort((a, b) => b.sortAt - a.sortAt);
  }

  /** Extract the NIP-18 reposted note embedded in a kind-6 event's content. */
  #embeddedRepostNote(event: NostrEvent, targetId: string): NostrEvent | null {
    try {
      const inner = JSON.parse(event.content) as NostrEvent;
      return inner && inner.id === targetId && inner.kind === Kind.Text ? inner : null;
    } catch {
      return null;
    }
  }

  /**
   * Fetch a single note and its direct replies (for the note detail view).
   * Both the root and replies are added to the store so engagement counts and
   * author profiles populate the same way they do for the feed.
   */
  async fetchThread(id: string): Promise<{ root: NostrEvent | null; replies: NostrEvent[] }> {
    const [roots, replyEvents] = await Promise.all([
      this.#client.fetchNotes({ ids: [id] }),
      this.#client.fetchNotes({ '#e': [id], limit: 100 }),
    ]);
    const root = roots.find((e) => e.id === id) ?? null;
    if (root) this.#addNote(root);
    const replies = replyEvents.filter((e) => e.id !== id).sort((a, b) => a.created_at - b.created_at);
    for (const r of replies) this.#addNote(r);
    if (root || replies.length > 0) {
      this.#scheduleEngagementRefresh();
      this.#emit();
    }
    return { root, replies };
  }

  /** Fetch follower count for a pubkey (distinct kind-3 authors tagging them). */
  async fetchFollowerCount(pubkey: Pubkey): Promise<number> {
    const events = await this.#client.pool.list([{ kinds: [Kind.Contacts], '#p': [pubkey], limit: 500 }]);
    return new Set(events.map((e) => e.pubkey)).size;
  }

  async setProfile(metadata: Parameters<NostrClient['setProfile']>[0]): Promise<void> {
    const { event } = await this.#client.setProfile(metadata);
    const profile = parseProfile(event);
    if (profile) this.#profiles.set(profile.pubkey, profile);
    this.#logAudit('profile', 'Profile metadata updated', 'Name, bio and links');
    this.#emit();
  }

  toggleSetting(key: keyof EngineSettings): boolean {
    const next = { ...this.#settings, [key]: !this.#settings[key] };
    this.#settings = next;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    this.#logAudit('device', `${key === 'hardware' ? 'Hardware signer' : 'Delegated signing'} setting changed`, next[key] ? 'enabled' : 'disabled');
    this.#emit();
    return next[key];
  }

  logAudit(type: AuditType, event: string, detail: string): void {
    this.#logAudit(type, event, detail);
    this.#emit();
  }

  #logAudit(type: AuditType, event: string, detail: string): void {
    this.#audit = appendAudit(this.#pubkey, { type, event, detail });
  }

  profileFor(pubkey: string): Profile | undefined {
    return this.#profiles.get(pubkey);
  }

  destroy(): void {
    this.#destroyed = true;
    this.#feedSub?.close();
    this.#dmSub?.close();
    this.#legacyDmSub?.close();
    this.#engagementSub?.close();
    for (const s of this.#subs) s.close();
    if (this.#engagementTimer) clearTimeout(this.#engagementTimer);
    if (this.#profileTimer) clearTimeout(this.#profileTimer);
    if (this.#loadingTimer) clearTimeout(this.#loadingTimer);
    this.#client.destroy();
    this.#listeners.clear();
  }
}
