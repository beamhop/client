import type { Event, EventTemplate } from 'nostr-tools/pure';

/** A signed Nostr event as it travels across relays. */
export type NostrEvent = Event;

/** An unsigned event template (kind, tags, content, created_at). */
export type NostrEventTemplate = EventTemplate;

/** Hex-encoded 32-byte public key. */
export type Pubkey = string;

/** Profile metadata (NIP-01 kind 0 content). */
export interface ProfileMetadata {
  readonly name?: string;
  readonly display_name?: string;
  readonly about?: string;
  readonly picture?: string;
  readonly banner?: string;
  readonly nip05?: string;
  readonly lud16?: string;
  readonly website?: string;
  /** Allow forward-compatible extra fields without losing them on round-trip. */
  readonly [key: string]: unknown;
}

/** A profile resolved from a kind 0 event. */
export interface Profile {
  readonly pubkey: Pubkey;
  readonly metadata: ProfileMetadata;
  readonly createdAt: number;
}

/** A decrypted direct message. */
export interface DirectMessage {
  readonly id: string;
  readonly from: Pubkey;
  readonly to: readonly Pubkey[];
  readonly content: string;
  readonly createdAt: number;
  /** id of the gift wrap (or source event) that delivered this message. */
  readonly wrapId: string;
  /** True when delivered over the legacy, less-secure encryption scheme. */
  readonly legacy: boolean;
}

/** Well-known Nostr event kinds used by Verity. */
export const Kind = {
  Metadata: 0,
  Text: 1,
  Repost: 6,
  Reaction: 7,
  Deletion: 5,
  Contacts: 3,
  LegacyDirectMessage: 4,
  Seal: 13,
  DirectMessage: 14,
  GiftWrap: 1059,
  RelayList: 10002,
  BookmarkList: 10003,
} as const;

export type KindValue = (typeof Kind)[keyof typeof Kind];
