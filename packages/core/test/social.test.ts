import { describe, test, expect } from 'bun:test';
import { finalizeEvent } from 'nostr-tools/pure';
import { generateKeyPair } from '../src/keys.js';
import { now } from '../src/events.js';
import { parseProfile, displayName, buildProfileContent } from '../src/profile.js';
import {
  parseContacts,
  addFollow,
  removeFollow,
  buildContactTags,
  isFollowing,
} from '../src/contacts.js';
import {
  parseBookmarks,
  addBookmark,
  removeBookmark,
  isBookmarked,
} from '../src/bookmarks.js';
import {
  buildReactionTags,
  reactionTargetId,
  buildRepostTags,
  repostTargetId,
  buildDeletionTags,
  isLike,
} from '../src/interactions.js';
import type { NostrEvent } from '../src/types.js';

const kp = generateKeyPair();
function signed(kind: number, content: string, tags: string[][] = []): NostrEvent {
  return finalizeEvent({ kind, created_at: now(), tags, content }, kp.secretKey);
}

describe('profile', () => {
  test('parseProfile reads kind 0 metadata', () => {
    const ev = signed(0, JSON.stringify({ name: 'maya', about: 'hi' }));
    const profile = parseProfile(ev);
    expect(profile?.metadata.name).toBe('maya');
    expect(displayName(profile ?? undefined, 'fallback')).toBe('maya');
  });

  test('parseProfile returns null for bad json', () => {
    expect(parseProfile(signed(0, 'not json'))).toBeNull();
  });

  test('parseProfile rejects non-metadata kinds', () => {
    expect(parseProfile(signed(1, '{}'))).toBeNull();
  });

  test('buildProfileContent strips empty values', () => {
    const content = buildProfileContent({ name: 'a', about: '', website: undefined });
    expect(JSON.parse(content)).toEqual({ name: 'a' });
  });

  test('displayName prefers display_name then name then fallback', () => {
    expect(displayName({ pubkey: 'x', createdAt: 0, metadata: { display_name: 'D', name: 'n' } }, 'f')).toBe('D');
    expect(displayName({ pubkey: 'x', createdAt: 0, metadata: { name: 'n' } }, 'f')).toBe('n');
    expect(displayName(undefined, 'f')).toBe('f');
  });
});

describe('contacts', () => {
  test('parse + add + remove follow', () => {
    const ev = signed(3, '', [['p', 'a'], ['p', 'b']]);
    const list = parseContacts(ev);
    expect(list.follows).toEqual(['a', 'b']);
    expect(isFollowing(list, 'a')).toBe(true);

    const added = addFollow(list, 'c');
    expect(added).toContain('c');
    // idempotent
    expect(addFollow({ ...list, follows: added }, 'c')).toEqual(added);

    const removed = removeFollow(list, 'a');
    expect(removed).toEqual(['b']);
  });

  test('buildContactTags maps follows to p tags', () => {
    expect(buildContactTags(['a', 'b'])).toEqual([['p', 'a'], ['p', 'b']]);
  });

  test('parseContacts handles null', () => {
    expect(parseContacts(null).follows).toEqual([]);
  });
});

describe('bookmarks', () => {
  test('parse + add + remove', () => {
    const ev = signed(10003, '', [['e', 'n1']]);
    const list = parseBookmarks(ev);
    expect(list.eventIds).toEqual(['n1']);
    expect(isBookmarked(list, 'n1')).toBe(true);
    expect(addBookmark(list, 'n2')).toEqual(['n1', 'n2']);
    expect(removeBookmark(list, 'n1')).toEqual([]);
  });
});

describe('interactions', () => {
  test('reaction tags point at target', () => {
    const target = signed(1, 'hi');
    const tags = buildReactionTags(target);
    expect(tags).toContainEqual(['e', target.id]);
    expect(tags).toContainEqual(['p', target.pubkey]);
    const reaction = signed(7, '+', tags);
    expect(reactionTargetId(reaction)).toBe(target.id);
    expect(isLike(reaction)).toBe(true);
  });

  test('empty content reaction still counts as like', () => {
    expect(isLike(signed(7, ''))).toBe(true);
    expect(isLike(signed(7, '😀'))).toBe(false);
  });

  test('repost tags point at target', () => {
    const target = signed(1, 'hi');
    const tags = buildRepostTags(target);
    const repost = signed(6, '', tags);
    expect(repostTargetId(repost)).toBe(target.id);
  });

  test('deletion tags reference each event id and its kind (NIP-09)', () => {
    const a = signed(1, 'first');
    const b = signed(1, 'second');
    const tags = buildDeletionTags([a, b]);
    expect(tags).toContainEqual(['e', a.id]);
    expect(tags).toContainEqual(['e', b.id]);
    // One 'k' tag for the single distinct kind.
    expect(tags.filter((t) => t[0] === 'k')).toEqual([['k', '1']]);
  });
});
