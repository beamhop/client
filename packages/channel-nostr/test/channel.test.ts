import { isBeamhopError } from '@beamhop/core';
import type { Event } from 'nostr-tools/core';
import * as nip17 from 'nostr-tools/nip17';
import { createRumor, createSeal, createWrap } from 'nostr-tools/nip59';
import { finalizeEvent } from 'nostr-tools/pure';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createNostrChannel,
  groupConversationId,
  type NostrConn,
  parseGroupRef,
  splitText,
} from '../src/channel.ts';
import { generateAgentKey } from '../src/keys.ts';
import { HOPS_TAG } from '../src/tags.ts';
import { collect, makeCtx, memoryKV } from './helpers/ctx.ts';
import { FakeRelay, sleep, waitFor } from './helpers/fake-relay.ts';

const now = () => Math.floor(Date.now() / 1000);
const plugin = createNostrChannel({ backoff: { initialMs: 50, maxMs: 200 } });

let A: FakeRelay;
let B: FakeRelay;
let G: FakeRelay;
const agent = generateAgentKey();
const user = generateAgentKey();
const conns: NostrConn[] = [];

beforeAll(async () => {
  A = await new FakeRelay().start();
  B = await new FakeRelay().start();
  G = await new FakeRelay({ authForWrites: true }).start();
});
afterAll(async () => {
  await Promise.all([A.stop(), B.stop(), G.stop()]);
});
afterEach(async () => {
  for (const c of conns.splice(0)) await c.close();
  await sleep(20);
  for (const r of [A, B, G]) r.reset();
});

const connect = async (settings: Record<string, unknown>, state = memoryKV()) => {
  const c = await plugin.connect(makeCtx(settings, agent.nsec, state));
  conns.push(c);
  return c;
};

const subsReady = (r: FakeRelay, n = 1) => waitFor(() => r.subscriptions >= n);

const dmToAgent = (text: string, tags: string[][] = [], createdAt = now()) => {
  const rumor = createRumor(
    { kind: 14, content: text, tags: [['p', agent.pubkey], ...tags], created_at: createdAt },
    user.secretKey,
  );
  return { rumor, wrap: createWrap(createSeal(rumor, user.secretKey, agent.pubkey), agent.pubkey) };
};

const unwrapFor = (r: FakeRelay, key: typeof user) =>
  r.events
    .filter((e) => e.kind === 1059 && e.tags.some((t) => t[0] === 'p' && t[1] === key.pubkey))
    .map((e) => nip17.unwrapEvent(e, key.secretKey));

