import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BOTFATHER_URL, createSetupWizard, telegramPlugin } from '../src/index.ts';
import { FAKE_TOKEN, FakeBotApi, fail, ok } from './fake-bot-api.ts';

let api: FakeBotApi;
beforeEach(async () => {
  api = await new FakeBotApi().start();
});
afterEach(async () => {
  await api.stop();
});

describe('setup wizard', () => {
  it('has the §5 steps', () => {
    const w = telegramPlugin.setup;
    expect(telegramPlugin.id).toBe('telegram');
    expect(w.steps.map((s) => s.id)).toEqual(['create', 'token', 'groups']);
    expect(w.steps[0]?.link?.url).toBe(BOTFATHER_URL);
    expect(w.steps[0]?.body).toContain('/newbot');
    expect(w.steps[1]?.fields).toEqual([
      expect.objectContaining({ kind: 'secret', id: 'token', envFlag: '--token-env' }),
    ]);
    expect(w.steps[2]?.body).toContain('/setprivacy');
  });

  it('validates a token and returns identity without the token in the avatar url', async () => {
    const w = createSetupWizard({ apiRoot: api.apiRoot });
    const r = await w.validate({}, { token: FAKE_TOKEN });
    expect(r.ok).toBe(true);
    expect(r.identity).toEqual({
      name: 'Beam Test',
      handle: '@beam_test_bot',
      avatarUrl: 'telegram-file:AVATAR_SMALL',
    });
    expect(r.message).toMatch(/Privacy mode is on/);
    expect(JSON.stringify(r)).not.toContain(FAKE_TOKEN);
  });

  it('works without an avatar', async () => {
    api.reply('getUserProfilePhotos', ok({ total_count: 0, photos: [] }));
    const r = await createSetupWizard({ apiRoot: api.apiRoot }).validate({}, { token: FAKE_TOKEN });
    expect(r.ok).toBe(true);
    expect(r.identity?.avatarUrl).toBeUndefined();
  });

  it('rejects missing, malformed and revoked tokens', async () => {
    const w = createSetupWizard({ apiRoot: api.apiRoot });
    expect((await w.validate({}, {})).ok).toBe(false);
    expect((await w.validate({}, { token: 'nope' })).message).toMatch(/does not look like/);
    const revoked = '123456789:AAThisTokenWasRevokedByBotFather_xyz12';
    const r = await w.validate({}, { token: revoked });
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/rejected/) });
    expect(JSON.stringify(r)).not.toContain(revoked);
  });

  it('reports network errors without the token', async () => {
    const w = createSetupWizard({ apiRoot: 'http://127.0.0.1:1' });
    const r = await w.validate({}, { token: FAKE_TOKEN });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Could not reach Telegram/);
    expect(r.message).not.toContain(FAKE_TOKEN);
  });

  it('flags non-bot tokens and server errors', async () => {
    const w = createSetupWizard({ apiRoot: api.apiRoot });
    api.reply('getMe', ok({ id: 1, is_bot: false, first_name: 'Human' }));
    expect((await w.validate({}, { token: FAKE_TOKEN })).message).toMatch(/does not belong to a bot/);
    api.reply('getMe', fail(500, 'Internal Server Error'));
    expect((await w.validate({}, { token: FAKE_TOKEN })).ok).toBe(false);
  });
});
