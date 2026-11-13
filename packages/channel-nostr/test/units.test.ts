import { finalizeEvent } from 'nostr-tools/pure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  decodePubkey,
  decodeSecretKey,
  generateAgentKey,
  keyFromSecret,
  tryDecodePubkey,
} from '../src/keys.ts';
import { LruMap, RateLimiter, SeenSet } from '../src/lru.ts';
import { renderNostrText } from '../src/markdown.ts';
import { fetchRelayInfo, relayHttpUrl, supportsNip } from '../src/nip11.ts';
import { RelayPool } from '../src/pool.ts';
import {
  contentMentions,
  extractAttachments,
  hopsTag,
  imetaTags,
  mentions,
  parseHops,
  threadRefs,
} from '../src/tags.ts';
import { FakeRelay, waitFor } from './helpers/fake-relay.ts';

const now = () => Math.floor(Date.now() / 1000);

describe('keys', () => {
  it('generates and round-trips keys', () => {
    const k = generateAgentKey();
    expect(k.npub.startsWith('npub1')).toBe(true);
    expect(k.nsec.startsWith('nsec1')).toBe(true);
    expect(decodeSecretKey(k.nsec)).toEqual(k.secretKey);
    expect(keyFromSecret(decodeSecretKey(Buffer.from(k.secretKey).toString('hex'))).pubkey).toBe(k.pubkey);
    expect(decodePubkey(k.npub)).toBe(k.pubkey);
    expect(decodePubkey(`nostr:${k.npub}`)).toBe(k.pubkey);
    expect(decodePubkey(k.pubkey.toUpperCase())).toBe(k.pubkey);
  });
  it('rejects bad input', () => {
    expect(() => decodeSecretKey('nsec1xyz')).toThrow();
    expect(() => decodeSecretKey(new Uint8Array(31))).toThrow();
    expect(() => decodeSecretKey(generateAgentKey().npub)).toThrow();
    expect(() => decodePubkey(generateAgentKey().nsec)).toThrow();
    expect(tryDecodePubkey('hello')).toBeUndefined();
  });
});

describe('markdown → nostr text', () => {
  it('strips formatting and keeps code fences', () => {
    const md = [
      '# Title',
      '',
      'Some **bold**, *italic*, _under_ and ~~gone~~ text with snake_case_name.',
      '- item [link](https://x.y) and ![img](https://i.png)',
      '- [x] done',
      '',
      '```ts',
      'const **a** = 1; // # not a heading',
      '```',
      'Inline `**raw**` stays. <b>html</b> \\*escaped\\*',
      '---',
    ].join('\n');
    expect(renderNostrText(md)).toBe(
      [
        'Title',
        '',
        'Some bold, italic, under and gone text with snake_case_name.',
        '• item link (https://x.y) and https://i.png',
        '☑ done',
        '',
        '```ts',
        'const **a** = 1; // # not a heading',
        '```',
        'Inline `**raw**` stays. html *escaped*',
        '———',
      ].join('\n'),
    );
  });
  it('keeps autolinks plain', () => {
    expect(renderNostrText('see <https://a.b> and [https://c.d](https://c.d)')).toBe(
      'see https://a.b and https://c.d',
    );
  });
});

describe('tags', () => {
  const k = generateAgentKey();
  it('hops', () => {
    expect(hopsTag(3)).toEqual(['beamhop-hops', '3']);
    expect(parseHops([['beamhop-hops', '4']])).toBe(4);
    expect(parseHops([['beamhop-hops', 'abc']])).toBe(0);
    expect(parseHops([['beamhop-hops', '99999999']])).toBe(0);
    expect(parseHops([])).toBe(0);
  });
  it('mentions via p tag or nostr: URI', () => {
    expect(mentions({ tags: [['p', k.pubkey]], content: '' }, k.pubkey)).toBe(true);
    expect(mentions({ tags: [], content: `hi nostr:${k.npub}!` }, k.pubkey)).toBe(true);
    expect(mentions({ tags: [], content: `hi ${k.npub}` }, k.pubkey)).toBe(false);
    expect(contentMentions('nostr:npub1invalid')).toEqual([]);
  });
  it('thread refs (marked, positional, q)', () => {
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    expect(
      threadRefs([
        ['e', a, '', 'root'],
        ['e', b, '', 'reply'],
      ]),
    ).toEqual({ root: a, reply: b });
    expect(threadRefs([['e', a, '', 'root']])).toEqual({ root: a, reply: a });
    expect(
      threadRefs([
        ['e', a],
        ['e', b],
      ]),
    ).toEqual({ root: a, reply: b });
    expect(threadRefs([['q', b]])).toEqual({ reply: b });
    expect(threadRefs([['e', 'nothex', '', 'root']])).toEqual({});
  });
  it('attachments from imeta and URLs', () => {
    const atts = extractAttachments({
      tags: [['imeta', 'url https://f.co/a.bin', 'm application/x-thing', `x ${'c'.repeat(64)}`, 'size 12']],
      content: 'look https://f.co/b.jpg and https://f.co/page',
    });
    expect(atts).toEqual([
      {
        name: 'a.bin',
        mime: 'application/x-thing',
        url: 'https://f.co/a.bin',
        sha256: 'c'.repeat(64),
        size: 12,
      },
      { name: 'b.jpg', mime: 'image/jpeg', url: 'https://f.co/b.jpg' },
    ]);
    expect(
      imetaTags([
        { name: 'x', mime: 'image/png', url: 'https://u/x.png' },
        { name: 'y', mime: 'a/b' },
      ]),
    ).toEqual([['imeta', 'url https://u/x.png', 'm image/png']]);
  });
});

