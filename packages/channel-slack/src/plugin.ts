import {
  BeamhopError,
  type ChannelConn,
  type ChannelContext,
  type ChannelPlugin,
  type Logger,
  type SetupWizard,
  type WizardValidation,
} from '@beamhop/core';
import { LogLevel, type Logger as SlackLogger, SocketModeClient } from '@slack/socket-mode';
import { type FetchLike, SlackApi, type SlackApiOptions } from './api.ts';
import { SlackConn, type SlackSocketLike } from './conn.ts';
import { SLACK_BOT_SCOPES, type SlackManifestOptions, slackManifestUrl } from './manifest.ts';

export const SLACK_SECRET_APP_TOKEN = 'appToken';
export const SLACK_SECRET_BOT_TOKEN = 'botToken';

export interface SlackPluginOptions extends SlackManifestOptions {
  fetch?: FetchLike;
  /** Broker-backed fetch for outbound URL attachments (see `SlackConnDeps.fetchAttachment`). */
  fetchAttachment?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** Build the Socket Mode client (defaults to `@slack/socket-mode`'s SocketModeClient). */
  socketFactory?: (appToken: string, log: Logger) => SlackSocketLike;
  readFile?: (path: string) => Promise<Uint8Array>;
  now?: () => Date;
}

/** Adapt beamhop's Logger to `@slack/logger`'s interface. */
const slackLogger = (log: Logger): SlackLogger => {
  let level = LogLevel.INFO;
  const fmt = (m: unknown[]) => m.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  return {
    debug: (...m: unknown[]) => log.debug(fmt(m)),
    info: (...m: unknown[]) => log.info(fmt(m)),
    warn: (...m: unknown[]) => log.warn(fmt(m)),
    error: (...m: unknown[]) => log.error(fmt(m)),
    setLevel: (l: LogLevel) => {
      level = l;
    },
    getLevel: () => level,
    setName: () => {},
  };
};

const defaultSocketFactory = (appToken: string, log: Logger): SlackSocketLike =>
  new SocketModeClient({ appToken, logger: slackLogger(log.child({ lib: 'slack-socket-mode' })) });

const checkPrefix = (value: string | undefined, prefix: string, label: string): string | undefined => {
  if (!value) return `${label} is missing`;
  if (!value.startsWith(prefix)) return `${label} must start with "${prefix}"`;
  return undefined;
};

export const createSlackSetup = (opts: SlackPluginOptions = {}): SetupWizard => {
  const apiOpts: SlackApiOptions = {
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
  };
  return {
    steps: [
      {
        id: 'create-app',
        title: 'Create the Slack app from a manifest',
        body: [
          'Open the link, pick your workspace and click **Create**. The manifest prefills:',
          '',
          '- **Socket Mode** on (no public URL needed) and **Interactivity** on (buttons)',
          `- Bot scopes: ${SLACK_BOT_SCOPES.map((s) => `\`${s}\``).join(', ')}`,
          '- Events: `app_mention`, `message.im`, `message.channels`, `message.groups`, `message.mpim`, `member_left_channel`, `channel_left`',
          '- The app description labels it as an **AI agent** operated by you.',
        ].join('\n'),
        link: { label: 'Create app from manifest', url: slackManifestUrl(opts) },
        fields: [],
      },
      {
        id: 'app-token',
        title: 'Create an app-level token',
        body: [
          'In **Basic Information → App-Level Tokens**, click **Generate Token and Scopes**,',
          'add the scope `connections:write`, and copy the token (starts with `xapp-`).',
        ].join('\n'),
        fields: [
          {
            kind: 'secret',
            id: SLACK_SECRET_APP_TOKEN,
            label: 'App-level token (xapp-…)',
            help: 'Needs the connections:write scope (Socket Mode).',
            envFlag: 'BEAMHOP_SLACK_APP_TOKEN',
          },
        ],
      },
      {
        id: 'install',
        title: 'Install to your workspace and copy the bot token',
        body: [
          'In **Install App**, click **Install to Workspace** and approve.',
          'Copy the **Bot User OAuth Token** (starts with `xoxb-`).',
          'Afterwards invite the bot to channels with `/invite @<bot name>`.',
        ].join('\n'),
        fields: [
          {
            kind: 'secret',
            id: SLACK_SECRET_BOT_TOKEN,
            label: 'Bot token (xoxb-…)',
            envFlag: 'BEAMHOP_SLACK_BOT_TOKEN',
          },
        ],
      },
    ],

    async validate(_values, secrets): Promise<WizardValidation> {
      const appToken = secrets[SLACK_SECRET_APP_TOKEN];
      const botToken = secrets[SLACK_SECRET_BOT_TOKEN];
      const bad =
        checkPrefix(botToken, 'xoxb-', 'Bot token') ?? checkPrefix(appToken, 'xapp-', 'App-level token');
      if (bad) return { ok: false, message: bad };
      try {
        // https://api.slack.com/methods/auth.test
        const auth = await new SlackApi(botToken as string, apiOpts).call<{
          ok: true;
          team: string;
          team_id: string;
          user: string;
          user_id: string;
          bot_id?: string;
        }>('auth.test');
        // https://api.slack.com/methods/apps.connections.open — proves the xapp token can open Socket Mode.
        await new SlackApi(appToken as string, apiOpts).call('apps.connections.open');
        let avatarUrl: string | undefined;
        let name = auth.user;
        try {
          const u = await new SlackApi(botToken as string, apiOpts).call<{
            ok: true;
            user?: {
              real_name?: string;
              profile?: { image_72?: string; real_name?: string; display_name?: string };
            };
          }>('users.info', { user: auth.user_id });
          avatarUrl = u.user?.profile?.image_72;
          name = u.user?.profile?.display_name || u.user?.real_name || name;
        } catch {
          // optional
        }
        return {
          ok: true,
          message: `Connected to ${auth.team} as @${auth.user}.`,
          identity: { name, handle: `@${auth.user}`, ...(avatarUrl ? { avatarUrl } : {}) },
        };
      } catch (e) {
        const se = (e as { slackError?: string }).slackError;
        const hint =
          se === 'invalid_auth' || se === 'not_authed'
            ? ' — check that you copied the whole token.'
            : se === 'not_allowed_token_type'
              ? ' — token type is wrong (xoxb- for the bot token, xapp- for the app token).'
              : se === 'missing_scope'
                ? ' — the app-level token needs the connections:write scope.'
                : '';
        return { ok: false, message: `${(e as Error).message}${hint}` };
      }
    },
  };
};

export const createSlackPlugin = (opts: SlackPluginOptions = {}): ChannelPlugin => ({
  id: 'slack',
  displayName: 'Slack',
  setup: createSlackSetup(opts),
  async connect(ctx: ChannelContext): Promise<ChannelConn> {
    const appToken = ctx.secrets[SLACK_SECRET_APP_TOKEN];
    const botToken = ctx.secrets[SLACK_SECRET_BOT_TOKEN];
    const bad =
      checkPrefix(botToken, 'xoxb-', 'Bot token') ?? checkPrefix(appToken, 'xapp-', 'App-level token');
    if (bad) throw new BeamhopError('invalid_input', `slack channel "${ctx.name}": ${bad}`);
    const log = ctx.log.child({ channel: ctx.name, provider: 'slack' });
    const api = new SlackApi(botToken as string, {
      log,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
    });
    const auth = await api.call<{
      ok: true;
      team_id: string;
      user_id: string;
      bot_id?: string;
      user: string;
    }>('auth.test');
    const socket = (opts.socketFactory ?? defaultSocketFactory)(appToken as string, log);
    const meshPeers = Array.isArray(ctx.settings.meshPeers)
      ? (ctx.settings.meshPeers as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];
    const conn = new SlackConn({
      name: ctx.name,
      api,
      socket,
      self: {
        teamId: auth.team_id,
        userId: auth.user_id,
        ...(auth.bot_id ? { botId: auth.bot_id } : {}),
        name: typeof ctx.settings.displayName === 'string' ? ctx.settings.displayName : auth.user,
      },
      log,
      meshPeers,
      resolveNames: ctx.settings.resolveNames !== false,
      ...(opts.fetchAttachment ? { fetchAttachment: opts.fetchAttachment } : {}),
      ...(opts.readFile ? { readFile: opts.readFile } : {}),
      ...(opts.now ? { now: opts.now } : {}),
    });
    await socket.start();
    log.info('slack connected', { team: auth.team_id, bot: auth.user_id });
    return conn;
  },
});

export const slackPlugin: ChannelPlugin = createSlackPlugin();