describe('NIP-17 DMs', () => {
  it('receives a gift-wrapped DM once across relays and replies wrapped to recipient and self', async () => {
    const conn = await connect({ relays: [A.url, B.url] });
    const inbox = collect(conn.inbound());
    await subsReady(A);
    await subsReady(B);
    expect(conn.self.principal).toBe(`nostr:${agent.npub}`);
    expect(conn.capabilities).toEqual({
      edit: false,
      buttons: false,
      typing: false,
      files: true,
      threads: true,
    });

    const { rumor, wrap } = dmToAgent('hello agent https://example.com/pic.png');
    A.inject(wrap);
    B.inject(wrap);
    const [m] = await waitFor(() => (inbox.length ? inbox : undefined));
    await sleep(100);
    expect(inbox).toHaveLength(1);
    expect(m!.id).toBe(rumor.id);
    expect(m!.from.principal).toBe(`nostr:${user.npub}`);
    expect(m!.conversation).toEqual({ kind: 'dm', id: user.npub });
    expect(m!.threadId).toBe(user.npub);
    expect(m!.text).toContain('hello agent');
    expect(m!.attachments[0]).toMatchObject({ mime: 'image/png', url: 'https://example.com/pic.png' });
    expect(m!.hops).toBe(0);
    expect(m!.from.isBot).toBe(false);

    const sent = await conn.send({
      conversation: { kind: 'dm', id: user.npub },
      threadId: m!.threadId,
      replyToId: m!.id,
      markdown: '**Hi** back, see `code`',
      hops: 2,
    });
    const got = await waitFor(() => unwrapFor(A, user).find((r) => r.id === sent.id));
    expect(got.content).toBe('Hi back, see `code`');
    expect(got.pubkey).toBe(agent.pubkey);
    expect(got.tags).toContainEqual(['e', rumor.id, '', 'reply']);
    expect(got.tags).toContainEqual([HOPS_TAG, '2']);
    expect(got.tags).toContainEqual(['p', user.pubkey]);
    // self copy (wrapped to the agent) exists and is not re-delivered as inbound
    await waitFor(() => unwrapFor(A, agent).find((r) => r.id === sent.id));
    // reply to the agent stays in the same thread and is flagged replyToAgent
    const r2 = dmToAgent('thanks', [['e', sent.id, '', 'reply']]);
    A.inject(r2.wrap);
    const m2 = await waitFor(() => inbox[1]);
    expect(m2.replyToAgent).toBe(true);
    expect(m2.replyToId).toBe(sent.id);
    expect(m2.threadId).toBe(user.npub);
    expect(inbox).toHaveLength(2);
  });

  it('a third party cannot read the DM (NIP-44 encryption)', async () => {
    const conn = await connect({ relays: [A.url] });
    const sent = await conn.send({ conversation: { kind: 'dm', id: user.pubkey }, markdown: 'secret stuff' });
    const eve = generateAgentKey();
    const wraps = A.events.filter((e) => e.kind === 1059);
    expect(wraps.some((w) => w.content.includes('secret'))).toBe(false);
    for (const w of wraps) expect(() => nip17.unwrapEvent(w, eve.secretKey)).toThrow();
    expect(unwrapFor(A, user).some((r) => r.id === sent.id)).toBe(true);
  });

  it('drops stale, duplicate and forged DMs (replay protection)', async () => {
    const conn = await connect({ relays: [A.url] });
    const inbox = collect(conn.inbound());
    await subsReady(A);
    const old = dmToAgent('old one', [], now() - 600);
    A.inject(old.wrap);
    const fresh = dmToAgent('fresh');
    A.inject(fresh.wrap);
    A.inject(fresh.wrap); // replayed copy
    // Same rumor re-wrapped in a new gift wrap → still deduped by rumor id
    A.inject(createWrap(createSeal(fresh.rumor, user.secretKey, agent.pubkey), agent.pubkey));
    // Seal signed by someone else claiming to be the user → rejected by unwrap
    const mallory = generateAgentKey();
    const forgedRumor = {
      ...createRumor({ kind: 14, content: 'forged', tags: [['p', agent.pubkey]] }, mallory.secretKey),
      pubkey: user.pubkey,
    };
    A.inject(createWrap(createSeal(forgedRumor, mallory.secretKey, agent.pubkey), agent.pubkey));
    await waitFor(() => inbox.length);
    await sleep(150);
    expect(inbox.map((m) => m.text)).toEqual(['fresh']);
  });

  it('persists seen ids so a restart does not re-deliver', async () => {
    const state = memoryKV();
    const c1 = await connect({ relays: [A.url] }, state);
    const inbox1 = collect(c1.inbound());
    await subsReady(A);
    const d = dmToAgent('only once');
    A.inject(d.wrap);
    await waitFor(() => inbox1.length);
    await c1.close();
    expect((state.data.get('seen') as string[]).includes(d.rumor.id)).toBe(true);
    const c2 = await connect({ relays: [A.url] }, state);
    const inbox2 = collect(c2.inbound());
    await sleep(300); // relay replays stored wrap on REQ
    expect(inbox2.filter((m) => m.id === d.rumor.id)).toHaveLength(0);
  });

  it('rejects invalid recipients and empty messages', async () => {
    const conn = await connect({ relays: [A.url] });
    await expect(
      conn.send({ conversation: { kind: 'dm', id: 'nope' }, markdown: 'x' }),
    ).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(
      conn.send({ conversation: { kind: 'dm', id: user.npub }, markdown: '   ' }),
    ).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });
});

