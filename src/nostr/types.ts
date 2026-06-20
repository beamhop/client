import type { Event as NostrEvent } from "nostr-tools";

export type { NostrEvent };

/** Nostr event kinds used by Verity. */
export const Kind = {
  Metadata: 0,
  Note: 1,
  Contacts: 3,
  EncryptedDM: 4,
  Deletion: 5,
  Repost: 6,
  Reaction: 7,
  PrivateDirectMessage: 17,
  Mention: 24,
  Report: 1984,
  ZapReceipt: 9735,
  MuteList: 10000,
  FollowSet: 30000,
  BookmarkSet: 30003,
  LongForm: 30023,
  LongFormDraft: 30024,
} as const;

/** Marker tag value distinguishing Documentation articles from blog Articles, both kind 30023. */
export const DOC_MARKER = "verity-doc";
export const ARTICLE_MARKER = "verity-article";

/** Decoded profile (kind 0 content). */
export type Profile = {
  pubkey: string;
  name?: string;
  displayName?: string;
  about?: string;
  picture?: string;
  banner?: string;
  nip05?: string;
  lud16?: string;
  website?: string;
  role?: string;
  event?: NostrEvent;
};

/** A feed note (kind 1) normalized for the UI. */
export type Note = {
  id: string;
  pubkey: string;
  content: string;
  createdAt: number;
  tags: string[][];
  replyTo?: string;
  rootId?: string;
  event?: NostrEvent;
};

/** Long-form content (kind 30023): both blog Articles and Documentation. */
export type LongForm = {
  id: string;
  pubkey: string;
  identifier: string; // the "d" tag — addressable identifier
  title: string;
  summary: string;
  image?: string;
  body: string; // markdown
  publishedAt: number;
  updatedAt: number;
  hashtags: string[];
  kind: "doc" | "article";
  event?: NostrEvent;
};

/** Direct message conversation peer + decrypted messages. */
export type DirectMessage = {
  id: string;
  pubkey: string; // the other party
  content: string;
  createdAt: number;
  fromMe: boolean;
  event?: NostrEvent;
};

/** A reaction (kind 7) — content "+", "🤙", etc. */
export type Reaction = {
  id: string;
  pubkey: string;
  targetId: string;
  content: string;
  event?: NostrEvent;
};

export type RelayStatus = "connecting" | "connected" | "error" | "disconnected";

export type RelayInfo = {
  url: string;
  enabled: boolean;
  read: boolean;
  write: boolean;
  status: RelayStatus;
};
