import type { ButtonPress, ChannelConn, InboundMsg, KV } from '@beamhop/core';
import { BeamhopError, silentLogger } from '@beamhop/core';
import { describe, expect, it } from 'vitest';
import { SlackApi } from '../src/api.ts';
import { buildSlackManifest, SLACK_BOT_EVENTS, slackManifestUrl } from '../src/manifest.ts';
import { createSlackPlugin } from '../src/plugin.ts';
import * as fx from './fixtures.ts';

const memKV = (): KV => {
  const m = new Map<string, unknown>();
  return {
    get: async <T>(k: string) => m.get(k) as T | undefined,
    set: async (k, v) => void m.set(k, v),
    delete: async (k) => void m.delete(k),
  };
};

const SECRETS = { appToken: 'xapp-1-A0APP0001-123-abc', botToken: 'xoxb-123-456-abc' };

const setup = async (settings: Record<string, unknown> = {}, http = new fx.FakeSlackHttp()) => {
  const socket = new fx.FakeSocket();
  const sleeps: number[] = [];
  const files = new Map<string, Uint8Array>([['/work/out/report.pdf', new Uint8Array(1234)]]);
  const plugin = createSlackPlugin({
    fetch: http.fetch,
    sleep: async (ms) => void sleeps.push(ms),
    socketFactory: () => socket,
    readFile: async (p) => {
      const f = files.get(p);
      if (!f) throw new Error('ENOENT');
      return f;
    },
    now: () => new Date('2026-11-13T00:00:00Z'),
  });
  const conn = await plugin.connect({
    name: 'acme',
    settings,
    secrets: SECRETS,
    log: silentLogger,
    state: memKV(),
  });
  const it = conn.inbound()[Symbol.asyncIterator]();
  const next = async (): Promise<InboundMsg> => {
    const r = await it.next();
    if (r.done) throw new Error('inbound closed');
    return r.value;
  };
  return { conn, socket, http, sleeps, next };
};

/** Deliver events, then collect everything queued until `marker` arrives. */
const drain = async (conn: ChannelConn, socket: fx.FakeSocket, events: Record<string, unknown>[]) => {
  for (const e of events) socket.deliver(fx.envelope(e));
  const marker = { ...fx.dmMessage, ts: '1799999999.999999', text: '__marker__' };
  socket.deliver(fx.envelope(marker));
  const out: InboundMsg[] = [];
  for await (const m of conn.inbound()) {
    if (m.text === '__marker__') break;
    out.push(m);
  }
  return out;
};

