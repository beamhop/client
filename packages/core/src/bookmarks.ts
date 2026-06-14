import { Kind } from './types.js';
import { tagValues } from './events.js';
import type { NostrEvent } from './types.js';

/** A NIP-51 bookmark list (kind 10003): the set of bookmarked event ids. */
export interface BookmarkList {
  readonly eventIds: readonly string[];
  readonly createdAt: number;
}

const EMPTY: BookmarkList = { eventIds: [], createdAt: 0 };

export function parseBookmarks(event: NostrEvent | null): BookmarkList {
  if (!event || event.kind !== Kind.BookmarkList) return EMPTY;
  return { eventIds: [...new Set(tagValues(event, 'e'))], createdAt: event.created_at };
}

export function addBookmark(list: BookmarkList, eventId: string): readonly string[] {
  if (list.eventIds.includes(eventId)) return list.eventIds;
  return [...list.eventIds, eventId];
}

export function removeBookmark(list: BookmarkList, eventId: string): readonly string[] {
  return list.eventIds.filter((id) => id !== eventId);
}

export function buildBookmarkTags(eventIds: readonly string[]): string[][] {
  return eventIds.map((id) => ['e', id]);
}

export function isBookmarked(list: BookmarkList, eventId: string): boolean {
  return list.eventIds.includes(eventId);
}
