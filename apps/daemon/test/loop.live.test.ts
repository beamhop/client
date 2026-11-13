// Live core loop. Run: pnpm vitest run -c vitest.live.config.ts apps/daemon/test/loop.live.test.ts
//
// 1. Nostr: throwaway owner + agent keys on public relays. The owner sends a NIP-17 DM → daemon
//    router → real opencode over ACP inside srt (broker on, beamhop MCP injected) → the agent calls
//    the beamhop `session_status` MCP tool → NIP-17 reply DM back to the owner key.
//    opencode uses its own free default model; that provider has no broker route, so its LLM
//    traffic goes to opencode.ai directly (allow-listed), while the broker env is still present.
// 2. Telegram: the real Bot API. An unknown sender DMs the agent on a fake channel → access
//    request → approval card with inline buttons in the owner's Telegram chat. Exactly one
//    Telegram message per run; the poller is off, so no update offset is ever confirmed.
import { spawnSync } from 'node:child_process';
import { createNostrChannel, generateAgentKey } from '@beamhop/channel-nostr';
import { createTelegramPlugin } from '@beamhop/channel-telegram';
import { type ChannelConn, createLogger, type InboundMsg, type KV, silentLogger } from '@beamhop/core';
import { createAcpHarness } from '@beamhop/harness-acp';
import { afterEach, describe, expect, it } from 'vitest';
import { proxyWebSocket } from '../src/net.ts';
import {
  FakeChannelPlugin,
  FakeHarnessPlugin,
  makeEnv,
  setupBot,
  type TestEnv,
  tmpHome,
  until,
} from './helpers.ts';
import { opencodeBinary, opencodeWorkspace, telegramOwnerChat, telegramToken } from './live-helpers.ts';

const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];
const bin = opencodeBinary();
const hasBwrap =
  process.platform === 'linux' && spawnSync('which', ['bwrap'], { stdio: 'ignore' }).status === 0;

const memKV = (): KV => {
  const m = new Map<string, unknown>();
  return {
    get: async <T>(k: string) => m.get(k) as T | undefined,
    set: async (k, v) => void m.set(k, v),
    delete: async (k) => void m.delete(k),
  };
};

let env: TestEnv | undefined;
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  await env?.close();
  env = undefined;
});

describe.runIf(Boolean(bin) && hasBwrap)(
  'live core loop: Nostr DM → sandboxed opencode (+MCP) → Nostr DM',
  () => {
    it('owner NIP-17 DM "reply with pong" gets a pong DM back, and the agent used session_status', async () => {
      const ws = proxyWebSocket();
      const nostr = createNostrChannel(ws ? { WebSocket: ws } : {});
      const agentKey = generateAgentKey();
      const ownerKey = generateAgentKey();
      const { work, sandbox } = opencodeWorkspace(tmpHome());
      const logs: string[] = [];
      const harness = createAcpHarness({
        id: 'opencode',
        displayName: 'OpenCode',
        command: bin!,
        args: ['acp'],
        detect: async () => null,
        startTimeoutMs: 90_000,
        log: createLogger({ level: 'debug', sink: (l) => logs.push(l) }),
      });
      env = await makeEnv({
        plugins: { channels: [nostr], harnesses: [harness] },
        sandbox,
        llmProxy: true,
      });
      const c = env.client;
      await c.call('channel.add', {
        name: 'nostr-live',
        provider: 'nostr',
        values: { relays: RELAYS, publishDmRelays: false },
        secrets: { nsec: agentKey.nsec },
      });
      await until(
        async () => (await c.call('channel.list')).channels[0]?.status === 'connected',
        30_000,
        'nostr connected',
      );
      await c.call('agent.create', {
        config: {
          name: 'bot',
          harness: 'opencode',
          model: 'default',
          mounts: [{ path: work, mode: 'rw', parallelUnsafe: true }],
          memberships: [{ target: 'nostr-live:dm', defaultRole: 'viewer', triggers: ['dm'] }],
          budgets: { dailyUsd: 1 },
        },
      });
      await c.call('owner.add', { principal: `nostr:${ownerKey.npub}` });

      // The owner's own client: a separate Nostr connection with the throwaway owner key.
      const owner = await nostr.connect({
        name: 'owner',
        settings: { relays: RELAYS, publishDmRelays: false },
        secrets: { nsec: ownerKey.nsec },
        log: silentLogger,
        state: memKV(),
      });
      cleanup.push(() => owner.close());
      const inbox: InboundMsg[] = [];
      void (async () => {
        for await (const m of owner.inbound()) inbox.push(m);
      })();
      await new Promise((r) => setTimeout(r, 1500)); // let subscriptions settle

      const t0 = Date.now();
      await owner.send({
        conversation: { kind: 'dm', id: agentKey.npub },
        markdown:
          'First call the beamhop session_status tool exactly once. ' +
          'Then reply with the single word pong and nothing else.',
      });
      const dump = () => {
        const [s0] = env!.d.store.sessions.list();
        if (s0)
          console.log(
            '[events]',
            env!.d.store.sessions
              .events(s0.id)
              .map((e) => `${e.kind}:${(e.text ?? JSON.stringify(e.tool ?? '')).slice(0, 200)}`)
              .join('\n'),
          );
        console.log(
          '[audit]',
          env!.d.store.audit
            .query({ limit: 30 })
            .map((a) => a.summary)
            .join('\n'),
        );
        console.log('[logs]', logs.slice(-30).join('\n'));
        console.log('[inbox]', inbox.map((m) => m.text).join('\n---\n'));
      };
      try {
        await until(() => inbox.some((m) => /pong/i.test(m.text)), 150_000, 'pong DM');
      } catch (e) {
        dump();
        throw e;
      }
      const pong = inbox.find((m) => /pong/i.test(m.text))!;
      console.log(`[live] owner DM → pong DM in ${Date.now() - t0} ms`);
      expect(pong.from.principal).toBe(`nostr:${agentKey.npub}`);
      expect(pong.conversation.kind).toBe('dm');

      const [s] = env.d.store.sessions.list();
      const events = env.d.store.sessions.events(s!.id);
      console.log(
        '[live] events',
        events.map((e) => `${e.kind}:${(e.text ?? e.tool?.name ?? '').slice(0, 60)}`).join(' | '),
      );
      const toolCall = events.find(
        (e) => e.kind === 'tool_call' && /session_status/.test(JSON.stringify(e.tool ?? {})),
      );
      if (!toolCall) dump();
      expect(toolCall).toBeDefined();
      // The tool ran through the bridge, i.e. it did not fail inside the sandbox.
      const result = events.find((e) => e.kind === 'tool_result' && e.tool?.id === toolCall!.tool?.id);
      console.log(
        '[live] session_status result',
        result?.tool?.ok,
        (result?.tool?.output ?? '').slice(0, 200),
      );
      if (!result?.tool?.ok) dump();
      expect(result?.tool?.ok).toBe(true);
    }, 200_000);
  },
);

