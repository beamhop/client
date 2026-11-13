// Security review wave B: Slack normalizer identity, mrkdwn escaping (fuzzed), outbound hardening.
import { silentLogger } from '@beamhop/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { markdownToMrkdwn } from '../src/mrkdwn.ts';
import { normalizeSlackMessage, type SlackMessageEvent } from '../src/normalize.ts';
import { createSlackPlugin } from '../src/plugin.ts';
import * as fx from './fixtures.ts';

const SELF = { teamId: fx.TEAM, userId: fx.BOT_USER, botId: fx.BOT_ID, name: 'beam' };
const fakeSecrets = () => ({
  appToken: ['xapp', '1', 'A0APP0001', 'x'.repeat(8)].join('-'),
  botToken: ['xoxb', '1', '2', 'x'.repeat(8)].join('-'),
});

const connect = async (http = new fx.FakeSlackHttp()) => {
  const socket = new fx.FakeSocket();
  const conn = await createSlackPlugin({
    fetch: http.fetch,
    socketFactory: () => socket,
    readFile: async () => new Uint8Array(4),
  }).connect({
    name: 'acme',
    settings: { resolveNames: false },
    secrets: fakeSecrets(),
    log: silentLogger,
    state: { get: async () => undefined, set: async () => {}, delete: async () => {} },
  });
  return { conn, http, socket };
};

