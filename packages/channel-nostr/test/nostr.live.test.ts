// Live tests against public relays (§4 "Testing on public relays").
// Run: pnpm vitest run -c vitest.live.config.ts packages/channel-nostr
// Throwaway keys per run; notes carry ["t","beamhop-test"] + NIP-40 expiration and are NIP-09 deleted.
import { type InboundMsg, silentLogger } from '@beamhop/core';
import type { Event } from 'nostr-tools/core';
import { finalizeEvent } from 'nostr-tools/pure';
import { afterAll, describe, expect, it } from 'vitest';
import { createNostrChannel, groupConversationId, type NostrConn } from '../src/channel.ts';
import { createControlClient } from '../src/control-client.ts';
import { createControlServer } from '../src/control-server.ts';
import { generateAgentKey } from '../src/keys.ts';
import { fetchRelayInfo, supportsNip } from '../src/nip11.ts';
import { RelayPool } from '../src/pool.ts';
import { collect, makeCtx } from './helpers/ctx.ts';
import { waitFor } from './helpers/fake-relay.ts';
import { LiveWebSocket, liveFetch } from './helpers/proxy.ts';

const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];
/** Public NIP-29 relay verified via NIP-11 (supported_nips includes 29) that allows group creation. */
const GROUP_RELAY = 'wss://relay.highlighter.com';
const TAG = ['t', 'beamhop-test'];
const now = () => Math.floor(Date.now() / 1000);
const expiration = () => ['expiration', String(now() + 300)];
const plugin = createNostrChannel({ WebSocket: LiveWebSocket, fetch: liveFetch });
const nonce = () => Math.random().toString(36).slice(2, 10);

const cleanup: (() => unknown)[] = [];
afterAll(async () => {
  for (const fn of cleanup.reverse()) await fn();
});

const pool = (relays = RELAYS, key?: Uint8Array) => {
  const p = new RelayPool({
    relays,
    WebSocket: LiveWebSocket,
    ...(key ? { signAuth: (t) => finalizeEvent(t, key) } : {}),
  });
  cleanup.push(() => p.close());
  return p;
};

const conn = async (nsec: string, settings: Record<string, unknown> = {}): Promise<NostrConn> => {
  const c = await plugin.connect({ ...makeCtx({ relays: RELAYS, ...settings }, nsec), log: silentLogger });
  cleanup.push(() => c.close());
  return c;
};

const report = (line: string) => console.log(`[live] ${line}`);

/** Which relays return the event id (fresh connection per relay). */
const whereIs = async (id: string, relays = RELAYS) => {
  const res = await Promise.all(
    relays.map(async (r) => {
      const p = pool([r]);
      const evs = await p.query([{ ids: [id] }], { timeoutMs: 6000 });
      p.close();
      return evs.length ? r : undefined;
    }),
  );
  return res.filter(Boolean) as string[];
};