describe('slack setup wizard', () => {
  it('generates a manifest with socket mode, scopes, events, interactivity and AI disclosure', () => {
    const m = buildSlackManifest({ botName: 'reviewer', operator: 'Alice' });
    expect(m.settings.socket_mode_enabled).toBe(true);
    expect(m.settings.interactivity.is_enabled).toBe(true);
    expect(m.oauth_config.scopes.bot).toEqual(
      expect.arrayContaining([
        'app_mentions:read',
        'chat:write',
        'channels:history',
        'groups:history',
        'im:history',
        'im:read',
        'im:write',
        'mpim:history',
        'files:read',
        'files:write',
        'users:read',
        'reactions:write',
      ]),
    );
    expect(m.settings.event_subscriptions.bot_events).toEqual(
      expect.arrayContaining([
        'app_mention',
        'message.im',
        'message.channels',
        'message.groups',
        'member_left_channel',
        'channel_left',
      ]),
    );
    expect(m.features.bot_user.display_name).toBe('reviewer');
    expect(m.display_information.description).toBe('AI agent operated by Alice, powered by beamhop.');
    expect(m.features.app_home.messages_tab_enabled).toBe(true);
  });

  it('clamps long names to Slack limits', () => {
    const m = buildSlackManifest({ botName: 'x'.repeat(100), operator: 'y'.repeat(200) });
    expect(m.display_information.name.length).toBe(35);
    expect(m.features.bot_user.display_name.length).toBe(80);
    expect(m.display_information.description.length).toBeLessThanOrEqual(140);
  });

  it('builds the prefilled create-app URL', () => {
    const url = slackManifestUrl({ botName: 'reviewer' });
    expect(url.startsWith('https://api.slack.com/apps?new_app=1&manifest_json=')).toBe(true);
    const json = decodeURIComponent(url.split('manifest_json=')[1] ?? '');
    expect(JSON.parse(json)).toEqual(buildSlackManifest({ botName: 'reviewer' }));
    expect(url).not.toMatch(/[ {}"]/); // fully URL-encoded
  });

  it('has 3 steps: manifest, xapp token, xoxb token', () => {
    const { steps } = createSlackPlugin().setup;
    expect(steps.map((s) => s.id)).toEqual(['create-app', 'app-token', 'install']);
    expect(steps[0]?.link?.url).toContain('manifest_json=');
    expect(steps[1]?.fields[0]).toMatchObject({ kind: 'secret', id: 'appToken' });
    expect(steps[1]?.body).toContain('connections:write');
    expect(steps[2]?.fields[0]).toMatchObject({ kind: 'secret', id: 'botToken' });
    for (const e of SLACK_BOT_EVENTS.slice(0, 4)) expect(steps[0]?.body).toContain(e);
  });

  it('validate() calls auth.test with the bot token and apps.connections.open with the app token', async () => {
    const http = new fx.FakeSlackHttp();
    const plugin = createSlackPlugin({ fetch: http.fetch });
    const v = await plugin.setup.validate({}, SECRETS);
    expect(v.ok).toBe(true);
    expect(v.identity).toMatchObject({
      handle: '@beamhop_agent',
      avatarUrl: 'https://avatars.slack-edge.com/a_72.png',
    });
    expect(http.byMethod('auth.test')[0]?.auth).toBe(`Bearer ${SECRETS.botToken}`);
    expect(http.byMethod('apps.connections.open')[0]?.auth).toBe(`Bearer ${SECRETS.appToken}`);
    expect(JSON.stringify(v)).not.toContain('xoxb-');
  });

  it('validate() rejects wrong token prefixes without calling Slack', async () => {
    const http = new fx.FakeSlackHttp();
    const plugin = createSlackPlugin({ fetch: http.fetch });
    expect(
      (await plugin.setup.validate({}, { appToken: SECRETS.appToken, botToken: 'xoxp-user' })).message,
    ).toContain('xoxb-');
    expect((await plugin.setup.validate({}, { botToken: SECRETS.botToken })).message).toContain(
      'App-level token',
    );
    expect(http.calls).toHaveLength(0);
  });

  it('validate() reports invalid_auth and missing_scope', async () => {
    const http = new fx.FakeSlackHttp().on('auth.test', () => ({ ok: false, error: 'invalid_auth' }));
    const v = await createSlackPlugin({ fetch: http.fetch }).setup.validate({}, SECRETS);
    expect(v.ok).toBe(false);
    expect(v.message).toContain('invalid_auth');
    const http2 = new fx.FakeSlackHttp().on('apps.connections.open', () => ({
      ok: false,
      error: 'missing_scope',
    }));
    const v2 = await createSlackPlugin({ fetch: http2.fetch }).setup.validate({}, SECRETS);
    expect(v2.ok).toBe(false);
    expect(v2.message).toContain('connections:write');
  });
});

describe('slack connect + inbound normalization', () => {
  it('refuses to connect without tokens', async () => {
    const plugin = createSlackPlugin({
      fetch: new fx.FakeSlackHttp().fetch,
      socketFactory: () => new fx.FakeSocket(),
    });
    await expect(
      plugin.connect({ name: 'x', settings: {}, secrets: {}, log: silentLogger, state: memKV() }),
    ).rejects.toBeInstanceOf(BeamhopError);
  });

  it('starts socket mode and exposes self identity', async () => {
    const { conn, socket } = await setup();
    expect(socket.started).toBe(true);
    expect(conn.self.principal).toBe(`slack:${fx.TEAM}/${fx.BOT_USER}`);
    expect(conn.capabilities).toEqual({
      edit: true,
      buttons: true,
      typing: true,
      files: true,
      threads: true,
    });
    await conn.close();
    expect(socket.disconnected).toBe(true);
  });

  it('normalizes a DM (and acks the envelope)', async () => {
    const { conn, socket, next } = await setup();
    const e = fx.envelope(fx.dmMessage);
    socket.deliver(e);
    const m = await next();
    expect(socket.acks).toContain(e.envelope_id);
    expect(m).toMatchObject({
      id: '1700000001.000100',
      channel: 'acme',
      provider: 'slack',
      conversation: { kind: 'dm', id: 'D0DMCHAN1' },
      threadId: 'D0DMCHAN1',
      from: { principal: `slack:${fx.TEAM}/${fx.ALICE}`, displayName: 'alice', isBot: false },
      text: 'Hello <agent> can you *help* me?',
      mentionsAgent: false,
      replyToAgent: false,
      hops: 0,
      receivedAt: '2026-11-13T00:00:00.000Z',
    });
    await conn.close();
  });

  it('normalizes a channel mention once even though message + app_mention both arrive', async () => {
    const { conn, socket } = await setup();
    const msgs = await drain(conn, socket, [fx.channelMessageWithMention, fx.appMention]);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      conversation: { kind: 'channel', id: 'C0GENERAL' },
      threadId: '1700000002.000200',
      mentionsAgent: true,
      text: '@beamhop_agent please review PR 42',
    });
    await conn.close();
  });

  it('flags plain channel chatter as not mentioning the agent', async () => {
    const { conn, socket } = await setup();
    const [m] = await drain(conn, socket, [fx.channelChatter]);
    expect(m).toMatchObject({ mentionsAgent: false, replyToAgent: false, threadId: '1700000003.000300' });
    await conn.close();
  });

  it('detects thread replies to the bot', async () => {
    const { conn, socket } = await setup();
    const [m] = await drain(conn, socket, [fx.threadReplyToBot]);
    expect(m).toMatchObject({
      threadId: '1700000004.000400',
      replyToAgent: true,
      replyToId: '1700000004.000400',
    });
    await conn.close();
  });

  it('ignores its own messages, foreign bots and edits; accepts mesh peers with hops', async () => {
    const { conn, socket } = await setup({ meshPeers: [fx.PEER_BOT_ID] });
    const msgs = await drain(conn, socket, [
      fx.botSelfMessage,
      fx.otherBotMessage,
      fx.messageChanged,
      fx.peerBotMessage,
    ]);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      from: { principal: `slack:${fx.TEAM}/${fx.PEER_BOT_USER}`, isBot: true, displayName: 'peer agent' },
      mentionsAgent: true,
      hops: 2,
    });
    await conn.close();
  });

  it('maps file shares to attachments and mpim to group', async () => {
    const { conn, socket } = await setup();
    const [f, g] = await drain(conn, socket, [fx.fileShare, fx.mpimMessage]);
    expect(f?.attachments).toEqual([
      {
        name: 'build.log',
        mime: 'text/plain',
        size: 2048,
        url: 'https://files.slack.com/files-pri/T0001TEAM-F0FILE0001/download/build.log',
      },
    ]);
    expect(g?.conversation.kind).toBe('group');
    await conn.close();
  });

  it('ignores redelivered envelopes (Slack retries)', async () => {
    const { conn, socket } = await setup();
    const msgs = await drain(conn, socket, [fx.dmMessage, fx.dmMessage]);
    expect(msgs).toHaveLength(1);
    await conn.close();
  });

  it('caches users.info lookups', async () => {
    const { conn, socket, http } = await setup();
    await drain(conn, socket, [fx.dmMessage, { ...fx.dmMessage, ts: '1700000001.000101' }]);
    expect(http.byMethod('users.info')).toHaveLength(1);
    await conn.close();
  });

  it('survives users.info failures', async () => {
    const http = new fx.FakeSlackHttp().on('users.info', () => ({ ok: false, error: 'user_not_found' }));
    const { conn, socket } = await setup({}, http);
    const [m] = await drain(conn, socket, [fx.dmMessage]);
    expect(m?.from.displayName).toBeUndefined();
    await conn.close();
  });
});