describe('lru / rate limit', () => {
  it('bounds memory', () => {
    const s = new SeenSet(3);
    for (const id of ['a', 'b', 'c', 'd']) expect(s.add(id)).toBe(true);
    expect(s.has('a')).toBe(false);
    expect(s.add('d')).toBe(false);
    const m = new LruMap<string, number>(2);
    m.set('x', 1);
    m.set('y', 2);
    m.get('x');
    m.set('z', 3);
    expect(m.keys()).toEqual(['x', 'z']);
  });
  it('rate limits in a sliding window', () => {
    let t = 0;
    const r = new RateLimiter(2, 1000, () => t);
    expect(r.take()).toBe(true);
    expect(r.take()).toBe(true);
    expect(r.take()).toBe(false);
    expect(r.retryAfterMs()).toBe(1000);
    t = 1001;
    expect(r.take()).toBe(true);
  });
});

describe('NIP-11', () => {
  it('fetches the relay document with the nostr+json accept header', async () => {
    let headers: Record<string, string> | undefined;
    const info = await fetchRelayInfo('wss://relay.example/', {
      fetch: async (url, init) => {
        headers = init?.headers;
        expect(url).toBe('https://relay.example/');
        return { ok: true, status: 200, json: async () => ({ name: 'r', supported_nips: 29 }) };
      },
    });
    expect(headers?.Accept).toBe('application/nostr+json');
    expect(supportsNip(info, 29)).toBe(true);
    expect(relayHttpUrl('ws://a:1')).toBe('http://a:1');
    await expect(
      fetchRelayInfo('wss://x', { fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }) }),
    ).rejects.toThrow(/404/);
  });
});

describe('relay pool', () => {
  let A: FakeRelay;
  let B: FakeRelay;
  beforeAll(async () => {
    A = await new FakeRelay().start();
    B = await new FakeRelay().start();
  });
  afterAll(async () => {
    await A.stop();
    await B.stop();
  });

  it('dedupes across relays, publishes everywhere, survives a dead relay', async () => {
    const k = generateAgentKey();
    const pool = new RelayPool({
      relays: [A.url, B.url, 'ws://127.0.0.1:1'],
      backoff: { initialMs: 50, maxMs: 100 },
    });
    const got: string[] = [];
    pool.subscribe([{ kinds: [1], authors: [k.pubkey] }], { onevent: (e) => got.push(e.id) });
    await waitFor(() => A.subscriptions && B.subscriptions);
    const ev = finalizeEvent({ kind: 1, created_at: now(), tags: [], content: 'x' }, k.secretKey);
    const res = await pool.publish(ev);
    expect(res.ok.sort()).toEqual([A.url, B.url].map((u) => `${u}/`).sort());
    expect(res.failed).toHaveLength(1);
    await waitFor(() => got.length);
    expect(got).toEqual([ev.id]);
    const q = await pool.query([{ ids: [ev.id] }], { timeoutMs: 2000 });
    expect(q.map((e) => e.id)).toEqual([ev.id]);
    pool.close();
  });

  it('publish with quorum resolves on the first OK without waiting for slow relays', async () => {
    const k = generateAgentKey();
    // 10.255.255.1 is unroutable: the connect attempt hangs until its timeout.
    const pool = new RelayPool({ relays: [A.url, 'ws://10.255.255.1:7777'], connectTimeoutMs: 5000 });
    const ev = finalizeEvent({ kind: 1, created_at: now(), tags: [], content: 'q' }, k.secretKey);
    const t0 = Date.now();
    const res = await pool.publish(ev, { quorum: 1 });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(res.ok).toEqual([`${A.url}/`]);
    pool.close();
  });

  it('drops events with invalid signatures', async () => {
    const k = generateAgentKey();
    const pool = new RelayPool({ relays: [A.url] });
    const got: string[] = [];
    pool.subscribe([{ kinds: [1], authors: [k.pubkey] }], { onevent: (e) => got.push(e.content) });
    await waitFor(() => A.subscriptions);
    const ev = finalizeEvent({ kind: 1, created_at: now(), tags: [], content: 'real' }, k.secretKey);
    A.inject({ ...ev, content: 'tampered' });
    A.inject(ev);
    await waitFor(() => got.length);
    expect(got).toEqual(['real']);
    pool.close();
  });
});