const token = telegramToken();
const ownerChat = telegramOwnerChat();

describe.runIf(Boolean(token && ownerChat))('live Telegram: approval card to the owner chat', () => {
  it('unknown sender → access request → card with inline buttons in the owner Telegram chat (1 message)', async () => {
    const channel = new FakeChannelPlugin();
    // poll: false — never call getUpdates, so no owner update is confirmed or dropped.
    const telegram = createTelegramPlugin({ poll: false });
    env = await makeEnv({
      channel,
      plugins: { channels: [channel, telegram], harnesses: [new FakeHarnessPlugin()] },
    });
    const c = env.client;
    await c.call('channel.add', { name: 'tg', provider: 'telegram', values: {}, secrets: { token: token! } });
    await until(
      async () =>
        (await c.call('channel.list')).channels.find((x) => x.config.name === 'tg')?.status === 'connected',
      20_000,
      'telegram connected',
    );
    const owner = `telegram:${ownerChat}`;
    await c.call('owner.add', { principal: owner });
    env.d.rememberDm(owner, 'tg', ownerChat!);

    const tg = env.d.channels.get('tg') as ChannelConn;
    const sent: { buttons: string[]; id: string; text: string }[] = [];
    const orig = tg.send.bind(tg);
    tg.send = async (m) => {
      if (sent.length >= 2) throw new Error('live test message budget exceeded');
      const r = await orig(m);
      sent.push({ buttons: (m.buttons ?? []).map((b) => b.id), id: r.id, text: m.markdown });
      return r;
    };

    const fk = await setupBot(env);
    fk.inject({
      text: 'hello, can I use this agent?',
      from: { principal: 'fake:mallory', displayName: 'Mallory (beamhop live test)' },
      conversation: { kind: 'dm', id: 'mallory' },
    });
    await until(() => sent.length >= 1, 20_000, 'telegram card');
    const [approval] = env.d.store.approvals.listStates({ status: 'pending' });
    expect(approval?.kind).toBe('access-request');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.id).toMatch(/\d+/); // Bot API accepted it: the owner chat has the message
    expect(sent[0]!.text).toContain('Access request');
    expect(sent[0]!.buttons).toEqual(
      expect.arrayContaining([`approve:${approval!.id}`, `deny:${approval!.id}`]),
    );
    console.log(`[live] telegram approval card delivered (message ${sent[0]!.id})`);

    // Decide it through the API (no getUpdates): the agent stays closed to the unknown sender.
    await c.call('approval.decide', { id: approval!.id, allow: false });
    await until(() => env!.d.store.approvals.get(approval!.id)?.status === 'denied', 5000, 'denied');
    expect(sent).toHaveLength(1);
  }, 60_000);
});
