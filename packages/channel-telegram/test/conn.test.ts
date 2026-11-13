import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ButtonPress, InboundMsg } from '@beamhop/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTelegramPlugin,
  downloadFile,
  type TelegramConn,
  type TelegramConnOptions,
} from '../src/index.ts';
import { FAKE_TOKEN, FakeBotApi, fail, ok } from './fake-bot-api.ts';
import * as fx from './fixtures.ts';
import { MemoryKV, makeCtx, take, until } from './helpers.ts';

let api: FakeBotApi;
let conn: TelegramConn | undefined;
let tmp: string;

const FAST: TelegramConnOptions = {
  pollTimeoutSec: 1,
  backoffBaseMs: 5,
  backoffMaxMs: 20,
  conflictBackoffMs: 10,
  rateLimit: { perChatIntervalMs: 0, groupPerMinute: 10_000 },
};

const connect = async (opts: TelegramConnOptions = {}, state = new MemoryKV()) => {
  conn = await createTelegramPlugin({ apiRoot: api.apiRoot, ...FAST, ...opts }).connect(makeCtx(state));
  return conn;
};

beforeEach(async () => {
  api = await new FakeBotApi().start();
  tmp = await mkdtemp(join(tmpdir(), 'bh-tg-'));
});

afterEach(async () => {
  await conn?.close();
  conn = undefined;
  await api.stop();
  await rm(tmp, { recursive: true, force: true });
  // The token must only ever appear in the URL path, never in params.
  for (const c of api.calls) expect(JSON.stringify(c.params)).not.toContain(FAKE_TOKEN);
});

describe('connect', () => {
  it('reads identity via getMe', async () => {
    const c = await connect({ poll: false });
    expect(c.self).toEqual({
      principal: 'telegram:777000111',
      displayName: 'Beam Test',
      handle: 'beam_test_bot',
    });
    expect(c.provider).toBe('telegram');
    expect(c.name).toBe('mybot');
    expect(c.capabilities).toEqual({ edit: true, buttons: true, typing: true, files: true, threads: true });
  });

  it('fails without a token and on a rejected token', async () => {
    const plugin = createTelegramPlugin({ apiRoot: api.apiRoot, ...FAST });
    await expect(plugin.connect({ ...makeCtx(), secrets: {} })).rejects.toThrow(/missing secret/);
    const err = await plugin.connect(makeCtx(new MemoryKV(), '999:wrong')).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/401/);
    expect((err as Error).message).not.toContain('999:wrong');
  });
});

