import {
  BeamhopError,
  type ChannelConn,
  type ChannelContext,
  type ChannelPlugin,
  type SetupWizard,
  type WizardValidation,
} from '@beamhop/core';
import { DiscordAPIError, REST, type RESTOptions } from '@discordjs/rest';
import { Client, type ClientOptions, Events, GatewayIntentBits, Partials, Routes } from 'discord.js';
import { DiscordConn } from './conn.ts';
import {
  APP_FLAG_GATEWAY_MESSAGE_CONTENT,
  APP_FLAG_GATEWAY_MESSAGE_CONTENT_LIMITED,
  applicationIdFromToken,
  DISCORD_MIN_PERMISSIONS,
  discordInviteUrl,
} from './permissions.ts';

export const DISCORD_SECRET_BOT_TOKEN = 'botToken';

/**
 * Gateway intents (https://discord.com/developers/docs/events/gateway#gateway-intents).
 * MessageContent is privileged and must be enabled in the Developer Portal.
 */
export const DISCORD_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.DirectMessages,
  GatewayIntentBits.MessageContent,
] as const;

/** Options every gateway client is built with. `Partials.Channel` is required to receive DMs in discord.js v14. */
export const discordClientOptions = (): ClientOptions => ({
  intents: [...DISCORD_INTENTS],
  partials: [Partials.Channel],
  allowedMentions: { parse: [] },
});

export interface DiscordPluginOptions {
  /** Build the gateway client (tests inject a client driven by fake gateway packets). */
  clientFactory?: (options: ClientOptions) => Client;
  /** REST options for validate() (tests pass `makeRequest`). */
  rest?: Partial<RESTOptions>;
  /** Prefill the invite URL in the wizard. */
  applicationId?: string;
  fetch?: (url: string) => Promise<Response>;
  readFile?: (path: string) => Promise<Uint8Array>;
  readyTimeoutMs?: number;
  now?: () => Date;
}

const TOKEN_SHAPE = /^[\w-]{20,}\.[\w-]{4,}\.[\w-]{20,}$/;

export const createDiscordSetup = (opts: DiscordPluginOptions = {}): SetupWizard => ({
  steps: [
    {
      id: 'create-app',
      title: 'Create a Discord application and bot',
      body: [
        '1. Open the Developer Portal and click **New Application**. Name it after your agent.',
        '2. In **General Information**, set the description to say it is an **AI agent** operated by you.',
        '3. Open **Bot**: click **Reset Token** and copy the token.',
        '4. Still under **Bot → Privileged Gateway Intents**, enable **Message Content Intent** and save.',
      ].join('\n'),
      link: { label: 'Open Discord Developer Portal', url: 'https://discord.com/developers/applications' },
      fields: [
        {
          kind: 'secret',
          id: DISCORD_SECRET_BOT_TOKEN,
          label: 'Bot token',
          help: 'Bot → Reset Token. Never share it.',
          envFlag: 'BEAMHOP_DISCORD_TOKEN',
        },
      ],
    },
    {
      id: 'invite',
      title: 'Invite the bot to your server',
      body: [
        'Open the invite link and pick a server. It requests only: View Channels, Send Messages,',
        'Send Messages in Threads, Read Message History, Attach Files, Add Reactions and Use Slash Commands',
        `(permissions=${DISCORD_MIN_PERMISSIONS}). After validation beamhop shows the exact link for your app.`,
      ].join('\n'),
      ...(opts.applicationId
        ? { link: { label: 'Invite bot', url: discordInviteUrl(opts.applicationId) } }
        : {}),
      fields: [
        {
          kind: 'text',
          id: 'applicationId',
          label: 'Application ID',
          help: 'General Information → Application ID (optional; derived from the token if empty).',
          optional: true,
        },
      ],
    },
  ],

  async validate(values, secrets): Promise<WizardValidation> {
    const token = secrets[DISCORD_SECRET_BOT_TOKEN]?.trim();
    if (!token) return { ok: false, message: 'Bot token is missing' };
    if (!TOKEN_SHAPE.test(token))
      return { ok: false, message: 'That does not look like a Discord bot token' };
    const rest = new REST({ version: '10', ...opts.rest }).setToken(token);
    try {
      // https://discord.com/developers/docs/resources/user#get-current-user
      const me = (await rest.get(Routes.user('@me'))) as {
        id: string;
        username: string;
        global_name?: string | null;
        avatar?: string | null;
        bot?: boolean;
      };
      if (!me.bot) return { ok: false, message: 'This token belongs to a user account, not a bot.' };
      let flags = 0;
      let appId =
        typeof values.applicationId === 'string' && values.applicationId ? values.applicationId : me.id;
      try {
        // https://discord.com/developers/docs/resources/application#get-current-application
        const app = (await rest.get(Routes.currentApplication())) as { id: string; flags?: number };
        flags = app.flags ?? 0;
        appId = app.id;
      } catch {
        // optional
      }
      const invite = discordInviteUrl(appId);
      const contentOk =
        (flags & (APP_FLAG_GATEWAY_MESSAGE_CONTENT | APP_FLAG_GATEWAY_MESSAGE_CONTENT_LIMITED)) !== 0;
      const warn = contentOk
        ? ''
        : ' Warning: the Message Content intent looks disabled — enable it under Bot → Privileged Gateway Intents.';
      return {
        ok: true,
        message: `Connected as ${me.username}. Invite it: ${invite}${warn}`,
        identity: {
          name: me.global_name ?? me.username,
          handle: me.username,
          ...(me.avatar ? { avatarUrl: `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png` } : {}),
        },
      };
    } catch (e) {
      if (e instanceof DiscordAPIError && e.status === 401) {
        return {
          ok: false,
          message: 'Discord rejected the token (401). Reset it in the Developer Portal and paste it again.',
        };
      }
      return { ok: false, message: `Discord validation failed: ${(e as Error).message}` };
    } finally {
      rest.clearHashSweeper();
      rest.clearHandlerSweeper();
    }
  },
});