describe('NIP-29 groups', () => {
  const groupMsg = (content: string, tags: string[][] = [], h = 'g1', kind = 9, key = user) =>
    finalizeEvent({ kind, created_at: now(), tags: [['h', h], ...tags], content }, key.secretKey);

  it('normalizes group messages, detects mentions and replies, and sends kind 9 with h/previous tags', async () => {
    const conn = await connect({ relays: [A.url], groups: [{ relay: G.url, id: 'g1' }] });
    const inbox = collect(conn.inbound());
    await subsReady(G);
    await subsReady(A);
    const convId = groupConversationId(G.url, 'g1');
    expect(convId).toBe(`127.0.0.1:${G.port}'g1`);

    const plain = groupMsg('just chatting');
    G.inject(plain);
    const byP = groupMsg('hey you', [['p', agent.pubkey]]);
    G.inject(byP);
    const byUri = groupMsg(`ping nostr:${agent.npub} please`);
    G.inject(byUri);
    G.inject(groupMsg('other group', [['p', agent.pubkey]], 'g2'));
    A.inject(groupMsg('not the authority relay', [['p', agent.pubkey]])); // same h on a non-group relay
    await waitFor(() => inbox.length >= 3);
    await sleep(100);
    expect(inbox.map((m) => [m.text, m.mentionsAgent])).toEqual([
      ['just chatting', false],
      ['hey you', true],
      [`ping nostr:${agent.npub} please`, true],
    ]);
    const m = inbox[1]!;
    expect(m.conversation).toMatchObject({ kind: 'group', id: convId });
    expect(m.threadId).toBe(convId);

    // Group relay requires NIP-42 auth for writes: the pool must authenticate and retry.
    const sent = await conn.send({
      conversation: { kind: 'group', id: convId },
      replyToId: m.id,
      markdown: '# Answer\nyes',
      hops: 1,
    });
    const ev = G.received.find((e) => e.id === sent.id)!;
    expect(ev.kind).toBe(9);
    expect(ev.content).toBe('Answer\nyes');
    expect(ev.tags).toContainEqual(['h', 'g1']);
    expect(ev.tags).toContainEqual(['e', m.id, G.url, 'reply']);
    expect(ev.tags).toContainEqual(['p', user.pubkey]);
    expect(ev.tags).toContainEqual([HOPS_TAG, '1']);
    const prev = ev.tags.find((t) => t[0] === 'previous')!;
    expect(prev.slice(1)).toContain(byUri.id.slice(0, 8));

    // A reply to the agent is detected even without a mention, and keeps the thread
    const reply = groupMsg('follow-up', [['e', sent.id, G.url, 'reply']]);
    G.inject(reply);
    const r = await waitFor(() => inbox.find((x) => x.id === reply.id));
    expect(r.replyToAgent).toBe(true);
    expect(r.mentionsAgent).toBe(false);
    expect(r.threadId).toBe(convId);

    // kind 11 thread root starts its own thread; replies with root tag join it
    const root = groupMsg('A thread', [['title', 'Topic']], 'g1', 11);
    G.inject(root);
    const inThread = groupMsg(
      'in thread',
      [
        ['e', root.id, G.url, 'root'],
        ['p', agent.pubkey],
      ],
      'g1',
      9,
    );
    G.inject(inThread);
    const t = await waitFor(() => inbox.find((x) => x.id === inThread.id));
    expect(t.threadId).toBe(root.id);
    expect(inbox.find((x) => x.id === root.id)!.text).toBe('Topic\n\nA thread');
  });

  describe('removal (kind 9001) is honored only from group admins (R-B4)', () => {
    const relayKey = generateAgentKey();
    const admin = generateAgentKey();
    const member = generateAgentKey();
    let nip11: Record<string, unknown> = {};
    const adminPlugin = createNostrChannel({
      backoff: { initialMs: 50, maxMs: 200 },
      fetch: async () => ({ ok: true, status: 200, json: async () => nip11 }),
    });
    const connectG = async () => {
      const c = await adminPlugin.connect(
        makeCtx({ relays: [A.url], groups: [`${G.url}'g1`] }, agent.nsec, memoryKV()),
      );
      conns.push(c);
      const removed: string[] = [];
      c.onRemoved!((x) => removed.push(x));
      await subsReady(G);
      return { c, removed };
    };
    const removal = (by: typeof admin, group = 'g1') =>
      finalizeEvent(
        {
          kind: 9001,
          created_at: now(),
          tags: [
            ['h', group],
            ['p', agent.pubkey],
          ],
          content: '',
        },
        by.secretKey,
      );
    const adminList = (signer: typeof admin, admins: string[], createdAt = now()) =>
      finalizeEvent(
        {
          kind: 39001,
          created_at: createdAt,
          tags: [['d', 'g1'], ...admins.map((a) => ['p', a, 'admin'])],
          content: '',
        },
        signer.secretKey,
      );

    it('honors an admin listed in the relay-signed 39001 list, and rejects unknown groups', async () => {
      nip11 = { pubkey: relayKey.pubkey, supported_nips: [29] };
      G.inject(adminList(relayKey, [admin.pubkey], now() - 100));
      const { c, removed } = await connectG();
      G.inject(removal(admin));
      await waitFor(() => removed.length);
      expect(removed).toEqual([groupConversationId(G.url, 'g1')]);
      const err = await c
        .send({ conversation: { kind: 'group', id: "x.example'zzz" }, markdown: 'hi' })
        .catch((e) => e);
      expect(isBeamhopError(err) && err.code).toBe('not_found');
    });

    it('honors a removal signed by the relay key itself', async () => {
      nip11 = { pubkey: relayKey.pubkey };
      const { removed } = await connectG();
      G.inject(removal(relayKey));
      await waitFor(() => removed.length);
      expect(removed).toHaveLength(1);
    });

    it('ignores removals by non-admins, forged admin lists, demoted admins and unknown relay keys', async () => {
      nip11 = { pubkey: relayKey.pubkey };
      // A member forges an admin list naming themselves; only the relay's list counts.
      G.inject(adminList(member, [member.pubkey]));
      // The newest relay-signed list no longer names `admin`.
      G.inject(adminList(relayKey, [admin.pubkey], now() - 200));
      G.inject(adminList(relayKey, [relayKey.pubkey], now() - 10));
      const { removed } = await connectG();
      G.inject(removal(member));
      G.inject(removal(admin));
      await sleep(300);
      expect(removed).toEqual([]);

      nip11 = {};
      const second = await connectG();
      G.inject(removal(relayKey));
      await sleep(300);
      expect(second.removed).toEqual([]);
    });
  });

  it('parses group refs', () => {
    expect(parseGroupRef("groups.example.com'abc")).toEqual({ relay: 'wss://groups.example.com', id: 'abc' });
    expect(() => parseGroupRef('nogroup')).toThrow();
  });
});