describe('polling', () => {
  it('normalizes DMs and persists the offset', async () => {
    const state = new MemoryKV();
    await state.set('offset', 5);
    api.push(fx.dmText(4, 'stale'), fx.dmText(5), fx.dmText(6, 'second'));
    const c = await connect({}, state);
    const it = c.inbound()[Symbol.asyncIterator]();
    const [a, b] = await take(it, 2);
    expect(a).toMatchObject({
      id: '4242:15',
      channel: 'mybot',
      provider: 'telegram',
      conversation: { kind: 'dm', id: '4242', title: 'Alice Liddell' },
      threadId: '4242',
      from: { principal: 'telegram:4242', displayName: 'Alice Liddell', isBot: false },
      text: 'hello agent',
      attachments: [],
      mentionsAgent: false,
      replyToAgent: false,
      hops: 0,
    });
    expect(a?.receivedAt).toBe(new Date(1_731_000_000_000).toISOString());
    expect(b?.text).toBe('second');
    await until(() => state.data.get('offset') === 7);
    const first = api.callsTo('getUpdates')[0]!;
    expect(first.params).toMatchObject({ offset: 5, timeout: 1 });
    expect(first.params.allowed_updates).toContain('my_chat_member');
    await api.waitFor('getUpdates', 2);
    expect(api.callsTo('getUpdates')[1]?.params.offset).toBe(7);
  });

  it('normalizes group mentions, commands, replies, reply chains and topics', async () => {
    api.push(
      fx.groupMention,
      fx.groupTextMention,
      fx.groupCommand,
      fx.groupOtherMention,
      fx.groupReplyToBot,
      fx.groupReplyChain,
      fx.topicMessage,
      fx.serviceMessage,
    );
    const c = await connect();
    const msgs = await take(c.inbound()[Symbol.asyncIterator](), 7);
    const [mention, textMention, cmd, other, replyBot, chain, topic] = msgs as InboundMsg[];
    expect(mention).toMatchObject({
      conversation: { kind: 'group', id: '-1001234567890', title: 'Beam Lab' },
      threadId: '501',
      mentionsAgent: true,
      from: { principal: 'telegram:5353', displayName: 'Bob' },
    });
    expect(textMention?.mentionsAgent).toBe(true);
    expect(cmd).toMatchObject({ mentionsAgent: true, text: '/status now' });
    expect(other).toMatchObject({ mentionsAgent: false, text: '@someone_else_bot hi /status@other_bot' });
    expect(replyBot).toMatchObject({
      replyToAgent: true,
      mentionsAgent: false,
      replyToId: '-1001234567890:900',
      threadId: '900',
    });
    // 506 replies to 505, whose thread is 900 → same thread.
    expect(chain).toMatchObject({ replyToAgent: false, threadId: '900', replyToId: '-1001234567890:505' });
    expect(topic).toMatchObject({
      conversation: { kind: 'group', id: '-1009876543210' },
      threadId: '55',
      mentionsAgent: true,
    });
    expect(topic?.replyToId).toBeUndefined();
  });

  it('maps photos (largest size) and documents to broker-fetchable refs', async () => {
    api.push(fx.photoMessage, fx.documentMessage);
    const c = await connect();
    const [photo, doc] = await take(c.inbound()[Symbol.asyncIterator](), 2);
    expect(photo?.text).toBe('look at this');
    expect(photo?.attachments).toEqual([
      { name: 'photo_pl.jpg', mime: 'image/jpeg', url: 'telegram-file:PHOTO_L', size: 98000 },
    ]);
    expect(doc?.attachments).toEqual([
      { name: 'report.pdf', mime: 'application/pdf', url: 'telegram-file:DOC_1', size: 2048 },
    ]);
    expect(JSON.stringify([photo, doc])).not.toContain(FAKE_TOKEN);
  });

  it('keeps polling through 409 conflicts (another poller)', async () => {
    api.reply(
      'getUpdates',
      fail(409, 'Conflict: terminated by other getUpdates request'),
      fail(409, 'Conflict'),
    );
    api.push(fx.dmText(1, 'after conflict'));
    const c = await connect();
    const [m] = await take(c.inbound()[Symbol.asyncIterator](), 1);
    expect(m?.text).toBe('after conflict');
    expect(api.callsTo('getUpdates').length).toBeGreaterThanOrEqual(3);
  });

  it('deletes an active webhook once on a 409 webhook conflict', async () => {
    api.reply('getUpdates', fail(409, "Conflict: can't use getUpdates method while webhook is active"));
    api.push(fx.dmText(1));
    const c = await connect();
    await take(c.inbound()[Symbol.asyncIterator](), 1);
    expect(api.callsTo('deleteWebhook')).toHaveLength(1);
    expect(api.callsTo('deleteWebhook')[0]?.params.drop_pending_updates).toBe(false);
  });

  it('backs off on server/network errors and on 429, then recovers', async () => {
    api.reply(
      'getUpdates',
      fail(502, 'Bad Gateway'),
      { status: 500, body: 'not json' },
      fail(429, 'Too Many Requests: retry after 0', { retry_after: 0 }),
    );
    api.push(fx.dmText(1, 'recovered'));
    const c = await connect();
    const [m] = await take(c.inbound()[Symbol.asyncIterator](), 1);
    expect(m?.text).toBe('recovered');
    expect(api.callsTo('getUpdates').length).toBeGreaterThanOrEqual(4);
  });

  it('stops polling on 401 and ends inbound()', async () => {
    api.reply('getUpdates', fail(401, 'Unauthorized'));
    const c = await connect();
    const r = await c.inbound()[Symbol.asyncIterator]().next();
    expect(r.done).toBe(true);
    expect(api.callsTo('getUpdates')).toHaveLength(1);
  });

  it('close() aborts the long poll and ends inbound()', async () => {
    const c = await connect({ pollTimeoutSec: 30 });
    await api.waitFor('getUpdates');
    const it = c.inbound()[Symbol.asyncIterator]();
    const pending = it.next();
    const t0 = Date.now();
    await c.close();
    expect((await pending).done).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(() => c.inbound()).toThrow(/already consumed/);
  });
});