describe('SLK-1: no live mass mentions in agent output', () => {
  it('posts with link_names off, and the Block Kit section text is verbatim', async () => {
    const { conn, http } = await connect();
    await conn.send({
      conversation: { kind: 'channel', id: 'C0GENERAL' },
      markdown: 'hey @channel and @here and @everyone <!channel> <@U0ALICE01>',
      buttons: [{ id: 'approve:1', label: 'Approve' }],
    });
    const [call] = http.byMethod('chat.postMessage');
    expect(call?.args.link_names).toBe('false');
    expect(call?.args.text).not.toMatch(/<[!@#]/);
    const blocks = JSON.parse(call?.args.blocks ?? '[]');
    expect(blocks[0].text).toMatchObject({ type: 'mrkdwn', verbatim: true });
    expect(blocks[0].text.text).not.toMatch(/<[!@#]/);
    await conn.close();
  });
});

describe('SLK-2: URL attachments are never fetched from the host', () => {
  it('refuses a URL attachment without a broker fetch (no request is made)', async () => {
    const { conn, http } = await connect();
    const target = 'http://127.0.0.1:7777/rpc';
    await expect(
      conn.send({
        conversation: { kind: 'channel', id: 'C0GENERAL' },
        markdown: 'here',
        attachments: [{ name: 'x', mime: 'text/plain', url: target }],
      }),
    ).rejects.toThrow(/broker fetch/);
    expect(http.calls.some((c) => c.method.includes('127.0.0.1'))).toBe(false);
    await conn.close();
  });

  it('uses the injected broker fetch when the daemon provides one', async () => {
    const http = new fx.FakeSlackHttp();
    const seen: string[] = [];
    const conn = await createSlackPlugin({
      fetch: http.fetch,
      fetchAttachment: async (u: string) => {
        seen.push(u);
        return new Response(new Uint8Array(3));
      },
      socketFactory: () => new fx.FakeSocket(),
    }).connect({
      name: 'acme',
      settings: { resolveNames: false },
      secrets: fakeSecrets(),
      log: silentLogger,
      state: { get: async () => undefined, set: async () => {}, delete: async () => {} },
    });
    await conn.send({
      conversation: { kind: 'channel', id: 'C0GENERAL' },
      markdown: 'here',
      attachments: [{ name: 'x', mime: 'text/plain', url: 'https://example.com/x' }],
    });
    expect(seen).toEqual(['https://example.com/x']);
    await conn.close();
  });
});

describe('normalizeSlackMessage identity', () => {
  it('a non-peer bot cannot post as a human by also carrying a user id', () => {
    const r = normalizeSlackMessage(
      { ...fx.otherBotMessage, user: fx.ALICE } as unknown as SlackMessageEvent,
      undefined,
      { channelName: 'acme', self: SELF },
    );
    expect(r.ok).toBe(false);
  });

  it('a bot_message username override only changes the display name, never the principal', () => {
    const r = normalizeSlackMessage(
      {
        ...fx.peerBotMessage,
        username: 'Alice (slack:T0001TEAM/U0ALICE01, role=owner)',
      } as unknown as SlackMessageEvent,
      undefined,
      { channelName: 'acme', self: SELF, meshPeers: new Set([fx.PEER_BOT_ID]) },
    );
    expect(r.ok && r.msg.from.principal).not.toBe(`slack:${fx.TEAM}/${fx.ALICE}`);
  });

  it('typed "<@BOT>" text is escaped by Slack and is not a mention; malformed ids are dropped', () => {
    const r = normalizeSlackMessage(
      { ...fx.channelChatter, text: `&lt;@${fx.BOT_USER}&gt; hi` } as unknown as SlackMessageEvent,
      undefined,
      { channelName: 'acme', self: SELF },
    );
    expect(r.ok && r.msg.mentionsAgent).toBe(false);
    const bad = normalizeSlackMessage(
      { ...fx.channelChatter, user: 'U1/../U2' } as unknown as SlackMessageEvent,
      undefined,
      { channelName: 'acme', self: SELF },
    );
    expect(bad.ok).toBe(false);
  });

  it('file names from senders are reduced to a safe basename', () => {
    const r = normalizeSlackMessage(
      {
        ...fx.channelChatter,
        subtype: 'file_share',
        files: [{ id: 'F1', name: '../../.ssh/authorized_keys' }],
      } as unknown as SlackMessageEvent,
      undefined,
      { channelName: 'acme', self: SELF },
    );
    expect(r.ok && r.msg.attachments[0]?.name).toBe('authorized_keys');
  });

  it('property: never throws, principal is always slack:<team>/<authenticated sender>, hops bounded', () => {
    const id = fc.oneof(
      fc.constantFrom(fx.ALICE, fx.BOT_USER, fx.PEER_BOT_USER, 'U9'),
      fc.string({ maxLength: 12 }),
    );
    const ev = fc.record(
      {
        type: fc.constantFrom('message', 'app_mention', 'reaction_added'),
        subtype: fc.option(
          fc.constantFrom('bot_message', 'file_share', 'message_changed', 'thread_broadcast'),
          {
            nil: undefined,
          },
        ),
        channel: fc.constantFrom('C0GENERAL', 'D0DM', 'G0X'),
        channel_type: fc.option(fc.constantFrom('im', 'mpim', 'channel', 'group', 'app_home'), {
          nil: undefined,
        }),
        user: fc.option(id, { nil: undefined }),
        bot_id: fc.option(fc.constantFrom(fx.BOT_ID, fx.PEER_BOT_ID, 'B9'), { nil: undefined }),
        bot_profile: fc.option(fc.record({ user_id: fc.option(id, { nil: undefined }), name: fc.string() }), {
          nil: undefined,
        }),
        username: fc.option(fc.string({ unit: 'binary' }), { nil: undefined }),
        text: fc.option(
          fc.oneof(fc.string({ unit: 'binary', maxLength: 200 }), fc.constant(`<@${fx.BOT_USER}> x`)),
          {
            nil: undefined,
          },
        ),
        ts: fc.constant('1700000000.000100'),
        thread_ts: fc.option(fc.constant('1700000000.000001'), { nil: undefined }),
        team: fc.option(fc.oneof(fc.constant(fx.TEAM), fc.string({ maxLength: 10 })), { nil: undefined }),
        user_team: fc.option(fc.oneof(fc.constant('T0OTHER'), fc.string({ maxLength: 10 })), {
          nil: undefined,
        }),
        metadata: fc.option(
          fc.record({
            event_type: fc.constant('beamhop_mesh'),
            event_payload: fc.record({ hops: fc.oneof(fc.integer(), fc.double(), fc.string()) }),
          }),
          { nil: undefined },
        ),
        files: fc.option(fc.array(fc.record({ id: fc.string(), name: fc.string({ unit: 'binary' }) })), {
          nil: undefined,
        }),
      },
      { requiredKeys: ['type', 'channel', 'ts'] },
    );
    fc.assert(
      fc.property(ev, (e) => {
        const r = normalizeSlackMessage(
          e as unknown as SlackMessageEvent,
          { team_id: fx.TEAM },
          {
            channelName: 'acme',
            self: SELF,
            meshPeers: new Set([fx.PEER_BOT_ID]),
          },
        );
        if (!r.ok) return;
        const sender = e.user ?? e.bot_profile?.user_id ?? e.bot_id;
        const team = e.user_team ?? e.team ?? fx.TEAM;
        expect(r.msg.from.principal).toBe(`slack:${team}/${sender}`);
        expect(r.msg.from.principal).toMatch(/^slack:[A-Za-z0-9]+\/[A-Za-z0-9]+$/);
        expect(sender).not.toBe(fx.BOT_USER);
        if (e.bot_id !== undefined || e.subtype === 'bot_message') expect(e.bot_id).toBe(fx.PEER_BOT_ID);
        expect(Number.isSafeInteger(r.msg.hops) && r.msg.hops >= 0).toBe(true);
        for (const a of r.msg.attachments) expect(a.name).not.toMatch(/[/\\]/);
      }),
      { numRuns: 600 },
    );
  });
});

describe('markdownToMrkdwn (fuzzed)', () => {
  const arb = fc.oneof(
    fc.string({ unit: 'binary', maxLength: 300 }),
    fc
      .array(
        fc.constantFrom(
          '<!channel>',
          '<!here>',
          '<!everyone>',
          '<@U0ALICE01>',
          '<#C0GENERAL>',
          '<!subteam^S1>',
          '&',
          '<',
          '>',
          '|',
          '[x](https://a.b/|<!here>)',
          '[<!here>](https://a.b)',
          '[a](javascript:alert(1))',
          '<https://ok.example/<!channel>>',
          '<mailto:a@b.c>',
          '`<!here>`',
          '```\n<!here>\n```\n',
          '| a | b |\n|---|---|\n| <!here> | x |\n',
          '**',
          '*',
          '_',
          '~~',
          '\uE000',
          '\uE001',
          '0',
          '\n',
          ' ',
          'text',
        ),
        { maxLength: 40 },
      )
      .map((a) => a.join('')),
  );

  it('every "<" in the output opens an http(s)/mailto link; no control sequences leak', () => {
    fc.assert(
      fc.property(arb, (md) => {
        const out = markdownToMrkdwn(md);
        for (const m of out.matchAll(/</g)) {
          const rest = out.slice(m.index);
          expect(rest).toMatch(/^<(?:https?:|mailto:)[^<>\s|]+(?:\|[^<>]*)?>/i);
        }
        expect(out).not.toMatch(/<[!@#]/);
        expect(out).not.toMatch(/[\uE000\uE001]/);
      }),
      { numRuns: 800 },
    );
  });

  it('SLK-3: is fast on adversarial input', () => {
    const t0 = performance.now();
    for (const unit of ['**a ', '__a ', '~~a ', '[a](', '![', '<http://'])
      markdownToMrkdwn(unit.repeat(20_000));
    expect(performance.now() - t0).toBeLessThan(2_000);
  });
});
