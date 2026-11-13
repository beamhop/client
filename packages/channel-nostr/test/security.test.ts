// Security review wave B: Nostr identity, replay and dedupe hardening, plus fuzzing.
import type { InboundMsg } from '@beamhop/core';
import fc from 'fast-check';
import type { Event } from 'nostr-tools/core';
import * as nip44 from 'nostr-tools/nip44';
import { createRumor, createSeal, createWrap } from 'nostr-tools/nip59';
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey } from 'nostr-tools/pure';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createNostrChannel, type NostrConn } from '../src/channel.ts';
import { generateAgentKey } from '../src/keys.ts';
import { renderNostrText } from '../src/markdown.ts';
import { extractAttachments, parseHops, threadRefs } from '../src/tags.ts';
import { unwrapGiftWrap } from '../src/unwrap.ts';
import { collect, makeCtx } from './helpers/ctx.ts';
import { FakeRelay, waitFor } from './helpers/fake-relay.ts';

const agent = generateAgentKey();
const owner = generateAgentKey();
const mallory = generateAgentKey();
let R: FakeRelay;
const conns: NostrConn[] = [];
let clock = Math.floor(Date.now() / 1000);

beforeAll(async () => {
  R = await new FakeRelay().start();
});
afterAll(async () => {
  await R.stop();
});
afterEach(async () => {
  for (const c of conns.splice(0)) await c.close();
  R.reset();
  clock = Math.floor(Date.now() / 1000);
});

const connect = async (settings: Record<string, unknown> = {}) => {
  const plugin = createNostrChannel({ now: () => clock, backoff: { initialMs: 50, maxMs: 200 } });
  const c = (await plugin.connect(makeCtx({ relays: [R.url], ...settings }, agent.nsec))) as NostrConn & {
    handle(ev: Event, relay: string): void;
  };
  conns.push(c);
  return { conn: c, inbox: collect(c.inbound()) };
};

const dm = (text: string, from = owner, createdAt = clock) => {
  const rumor = createRumor(
    { kind: 14, content: text, tags: [['p', agent.pubkey]], created_at: createdAt },
    from.secretKey,
  );
  return { rumor, wrap: createWrap(createSeal(rumor, from.secretKey, agent.pubkey), agent.pubkey) };
};

/** Hand-rolled seal/wrap so tests can put anything inside (forged authors, forged ids). */
const wrapRaw = (rumor: Record<string, unknown>, sealer: Uint8Array): Event => {
  const seal = finalizeEvent(
    {
      kind: 13,
      created_at: clock,
      tags: [],
      content: nip44.v2.encrypt(
        JSON.stringify(rumor),
        nip44.v2.utils.getConversationKey(sealer, agent.pubkey),
      ),
    },
    sealer,
  );
  const eph = generateSecretKey();
  return finalizeEvent(
    {
      kind: 1059,
      created_at: clock,
      tags: [['p', agent.pubkey]],
      content: nip44.v2.encrypt(JSON.stringify(seal), nip44.v2.utils.getConversationKey(eph, agent.pubkey)),
    },
    eph,
  );
};

const settle = () => new Promise((r) => setTimeout(r, 20));

describe('NOS-1: replay after dedupe eviction', () => {
  it('a flood of junk gift wraps cannot evict a real DM id and let it be replayed', async () => {
    const { conn, inbox } = await connect();
    const { wrap } = dm('/approve apr_1');
    conn.handle(wrap, R.url);
    await waitFor(() => inbox.length === 1);
    // Junk wraps: cheap to mint, fail to decrypt. Before the fix each one was recorded in the same
    // bounded set as authenticated ids, evicting them.
    const junkKey = '00'.repeat(32);
    for (let i = 0; i < 25_000; i++)
      conn.handle({ ...wrap, id: i.toString(16).padStart(64, '0'), pubkey: junkKey }, R.url);
    conn.handle(wrap, R.url);
    await settle();
    expect(inbox).toHaveLength(1);
  });

  it('events older than maxEventAgeS are dropped even on a long-running connection', async () => {
    const { conn, inbox } = await connect();
    const old = dm('/stop', owner, clock + 60);
    clock += 2 * 24 * 3600; // two days later, still connected
    conn.handle(old.wrap, R.url);
    const fresh = dm('hello', owner, clock);
    conn.handle(fresh.wrap, R.url);
    await waitFor(() => inbox.length === 1);
    await settle();
    expect(inbox.map((m) => m.text)).toEqual(['hello']);
  });
});

describe('NOS-2: NIP-17 sender authentication', () => {
  it('rejects a rumor that claims the owner as author but is sealed by someone else', async () => {
    const { conn, inbox } = await connect();
    const forged = createRumor(
      { kind: 14, content: '/approve apr_1', tags: [['p', agent.pubkey]], created_at: clock },
      owner.secretKey,
    );
    // Mallory seals the owner-authored rumor with her own key.
    conn.handle(wrapRaw(forged, mallory.secretKey), R.url);
    const ok = dm('legit', mallory);
    conn.handle(ok.wrap, R.url);
    await waitFor(() => inbox.length === 1);
    await settle();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.from.principal).toBe(`nostr:${mallory.npub}`);
  });

  it('unwrapGiftWrap enforces seal signature, author match and rumor id', () => {
    const rumor = createRumor({ kind: 14, content: 'x', tags: [], created_at: clock }, mallory.secretKey);
    expect(unwrapGiftWrap(wrapRaw(rumor, mallory.secretKey), agent.secretKey).pubkey).toBe(mallory.pubkey);
    expect(() =>
      unwrapGiftWrap(wrapRaw({ ...rumor, pubkey: owner.pubkey }, mallory.secretKey), agent.secretKey),
    ).toThrow();
    expect(() =>
      unwrapGiftWrap(wrapRaw({ ...rumor, id: 'ab'.repeat(32) }, mallory.secretKey), agent.secretKey),
    ).toThrow(/id/);
    expect(() =>
      unwrapGiftWrap(wrapRaw({ ...rumor, tags: [[1]] }, mallory.secretKey), agent.secretKey),
    ).toThrow();
  });
});