describe('buttons and removal', () => {
  it('sends inline keyboards and dispatches callback queries', async () => {
    const c = await connect();
    const presses: ButtonPress[] = [];
    c.onButton?.((p) => presses.push(p));
    const longId = `approve:${'x'.repeat(80)}`;
    await c.send({
      conversation: { kind: 'dm', id: '4242' },
      markdown: 'Approve **deploy**?',
      buttons: [
        { id: 'approve:abc', label: 'Approve', style: 'primary' },
        { id: 'deny:abc', label: 'Deny', style: 'danger' },
        { id: longId, label: 'Long' },
      ],
    });
    const sent = (await api.waitFor('sendMessage'))[0]!;
    const kb = sent.params.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] };
    const flat = kb.inline_keyboard.flat();
    expect(flat.map((b) => b.text)).toEqual(['Approve', '⛔ Deny', 'Long']);
    for (const b of flat) expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
    expect(flat[0]?.callback_data).toBe('approve:abc');
    const alias = flat[2]!.callback_data;
    expect(alias).not.toBe(longId);

    api.push({ ...fx.callback('approve:abc'), update_id: 300 }, { ...fx.callback(alias), update_id: 301 });
    api.push({ ...fx.callback('~unknownalias'), update_id: 302 });
    await until(() => presses.length === 2 && api.callsTo('answerCallbackQuery').length === 3);
    expect(presses[0]).toEqual({
      messageId: '4242:1000',
      buttonId: 'approve:abc',
      principal: 'telegram:4242',
      conversationId: '4242',
    });
    expect(presses[1]?.buttonId).toBe(longId);
    expect(api.callsTo('answerCallbackQuery')[0]?.params.callback_query_id).toBe('4382bfdwdsb323b2d9');
  });

  it('reports kicked/left via my_chat_member, ignores promotions', async () => {
    const c = await connect();
    const removed: string[] = [];
    c.onRemoved?.((id) => removed.push(id));
    api.push(fx.promoted, fx.kicked, fx.left);
    await until(() => removed.length === 2);
    expect(removed).toEqual(['-1001234567890', '-1009876543210']);
  });

  it('reports removal when a send fails with 403 kicked', async () => {
    const c = await connect({ poll: false });
    const removed: string[] = [];
    c.onRemoved?.((id) => removed.push(id));
    api.reply('sendMessage', fail(403, 'Forbidden: bot was kicked from the supergroup chat'));
    await expect(c.send({ conversation: { kind: 'group', id: '-100555' }, markdown: 'hi' })).rejects.toThrow(
      /403/,
    );
    expect(removed).toEqual(['-100555']);
  });
});

