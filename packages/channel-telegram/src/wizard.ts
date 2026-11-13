import type { SetupWizard, WizardValidation } from '@beamhop/core';
import { BotApi, fileRef, TelegramApiError } from './api.ts';
import type { TgUser, TgUserProfilePhotos } from './types.ts';

export const BOTFATHER_URL = 'https://t.me/BotFather';
const TOKEN_SHAPE = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;

export interface WizardOptions {
  apiRoot?: string;
  fetch?: typeof fetch;
}

export const createSetupWizard = (opts: WizardOptions = {}): SetupWizard => ({
  steps: [
    {
      id: 'create',
      title: 'Create a bot with @BotFather',
      body: [
        '1. Open **@BotFather** in Telegram.',
        '2. Send `/newbot`.',
        '3. Pick a display name, then a username that ends in `bot` (for example `my_agent_bot`).',
        '4. BotFather replies with an HTTP API token. Copy it for the next step.',
      ].join('\n'),
      link: { label: 'Open @BotFather', url: BOTFATHER_URL },
      fields: [],
    },
    {
      id: 'token',
      title: 'Paste the bot token',
      body: 'The token looks like `123456789:AA...`. It is stored in the encrypted beamhop vault, never in config files.',
      fields: [
        {
          kind: 'secret',
          id: 'token',
          label: 'Bot token',
          help: 'From @BotFather. Headless: pass --token-env <VAR> to read it from an environment variable.',
          envFlag: '--token-env',
        },
      ],
    },
    {
      id: 'groups',
      title: 'Optional: use the bot in groups',
      body: [
        'To use the agent in a group, add the bot to the group.',
        'By default the bot only sees messages that @mention it, reply to it, or are `/commands` — which is all',
        'beamhop needs to respond. If the agent should read **every** message (for context), send',
        '`/setprivacy` to @BotFather, pick the bot and choose **Disable**, then remove and re-add the bot to the group.',
        'Remove the bot from a group at any time to revoke its access there.',
      ].join(' '),
      link: { label: 'Open @BotFather', url: BOTFATHER_URL },
      fields: [],
    },
  ],

  async validate(_values, secrets): Promise<WizardValidation> {
    const token = (secrets.token ?? '').trim();
    if (!token) return { ok: false, message: 'Paste the bot token from @BotFather.' };
    if (!TOKEN_SHAPE.test(token)) {
      return {
        ok: false,
        message: 'That does not look like a bot token (expected "<digits>:<35 characters>").',
      };
    }
    const api = new BotApi({ token, ...opts });
    let me: TgUser;
    try {
      me = await api.call<TgUser>('getMe');
    } catch (e) {
      if (e instanceof TelegramApiError && (e.status === 401 || e.status === 404)) {
        return { ok: false, message: 'Telegram rejected this token. Copy it again from @BotFather.' };
      }
      return {
        ok: false,
        message: `Could not reach Telegram: ${e instanceof Error ? api.scrub(e.message) : 'error'}`,
      };
    }
    if (!me.is_bot) return { ok: false, message: 'This token does not belong to a bot.' };
    const identity: NonNullable<WizardValidation['identity']> = { name: me.first_name };
    if (me.username) identity.handle = `@${me.username}`;
    try {
      const photos = await api.call<TgUserProfilePhotos>('getUserProfilePhotos', {
        user_id: me.id,
        limit: 1,
      });
      const sizes = photos.photos[0];
      const small = sizes?.[0];
      // A Bot API file URL embeds the token, so return a broker reference the daemon can resolve.
      if (small) identity.avatarUrl = fileRef(small.file_id);
    } catch {
      // Avatar is optional.
    }
    const privacy =
      me.can_read_all_group_messages === true
        ? ' Privacy mode is off: in groups the bot sees every message.'
        : ' Privacy mode is on: in groups the bot sees only mentions, replies and commands.';
    return { ok: true, message: `Connected to ${identity.handle ?? me.first_name}.${privacy}`, identity };
  },
});