const waitReady = (client: Client, timeoutMs: number) =>
  new Promise<void>((resolve, reject) => {
    if (client.isReady()) return resolve();
    const t = setTimeout(
      () => reject(new BeamhopError('timeout', 'discord gateway did not become ready')),
      timeoutMs,
    );
    client.once(Events.ClientReady, () => {
      clearTimeout(t);
      resolve();
    });
  });

export const createDiscordPlugin = (opts: DiscordPluginOptions = {}): ChannelPlugin => ({
  id: 'discord',
  displayName: 'Discord',
  setup: createDiscordSetup(opts),
  async connect(ctx: ChannelContext): Promise<ChannelConn> {
    const token = ctx.secrets[DISCORD_SECRET_BOT_TOKEN]?.trim();
    if (!token)
      throw new BeamhopError('invalid_input', `discord channel "${ctx.name}": bot token is missing`);
    const log = ctx.log.child({ channel: ctx.name, provider: 'discord' });
    const client = (opts.clientFactory ?? ((o) => new Client(o)))(discordClientOptions());
    const ready = waitReady(client, opts.readyTimeoutMs ?? 30_000);
    try {
      await client.login(token);
      await ready;
    } catch (e) {
      await client.destroy().catch(() => {});
      if (e instanceof BeamhopError) throw e;
      const msg = (e as Error).message ?? String(e);
      // "Used disallowed intents" → Message Content intent not enabled in the portal.
      throw new BeamhopError(
        /disallowed intents/i.test(msg) ? 'forbidden' : /token/i.test(msg) ? 'unauthorized' : 'unavailable',
        `discord login failed: ${msg}`,
      );
    }
    const user = client.user;
    if (!user) throw new BeamhopError('internal', 'discord client has no user after ready');
    const meshPeers = Array.isArray(ctx.settings.meshPeers)
      ? (ctx.settings.meshPeers as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];
    const conn = new DiscordConn({
      name: ctx.name,
      client,
      self: { id: user.id, name: user.globalName ?? user.username },
      log,
      meshPeers,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.readFile ? { readFile: opts.readFile } : {}),
      ...(opts.now ? { now: opts.now } : {}),
    });
    log.info('discord connected', {
      bot: user.id,
      invite: discordInviteUrl(applicationIdFromToken(token) ?? user.id),
    });
    return conn;
  },
});

export const discordPlugin: ChannelPlugin = createDiscordPlugin();