describe('send', () => {
  it('renders Markdown as HTML with parse_mode', async () => {
    const c = await connect({ poll: false });
    const sent = await c.send({ conversation: { kind: 'dm', id: '4242' }, markdown: '**hi** <there> & `x`' });
    const call = api.callsTo('sendMessage')[0]!;
    expect(call.params).toMatchObject({
      chat_id: '4242',
      parse_mode: 'HTML',
      text: '<b>hi</b> &lt;there&gt; &amp; <code>x</code>',
    });
    expect(sent.id).toBe('4242:1000');
  });

  it('falls back to plain text when Telegram cannot parse entities', async () => {
    const c = await connect({ poll: false });
    api.reply(
      'sendMessage',
      fail(400, 'Bad Request: can\'t parse entities: Unsupported start tag "x" at byte offset 3'),
    );
    await c.send({ conversation: { kind: 'dm', id: '4242' }, markdown: '**bold** a<b' });
    const [first, second] = api.callsTo('sendMessage');
    expect(first?.params.parse_mode).toBe('HTML');
    expect(second?.params.parse_mode).toBeUndefined();
    expect(second?.params.text).toBe('bold a<b');
  });

  it('propagates other 400 errors', async () => {
    const c = await connect({ poll: false });
    api.reply('sendMessage', fail(400, 'Bad Request: chat not found'));
    await expect(c.send({ conversation: { kind: 'dm', id: '1' }, markdown: 'x' })).rejects.toMatchObject({
      code: 'invalid_input',
      status: 400,
    });
    expect(api.callsTo('sendMessage')).toHaveLength(1);
  });

  it('splits messages over 4096 chars; buttons go on the last part', async () => {
    const c = await connect({ poll: false });
    const md = `\`\`\`\n${'0123456789 '.repeat(900)}\n\`\`\`\n${'tail '.repeat(300)}`;
    await c.send({
      conversation: { kind: 'dm', id: '4242' },
      markdown: md,
      replyToId: '4242:15',
      buttons: [{ id: 'ok', label: 'OK' }],
    });
    const calls = api.callsTo('sendMessage');
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const call of calls) expect(String(call.params.text).length).toBeLessThanOrEqual(4096);
    expect(String(calls[1]?.params.text).startsWith('<pre>')).toBe(true);
    expect(calls[0]?.params.reply_parameters).toEqual({ message_id: 15, allow_sending_without_reply: true });
    expect(calls[1]?.params.reply_parameters).toBeUndefined();
    expect(calls.slice(0, -1).every((x) => x.params.reply_markup === undefined)).toBe(true);
    expect(calls.at(-1)?.params.reply_markup).toBeDefined();
  });

  it('respects 429 retry_after on send', async () => {
    const sleeps: number[] = [];
    const c = await connect({
      poll: false,
      rateLimit: { perChatIntervalMs: 0, sleep: async (ms) => void sleeps.push(ms) },
    });
    api.reply('sendMessage', fail(429, 'Too Many Requests: retry after 3', { retry_after: 3 }));
    await c.send({ conversation: { kind: 'dm', id: '4242' }, markdown: 'hi' });
    expect(sleeps).toContain(3000);
    expect(api.callsTo('sendMessage')).toHaveLength(2);
  });

  it('routes replies into topics and reply-chain threads', async () => {
    api.push(fx.topicMessage, fx.groupReplyToBot);
    const c = await connect();
    await take(c.inbound()[Symbol.asyncIterator](), 2);
    await c.send({
      conversation: { kind: 'group', id: '-1009876543210' },
      threadId: '55',
      markdown: 'in topic',
    });
    await c.send({
      conversation: { kind: 'group', id: '-1001234567890' },
      threadId: '900',
      markdown: 'in chain',
    });
    await c.send({ conversation: { kind: 'dm', id: '4242' }, threadId: '4242', markdown: 'dm' });
    const [topic, chain, dm] = api.callsTo('sendMessage');
    expect(topic?.params.message_thread_id).toBe(55);
    expect(topic?.params.reply_parameters).toBeUndefined();
    expect(chain?.params.message_thread_id).toBeUndefined();
    expect(chain?.params.reply_parameters).toEqual({ message_id: 900, allow_sending_without_reply: true });
    expect(dm?.params.message_thread_id).toBeUndefined();
    expect(dm?.params.reply_parameters).toBeUndefined();
  });

  it('edits via editMessageText, ignoring "message is not modified", keeping buttons', async () => {
    const c = await connect({ poll: false });
    const sent = await c.send({
      conversation: { kind: 'dm', id: '4242' },
      markdown: 'working…',
      buttons: [{ id: 'stop', label: 'Stop' }],
    });
    await sent.edit?.('**done**');
    api.reply(
      'editMessageText',
      fail(
        400,
        'Bad Request: message is not modified: specified new message content and reply markup are exactly the same',
      ),
    );
    await expect(sent.edit?.('**done**')).resolves.toBeUndefined();
    const edits = api.callsTo('editMessageText');
    expect(edits[0]?.params).toMatchObject({
      chat_id: '4242',
      message_id: 1000,
      text: '<b>done</b>',
      parse_mode: 'HTML',
    });
    expect(edits[0]?.params.reply_markup).toEqual({
      inline_keyboard: [[{ text: 'Stop', callback_data: 'stop' }]],
    });
  });

  it('edit falls back to plain text on parse errors', async () => {
    const c = await connect({ poll: false });
    const sent = await c.send({ conversation: { kind: 'dm', id: '4242' }, markdown: 'a' });
    api.reply('editMessageText', fail(400, "Bad Request: can't parse entities"));
    await sent.edit?.('**b**');
    const edits = api.callsTo('editMessageText');
    expect(edits).toHaveLength(2);
    expect(edits[1]?.params).toMatchObject({ text: 'b' });
    expect(edits[1]?.params.parse_mode).toBeUndefined();
  });

  it('edit grows into extra parts and shrinks by deleting them', async () => {
    const c = await connect({ poll: false });
    const sent = await c.send({ conversation: { kind: 'dm', id: '4242' }, markdown: 'short' });
    await sent.edit?.('word '.repeat(2000));
    expect(api.callsTo('editMessageText')).toHaveLength(1);
    expect(api.callsTo('sendMessage')).toHaveLength(3);
    await sent.edit?.('short again');
    expect(api.callsTo('deleteMessage').map((x) => x.params.message_id)).toEqual([1001, 1002]);
  });

  it('sends typing via sendChatAction and swallows errors', async () => {
    const c = await connect({ poll: false });
    await c.typing?.('4242');
    expect(api.callsTo('sendChatAction')[0]?.params).toEqual({ chat_id: '4242', action: 'typing' });
    api.reply('sendChatAction', fail(400, 'Bad Request: chat not found'));
    await expect(c.typing?.('1')).resolves.toBeUndefined();
  });

  it('uploads files with multipart sendDocument / sendPhoto, reuses file refs', async () => {
    const c = await connect({ poll: false });
    const txt = join(tmp, 'notes.txt');
    const png = join(tmp, 'shot.png');
    await writeFile(txt, 'hello file');
    await writeFile(png, 'PNGDATA');
    const sent = await c.send({
      conversation: { kind: 'dm', id: '4242' },
      markdown: '',
      attachments: [
        { name: 'notes.txt', mime: 'text/plain', localPath: txt },
        { name: 'shot.png', mime: 'image/png', localPath: png },
        { name: 'again.pdf', mime: 'application/pdf', url: 'telegram-file:DOC_1' },
      ],
      buttons: [{ id: 'k', label: 'K' }],
    });
    expect(sent.edit).toBeUndefined();
    const [doc, again] = api.callsTo('sendDocument');
    const photo = api.callsTo('sendPhoto')[0];
    expect(doc?.files.document).toEqual({ name: 'notes.txt', type: 'text/plain', text: 'hello file' });
    expect(doc?.params.chat_id).toBe(4242);
    expect(photo?.files.photo).toMatchObject({ name: 'shot.png', type: 'image/png', text: 'PNGDATA' });
    expect(again?.params.document).toBe('DOC_1');
    expect(again?.params.reply_markup).toBeDefined();
    expect(api.callsTo('sendMessage')).toHaveLength(0);
  });

  it('rejects empty messages and attachments without a source', async () => {
    const c = await connect({ poll: false });
    await expect(c.send({ conversation: { kind: 'dm', id: '4242' }, markdown: '  ' })).rejects.toThrow(
      /nothing to send/,
    );
    await expect(
      c.send({
        conversation: { kind: 'dm', id: '4242' },
        markdown: '',
        attachments: [{ name: 'x', mime: 'text/plain' }],
      }),
    ).rejects.toThrow(/no localPath/);
  });
});

