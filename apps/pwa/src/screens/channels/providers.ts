/**
 * Provider knowledge for the channel wizard (JOURNEYS §4): which steps exist, what each credential
 * looks like (shape check before any network call), and the deep links into each provider's own UI.
 * Pure functions only, so the fiddly bits (manifest URL, invite permissions, deep-link params) are unit-tested.
 *
 * The step *order* comes from the daemon (`channel.providers`); this file supplies the local copy
 * and validation for each step id. Unknown step ids render a generic step (plugin channels).
 */
import type { ChannelView } from '@beamhop/core';

export type StepId = 'create' | 'credentials' | 'validate' | 'connect' | 'pair' | 'join' | 'relay' | 'group';

export const DEFAULT_STEPS: Record<string, StepId[]> = {
  telegram: ['create', 'credentials', 'validate', 'connect', 'pair', 'join'],
  slack: ['create', 'credentials', 'validate', 'connect', 'pair', 'join'],
  discord: ['create', 'credentials', 'validate', 'connect', 'join', 'pair'],
  nostr: ['relay', 'group', 'join'],
};

export const STEP_LABEL: Record<string, string> = {
  create: 'Create',
  credentials: 'Credentials',
  validate: 'Validate',
  connect: 'Connect',
  pair: 'Pair',
  join: 'Join',
  relay: 'Relay',
  group: 'Group',
};

/** `channel.providers` steps are `unknown[]` in the contract: accept strings or `{ id }` objects. */
export const normalizeSteps = (provider: string, steps?: unknown[]): string[] => {
  const ids = (steps ?? [])
    .map((s) => (typeof s === 'string' ? s : (s as { id?: unknown } | null)?.id))
    .filter((s): s is string => typeof s === 'string' && s.length > 0);
  return ids.length > 0 ? ids : (DEFAULT_STEPS[provider] ?? ['credentials', 'validate', 'connect', 'join']);
};

/** Steps the user never "does": they resolve in place on the Credentials screen (SCREENS §5). */
export const AUTO_STEPS = new Set(['validate', 'connect']);

export interface SecretSpec {
  /** Vault key suffix: `channel/<name>/<key>`. */
  key: string;
  label: string;
  format: RegExp;
  formatLabel: string;
  /** Shape hint shown before anything is typed (never a real-looking token). */
  shape: string;
  /** Prefix that identifies this secret, for wrong-field detection. */
  prefix?: string;
}

export interface ProviderMeta {
  id: string;
  name: string;
  /** Picker line: `Bot token · 2 min`. */
  how: string;
  minutes: number;
  transport: string;
  secrets: SecretSpec[];
}

export const PROVIDERS: Record<string, ProviderMeta> = {
  telegram: {
    id: 'telegram',
    name: 'Telegram',
    how: 'Bot token',
    minutes: 2,
    transport: 'long-polling',
    secrets: [
      {
        key: 'bot-token',
        label: 'Bot token',
        format: /^\d{6,12}:[A-Za-z0-9_-]{30,}$/,
        formatLabel: 'Looks like a bot token',
        shape: '123456:ABC…',
      },
    ],
  },
  slack: {
    id: 'slack',
    name: 'Slack',
    how: 'App from manifest',
    minutes: 4,
    transport: 'Socket Mode',
    secrets: [
      {
        key: 'app-token',
        label: 'App-level token',
        format: /^xapp-\d-[A-Za-z0-9]+-\d+-[A-Za-z0-9]{16,}$/,
        formatLabel: 'Looks like an app-level token',
        shape: 'xapp-1-…',
        prefix: 'xapp-',
      },
      {
        key: 'bot-token',
        label: 'Bot token',
        format: /^xoxb-\d+-\d+-[A-Za-z0-9]{16,}$/,
        formatLabel: 'Looks like a bot token',
        shape: 'xoxb-…',
        prefix: 'xoxb-',
      },
    ],
  },
  discord: {
    id: 'discord',
    name: 'Discord',
    how: 'Developer Portal',
    minutes: 4,
    transport: 'gateway',
    secrets: [
      {
        key: 'bot-token',
        label: 'Bot token',
        format: /^[A-Za-z0-9_-]{18,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}$/,
        formatLabel: 'Three dot-separated parts, like a bot token',
        shape: 'MTMw….Gx….…',
      },
    ],
  },
  nostr: {
    id: 'nostr',
    name: 'Nostr group',
    how: 'Relay group',
    minutes: 1,
    transport: 'relay',
    secrets: [
      {
        key: 'nsec',
        label: 'Group key (nsec)',
        format: /^nsec1[02-9ac-hj-np-z]{58}$/,
        formatLabel: 'Looks like an nsec',
        shape: 'nsec1…',
        prefix: 'nsec1',
      },
    ],
  },
};