describe('public relays', () => {
  it('each test relay passes a NIP-11 check', async () => {
    for (const r of RELAYS) {
      const info = await fetchRelayInfo(r, { fetch: liveFetch, timeoutMs: 10_000 });
      report(`NIP-11 ${r}: ${info.software ?? '?'} nips=${JSON.stringify(info.supported_nips)}`);
      expect(supportsNip(info, 1)).toBe(true);
    }
  });

  it('NIP-17 DM round trip between two fresh keys', async () => {
    const agentKey = generateAgentKey();
    const userKey = generateAgentKey();
    const agent = await conn(agentKey.nsec);
    const user = await conn(userKey.nsec);
    const agentIn = collect(agent.inbound());
    const userIn = collect(user.inbound());
    await new Promise((r) => setTimeout(r, 1500)); // let subscriptions settle
    const n = nonce();
    const t0 = Date.now();
    const sent = await user.send({ conversation: { kind: 'dm', id: agentKey.npub }, markdown: `ping ${n}` });
    const got = await waitFor(() => agentIn.find((m) => m.text === `ping ${n}`), 45_000, 200);
    report(`DM user→agent delivered in ${Date.now() - t0} ms`);
    expect(got.id).toBe(sent.id);
    expect(got.from.principal).toBe(`nostr:${userKey.npub}`);
    const t1 = Date.now();
    await agent.send({
      conversation: got.conversation,
      threadId: got.threadId,
      replyToId: got.id,
      markdown: `pong ${n}`,
      hops: 1,
    });
    const back: InboundMsg = await waitFor(() => userIn.find((m) => m.text === `pong ${n}`), 45_000, 200);
    report(`DM agent→user delivered in ${Date.now() - t1} ms`);
    expect(back.replyToAgent).toBe(true);
    expect(back.hops).toBe(1);
  });

  it('control-plane RPC round trip', async () => {
    const daemon = generateAgentKey();
    const phone = generateAgentKey();
    const server = createControlServer({
      key: daemon.secretKey,
      allowlist: [phone.npub],
      relays: RELAYS,
      WebSocket: LiveWebSocket,
      handle: (req) => ({ jsonrpc: '2.0', id: req.id, result: { pong: req.params } }),
    });
    cleanup.push(() => server.close());
    await server.ready();
    const client = createControlClient({
      key: phone.nsec,
      daemonPubkey: daemon.npub,
      relays: RELAYS,
      WebSocket: LiveWebSocket,
    });
    cleanup.push(() => client.close());
    await client.ready();
    const t0 = Date.now();
    const res = await client.call<{ pong: unknown }>('system.ping', { n: 1 }, 30_000);
    report(`control RPC round trip in ${Date.now() - t0} ms`);
    expect(res).toEqual({ pong: { n: 1 } });
    // Pushed events
    const evs: unknown[] = [];
    client.onEvent((e) => evs.push(e));
    await server.notify({ type: 'panic', active: false });
    await waitFor(() => evs.length, 30_000, 200);
    expect(evs[0]).toEqual({ type: 'panic', active: false });
  });

  it('kind-1 note publish + fetch, with NIP-40 expiration and NIP-09 delete', async () => {
    const k = generateAgentKey();
    const p = pool();
    const note = finalizeEvent(
      { kind: 1, created_at: now(), tags: [TAG, expiration()], content: `beamhop live test ${nonce()}` },
      k.secretKey,
    );
    const pub = await p.publish(note);
    report(`note accepted by: ${pub.ok.join(', ') || 'none'}; rejected: ${JSON.stringify(pub.failed)}`);
    expect(pub.ok.length).toBeGreaterThan(0);
    const found = await whereIs(note.id);
    report(`note returned by: ${found.join(', ')}`);
    expect(found.length).toBeGreaterThan(0);

    const del = finalizeEvent(
      {
        kind: 5,
        created_at: now(),
        tags: [['e', note.id], ['k', '1'], TAG, expiration()],
        content: 'beamhop test cleanup',
      },
      k.secretKey,
    );
    const delRes = await p.publish(del);
    report(`delete accepted by: ${delRes.ok.join(', ') || 'none'}`);
    expect(delRes.ok.length).toBeGreaterThan(0);
    const after = await whereIs(note.id);
    report(`note still returned after delete by: ${after.join(', ') || 'none'}`);
  });

  it('public mention reaches an agent with publicNotes on', async () => {
    const agentKey = generateAgentKey();
    const userKey = generateAgentKey();
    const agent = await conn(agentKey.nsec, { publicNotes: true });
    const inbox = collect(agent.inbound());
    await new Promise((r) => setTimeout(r, 1500));
    const p = pool();
    const note = finalizeEvent(
      {
        kind: 1,
        created_at: now(),
        tags: [['p', agentKey.pubkey], TAG, expiration()],
        content: `nostr:${agentKey.npub} beamhop live mention ${nonce()}`,
      },
      userKey.secretKey,
    );
    await p.publish(note);
    cleanup.push(() =>
      p.publish(
        finalizeEvent(
          { kind: 5, created_at: now(), tags: [['e', note.id], ['k', '1'], TAG], content: '' },
          userKey.secretKey,
        ),
      ),
    );
    const m = await waitFor(() => inbox.find((x) => x.id === note.id), 45_000, 200);
    expect(m.conversation.kind).toBe('public');
    expect(m.mentionsAgent).toBe(true);
  });
});

describe('NIP-29 group relay', () => {
  it(`group round trip on ${GROUP_RELAY}`, async () => {
    const info = await fetchRelayInfo(GROUP_RELAY, { fetch: liveFetch, timeoutMs: 10_000 });
    report(`NIP-11 ${GROUP_RELAY}: nips=${JSON.stringify(info.supported_nips)}`);
    expect(supportsNip(info, 29)).toBe(true);

    const admin = generateAgentKey();
    const agentKey = generateAgentKey();
    const gid = `beamhop-test-${nonce()}`;
    const ap = pool([GROUP_RELAY], admin.secretKey);
    const created = await ap.publish(
      finalizeEvent({ kind: 9007, created_at: now(), tags: [['h', gid]], content: '' }, admin.secretKey),
    );
    report(`create group ${gid}: ${created.ok.length ? 'ok' : JSON.stringify(created.failed)}`);
    expect(created.ok.length).toBe(1);
    cleanup.push(() =>
      ap.publish(
        finalizeEvent({ kind: 9008, created_at: now(), tags: [['h', gid]], content: '' }, admin.secretKey),
      ),
    );
    const added = await ap.publish(
      finalizeEvent(
        {
          kind: 9000,
          created_at: now(),
          tags: [
            ['h', gid],
            ['p', agentKey.pubkey],
          ],
          content: '',
        },
        admin.secretKey,
      ),
    );
    report(`add agent as member: ${added.ok.length ? 'ok' : JSON.stringify(added.failed)}`);

    const agent = await conn(agentKey.nsec, {
      relays: [RELAYS[0]],
      groups: [{ relay: GROUP_RELAY, id: gid }],
    });
    const inbox = collect(agent.inbound());
    await new Promise((r) => setTimeout(r, 1500));
    const ask = finalizeEvent(
      {
        kind: 9,
        created_at: now(),
        tags: [['h', gid], ['p', agentKey.pubkey], TAG, expiration()],
        content: 'hello agent',
      },
      admin.secretKey,
    );
    const askRes = await ap.publish(ask);
    expect(askRes.ok.length).toBe(1);
    const m = await waitFor(() => inbox.find((x) => x.id === ask.id), 30_000, 200);
    expect(m.conversation).toMatchObject({ kind: 'group', id: groupConversationId(GROUP_RELAY, gid) });
    expect(m.mentionsAgent).toBe(true);
    const sent = await agent.send({
      conversation: m.conversation,
      replyToId: m.id,
      markdown: 'hello admin',
      hops: 1,
    });
    const back = (await ap.query([{ ids: [sent.id] }], { timeoutMs: 8000 })) as Event[];
    report(`agent group reply stored on relay: ${back.length === 1}`);
    expect(back[0]?.tags).toContainEqual(['h', gid]);
  });
});
