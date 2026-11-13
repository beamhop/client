import { describe, expect, it } from 'vitest';
import { clearDraft, listDrafts, readDraft, writeDraft } from './draft.ts';
import {
  channelChats,
  channelSecretRef,
  discordClientId,
  discordInviteUrl,
  isBotUsername,
  misplacedSecret,
  normalizeSteps,
  PLUGIN_STEPS,
  PROVIDERS,
  parseRelay,
  pluginSecretFields,
  providerMeta,
  secretKeyOf,
  slackCreateUrl,
  suggestBotUsername,
  telegramGroupLink,
  telegramStartLink,
  toSlug,
  uniqueName,
  validationCaution,
} from './providers.ts';

// Token-shaped values are assembled at runtime (never committed as literals).
const tg = () => `${'1'.repeat(9)}:${'aB3-'.repeat(9)}`;
const xoxb = () => ['xoxb', '12', '34', 'q'.repeat(20)].join('-');
const xapp = () => ['xapp', '1', 'A0B', '99', 'f'.repeat(20)].join('-');

describe('channel providers', () => {
  it('uses string step lists as the order, with a per-provider fallback', () => {
    expect(normalizeSteps('discord', ['create', 'credentials', 'join'])).toEqual([
      'create',
      'credentials',
      'join',
    ]);
    expect(normalizeSteps('telegram')).toHaveLength(6);
    expect(normalizeSteps('discord').indexOf('join')).toBeLessThan(normalizeSteps('discord').indexOf('pair'));
    expect(normalizeSteps('matrix', [])).toContain('credentials');
  });

  // Regression (real daemon): `channel.providers` returns each plugin's WizardStep objects.
  const tgSteps = [
    { id: 'create', title: 'Create a bot', body: '', fields: [] },
    { id: 'token', title: 'Paste', body: '', fields: [{ kind: 'secret', id: 'token', label: 'Bot token' }] },
    { id: 'groups', title: 'Groups', body: '', fields: [] },
  ];
  const fakeSteps = [
    {
      id: 'token',
      title: 'Token',
      body: 'paste',
      fields: [
        { kind: 'secret', id: 'token', label: 'Token', help: 'from the bot' },
        { kind: 'text', id: 'room', label: 'Room' },
      ],
    },
    { id: 'again', title: 'Again', body: '', fields: [{ kind: 'secret', id: 'token', label: 'Dup' }] },
  ];
  it('keeps the bespoke flow for built-ins when the daemon sends plugin WizardSteps', () => {
    expect(normalizeSteps('telegram', tgSteps)).toEqual(normalizeSteps('telegram'));
    expect(normalizeSteps('fake', fakeSteps)).toEqual(PLUGIN_STEPS);
  });
  it('collects a plugin channel’s secret fields from its wizard steps', () => {
    expect(pluginSecretFields(fakeSteps)).toEqual([{ id: 'token', label: 'Token', help: 'from the bot' }]);
    const meta = providerMeta('fake', fakeSteps);
    expect(meta.secrets.map((s) => s.key)).toEqual(['token']);
    expect(meta.secrets[0]!.format.test('x')).toBe(true);
    expect(meta.secrets[0]!.format.test('  ')).toBe(false);
    expect(providerMeta('fake').secrets).toEqual([]);
  });
  it('uses the plugins’ secret field ids and the daemon’s vault naming', () => {
    expect(PROVIDERS.telegram!.secrets.map((s) => s.key)).toEqual(['token']);
    expect(PROVIDERS.slack!.secrets.map((s) => s.key)).toEqual(['appToken', 'botToken']);
    expect(PROVIDERS.discord!.secrets.map((s) => s.key)).toEqual(['botToken']);
    expect(PROVIDERS.nostr!.secrets.map((s) => s.key)).toEqual(['nsec']);
    expect(channelSecretRef('tg', 'token')).toBe('channel.tg.token');
    expect(secretKeyOf('tg', 'channel.tg.token')).toBe('token');
    expect(secretKeyOf('my.chan', 'channel.my.chan.botToken')).toBe('botToken');
  });
  it('treats only warning words in a successful validation as a caution', () => {
    expect(validationCaution('Connected to @bot.')).toBe(false);
    expect(validationCaution('Valid')).toBe(false);
    expect(validationCaution('Connected as x. Warning: the Message Content intent looks disabled')).toBe(
      true,
    );
    expect(validationCaution('Message Content intent is off.')).toBe(true);
  });

  it('checks credential shapes before any network call', () => {
    const [bot] = PROVIDERS.telegram!.secrets;
    expect(bot!.format.test(tg())).toBe(true);
    expect(bot!.format.test('123:short')).toBe(false);
    const [app, sbot] = PROVIDERS.slack!.secrets;
    expect(app!.format.test(xapp())).toBe(true);
    expect(sbot!.format.test(xoxb())).toBe(true);
    expect(sbot!.format.test(xapp())).toBe(false);
  });

  it('spots a Slack token pasted into the wrong field', () => {
    expect(misplacedSecret(PROVIDERS.slack!, 'appToken', xoxb())?.key).toBe('botToken');
    expect(misplacedSecret(PROVIDERS.slack!, 'botToken', xoxb())).toBeUndefined();
    expect(misplacedSecret(PROVIDERS.slack!, 'botToken', '')).toBeUndefined();
  });

  it('builds Telegram deep links with a sanitized ≤64-char start parameter', () => {
    expect(telegramStartLink('@reviewer_alice_bot', '7KQ2-9XHD')).toBe(
      'https://t.me/reviewer_alice_bot?start=pair-7KQ29XHD',
    );
    expect(telegramGroupLink('bot', 'a b/c')).toBe('https://t.me/bot?startgroup=join-abc');
    const long = telegramStartLink('b', 'x'.repeat(100));
    expect(new URL(long).searchParams.get('start')!.length).toBeLessThanOrEqual(64);
  });

  it('suggests BotFather usernames that follow its rules', () => {
    const u = suggestBotUsername('reviewer', 'k9z2');
    expect(u).toBe('reviewer_k9z2_bot');
    expect(isBotUsername(u)).toBe(true);
    expect(isBotUsername(suggestBotUsername('a-very-long-agent-name-that-goes-on', 'zz'))).toBe(true);
    expect(isBotUsername('nobot_here')).toBe(false);
  });

  it('prefills the Slack manifest with Socket Mode and /pair', () => {
    const url = new URL(slackCreateUrl('beamhop'));
    expect(url.searchParams.get('new_app')).toBe('1');
    const m = JSON.parse(url.searchParams.get('manifest_json')!);
    expect(m.settings.socket_mode_enabled).toBe(true);
    expect(m.features.slash_commands[0].command).toBe('/pair');
    expect(m.oauth_config.scopes.bot).toContain('chat:write');
  });

  it('derives the Discord client id from the token and asks for minimal permissions', () => {
    const id = '1301928374655123456';
    const token = [btoa(id).replace(/=+$/, ''), 'GxAbCd', 'z'.repeat(27)].join('.');
    expect(discordClientId(token)).toBe(id);
    expect(discordClientId('garbage')).toBeUndefined();
    expect(discordInviteUrl(id, false)).toContain('permissions=117760');
    expect(discordInviteUrl(id, true)).toContain(`permissions=${117760n + (1n << 38n)}`);
    expect(discordInviteUrl(id, false)).toContain('scope=bot+applications.commands');
  });

  it('parses relay addresses and refuses plaintext ws://', () => {
    expect(parseRelay('groups.fiatjaf.com')).toEqual({ url: 'wss://groups.fiatjaf.com' });
    expect(parseRelay('wss://Relay.Example.com/')).toEqual({ url: 'wss://relay.example.com' });
    expect(parseRelay('ws://relay.example.com')).toHaveProperty('error');
    expect(parseRelay('not a relay')).toHaveProperty('error');
  });

  it('derives unique slug names from bot handles', () => {
    expect(toSlug('@reviewer_alice_bot')).toBe('reviewer-alice');
    expect(uniqueName('tg', ['tg', 'tg-2'])).toBe('tg-3');
    expect(uniqueName('Bad Name', [])).toBe('channel');
  });

  it('reads chats from settings.chats or Slack channel names', () => {
    const base = {
      status: 'connected' as const,
      config: { name: 'x', provider: 'slack', secretRefs: [], enabled: true, createdAt: '' },
    };
    expect(channelChats({ ...base, config: { ...base.config, settings: { channels: ['#eng'] } } })).toEqual([
      { target: 'channel/eng', title: '#eng' },
    ]);
  });
});

describe('wizard drafts', () => {
  it('persists non-secret progress, lists fresh drafts and clears them', () => {
    writeDraft({
      provider: 'telegram',
      step: 5,
      values: { openedCreate: true },
      channel: 'tg2',
      updatedAt: new Date().toISOString(),
    });
    writeDraft({ provider: 'discord', step: 2, values: {}, updatedAt: new Date().toISOString() });
    writeDraft({
      provider: 'slack',
      step: 2,
      values: { openedCreate: true },
      updatedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    });
    expect(readDraft('telegram')?.step).toBe(5);
    expect(listDrafts(['telegram', 'slack', 'discord']).map((d) => d.provider)).toEqual(['telegram']);
    clearDraft('telegram');
    expect(readDraft('telegram')).toBeUndefined();
    expect(JSON.stringify(localStorage)).not.toMatch(/xox|token/i);
  });
});