export const providerMeta = (id: string): ProviderMeta =>
  PROVIDERS[id] ?? { id, name: id, how: 'Plugin', minutes: 3, transport: 'plugin', secrets: [] };

/** Pasted into the wrong field? Returns the key of the field it belongs to (Slack app vs bot token). */
export const misplacedSecret = (
  meta: ProviderMeta,
  fieldKey: string,
  value: string,
): SecretSpec | undefined => {
  const v = value.trim();
  if (!v) return undefined;
  return meta.secrets.find((s) => s.key !== fieldKey && s.prefix && v.startsWith(s.prefix));
};

// ─────────── names ───────────

/** Channel names are slugs (`[a-z0-9][a-z0-9-]*`, ≤48). */
export const toSlug = (raw: string): string =>
  raw
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/_bot$|bot$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');

export const isSlug = (s: string): boolean => /^[a-z0-9][a-z0-9-]{0,47}$/.test(s);

/** A free channel name: `base`, `base-2`, `base-3`… */
export const uniqueName = (base: string, taken: Iterable<string>): string => {
  const set = new Set(taken);
  const b = isSlug(base) ? base : 'channel';
  if (!set.has(b)) return b;
  for (let i = 2; i < 100; i++) if (!set.has(`${b}-${i}`)) return `${b}-${i}`;
  return `${b}-${Date.now().toString(36)}`;
};

export const DEFAULT_NAME: Record<string, string> = {
  telegram: 'tg',
  slack: 'slack',
  discord: 'discord',
  nostr: 'nostr-group',
};

// ─────────── Telegram ───────────

export const BOTFATHER_URL = 'https://t.me/BotFather';

/** Telegram deep-link parameters allow `[A-Za-z0-9_-]`, ≤64 chars (core.telegram.org/bots/features). */
export const tgParam = (prefix: string, code: string): string =>
  `${prefix}-${code.replace(/[^A-Za-z0-9]/g, '')}`.slice(0, 64);

const bare = (handle: string) => handle.replace(/^@/, '');

export const telegramStartLink = (bot: string, code: string) =>
  `https://t.me/${bare(bot)}?start=${tgParam('pair', code)}`;
export const telegramGroupLink = (bot: string, code: string) =>
  `https://t.me/${bare(bot)}?startgroup=${tgParam('join', code)}`;

/** BotFather username rules: 5–32 chars, letters/digits/underscore, must end in "bot". */
export const suggestBotUsername = (agent: string, salt: string): string => {
  const a = agent.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'beamhop';
  const s = salt.replace(/[^a-z0-9]/gi, '').slice(0, 4) || 'bh';
  const head = `${a}_${s}`.slice(0, 32 - 4);
  return `${head}_bot`;
};
export const isBotUsername = (u: string) =>
  /^[A-Za-z][A-Za-z0-9_]{1,28}bot$/i.test(u) && u.length >= 5 && u.length <= 32;

// ─────────── Slack ───────────

