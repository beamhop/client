import { Kind } from './types.js';
import { firstTagValue } from './events.js';
import type { NostrEvent } from './types.js';

/** The "+" content used for a like, per NIP-25. */
export const LIKE_CONTENT = '+';

/** Build the tags for a kind 7 reaction to `target`. */
export function buildReactionTags(target: NostrEvent): string[][] {
  return [
    ['e', target.id],
    ['p', target.pubkey],
    ['k', String(target.kind)],
  ];
}

/** The event id a kind 7 reaction points at (its last "e" tag, per NIP-25). */
export function reactionTargetId(event: NostrEvent): string | undefined {
  const eTags = event.tags.filter((t) => t[0] === 'e');
  return eTags[eTags.length - 1]?.[1];
}

/** Build the tags for a kind 6 repost of `target`, per NIP-18. */
export function buildRepostTags(target: NostrEvent): string[][] {
  return [
    ['e', target.id],
    ['p', target.pubkey],
  ];
}

/** The event id a kind 6 repost points at (its first "e" tag). */
export function repostTargetId(event: NostrEvent): string | undefined {
  return firstTagValue(event, 'e');
}

/**
 * Build the tags for a kind 5 deletion request (NIP-09): an `e` tag per deleted
 * event id, plus a `k` tag for each distinct kind being deleted.
 */
export function buildDeletionTags(events: readonly NostrEvent[]): string[][] {
  const tags: string[][] = events.map((e) => ['e', e.id]);
  for (const kind of new Set(events.map((e) => e.kind))) tags.push(['k', String(kind)]);
  return tags;
}

/** True for a positive reaction (like). NIP-25 treats "" and "+" as likes. */
export function isLike(event: NostrEvent): boolean {
  return event.kind === Kind.Reaction && (event.content === '' || event.content === '+');
}

/** Aggregate engagement counts for a target note from a stream of events. */
export interface EngagementCounts {
  likes: number;
  reposts: number;
  replies: number;
}

export function emptyEngagement(): EngagementCounts {
  return { likes: 0, reposts: 0, replies: 0 };
}