describe('slack removal (kick) events', () => {
  it('fires onRemoved for member_left_channel (bot only) and channel_left', async () => {
    const { conn, socket } = await setup();
    const removed: string[] = [];
    conn.onRemoved?.((id) => removed.push(id));
    await drain(conn, socket, [fx.memberLeftOther, fx.memberLeftChannel, fx.channelLeft]);
    expect(removed).toEqual(['C0GENERAL', 'C0PRIVATE']);
    await conn.close();
  });
});

describe('slack outbound', () => {
  it('sends mrkdwn into the right thread with unfurls off', async () => {
    const { conn, http } = await setup();
    const sent = await conn.send({
      conversation: { kind: 'channel', id: 'C0GENERAL' },
      threadId: '1700000002.000200',
      markdown: '**Done** — see [PR](https://github.com/o/r/pull/1)',
    });
    const [call] = http.byMethod('chat.postMessage');
    expect(call?.args).toMatchObject({
      channel: 'C0GENERAL',
      thread_ts: '1700000002.000200',
      text: '*Done* — see <https://github.com/o/r/pull/1|PR>',
      unfurl_links: 'false',
    });
    expect(call?.args.blocks).toBeUndefined();
    expect(sent.id).toMatch(/^1700000100\./);
    await conn.close();
  });

  it('does not thread DM replies whose threadId is the conversation', async () => {
    const { conn, http } = await setup();
    await conn.send({ conversation: { kind: 'dm', id: 'D0DMCHAN1' }, threadId: 'D0DMCHAN1', markdown: 'hi' });
    expect(http.byMethod('chat.postMessage')[0]?.args.thread_ts).toBeUndefined();
    await conn.close();
  });

  it('carries mesh hops in message metadata', async () => {
    const { conn, http } = await setup();
    await conn.send({ conversation: { kind: 'channel', id: 'C0GENERAL' }, markdown: 'peer', hops: 3 });
    expect(JSON.parse(http.byMethod('chat.postMessage')[0]?.args.metadata ?? '{}')).toEqual({
      event_type: 'beamhop_mesh',
      event_payload: { hops: 3 },
    });
    await conn.close();
  });

  it('renders buttons as Block Kit and round-trips block_actions to onButton', async () => {
    const { conn, socket, http } = await setup();
    const presses: ButtonPress[] = [];
    conn.onButton?.((p) => presses.push(p));
    const sent = await conn.send({
      conversation: { kind: 'channel', id: 'C0GENERAL' },
      markdown: 'Run `rm -rf build`?',
      buttons: [
        { id: 'approve:abc', label: 'Approve', style: 'primary' },
        { id: 'deny:abc', label: 'Deny', style: 'danger' },
        { id: 'details:abc', label: 'Details' },
      ],
    });
    const blocks = JSON.parse(http.byMethod('chat.postMessage')[0]?.args.blocks ?? '[]');
    expect(blocks[0]).toEqual({ type: 'section', text: { type: 'mrkdwn', text: 'Run `rm -rf build`?' } });
    expect(blocks[1].type).toBe('actions');
    expect(blocks[1].elements).toEqual([
      {
        type: 'button',
        action_id: 'bh:0:approve:abc',
        text: { type: 'plain_text', text: 'Approve', emoji: true },
        value: 'approve:abc',
        style: 'primary',
      },
      {
        type: 'button',
        action_id: 'bh:1:deny:abc',
        text: { type: 'plain_text', text: 'Deny', emoji: true },
        value: 'deny:abc',
        style: 'danger',
      },
      {
        type: 'button',
        action_id: 'bh:2:details:abc',
        text: { type: 'plain_text', text: 'Details', emoji: true },
        value: 'details:abc',
      },
    ]);

    const env = fx.blockActions(sent.id, 'approve:abc');
    socket.deliver(env);
    await new Promise((r) => setTimeout(r, 0));
    expect(socket.acks).toContain('env-interactive');
    expect(presses).toEqual([
      {
        messageId: sent.id,
        buttonId: 'approve:abc',
        principal: `slack:${fx.TEAM}/${fx.ALICE}`,
        conversationId: 'C0GENERAL',
      },
    ]);
    await conn.close();
  });

  it('ignores block_actions that are not ours', async () => {
    const { conn, socket } = await setup();
    const presses: ButtonPress[] = [];
    conn.onButton?.((p) => presses.push(p));
    const env = fx.blockActions('1.2', 'x');
    env.body.actions[0]!.action_id = 'someone_elses_action';
    socket.deliver(env);
    await new Promise((r) => setTimeout(r, 0));
    expect(presses).toEqual([]);
    await conn.close();
  });

  it('live-edits via chat.update, keeping buttons on the last chunk', async () => {
    const { conn, http } = await setup();
    const sent = await conn.send({
      conversation: { kind: 'channel', id: 'C0GENERAL' },
      markdown: 'thinking…',
      buttons: [{ id: 'stop', label: 'Stop', style: 'danger' }],
    });
    await sent.edit?.('**final** answer');
    const [upd] = http.byMethod('chat.update');
    expect(upd?.args).toMatchObject({ channel: 'C0GENERAL', ts: sent.id, text: '*final* answer' });
    expect(JSON.parse(upd?.args.blocks ?? '[]')[1].elements[0].value).toBe('stop');
    await conn.close();
  });

  it('splits long messages and grows/shrinks parts on edit', async () => {
    const { conn, http, socket } = await setup();
    const presses: ButtonPress[] = [];
    conn.onButton?.((p) => presses.push(p));
    const long = Array.from({ length: 200 }, (_, i) => `line ${i} ${'x'.repeat(30)}`).join('\n'); // ~8k chars
    const sent = await conn.send({
      conversation: { kind: 'channel', id: 'C0GENERAL' },
      markdown: long,
      buttons: [{ id: 'ok', label: 'OK' }],
    });
    const posts = http.byMethod('chat.postMessage');
    expect(posts.length).toBe(3);
    for (const p of posts) expect(p.args.text?.length).toBeLessThanOrEqual(3000);
    expect(posts.slice(0, 2).every((p) => p.args.blocks === undefined)).toBe(true);
    expect(posts[2]?.args.blocks).toContain('actions');

    await sent.edit?.('short now');
    expect(http.byMethod('chat.update')).toHaveLength(1);
    expect(http.byMethod('chat.delete')).toHaveLength(2);
    expect(JSON.parse(http.byMethod('chat.update')[0]?.args.blocks ?? '[]')[1].type).toBe('actions');
    // After shrinking, the buttons live on the first (only) part.
    socket.deliver(fx.blockActions(sent.id, 'ok'));
    await new Promise((r) => setTimeout(r, 0));
    expect(presses[0]?.messageId).toBe(sent.id);
    await conn.close();
  });

  it('uploads files via getUploadURLExternal → upload → completeUploadExternal', async () => {
    const { conn, http } = await setup();
    await conn.send({
      conversation: { kind: 'channel', id: 'C0GENERAL' },
      threadId: '1700000002.000200',
      markdown: 'report attached',
      attachments: [{ name: 'report.pdf', mime: 'application/pdf', localPath: '/work/out/report.pdf' }],
    });
    expect(http.byMethod('files.getUploadURLExternal')[0]?.args).toEqual({
      filename: 'report.pdf',
      length: '1234',
    });
    expect(http.uploads).toEqual([{ url: 'https://files.slack.com/upload/v1/ABC', bytes: 1234 }]);
    const done = http.byMethod('files.completeUploadExternal')[0]?.args;
    expect(done).toMatchObject({ channel_id: 'C0GENERAL', thread_ts: '1700000002.000200' });
    expect(JSON.parse(done?.files ?? '[]')).toEqual([{ id: 'F0UPLOAD01', title: 'report.pdf' }]);
    await conn.close();
  });

  it('rejects attachments without a source', async () => {
    const { conn } = await setup();
    await expect(
      conn.send({
        conversation: { kind: 'dm', id: 'D1' },
        markdown: '',
        attachments: [{ name: 'x', mime: 'text/plain' }],
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await conn.close();
  });

  it('typing adds an hourglass reaction to the last inbound message and removes it on reply', async () => {
    const { conn, socket, http } = await setup();
    await drain(conn, socket, [fx.channelMessageWithMention]);
    await conn.typing?.('C0GENERAL');
    await conn.typing?.('C0GENERAL'); // idempotent
    expect(http.byMethod('reactions.add')).toHaveLength(1);
    expect(http.byMethod('reactions.add')[0]?.args).toEqual({
      channel: 'C0GENERAL',
      timestamp: '1700000002.000200',
      name: 'hourglass_flowing_sand',
    });
    await conn.send({ conversation: { kind: 'channel', id: 'C0GENERAL' }, markdown: 'done' });
    expect(http.byMethod('reactions.remove')[0]?.args.timestamp).toBe('1700000002.000200');
    await conn.typing?.('C0UNKNOWN'); // no inbound yet → no-op
    expect(http.byMethod('reactions.add')).toHaveLength(1);
    await conn.close();
  });

  it('fails sends after close', async () => {
    const { conn } = await setup();
    await conn.close();
    await expect(conn.send({ conversation: { kind: 'dm', id: 'D1' }, markdown: 'x' })).rejects.toMatchObject({
      code: 'unavailable',
    });
  });
});

describe('slack rate limiting', () => {
  it('retries 429 after Retry-After seconds', async () => {
    const http = new fx.FakeSlackHttp().on('chat.postMessage', (_a, n) =>
      n < 3
        ? new Response('', { status: 429, headers: { 'retry-after': String(n * 2) } })
        : { ok: true, channel: 'C1', ts: '1.000001' },
    );
    const { conn, sleeps } = await setup({}, http);
    const sent = await conn.send({ conversation: { kind: 'channel', id: 'C1' }, markdown: 'x' });
    expect(sent.id).toBe('1.000001');
    expect(sleeps).toEqual([2000, 4000]);
    expect(http.byMethod('chat.postMessage')).toHaveLength(3);
    await conn.close();
  });

  it('gives up with rate_limited after maxRetries', async () => {
    const http = new fx.FakeSlackHttp().on(
      'auth.test',
      () => new Response('', { status: 429, headers: { 'retry-after': '1' } }),
    );
    const sleeps: number[] = [];
    const api = new SlackApi('xoxb-1', {
      fetch: http.fetch,
      sleep: async (ms) => void sleeps.push(ms),
      maxRetries: 2,
    });
    await expect(api.call('auth.test')).rejects.toMatchObject({ code: 'rate_limited' });
    expect(sleeps).toEqual([1000, 1000]);
  });

  it('caps absurd Retry-After values and retries 5xx with backoff', async () => {
    const http = new fx.FakeSlackHttp().on('auth.test', (_a, n) =>
      n === 1
        ? new Response('', { status: 429, headers: { 'retry-after': '99999' } })
        : n === 2
          ? new Response('oops', { status: 503 })
          : fx.authTest,
    );
    const sleeps: number[] = [];
    const api = new SlackApi('xoxb-1', { fetch: http.fetch, sleep: async (ms) => void sleeps.push(ms) });
    await expect(api.call('auth.test')).resolves.toMatchObject({ ok: true });
    expect(sleeps).toEqual([60_000, 1000]);
  });

  it('maps Slack errors to beamhop error codes', async () => {
    const http = new fx.FakeSlackHttp()
      .on('chat.postMessage', () => ({ ok: false, error: 'not_in_channel' }))
      .on('chat.update', () => ({ ok: false, error: 'token_revoked' }));
    const api = new SlackApi('xoxb-1', { fetch: http.fetch });
    await expect(api.call('chat.postMessage')).rejects.toMatchObject({
      code: 'forbidden',
      slackError: 'not_in_channel',
    });
    await expect(api.call('chat.update')).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('never puts the token in error messages', async () => {
    const api = new SlackApi('xoxb-secret-value', {
      fetch: async () => {
        throw new Error('ECONNRESET');
      },
    });
    const err = await api.call('auth.test').catch((e) => e);
    expect(err.code).toBe('unavailable');
    expect(JSON.stringify(err)).not.toContain('xoxb-secret-value');
  });
});