export const slackManifest = (name: string) => ({
  display_information: {
    name,
    description: 'AI agent operated through beamhop',
    background_color: '#1b1612',
  },
  features: {
    app_home: { messages_tab_enabled: true, messages_tab_read_only_enabled: false },
    bot_user: { display_name: name, always_online: true },
    slash_commands: [
      {
        command: '/pair',
        description: 'Pair your Slack account with beamhop',
        usage_hint: 'CODE',
        should_escape: false,
      },
    ],
  },
  oauth_config: {
    scopes: {
      bot: [
        'app_mentions:read',
        'channels:history',
        'channels:read',
        'chat:write',
        'commands',
        'groups:history',
        'im:history',
        'im:read',
        'im:write',
        'users:read',
      ],
    },
  },
  settings: {
    event_subscriptions: { bot_events: ['app_mention', 'message.channels', 'message.groups', 'message.im'] },
    interactivity: { is_enabled: true },
    org_deploy_enabled: false,
    socket_mode_enabled: true,
    token_rotation_enabled: false,
  },
});

/** https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests — prefilled "Create app" link. */
export const slackCreateUrl = (name: string) =>
  `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(slackManifest(name)))}`;

export const SLACK_OPEN_URL = 'https://app.slack.com/client';

// ─────────── Discord ───────────

export const DISCORD_PORTAL_URL = 'https://discord.com/developers/applications';

/** View Channels, Send Messages, Embed Links, Attach Files, Read Message History. */
export const DISCORD_BASE_PERMISSIONS = 1024n + 2048n + 16384n + 32768n + 65536n; // 117760
export const DISCORD_THREADS_PERMISSION = 1n << 38n; // Send Messages in Threads

/** A bot token's first segment is the base64url bot user id, which is also the application (client) id. */
export const discordClientId = (token: string): string | undefined => {
  const seg = token.trim().split('.')[0];
  if (!seg) return undefined;
  try {
    const b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
    const id = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    return /^\d{15,22}$/.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
};

export const discordInviteUrl = (clientId: string, threads: boolean) => {
  const perms = DISCORD_BASE_PERMISSIONS + (threads ? DISCORD_THREADS_PERMISSION : 0n);
  return `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(clientId)}&scope=bot+applications.commands&permissions=${perms}`;
};

// ─────────── Nostr ───────────

/** Normalise a relay address: adds wss://, rejects ws:// (unencrypted) and paths with spaces. */
export const parseRelay = (raw: string): { url: string } | { error: string } => {
  const v = raw.trim().replace(/\/+$/, '');
  if (!v) return { error: 'Enter a relay address.' };
  if (/^ws:\/\//i.test(v)) return { error: 'Use wss:// — beamhop only talks to relays over TLS.' };
  const url = /^wss:\/\//i.test(v) ? v : `wss://${v.replace(/^https?:\/\//i, '')}`;
  if (!/^wss:\/\/[a-z0-9.-]+\.[a-z]{2,}(:\d+)?(\/[^\s]*)?$/i.test(url))
    return { error: "That doesn't look like a relay address." };
  return { url: url.toLowerCase() };
};

// ─────────── views ───────────

export interface Pairing {
  principal: string;
  displayName: string;
  handle?: string;
  role?: string;
  pairedAt: string;
}

/** Owner pairings recorded on the channel (`settings.pairings`, non-secret). */
export const channelPairings = (c?: ChannelView): Pairing[] =>
  ((c?.config.settings.pairings as Pairing[] | undefined) ?? []).filter(
    (p) => p && typeof p.principal === 'string',
  );

export interface ChatRef {
  target: string;
  title: string;
}

/** Chats the bot is in: `settings.chats` ({target,title}) or Slack's `settings.channels` (['#eng']). */
export const channelChats = (c?: ChannelView): ChatRef[] => {
  const s = c?.config.settings ?? {};
  const chats = (s.chats as ChatRef[] | undefined) ?? [];
  if (chats.length) return chats;
  const slack = (s.channels as string[] | undefined) ?? [];
  return slack.map((name) => ({ target: `channel/${name.replace(/^#/, '')}`, title: name }));
};

/** Transport line for slugs: `long-poll` / `Socket Mode` / `3/4 relays`. */
export const transportOf = (c: ChannelView): string => {
  const mode = c.config.settings.mode as string | undefined;
  if (mode === 'socket') return 'Socket Mode';
  if (mode) return mode;
  return providerMeta(c.config.provider).transport;
};
