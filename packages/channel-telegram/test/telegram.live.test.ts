// Live Telegram test. Run: pnpm vitest run -c vitest.live.config.ts packages/channel-telegram
// Token: env TELEGRAM_BOT_TOKEN or ~/.config/beamhop/secrets.env (TELEGRAM_BOT_TOKEN=...). Never printed.
// Owner chat: ~/.config/beamhop/owner_chat_id. Sends at most 3 messages (+1 edit) per run.
// Does not start the poller and never confirms an update offset, so the owner's messages are untouched.

import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentLogger } from '@beamhop/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BotApi,
  createTelegramPlugin,
  TelegramApiError,
  type TelegramConn,
  telegramPlugin,
} from '../src/index.ts';
import { MemoryKV } from './helpers.ts';

const cfgDir = join(homedir(), '.config', 'beamhop');

const readToken = (): string | undefined => {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN.trim();
  const file = join(cfgDir, 'secrets.env');
  if (!existsSync(file)) return undefined;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?TELEGRAM_BOT_TOKEN\s*=\s*(.*)\s*$/.exec(line);
    if (m?.[1]) return m[1].replace(/^['"]|['"]$/g, '').trim();
  }
  return undefined;
};

const readOwnerChat = (): string | undefined => {
  const file = join(cfgDir, 'owner_chat_id');
  return existsSync(file) ? readFileSync(file, 'utf8').trim() || undefined : undefined;
};

const token = readToken();
const ownerChat = readOwnerChat();

describe('telegram live', () => {
  let conn: TelegramConn;
  let tmp: string;

  beforeAll(async () => {
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN not set (env or ~/.config/beamhop/secrets.env)');
    if (!ownerChat) throw new Error('~/.config/beamhop/owner_chat_id missing');
    tmp = await mkdtemp(join(tmpdir(), 'bh-tg-live-'));
    // poll: false — never run getUpdates with an offset, so no owner update is confirmed/dropped.
    conn = await createTelegramPlugin({ poll: false }).connect({
      name: 'live',
      settings: {},
      secrets: { token },
      log: silentLogger,
      state: new MemoryKV(),
    });
  });

  afterAll(async () => {
    await conn?.close();
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  it('validates the token with getMe', async () => {
    const r = await telegramPlugin.setup.validate({}, { token: token! });
    expect(r.ok).toBe(true);
    expect(r.identity?.handle).toMatch(/^@\w+bot$/i);
    expect(JSON.stringify(r)).not.toContain(token!);
    console.log(`validate: ${r.message} avatar=${r.identity?.avatarUrl ?? '(none)'}`);
  });

  it('peeks getUpdates without confirming any offset', async () => {
    const api = new BotApi({ token: token! });
    try {
      const updates = await api.call<unknown[]>('getUpdates', { timeout: 0, limit: 1 });
      expect(Array.isArray(updates)).toBe(true);
      console.log(`peek: ${updates.length} pending update(s) (offset not advanced)`);
    } catch (e) {
      // Another poller/webhook may own getUpdates; that's fine for this test.
      expect(e instanceof TelegramApiError && e.status === 409).toBe(true);
      console.log('peek: 409 conflict (another poller is running)');
    }
  });

  it('sends, edits, sends buttons and a document to the owner chat', async () => {
    const conversation = { kind: 'dm' as const, id: ownerChat! };
    const sent = await conn.send({ conversation, markdown: '🧪 beamhop live test: telegram send OK' });
    expect(sent.id).toMatch(/^-?\d+:\d+$/);
    await sent.edit?.('🧪 beamhop live test: telegram send OK — **edited** ✅');

    const withButtons = await conn.send({
      conversation,
      markdown: '🧪 beamhop live test: inline buttons (no action needed)',
      buttons: [
        { id: 'live:ok', label: 'OK', style: 'primary' },
        { id: 'live:no', label: 'Dismiss', style: 'danger' },
      ],
    });
    expect(withButtons.id).toMatch(/:\d+$/);

    const file = join(tmp, 'beamhop-live-test.txt');
    await writeFile(file, `beamhop live test document\n${new Date().toISOString()}\n`);
    const doc = await conn.send({
      conversation,
      markdown: '',
      attachments: [{ name: 'beamhop-live-test.txt', mime: 'text/plain', localPath: file }],
    });
    expect(doc.id).toMatch(/:\d+$/);
    console.log(`sent: ${sent.id}, ${withButtons.id}, ${doc.id}`);
  });
});
