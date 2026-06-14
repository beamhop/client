import type { NostrEvent, Profile, EngagementCounts, DirectMessage } from '@verity/core';
import type { AuditEntry } from '../lib/audit.js';
import type { SignerKind } from '../lib/session.js';

/** A single item in the home feed: a note, optionally surfaced via a repost. */
export interface FeedItem {
  readonly note: NostrEvent;
  readonly repostedBy?: string;
  readonly sortAt: number;
}

/** A 1:1 conversation thread keyed by the peer pubkey. */
export interface Conversation {
  readonly peer: string;
  readonly messages: readonly DirectMessage[];
  readonly lastAt: number;
  readonly unread: number;
}

export interface EngineSettings {
  readonly hardware: boolean;
  readonly delegation: boolean;
}

/** The immutable snapshot the React layer renders from. */
export interface EngineState {
  readonly pubkey: string;
  readonly npub: string;
  readonly signerKind: SignerKind;
  readonly profiles: Readonly<Record<string, Profile>>;
  readonly feed: readonly FeedItem[];
  readonly engagement: Readonly<Record<string, EngagementCounts>>;
  readonly liked: readonly string[];
  readonly reposted: readonly string[];
  readonly bookmarked: readonly string[];
  readonly deleted: readonly string[];
  readonly follows: readonly string[];
  readonly conversations: readonly Conversation[];
  readonly audit: readonly AuditEntry[];
  readonly settings: EngineSettings;
  readonly relays: readonly string[];
  readonly loadingFeed: boolean;
}
