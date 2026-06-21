/**
 * Pure domain module for NIP-51 list types: FollowSet and BookmarkSet.
 *
 * No React, no Nostr I/O, no side effects. All mutations return new objects.
 * Persistence and relay sync live in the store; NIP-51 event building lives
 * in nostr/nip51.ts — this module only defines the domain shape and pure
 * transformations.
 */

// ---------- types ----------

export type FollowSet = {
  /** Short local id (first 8 chars of a UUID). Stable until the set is synced
   *  from a relay, at which point `eventId` carries the canonical identity. */
  id: string;
  /** User-given display name; also used as the "d" tag when publishing. */
  name: string;
  pubkeys: string[];
  isPrivate: boolean;
  /** Seconds epoch (Nostr time). */
  createdAt: number;
  /** Set once the set has been synced from or published to a relay. */
  eventId?: string;
};

export type BookmarkSet = {
  id: string;
  name: string;
  eventIds: string[];
  isPrivate: boolean;
  createdAt: number;
  eventId?: string;
};

// ---------- id helper ----------

// crypto.randomUUID is available in all modern browsers and Bun.
const newId = (): string => crypto.randomUUID().slice(0, 8);

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

// ---------- FollowSet mutations ----------

export const createFollowSet = (name: string, isPrivate: boolean): FollowSet => ({
  id: newId(),
  name,
  pubkeys: [],
  isPrivate,
  createdAt: nowSeconds(),
});

/** Returns a new FollowSet with `pubkey` appended, deduped by value. */
export const addPubkeyToFollowSet = (set: FollowSet, pubkey: string): FollowSet => {
  if (set.pubkeys.includes(pubkey)) return set;
  return { ...set, pubkeys: [...set.pubkeys, pubkey] };
};

/** Returns a new FollowSet with `pubkey` removed (no-op if absent). */
export const removePubkeyFromFollowSet = (set: FollowSet, pubkey: string): FollowSet => ({
  ...set,
  pubkeys: set.pubkeys.filter((pk) => pk !== pubkey),
});

// ---------- BookmarkSet mutations ----------

export const createBookmarkSet = (name: string, isPrivate: boolean): BookmarkSet => ({
  id: newId(),
  name,
  eventIds: [],
  isPrivate,
  createdAt: nowSeconds(),
});

/** Returns a new BookmarkSet with `eventId` appended, deduped by value. */
export const addEventIdToBookmarkSet = (set: BookmarkSet, eventId: string): BookmarkSet => {
  if (set.eventIds.includes(eventId)) return set;
  return { ...set, eventIds: [...set.eventIds, eventId] };
};

/** Returns a new BookmarkSet with `eventId` removed (no-op if absent). */
export const removeEventIdFromBookmarkSet = (set: BookmarkSet, eventId: string): BookmarkSet => ({
  ...set,
  eventIds: set.eventIds.filter((id) => id !== eventId),
});