describe('downloadFile', () => {
  it('downloads via getFile + file endpoint without exposing the token', async () => {
    api.files.set('documents/DOC_1.bin', Buffer.from('PDFBYTES'));
    const c = await connect({ poll: false });
    const dest = join(tmp, 'inbox', 'report.pdf');
    const r = await c.downloadFile('telegram-file:DOC_1', dest);
    expect(r.size).toBe(8);
    expect(await readFile(dest, 'utf8')).toBe('PDFBYTES');
    expect(api.callsTo('getFile')[0]?.params.file_id).toBe('DOC_1');
    // standalone helper for the broker
    const dest2 = join(tmp, 'b.bin');
    await downloadFile({ token: FAKE_TOKEN, apiRoot: api.apiRoot }, 'DOC_1', dest2);
    expect(await readFile(dest2, 'utf8')).toBe('PDFBYTES');
  });

  it('enforces the size limit and cleans up', async () => {
    api.files.set('documents/BIG.bin', Buffer.alloc(100, 1));
    const c = await connect({ poll: false });
    const dest = join(tmp, 'big.bin');
    await expect(c.downloadFile('BIG', dest, { maxBytes: 10 })).rejects.toThrow(/exceeds/);
    await expect(readFile(dest)).rejects.toThrow();
    api.reply(
      'getFile',
      ok({ file_id: 'X', file_unique_id: 'x', file_size: 999, file_path: 'documents/X.bin' }),
    );
    await expect(c.downloadFile('X', dest, { maxBytes: 10 })).rejects.toThrow(/too large/);
  });

  it('errors on missing files without leaking the token', async () => {
    const c = await connect({ poll: false });
    const err = (await c.downloadFile('MISSING', join(tmp, 'm')).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/404/);
    expect(err.message).not.toContain(FAKE_TOKEN);
  });
});
