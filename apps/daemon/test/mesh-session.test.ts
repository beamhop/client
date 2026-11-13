// Mesh tools go out on the asking agent's own Nostr key (nostr@<agent>), and resumed sessions on
// agent-keyed channels keep their real conversation kind.
import { rmSync } from 'node:fs';
import { createNostrChannel } from '@beamhop/channel-nostr';
import { silentLogger } from '@beamhop/core';
import { ConfigStore } from '@beamhop/store';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { FakeRelay } from '../../../packages/channel-nostr/test/helpers/fake-relay.ts';
import type { NostrMesh } from '../src/mesh.ts';
import type { Turn } from '../src/sessions.ts';
import { FakeChannelPlugin, FakeHarnessPlugin, makeEnv, type TestEnv, tmpHome, until } from './helpers.ts';

let R: FakeRelay;
let env: TestEnv | undefined;
beforeAll(async () => {
  R = await new FakeRelay().start();
});
afterAll(() => R.stop());
afterEach(async () => {
  await env?.d.identity.settled();
  await env?.close();
  if (env) rmSync(env.home, { recursive: true, force: true });
  env = undefined;
  R.reset();
});

const start = async () => {
  const home = tmpHome();
  const cs = new ConfigStore({ home, logger: silentLogger });
  cs.ensureDirs();
  cs.saveGlobal({ nostr: { relays: [R.url] } });
  const harness = new FakeHarnessPlugin();
  const channel = new FakeChannelPlugin();
  env = await makeEnv({
    home,
    harness,
    channel,
    plugins: {
      channels: [createNostrChannel({ WebSocket: WebSocket as never }), channel],
      harnesses: [harness],
    },
    nostrWebSocket: WebSocket,
  });
  return env;
};

describe('mesh uses the asking agent key', () => {
  it('picks nostr@<agent>, never another agent connection', async () => {
    const e = await start();
    for (const name of ['alpha', 'beta'])
      await e.client.call('agent.create', {
        config: { name, harness: 'fake', memberships: [{ target: 'nostr:dm' }] },
      });
    await until(() => !!e.d.channels.get('nostr@alpha') && !!e.d.channels.get('nostr@beta'), 3000, 'conns');
    const mesh = e.d.mesh as NostrMesh;
    expect(mesh.conn('beta').name).toBe('nostr@beta');
    expect(mesh.conn('alpha').name).toBe('nostr@alpha');
    // An agent without its own connection does not borrow another agent's key.
    expect(() => mesh.conn('gamma')).toThrow(/agent gamma/);

    const betaPk = (e.d.channels.get('nostr@beta') as unknown as { pubkey: string }).pubkey;
    const { jobId } = await mesh.postJob({
      agent: 'beta',
      kind: 5050,
      input: 'hi',
      inputType: 'text',
      hops: 1,
    });
    const ev = R.events.find((x) => x.id === jobId)!;
    expect(ev.pubkey).toBe(betaPk);

    // mesh_ask_agent: the question is sent by beta's key, and only an answer to beta resolves it.
    const peer = (e.d.channels.get('nostr@alpha') as unknown as { npub: string }).npub;
    const ctl = new AbortController();
    const asked = mesh.ask({
      agent: 'beta',
      npub: peer,
      question: 'ping?',
      hops: 1,
      timeoutSeconds: 3,
      signal: ctl.signal,
    });
    await until(() => R.events.some((x) => x.kind === 1059), 3000, 'gift wrap');
    const alphaConn = e.d.channels.get('nostr@alpha')!;
    const betaConn = e.d.channels.get('nostr@beta')!;
    const reply = (conn: typeof alphaConn) => ({
      id: `r-${conn.name}`,
      channel: conn.name,
      provider: 'nostr',
      conversation: { kind: 'dm' as const, id: peer },
      threadId: peer,
      from: { principal: `nostr:${peer}` },
      text: `answer via ${conn.name}`,
      attachments: [],
      receivedAt: new Date().toISOString(),
      mentionsAgent: false,
      replyToAgent: false,
    });
    expect(mesh.onInbound(alphaConn, reply(alphaConn) as never)).toBe(false);
    expect(mesh.onInbound(betaConn, reply(betaConn) as never)).toBe(true);
    expect(await asked).toBe('answer via nostr@beta');
  });
});

describe('session conversation kind', () => {
  it('a resumed group session on an agent-keyed channel stays a group session', async () => {
    const e = await start();
    await e.client.call('agent.create', { config: { name: 'bot', harness: 'fake' } });
    const agent = e.d.agent('bot');
    const key = { agent: 'bot', channel: 'nostr@bot', conversationId: 'grp1', threadId: 'grp1' };
    let done!: () => void;
    const finished = new Promise<void>((r) => {
      done = r;
    });
    const turn: Turn = {
      text: 'hello group',
      promptFor: () => 'hello group',
      from: { principal: 'local:owner', role: 'owner' },
      role: e.d.roleDef('owner'),
      attachments: [],
      hops: 0,
      source: 'api',
      done: () => done(),
    };
    const live = await e.d.sessions.submit({
      agent,
      channel: key.channel,
      conversation: { kind: 'group', id: key.conversationId },
      threadId: key.threadId,
      turn,
    });
    expect(live.conversationKind).toBe('group');
    await finished;
    await e.d.sessions.endThread(key, 'test');
    const id = e.d.sessions.resumeThread(key)!;
    expect(id).toBe(live.id);
    expect(e.d.sessions.live(id)!.conversationKind).toBe('group');
    // Without the stored kind, a membership on the base channel (`nostr`) still decides.
    e.d.store.kv.delete('conv-kind', 'nostr@bot|grp1');
    expect(e.d.sessions.kindOf(key)).toBe('dm');
    e.d.config.agents.update('bot', (a) => ({ ...a, memberships: [{ target: 'nostr:group/grp1' }] }));
    expect(e.d.sessions.kindOf(key)).toBe('group');
  });
});