describe('NOS-3: forged rumor ids cannot suppress other events', () => {
  it('a DM whose rumor id copies a public group event id does not make that event a duplicate', async () => {
    const { conn, inbox } = await connect({ groups: [{ relay: R.url, id: 'g1' }] });
    const groupRelay = (conn as unknown as { groups: { relayUrl: string }[] }).groups[0]!.relayUrl;
    const groupEv = finalizeEvent(
      {
        kind: 9,
        created_at: clock,
        tags: [
          ['h', 'g1'],
          ['p', agent.pubkey],
        ],
        content: 'owner in group',
      },
      owner.secretKey,
    );
    // Mallory saw the event on the public group relay and races it with a forged-id DM.
    const forged = {
      ...createRumor({ kind: 14, content: 'x', tags: [], created_at: clock }, mallory.secretKey),
    };
    forged.id = groupEv.id;
    conn.handle(wrapRaw(forged, mallory.secretKey), R.url);
    conn.handle(groupEv, groupRelay);
    await waitFor(() => inbox.length >= 1);
    await settle();
    expect(inbox.map((m) => m.text)).toEqual(['owner in group']);
  });
});

describe('Nostr parsers (fuzzed)', () => {
  const tag = fc.array(
    fc.oneof(
      fc.string({ unit: 'binary', maxLength: 30 }),
      fc.constantFrom(
        'e',
        'p',
        'imeta',
        'q',
        'beamhop-hops',
        'root',
        'reply',
        `url https://x.y/%E0%A4%A.png`,
        'url https://x.y/../../.ssh/id',
        '9007199254740993',
        '-1',
      ),
    ),
    {
      maxLength: 5,
    },
  );
  const tags = fc.array(tag, { maxLength: 8 });

  it('tag helpers never throw; hops are bounded; attachment names are safe; thread refs are hex', () => {
    fc.assert(
      fc.property(tags, fc.string({ unit: 'binary', maxLength: 200 }), (t, content) => {
        const hops = parseHops(t);
        expect(Number.isSafeInteger(hops) && hops >= 0 && hops <= 1000).toBe(true);
        for (const a of extractAttachments({ tags: t, content: `${content} https://h.x/%E0%A4%A.png` })) {
          expect(a.name).not.toMatch(/[/\\]/);
          expect(a.url).toMatch(/^https?:\/\//);
        }
        const refs = threadRefs(t);
        for (const v of [refs.root, refs.reply]) if (v !== undefined) expect(v).toMatch(/^[0-9a-f]{64}$/);
      }),
      { numRuns: 1000 },
    );
  });

  it('handle() never throws and never emits a principal other than the signer', async () => {
    const { conn, inbox } = await connect({ groups: [{ relay: R.url, id: 'g1' }], publicNotes: true });
    const groupRelay = (conn as unknown as { groups: { relayUrl: string }[] }).groups[0]!.relayUrl;
    const signers = [owner, mallory];
    const before = inbox.length;
    const expected: string[] = [];
    fc.assert(
      fc.property(
        fc.constantFrom(1, 9, 11, 1059, 5050, 9001, 7),
        tags,
        fc.string({ unit: 'binary', maxLength: 100 }),
        fc.integer({ min: 0, max: 1 }),
        (kind, t, content, who) => {
          const s = signers[who]!;
          const ev = finalizeEvent(
            { kind, created_at: clock, tags: [...t, ['p', agent.pubkey], ['h', 'g1']], content },
            s.secretKey,
          );
          expected.push(`nostr:${s.npub}`);
          expect(() => conn.handle(ev, groupRelay)).not.toThrow();
          expect(() => conn.handle({ ...ev, content: '{', kind: 1059 }, R.url)).not.toThrow();
        },
      ),
      { numRuns: 200 },
    );
    await settle();
    const principals = new Set(expected);
    for (const m of inbox.slice(before) as InboundMsg[]) expect(principals.has(m.from.principal)).toBe(true);
  });

  it('renderNostrText is fast on adversarial input', () => {
    const t0 = performance.now();
    for (const unit of ['**a ', '__a ', '~~a ', '*a ', '[a](', '<http://'])
      renderNostrText(unit.repeat(20_000));
    expect(performance.now() - t0).toBeLessThan(2_000);
  });

  it('getEventHash sanity for forged ids', () => {
    const r = createRumor({ kind: 14, content: 'x', tags: [], created_at: 1 }, generateSecretKey());
    expect(getEventHash(r)).toBe(r.id);
    expect(getPublicKey(agent.secretKey)).toBe(agent.pubkey);
  });
});