describe('kind 1 public notes', () => {
  const note = (content: string, tags: string[][] = [], createdAt = now()) =>
    finalizeEvent({ kind: 1, created_at: createdAt, tags, content }, user.secretKey);

  it('ignores public mentions unless publicNotes is enabled', async () => {
    const conn = await connect({ relays: [A.url] });
    const inbox = collect(conn.inbound());
    await subsReady(A);
    A.inject(note('hi', [['p', agent.pubkey]]));
    await sleep(150);
    expect(inbox).toHaveLength(0);
    await expect(
      conn.send({ conversation: { kind: 'public', id: 'notes' }, markdown: 'x' }),
    ).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('responds to p-tag mentions with NIP-10 replies, rate-limited', async () => {
    const conn = await connect({ relays: [A.url], publicNotes: true, publicNotesPerMinute: 2 });
    const inbox = collect(conn.inbound());
    await subsReady(A);
    const root = note('root post');
    A.inject(root);
    const mention = note('@agent what do you think?', [
      ['e', root.id, '', 'root'],
      ['p', agent.pubkey],
    ]);
    A.inject(mention);
    A.inject(note('stale mention', [['p', agent.pubkey]], now() - 3600));
    const m = await waitFor(() => inbox[0]);
    await sleep(100);
    expect(inbox).toHaveLength(1);
    expect(m.conversation.kind).toBe('public');
    expect(m.threadId).toBe(root.id);
    expect(m.mentionsAgent).toBe(true);

    const sent = await conn.send({
      conversation: m.conversation,
      threadId: m.threadId,
      replyToId: m.id,
      markdown: 'Good idea',
    });
    const ev = A.received.find((e) => e.id === sent.id)!;
    expect(ev.kind).toBe(1);
    expect(ev.tags).toContainEqual(['e', root.id, '', 'root']);
    expect(ev.tags).toContainEqual(['e', mention.id, '', 'reply']);
    expect(ev.tags).toContainEqual(['p', user.pubkey]);

    await conn.send({ conversation: m.conversation, markdown: 'second' });
    const err = await conn.send({ conversation: m.conversation, markdown: 'third' }).catch((e) => e);
    expect(err.code).toBe('rate_limited');
  });
});

describe('NIP-90 jobs', () => {
  it('exposes job requests as DMs with a job marker; sends feedback and kind+1000 results without payment tags', async () => {
    const conn = await connect({ relays: [A.url] });
    const inbox = collect(conn.inbound());
    await subsReady(A);
    const req = finalizeEvent(
      {
        kind: 5050,
        created_at: now(),
        tags: [
          ['i', 'Summarize: beamhop is a daemon', 'text'],
          ['param', 'lang', 'en'],
          ['output', 'text/plain'],
          ['bid', '10000'],
          ['p', agent.pubkey],
          [HOPS_TAG, '1'],
        ],
        content: '',
      },
      user.secretKey,
    );
    A.inject(req);
    const m = await waitFor(() => inbox[0]);
    expect(m.conversation).toMatchObject({ kind: 'dm', id: user.npub });
    expect(m.threadId).toBe(req.id);
    expect(m.hops).toBe(1);
    expect(m.text).toContain('Summarize: beamhop is a daemon');
    expect(m.text).toContain('param lang: en');
    expect(m.text).not.toContain('10000');
    const job = (m.raw as { job: { kind: number; resultKind: number } }).job;
    expect(job).toMatchObject({ kind: 5050, resultKind: 6050 });

    await conn.jobFeedback(req.id, 'processing', 'working on it');
    const fb = await waitFor(() => A.received.find((e) => e.kind === 7000));
    expect(fb.tags).toContainEqual(['status', 'processing', 'working on it']);
    expect(fb.tags).toContainEqual(['p', user.pubkey]);
    expect(fb.tags.find((t) => t[0] === 'e')?.[1]).toBe(req.id);

    const sent = await conn.send({
      conversation: m.conversation,
      threadId: m.threadId,
      markdown: 'A daemon.',
      hops: 2,
    });
    const res = A.received.find((e) => e.id === sent.id)!;
    expect(res.kind).toBe(6050);
    expect(res.content).toBe('A daemon.');
    expect(JSON.parse(res.tags.find((t) => t[0] === 'request')![1]!).id).toBe(req.id);
    expect(res.tags).toContainEqual(['p', user.pubkey]);
    expect(res.tags).toContainEqual(['i', 'Summarize: beamhop is a daemon', 'text']);
    expect(res.tags).toContainEqual([HOPS_TAG, '2']);
    for (const e of [fb, res]) expect(e.tags.some((t) => t[0] === 'amount' || t[0] === 'bid')).toBe(false);
    await expect(conn.jobFeedback('f'.repeat(64), 'error')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rejects encrypted job requests with error feedback', async () => {
    const conn = await connect({ relays: [A.url] });
    const inbox = collect(conn.inbound());
    await subsReady(A);
    const req = finalizeEvent(
      { kind: 5100, created_at: now(), tags: [['p', agent.pubkey], ['encrypted']], content: 'ciphertext' },
      user.secretKey,
    );
    A.inject(req);
    const fb = await waitFor(() =>
      A.received.find((e) => e.kind === 7000 && e.tags.some((t) => t[1] === req.id)),
    );
    expect(fb.tags.find((t) => t[0] === 'status')?.[1]).toBe('error');
    expect(inbox).toHaveLength(0);
  });
});

describe('mesh hops', () => {
  it('parses hops from agent-sent events and marks them as bots', async () => {
    const conn = await connect({ relays: [A.url] });
    const inbox = collect(conn.inbound());
    await subsReady(A);
    A.inject(dmToAgent('from another agent', [[HOPS_TAG, '3']]).wrap);
    A.inject(dmToAgent('bogus hops', [[HOPS_TAG, '-5']]).wrap);
    await waitFor(() => inbox.length >= 2);
    const byText = Object.fromEntries(inbox.map((m) => [m.text, m]));
    expect(byText['from another agent']).toMatchObject({ hops: 3, from: { isBot: true } });
    expect(byText['bogus hops']!.hops).toBe(0);
  });
});

describe('connection', () => {
  it('requires a valid nsec', async () => {
    await expect(plugin.connect(makeCtx({ relays: [A.url] }, 'garbage'))).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(plugin.connect(makeCtx({ relays: ['http://x'] }, agent.nsec))).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('reconnects and resubscribes after the relay drops connections', async () => {
    const conn = await connect({ relays: [A.url] });
    const inbox = collect(conn.inbound());
    await subsReady(A);
    A.dropAll();
    await waitFor(() => A.subscriptions >= 1, 5000);
    A.inject(dmToAgent('after reconnect').wrap);
    await waitFor(() => inbox.find((m) => m.text === 'after reconnect'));
    expect(conn.status()[0]!.connected).toBe(true);
  });

  it('typing is a no-op and close ends the inbound stream', async () => {
    const conn = await connect({ relays: [A.url] });
    await conn.typing!('x');
    const it = conn.inbound()[Symbol.asyncIterator]();
    const next = it.next();
    await conn.close();
    expect((await next).done).toBe(true);
  });

  it('splits long text on paragraph boundaries', () => {
    const parts = splitText(`${'a'.repeat(9000)}\n\n${'b'.repeat(9000)}`);
    expect(parts).toHaveLength(2);
    expect(parts[1]).toBe('b'.repeat(9000));
  });

  it('setup wizard validates key and relays', async () => {
    const fetch = async (url: string) => ({
      ok: url.includes('127.0.0.1'),
      status: url.includes('127.0.0.1') ? 200 : 500,
      json: async () => ({ supported_nips: [1, 29] }),
    });
    const p = createNostrChannel({ fetch });
    expect((await p.setup.validate({ relays: [A.url] }, { nsec: 'bad' })).ok).toBe(false);
    const ok = await p.setup.validate({ relays: [A.url, 'wss://down.example'] }, { nsec: agent.nsec });
    expect(ok.ok).toBe(true);
    expect(ok.identity?.handle).toBe(agent.npub);
    expect(ok.message).toContain('unreachable');
  });
});

export type { Event };

describe('history', () => {
  it('reads a DM conversation from gift wraps (both directions) and a group from its relay, oldest first', async () => {
    const conn = await connect({ relays: [A.url], groups: [{ relay: G.url, id: 'g1' }] });
    await subsReady(A);
    const t0 = now() - 100;
    A.inject(dmToAgent('first', [], t0).wrap, true);
    A.inject(dmToAgent('second', [], t0 + 10).wrap, true);
    // a DM from someone else is another conversation
    const other = generateAgentKey();
    const foreign = createRumor(
      { kind: 14, content: 'not yours', tags: [['p', agent.pubkey]], created_at: t0 + 5 },
      other.secretKey,
    );
    A.inject(createWrap(createSeal(foreign, other.secretKey, agent.pubkey), agent.pubkey), true);
    const sent = await conn.send({ conversation: { kind: 'dm', id: user.npub }, markdown: 'my reply' });
    await waitFor(() => unwrapFor(A, agent).find((r) => r.id === sent.id));

    const dm = await conn.fetchHistory!({ conversation: { kind: 'dm', id: user.npub }, limit: 10 });
    expect(dm.map((m) => [m.text, !!m.self])).toEqual([
      ['first', false],
      ['second', false],
      ['my reply', true],
    ]);
    expect(dm[0]!.from.principal).toBe(`nostr:${user.npub}`);

    const convId = groupConversationId(G.url, 'g1');
    G.inject(
      finalizeEvent({ kind: 9, created_at: t0, tags: [['h', 'g1']], content: 'group hello' }, user.secretKey),
    );
    G.inject(
      finalizeEvent(
        { kind: 9, created_at: t0 + 1, tags: [['h', 'g2']], content: 'elsewhere' },
        user.secretKey,
      ),
    );
    const grp = await conn.fetchHistory!({ conversation: { kind: 'group', id: convId }, limit: 10 });
    expect(grp.map((m) => m.text)).toEqual(['group hello']);
  });
});
