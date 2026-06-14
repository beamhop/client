import { describe, test, expect } from 'bun:test';
import { finalizeEvent } from 'nostr-tools/pure';
import { generateKeyPair } from '../src/keys.js';
import {
  buildReplyTags,
  buildMentionTags,
  extractMentions,
  dedupeTags,
  firstTagValue,
  tagValues,
  now,
} from '../src/events.js';
import { encodeNpub } from '../src/keys.js';
import type { NostrEvent } from '../src/types.js';

function note(content: string, tags: string[][] = []): NostrEvent {
  const kp = generateKeyPair();
  return finalizeEvent({ kind: 1, created_at: now(), tags, content }, kp.secretKey);
}

describe('events', () => {
  test('buildReplyTags marks a top-level note as root', () => {
    const parent = note('hello');
    const tags = buildReplyTags(parent);
    const eTags = tags.filter((t) => t[0] === 'e');
    expect(eTags).toHaveLength(1);
    expect(eTags[0]).toEqual(['e', parent.id, '', 'root']);
    expect(tagValues({ ...parent, tags } as NostrEvent, 'p')).toContain(parent.pubkey);
  });

  test('buildReplyTags preserves root and adds reply marker for nested replies', () => {
    const root = note('root');
    const mid = note('mid', [['e', root.id, '', 'root'], ['p', root.pubkey]]);
    const tags = buildReplyTags(mid);
    expect(tags).toContainEqual(['e', root.id, '', 'root']);
    expect(tags).toContainEqual(['e', mid.id, '', 'reply']);
    const pTags = tags.filter((t) => t[0] === 'p').map((t) => t[1]);
    expect(pTags).toContain(root.pubkey);
    expect(pTags).toContain(mid.pubkey);
  });

  test('extractMentions decodes npub references from content', () => {
    const kp = generateKeyPair();
    const npub = encodeNpub(kp.publicKey);
    const content = `hey nostr:${npub} take a look`;
    expect(extractMentions(content)).toEqual([kp.publicKey]);
    expect(buildMentionTags(content)).toEqual([['p', kp.publicKey]]);
  });

  test('extractMentions ignores malformed references', () => {
    expect(extractMentions('nostr:npub1garbage and text')).toEqual([]);
  });

  test('dedupeTags removes exact duplicates', () => {
    const deduped = dedupeTags([
      ['p', 'a'],
      ['p', 'a'],
      ['e', 'x', '', 'root'],
    ]);
    expect(deduped).toHaveLength(2);
  });

  test('firstTagValue and tagValues read tags', () => {
    const ev = note('x', [['p', 'a'], ['p', 'b'], ['e', 'evt']]);
    expect(firstTagValue(ev, 'p')).toBe('a');
    expect(tagValues(ev, 'p')).toEqual(['a', 'b']);
    expect(firstTagValue(ev, 'missing')).toBeUndefined();
  });
});
