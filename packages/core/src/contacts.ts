import { Kind } from './types.js';
import { tagValues } from './events.js';
import type { NostrEvent, Pubkey } from './types.js';

/** A NIP-02 contact list (kind 3): the set of followed pubkeys + relay hints. */
export interface ContactList {
  readonly follows: readonly Pubkey[];
  readonly content: string;
  readonly createdAt: number;
}

const EMPTY_CONTACTS: ContactList = { follows: [], content: '', createdAt: 0 };

/** Parse a kind 3 event into a ContactList. */
export function parseContacts(event: NostrEvent | null): ContactList {
  if (!event || event.kind !== Kind.Contacts) return EMPTY_CONTACTS;
  return {
    follows: [...new Set(tagValues(event, 'p'))],
    content: event.content,
    createdAt: event.created_at,
  };
}

/** Return a new follow list with `pubkey` added (idempotent). */
export function addFollow(list: ContactList, pubkey: Pubkey): readonly Pubkey[] {
  if (list.follows.includes(pubkey)) return list.follows;
  return [...list.follows, pubkey];
}

/** Return a new follow list with `pubkey` removed. */
export function removeFollow(list: ContactList, pubkey: Pubkey): readonly Pubkey[] {
  return list.follows.filter((p) => p !== pubkey);
}

/** Build kind 3 tags from a set of followed pubkeys. */
export function buildContactTags(follows: readonly Pubkey[]): string[][] {
  return follows.map((pk) => ['p', pk]);
}

export function isFollowing(list: ContactList, pubkey: Pubkey): boolean {
  return list.follows.includes(pubkey);
}
