import type { ButtonPress, InboundMsg, KV } from '@beamhop/core';
import { silentLogger } from '@beamhop/core';
import { GatewayIntentBits, Partials, PermissionFlagsBits } from 'discord.js';
import { afterEach, describe, expect, it } from 'vitest';
import { markdownToDiscord } from '../src/format.ts';
import {
  applicationIdFromToken,
  DISCORD_MIN_PERMISSIONS,
  DISCORD_PERMISSION_BITS,
  discordInviteUrl,
} from '../src/permissions.ts';
import { createDiscordPlugin } from '../src/plugin.ts';
import * as h from './harness.ts';

const memKV = (): KV => {
  const m = new Map<string, unknown>();
  return {
    get: async <T>(k: string) => m.get(k) as T | undefined,
    set: async (k, v) => void m.set(k, v),
    delete: async (k) => void m.delete(k),
  };
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const setup = async (settings: Record<string, unknown> = {}) => {
  const fake = new h.FakeDiscord();
  const files = new Map<string, Uint8Array>([
    ['/work/out/report.txt', new TextEncoder().encode('hello report')],
  ]);
  const plugin = createDiscordPlugin({
    clientFactory: fake.factory,
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
    secrets: { botToken: h.TOKEN },
    log: silentLogger,
    state: memKV(),
  });
  cleanups.push(() => conn.close());
  const it = conn.inbound()[Symbol.asyncIterator]();
  const next = async (): Promise<InboundMsg> => {
    const r = await it.next();
    if (r.done) throw new Error('closed');
    return r.value;
  };
  /** Dispatch MESSAGE_CREATE payloads, then collect inbound until a DM marker. */
  const drain = async (payloads: Record<string, unknown>[]) => {
    for (const p of payloads) fake.dispatch('MESSAGE_CREATE', p);
    fake.dispatch('MESSAGE_CREATE', h.dmPayload({ content: '__marker__' }));
    const out: InboundMsg[] = [];
    for (;;) {
      const m = await next();
      if (m.text === '__marker__') return out;
      out.push(m);
    }
  };
  return { fake, conn, next, drain };
};

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('discord permissions + invite URL', () => {
  it('computes the minimal permission bitfield', () => {
    // 64 (AddReactions) + 1024 (ViewChannel) + 2048 (SendMessages) + 32768 (AttachFiles)
    // + 65536 (ReadMessageHistory) + 2147483648 (UseApplicationCommands)
    // + 274877906944 (SendMessagesInThreads) = 277025492032
    expect(64n + 1024n + 2048n + 32768n + 65536n + 2147483648n + 274877906944n).toBe(277025492032n);
    expect(DISCORD_MIN_PERMISSIONS).toBe(277025492032n);
    // Cross-check against discord.js' own flag table.
    expect(DISCORD_PERMISSION_BITS).toEqual({
      AddReactions: PermissionFlagsBits.AddReactions,
      ViewChannel: PermissionFlagsBits.ViewChannel,
      SendMessages: PermissionFlagsBits.SendMessages,
      AttachFiles: PermissionFlagsBits.AttachFiles,
      ReadMessageHistory: PermissionFlagsBits.ReadMessageHistory,
      UseApplicationCommands: PermissionFlagsBits.UseApplicationCommands,
      SendMessagesInThreads: PermissionFlagsBits.SendMessagesInThreads,
    });
    // No dangerous permissions.
    expect(DISCORD_MIN_PERMISSIONS & PermissionFlagsBits.Administrator).toBe(0n);
    expect(DISCORD_MIN_PERMISSIONS & PermissionFlagsBits.MentionEveryone).toBe(0n);
    expect(DISCORD_MIN_PERMISSIONS & PermissionFlagsBits.ManageMessages).toBe(0n);
  });

  it('builds the OAuth2 invite URL', () => {
    expect(discordInviteUrl(h.BOT_ID)).toBe(
      `https://discord.com/oauth2/authorize?client_id=${h.BOT_ID}&scope=bot%20applications.commands&permissions=277025492032`,
    );
    expect(() => discordInviteUrl('abc&scope=evil')).toThrow(RangeError);
  });

  it('derives the application id from a bot token', () => {
    expect(applicationIdFromToken(h.TOKEN)).toBe(h.BOT_ID);
    expect(applicationIdFromToken('garbage')).toBeUndefined();
  });
});

describe('discord setup wizard', () => {
  it('has developer-portal and invite steps', () => {
    const { steps } = createDiscordPlugin({ applicationId: h.BOT_ID }).setup;
    expect(steps.map((s) => s.id)).toEqual(['create-app', 'invite']);
    expect(steps[0]?.body).toContain('Message Content Intent');
    expect(steps[0]?.body).toContain('AI agent');
    expect(steps[0]?.link?.url).toBe('https://discord.com/developers/applications');
    expect(steps[0]?.fields[0]).toMatchObject({ kind: 'secret', id: 'botToken' });
    expect(steps[1]?.link?.url).toBe(discordInviteUrl(h.BOT_ID));
    expect(createDiscordPlugin().setup.steps[1]?.link).toBeUndefined();
  });

  it('validate() calls GET /users/@me with the bot token and returns identity + invite', async () => {
    const fake = new h.FakeDiscord();
    const plugin = createDiscordPlugin({ rest: { makeRequest: fake.makeRequest as never } });
    const v = await plugin.setup.validate({}, { botToken: h.TOKEN });
    expect(v.ok).toBe(true);
    expect(fake.requests[0]).toMatchObject({ method: 'GET', path: '/users/@me', auth: `Bot ${h.TOKEN}` });
    expect(v.identity).toEqual({
      name: 'beamhop-agent',
      handle: 'beamhop-agent',
      avatarUrl: `https://cdn.discordapp.com/avatars/${h.BOT_ID}/a1b2c3d4e5f6.png`,
    });
    expect(v.message).toContain(discordInviteUrl(h.BOT_ID));
    expect(v.message).not.toContain('Warning');
    expect(v.message).not.toContain(h.TOKEN);
  });

  it('validate() warns when the Message Content intent is off', async () => {
    const fake = new h.FakeDiscord();
    fake.appFlags = 0;
    const v = await createDiscordPlugin({ rest: { makeRequest: fake.makeRequest as never } }).setup.validate(
      {},
      { botToken: h.TOKEN },
    );
    expect(v.ok).toBe(true);
    expect(v.message).toContain('Message Content intent');
  });

  it('validate() rejects bad tokens', async () => {
    const fake = new h.FakeDiscord().override('GET', /^\/users\/@me$/, () =>
      Response.json({ message: '401: Unauthorized', code: 0 }, { status: 401 }),
    );
    const plugin = createDiscordPlugin({ rest: { makeRequest: fake.makeRequest as never } });
    const v = await plugin.setup.validate({}, { botToken: h.TOKEN });
    expect(v).toMatchObject({ ok: false });
    expect(v.message).toContain('401');
    expect((await plugin.setup.validate({}, { botToken: 'nope' })).ok).toBe(false);
    expect((await plugin.setup.validate({}, {})).ok).toBe(false);
  });

  it('validate() retries on 429 using retry_after (REST rate limiting)', async () => {
    const fake = new h.FakeDiscord().override(
      'GET',
      /^\/users\/@me$/,
      () =>
        new Response(
          JSON.stringify({ message: 'You are being rate limited.', retry_after: 0.05, global: false }),
          {
            status: 429,
            headers: {
              'content-type': 'application/json',
              'retry-after': '0.05',
              'x-ratelimit-scope': 'user',
              'x-ratelimit-limit': '1',
              'x-ratelimit-remaining': '0',
              'x-ratelimit-reset-after': '0.05',
              'x-ratelimit-bucket': 'abcd',
            },
          },
        ),
    );
    const plugin = createDiscordPlugin({ rest: { makeRequest: fake.makeRequest as never, offset: 0 } });
    const t0 = Date.now();
    const v = await plugin.setup.validate({}, { botToken: h.TOKEN });
    expect(v.ok).toBe(true);
    expect(fake.req('GET', /^\/users\/@me$/)).toHaveLength(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(40);
  });
});

describe('discord gateway connect', () => {
  it('uses the required intents and DM partials, and never parses mentions by default', async () => {
    const { fake, conn } = await setup();
    const intents = fake.options?.intents as number[];
    expect(intents).toEqual([
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ]);
    expect(fake.options?.partials).toContain(Partials.Channel);
    expect(fake.options?.allowedMentions).toEqual({ parse: [] });
    expect(conn.self).toEqual({
      principal: `discord:${h.BOT_ID}`,
      displayName: 'beamhop-agent',
      handle: `<@${h.BOT_ID}>`,
    });
  });

  it('refuses to connect without a token', async () => {
    const plugin = createDiscordPlugin({ clientFactory: new h.FakeDiscord().factory });
    await expect(
      plugin.connect({ name: 'x', settings: {}, secrets: {}, log: silentLogger, state: memKV() }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('maps disallowed-intents login failures to forbidden', async () => {
    const fake = new h.FakeDiscord();
    const plugin = createDiscordPlugin({
      clientFactory: (o) => {
        const c = fake.factory(o);
        (c as unknown as { login: () => Promise<string> }).login = async () => {
          throw new Error('Used disallowed intents');
        };
        return c;
      },
    });
    await expect(
      plugin.connect({
        name: 'x',
        settings: {},
        secrets: { botToken: h.TOKEN },
        log: silentLogger,
        state: memKV(),
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('discord inbound normalization', () => {
  it('normalizes a DM', async () => {
    const { fake, next } = await setup();
    const p = h.dmPayload({ content: 'hi agent' });
    fake.dispatch('MESSAGE_CREATE', p);
    expect(await next()).toMatchObject({
      id: p.id,
      channel: 'acme',
      provider: 'discord',
      conversation: { kind: 'dm', id: h.DM },
      threadId: h.DM,
      from: { principal: `discord:${h.ALICE}`, displayName: 'Alice', isBot: false },
      text: 'hi agent',
      mentionsAgent: false,
      replyToAgent: false,
      hops: 0,
      receivedAt: '2026-11-13T00:00:00.000Z',
    });
  });

  it('normalizes a channel mention (user mention and managed-role mention)', async () => {
    const { drain } = await setup();
    const [a, b, c] = await drain([
      h.messagePayload({ content: `<@${h.BOT_ID}> review PR 42`, mentions: [h.botUser] }),
      h.messagePayload({ content: `<@&${h.BOT_ROLE}> ping`, mention_roles: [h.BOT_ROLE] }),
      h.messagePayload({ content: 'just chatting' }),
    ]);
    expect(a).toMatchObject({
      conversation: { kind: 'channel', id: h.GENERAL, title: 'general' },
      threadId: h.GENERAL,
      from: { displayName: 'Ally' },
      mentionsAgent: true,
      text: '@beamhop-agent review PR 42',
    });
    expect(b?.mentionsAgent).toBe(true);
    expect(c?.mentionsAgent).toBe(false);
  });

  it('maps thread messages to the parent channel with threadId = thread id', async () => {
    const { drain } = await setup();
    const [m] = await drain([h.messagePayload({ channel_id: h.THREAD, content: 'in thread' })]);
    expect(m).toMatchObject({
      conversation: { kind: 'channel', id: h.GENERAL, title: 'general' },
      threadId: h.THREAD,
    });
  });

  it('detects replies to the agent via message_reference', async () => {
    const { drain } = await setup();
    const botMsg = h.messagePayload({ author: h.botUser, member: undefined, content: 'I am done' });
    const [r, other] = await drain([
      h.messagePayload({
        type: 19,
        content: 'thanks! one more thing',
        mentions: [h.botUser],
        message_reference: { type: 0, message_id: botMsg.id, channel_id: h.GENERAL, guild_id: h.GUILD },
        referenced_message: botMsg,
      }),
      h.messagePayload({
        type: 19,
        content: 'replying to alice',
        message_reference: { type: 0, message_id: '1', channel_id: h.GENERAL, guild_id: h.GUILD },
        referenced_message: h.messagePayload({ id: '1' }),
      }),
    ]);
    expect(r).toMatchObject({ replyToAgent: true, replyToId: botMsg.id, mentionsAgent: false });
    expect(other).toMatchObject({ replyToAgent: false, replyToId: '1' });
  });

  it('ignores its own messages, other bots, webhooks and system messages; accepts mesh peers', async () => {
    const { drain } = await setup({ meshPeers: [h.PEER_BOT] });
    const msgs = await drain([
      h.messagePayload({ author: h.botUser, member: undefined, content: 'self' }),
      h.messagePayload({
        author: { id: h.OTHER_BOT, username: 'mee6', discriminator: '0', bot: true, avatar: null },
        content: 'bot',
      }),
      h.messagePayload({
        webhook_id: '1700000000000000001',
        author: {
          id: '1700000000000000001',
          username: 'hook',
          discriminator: '0000',
          bot: true,
          avatar: null,
        },
        content: 'hook',
      }),
      h.messagePayload({ type: 7, content: '' }), // UserJoin system message
      h.messagePayload({
        author: {
          id: h.PEER_BOT,
          username: 'peer-agent',
          global_name: null,
          discriminator: '0',
          bot: true,
          avatar: null,
        },
        member: undefined,
        content: `<@${h.BOT_ID}> summarise please`,
      }),
    ]);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      from: { principal: `discord:${h.PEER_BOT}`, isBot: true },
      mentionsAgent: true,
    });
  });

  it('maps attachments', async () => {
    const { drain } = await setup();
    const [m] = await drain([
      h.messagePayload({
        content: 'log attached',
        attachments: [
          {
            id: '1800000000000000001',
            filename: 'build.log',
            size: 2048,
            url: 'https://cdn.discordapp.com/attachments/1/2/build.log?ex=1&is=2&hm=3',
            proxy_url: 'https://media.discordapp.net/attachments/1/2/build.log',
            content_type: 'text/plain; charset=utf-8',
          },
        ],
      }),
    ]);
    expect(m?.attachments).toEqual([
      {
        name: 'build.log',
        mime: 'text/plain; charset=utf-8',
        size: 2048,
        url: 'https://cdn.discordapp.com/attachments/1/2/build.log?ex=1&is=2&hm=3',
      },
    ]);
  });
});

describe('discord outbound', () => {
  it('sends Markdown with allowed_mentions parse [] and a reply reference', async () => {
    const { fake, conn, drain } = await setup();
    await drain([]);
    const sent = await conn.send({
      conversation: { kind: 'channel', id: h.GENERAL },
      threadId: h.GENERAL,
      replyToId: '1600000000000000999',
      markdown: '**Done** @everyone <@&123> see `x`',
    });
    const [post] = fake.req('POST', /^\/channels\/\d+\/messages$/);
    expect(post?.path).toBe(`/channels/${h.GENERAL}/messages`);
    expect(post?.body).toMatchObject({
      content: '**Done** @everyone <@&123> see `x`',
      allowed_mentions: { parse: [] },
      message_reference: { message_id: '1600000000000000999', fail_if_not_exists: false },
    });
    expect(sent.id).toMatch(/^\d+$/);
  });

  it('sends into threads by thread channel id', async () => {
    const { fake, conn } = await setup();
    await conn.send({
      conversation: { kind: 'channel', id: h.GENERAL },
      threadId: h.THREAD,
      markdown: 'in thread',
    });
    expect(fake.req('POST', /messages$/)[0]?.path).toBe(`/channels/${h.THREAD}/messages`);
  });

  it('fails cleanly for unknown channels', async () => {
    const { conn } = await setup();
    await expect(
      conn.send({ conversation: { kind: 'channel', id: '1999999999999999999' }, markdown: 'x' }),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('splits messages over 2000 chars, keeping fences balanced and buttons on the last part', async () => {
    const { fake, conn } = await setup();
    const code = Array.from({ length: 120 }, (_, i) => `const v${i} = ${i}; // ${'pad'.repeat(5)}`).join(
      '\n',
    );
    await conn.send({
      conversation: { kind: 'channel', id: h.GENERAL },
      markdown: `Here:\n\`\`\`ts\n${code}\n\`\`\`\nend`,
      buttons: [{ id: 'ok', label: 'OK' }],
    });
    const posts = fake.req('POST', /messages$/);
    expect(posts.length).toBeGreaterThanOrEqual(3);
    for (const p of posts) {
      expect(p.body.content.length).toBeLessThanOrEqual(2000);
      expect((p.body.content.match(/```/g) ?? []).length % 2).toBe(0);
      expect(p.body.allowed_mentions).toEqual({ parse: [] });
    }
    expect(posts.slice(0, -1).every((p) => !p.body.components?.length)).toBe(true);
    expect(posts.at(-1)?.body.components).toHaveLength(1);
  });

  it('renders buttons as action rows and round-trips interactionCreate to onButton', async () => {
    const { fake, conn } = await setup();
    const presses: ButtonPress[] = [];
    conn.onButton?.((p) => presses.push(p));
    const buttons = Array.from({ length: 7 }, (_, i) => ({
      id: `b${i}`,
      label: `B${i}`,
      style: (i === 0 ? 'primary' : i === 1 ? 'danger' : 'default') as 'primary' | 'danger' | 'default',
    }));
    const sent = await conn.send({
      conversation: { kind: 'channel', id: h.THREAD },
      markdown: 'Approve?',
      buttons,
    });
    const body = fake.req('POST', /messages$/)[0]?.body;
    expect(body.components).toHaveLength(2);
    expect(body.components[0].type).toBe(1);
    expect(body.components[0].components).toHaveLength(5);
    expect(body.components[1].components).toHaveLength(2);
    expect(body.components[0].components.slice(0, 3)).toEqual([
      { type: 2, custom_id: 'bh:b0', label: 'B0', style: 1 },
      { type: 2, custom_id: 'bh:b1', label: 'B1', style: 4 },
      { type: 2, custom_id: 'bh:b2', label: 'B2', style: 2 },
    ]);

    const interactionId = h.nextId();
    fake.dispatch('INTERACTION_CREATE', {
      id: interactionId,
      application_id: h.BOT_ID,
      type: 3,
      data: { custom_id: 'bh:b1', component_type: 2 },
      guild_id: h.GUILD,
      channel_id: h.THREAD,
      channel: { id: h.THREAD, type: 11, guild_id: h.GUILD, parent_id: h.GENERAL, name: 'PR 42 review' },
      member: {
        user: h.aliceUser,
        roles: [],
        permissions: '1071698660929',
        joined_at: '2026-11-13T00:00:00.000000+00:00',
        deaf: false,
        mute: false,
        flags: 0,
        nick: null,
        avatar: null,
        premium_since: null,
        pending: false,
      },
      token: 'interaction-token-abc',
      version: 1,
      message: h.messagePayload({
        id: sent.id,
        channel_id: h.THREAD,
        author: h.botUser,
        member: undefined,
        content: 'Approve?',
        components: body.components,
      }),
      app_permissions: '277025492032',
      locale: 'en-US',
      guild_locale: 'en-US',
      entitlements: [],
      authorizing_integration_owners: { '0': h.GUILD },
      context: 0,
    });
    await tick();
    expect(presses).toEqual([
      { messageId: sent.id, buttonId: 'b1', principal: `discord:${h.ALICE}`, conversationId: h.GENERAL },
    ]);
    const cb = fake.req('POST', /^\/interactions\//)[0];
    expect(cb?.path).toBe(`/interactions/${interactionId}/interaction-token-abc/callback`);
    expect(cb?.body).toMatchObject({ type: 6 }); // DEFERRED_UPDATE_MESSAGE
  });

  it('hashes button ids longer than custom_id allows and still round-trips them', async () => {
    const { fake, conn } = await setup();
    const presses: ButtonPress[] = [];
    conn.onButton?.((p) => presses.push(p));
    const longId = `approve:${'x'.repeat(150)}`;
    const sent = await conn.send({
      conversation: { kind: 'dm', id: h.DM },
      markdown: 'ok?',
      buttons: [{ id: longId, label: 'OK' }],
    });
    const cid = fake.req('POST', /messages$/)[0]?.body.components[0].components[0].custom_id as string;
    expect(cid.length).toBeLessThanOrEqual(100);
    fake.dispatch('INTERACTION_CREATE', {
      id: h.nextId(),
      application_id: h.BOT_ID,
      type: 3,
      data: { custom_id: cid, component_type: 2 },
      channel_id: h.DM,
      channel: { id: h.DM, type: 1 },
      user: h.aliceUser,
      token: 'tok2',
      version: 1,
      message: h.dmPayload({ id: sent.id, author: h.botUser, content: 'ok?' }),
      app_permissions: '0',
      locale: 'en-US',
      entitlements: [],
      authorizing_integration_owners: { '1': h.ALICE },
      context: 1,
    });
    await tick();
    expect(presses[0]).toMatchObject({
      buttonId: longId,
      conversationId: h.DM,
      principal: `discord:${h.ALICE}`,
    });
  });

  it('live-edits via message.edit and grows/shrinks parts', async () => {
    const { fake, conn } = await setup();
    const sent = await conn.send({
      conversation: { kind: 'channel', id: h.GENERAL },
      markdown: 'thinking…',
      buttons: [{ id: 'stop', label: 'Stop', style: 'danger' }],
    });
    await sent.edit?.('step 1 done');
    const [patch] = fake.req('PATCH', /messages\/\d+$/);
    expect(patch?.path).toBe(`/channels/${h.GENERAL}/messages/${sent.id}`);
    expect(patch?.body).toMatchObject({ content: 'step 1 done', allowed_mentions: { parse: [] } });
    expect(patch?.body.components[0].components[0].custom_id).toBe('bh:stop');

    await sent.edit?.(Array.from({ length: 100 }, (_, i) => `line ${i} ${'y'.repeat(40)}`).join('\n'));
    expect(fake.req('POST', /messages$/).length).toBe(1 + 2); // original + 2 overflow parts
    // Buttons moved from the first part to the new last part.
    expect(fake.req('PATCH', /messages\/\d+$/).at(-1)?.body.components).toEqual([]);
    expect(fake.req('POST', /messages$/).at(-1)?.body.components).toHaveLength(1);

    await sent.edit?.('final');
    expect(fake.req('DELETE', /messages\/\d+$/)).toHaveLength(2);
  });

  it('sends typing to the channel/thread of the latest inbound', async () => {
    const { fake, conn, drain } = await setup();
    await drain([h.messagePayload({ channel_id: h.THREAD, content: 'in thread' })]);
    await conn.typing?.(h.GENERAL);
    expect(fake.req('POST', /typing$/)[0]?.path).toBe(`/channels/${h.THREAD}/typing`);
    await conn.typing?.('1999999999999999999'); // unknown: swallowed
  });

  it('sends files as multipart attachments', async () => {
    const { fake, conn } = await setup();
    await conn.send({
      conversation: { kind: 'channel', id: h.GENERAL },
      markdown: 'report attached',
      attachments: [{ name: 'report.txt', mime: 'text/plain', localPath: '/work/out/report.txt' }],
    });
    const [post] = fake.req('POST', /messages$/);
    expect(post?.files).toEqual(['report.txt']);
    expect(post?.body).toMatchObject({ content: 'report attached', allowed_mentions: { parse: [] } });
    expect(post?.body.attachments).toEqual([{ id: '0' }]); // filename travels in the multipart part
  });

  it('sends file-only messages and >10 files across messages', async () => {
    const { fake, conn } = await setup();
    const attachments = Array.from({ length: 12 }, (_, i) => ({
      name: `f${i}.txt`,
      mime: 'text/plain',
      localPath: '/work/out/report.txt',
    }));
    const sent = await conn.send({ conversation: { kind: 'dm', id: h.DM }, markdown: '', attachments });
    const posts = fake.req('POST', /messages$/);
    expect(posts.map((p) => p.files.length)).toEqual([10, 2]);
    expect(posts[0]?.body.content).toBeUndefined();
    expect(sent.id).toMatch(/^\d+$/);
  });

  it('rate limit: retries a 429 on send transparently', async () => {
    const { fake, conn } = await setup();
    fake.override(
      'POST',
      /^\/channels\/\d+\/messages$/,
      () =>
        new Response(
          JSON.stringify({ message: 'You are being rate limited.', retry_after: 0.05, global: false }),
          {
            status: 429,
            headers: {
              'content-type': 'application/json',
              'retry-after': '0.05',
              'x-ratelimit-scope': 'user',
              'x-ratelimit-limit': '5',
              'x-ratelimit-remaining': '0',
              'x-ratelimit-reset-after': '0.05',
              'x-ratelimit-bucket': 'msgbucket',
            },
          },
        ),
    );
    const sent = await conn.send({
      conversation: { kind: 'channel', id: h.GENERAL },
      markdown: 'eventually',
    });
    expect(sent.id).toMatch(/^\d+$/);
    expect(fake.req('POST', /messages$/)).toHaveLength(2);
  });

  it('fails sends after close', async () => {
    const { conn } = await setup();
    await conn.close();
    await expect(conn.send({ conversation: { kind: 'dm', id: h.DM }, markdown: 'x' })).rejects.toMatchObject({
      code: 'unavailable',
    });
  });
});

describe('discord removal (kick) events', () => {
  it('guildDelete (kick) fires onRemoved for the guild channels; outages do not', async () => {
    const { fake, conn, drain } = await setup();
    const removed: string[] = [];
    conn.onRemoved?.((id) => removed.push(id));
    await drain([h.messagePayload({ content: 'hi' })]);
    fake.dispatch('GUILD_DELETE', { id: h.GUILD, unavailable: true }); // outage
    await tick();
    expect(removed).toEqual([]);
    fake.dispatch('GUILD_CREATE', h.guildCreate());
    fake.dispatch('GUILD_DELETE', { id: h.GUILD }); // kicked
    await tick();
    expect(new Set(removed)).toEqual(new Set([h.GENERAL, h.RANDOM]));
  });

  it('channelDelete fires onRemoved', async () => {
    const { fake, conn } = await setup();
    const removed: string[] = [];
    conn.onRemoved?.((id) => removed.push(id));
    fake.dispatch('CHANNEL_DELETE', {
      id: h.RANDOM,
      type: 0,
      guild_id: h.GUILD,
      name: 'random',
      position: 1,
      permission_overwrites: [],
    });
    await tick();
    expect(removed).toEqual([h.RANDOM]);
  });
});

describe('markdownToDiscord', () => {
  it('passes native markdown through and adapts the rest', () => {
    expect(markdownToDiscord('**b** _i_ ~~s~~ `c` [l](https://x.io)\n# H1\n#### H4')).toBe(
      '**b** _i_ ~~s~~ `c` [l](https://x.io)\n# H1\n**H4**',
    );
    expect(markdownToDiscord('| a | b |\n|---|---|\n| 1 | 2 |\nafter')).toBe(
      '```\n| a | b |\n|---|---|\n| 1 | 2 |\n```\nafter',
    );
    expect(markdownToDiscord('![chart](https://x.io/c.png)')).toBe('[chart](https://x.io/c.png)');
    expect(markdownToDiscord('```\n#### not a heading\n```')).toBe('```\n#### not a heading\n```');
  });
});
