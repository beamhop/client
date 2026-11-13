// Security review wave B: Telegram normalizer identity and formatter escaping (fuzzed).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { htmlToPlain, isBalanced, markdownToTelegramHtml, splitHtml } from '../src/format.ts';
import { normalizeMessage, parseMessageKey, ThreadTracker } from '../src/normalize.ts';
import type { TgMessage } from '../src/types.ts';
import { ALICE, BOT, GROUP } from './fixtures.ts';

const opts = () => ({
  channel: 'tg',
  bot: { id: BOT.id, username: BOT.username },
  threads: new ThreadTracker(),
});
const CHANNEL_BOT = { id: 136817688, is_bot: true, first_name: 'Channel', username: 'Channel_Bot' };
const ANON_ADMIN = { id: 1087968824, is_bot: true, first_name: 'Group', username: 'GroupAnonymousBot' };

describe('TG-1: sender attribution', () => {
  it('a message sent as a channel is attributed to that channel, not the shared Channel_Bot', () => {
    const mk = (chatId: number, title: string): TgMessage => ({
      message_id: 1,
      from: CHANNEL_BOT,
      sender_chat: { id: chatId, type: 'channel', title },
      chat: GROUP,
      date: 1_731_000_000,
      text: 'hi',
    });
    const a = normalizeMessage(mk(-1001, 'Mallory News'), opts());
    const b = normalizeMessage(mk(-1002, 'Owner Blog'), opts());
    expect(a?.from.principal).toBe('telegram:-1001');
    expect(b?.from.principal).toBe('telegram:-1002');
    expect(a?.from.principal).not.toBe(b?.from.principal);
    expect(a?.from.isBot).toBe(false);
  });

  it('anonymous group admins are attributed to the group chat, not GroupAnonymousBot', () => {
    const m = normalizeMessage(
      { message_id: 2, from: ANON_ADMIN, sender_chat: GROUP, chat: GROUP, date: 1_731_000_000, text: 'x' },
      opts(),
    );
    expect(m?.from.principal).toBe(`telegram:${GROUP.id}`);
  });

  it('messages with no attributable sender are dropped (no shared "telegram:unknown")', () => {
    const m = normalizeMessage({ message_id: 3, chat: GROUP, date: 1_731_000_000, text: 'x' }, opts());
    expect(m).toBeUndefined();
    const bad = normalizeMessage(
      {
        message_id: 3,
        from: { ...ALICE, id: '1 role=owner' as unknown as number },
        chat: GROUP,
        date: 1,
        text: 'x',
      },
      opts(),
    );
    expect(bad).toBeUndefined();
  });

  it('forwarded messages are attributed to the forwarder', () => {
    const m = normalizeMessage(
      {
        message_id: 4,
        from: ALICE,
        chat: GROUP,
        date: 1_731_000_000,
        text: '/approve apr_1',
        forward_origin: { type: 'user', sender_user: BOT },
      } as TgMessage,
      opts(),
    );
    expect(m?.from.principal).toBe(`telegram:${ALICE.id}`);
  });

  it('a missing or bogus date does not throw', () => {
    const m = normalizeMessage(
      { message_id: 5, from: ALICE, chat: GROUP, date: undefined as unknown as number, text: 'x' },
      opts(),
    );
    expect(m?.receivedAt).toMatch(/^\d{4}-/);
  });

  it('document file names cannot traverse out of the inbox', () => {
    const m = normalizeMessage(
      {
        message_id: 6,
        from: ALICE,
        chat: GROUP,
        date: 1_731_000_000,
        document: { file_id: 'f', file_unique_id: 'u', file_name: '../../.ssh/authorized_keys' },
      },
      opts(),
    );
    expect(m?.attachments[0]?.name).toBe('authorized_keys');
  });
});

const user = fc.record({
  id: fc.oneof(fc.integer(), fc.constant(Number.NaN), fc.string()),
  is_bot: fc.oneof(fc.boolean(), fc.constant(undefined)),
  first_name: fc.string({ unit: 'binary' }),
  last_name: fc.option(fc.string({ unit: 'binary' }), { nil: undefined }),
  username: fc.option(fc.string(), { nil: undefined }),
});
const chat = fc.record({
  id: fc.integer(),
  type: fc.constantFrom('private', 'group', 'supergroup', 'channel'),
  title: fc.option(fc.string({ unit: 'binary' }), { nil: undefined }),
});
const entity = fc.record({
  type: fc.constantFrom('mention', 'text_mention', 'bot_command', 'bold'),
  offset: fc.integer({ min: -5, max: 300 }),
  length: fc.integer({ min: -5, max: 300 }),
  user: fc.option(user, { nil: undefined }),
});
const message: fc.Arbitrary<TgMessage> = fc.letrec((tie) => ({
  msg: fc.record(
    {
      message_id: fc.integer(),
      message_thread_id: fc.option(fc.integer(), { nil: undefined }),
      is_topic_message: fc.option(fc.boolean(), { nil: undefined }),
      from: fc.option(user, { nil: undefined }),
      sender_chat: fc.option(chat, { nil: undefined }),
      date: fc.oneof(fc.integer(), fc.double()),
      chat,
      reply_to_message: fc.option(tie('msg'), { nil: undefined, depthSize: 'small' }),
      text: fc.option(fc.string({ unit: 'binary', maxLength: 200 }), { nil: undefined }),
      caption: fc.option(fc.string({ unit: 'binary' }), { nil: undefined }),
      entities: fc.option(fc.array(entity, { maxLength: 5 }), { nil: undefined }),
      document: fc.option(
        fc.record({
          file_id: fc.string(),
          file_unique_id: fc.string(),
          file_name: fc.string({ unit: 'binary' }),
        }),
        { nil: undefined },
      ),
    },
    { requiredKeys: ['message_id', 'date', 'chat'] },
  ),
})).msg as unknown as fc.Arbitrary<TgMessage>;

describe('normalizeMessage (fuzzed)', () => {
  it('never throws, and the principal is always the authenticated sender', () => {
    fc.assert(
      fc.property(message, (m) => {
        const out = normalizeMessage(m, opts());
        if (!out) return;
        const expected = m.sender_chat ? m.sender_chat.id : m.from?.id;
        expect(out.from.principal).toBe(`telegram:${expected}`);
        expect(Number.isSafeInteger(expected)).toBe(true);
        expect(out.id).toBe(`${m.chat.id}:${m.message_id}`);
        for (const a of out.attachments) expect(a.name).not.toMatch(/[/\\]/);
        expect(() => new Date(out.receivedAt).toISOString()).not.toThrow();
      }),
      { numRuns: 500 },
    );
  });

  it('parseMessageKey never throws', () => {
    fc.assert(fc.property(fc.string({ unit: 'binary' }), (k) => void parseMessageKey(k)));
  });
});

const ALLOWED_TAG =
  /^<(?:\/?(?:b|i|s|u|code|pre|blockquote|tg-spoiler)|code class="language-[\w+#.-]*"|a href="(?:https?:\/\/|tg:\/\/|mailto:)[^"<>]*"|\/a)>$/i;

describe('markdownToTelegramHtml (fuzzed)', () => {
  const mdArb = fc.oneof(
    fc.string({ unit: 'binary', maxLength: 300 }),
    fc
      .array(
        fc.constantFrom(
          '<',
          '>',
          '&',
          '"',
          '**',
          '__',
          '*',
          '_',
          '~~',
          '||',
          '`',
          '```',
          '\n',
          '[x](',
          ')',
          'https://a.b/?q="<x>"',
          'javascript:alert(1)',
          '<https://e.x>',
          '',
          '0',
          '# ',
          '> ',
          '- ',
          '<b>',
          '</a>',
          '<a href="https://evil">',
          ' ',
          'text',
        ),
        { maxLength: 60 },
      )
      .map((a) => a.join('')),
  );

  it('only ever emits whitelisted tags with safe hrefs, balanced, and preserves text', () => {
    fc.assert(
      fc.property(mdArb, (md) => {
        const html = markdownToTelegramHtml(md);
        expect(isBalanced(html)).toBe(true);
        for (const tag of html.match(/<[^>]*>?/g) ?? []) expect(tag).toMatch(ALLOWED_TAG);
        // No raw '<' outside tags, and every '&' starts an entity.
        expect(html.replace(/<[^>]*>/g, '')).not.toMatch(/[<>]/);
        expect(html).not.toMatch(/&(?!amp;|lt;|gt;|quot;)/);
        expect(htmlToPlain(html)).not.toContain('');
        for (const chunk of splitHtml(html, 200)) {
          expect(chunk.length).toBeLessThanOrEqual(200);
          expect(isBalanced(chunk)).toBe(true);
        }
      }),
      { numRuns: 800 },
    );
  });

  it('is fast on adversarial emphasis/link input', () => {
    const t0 = performance.now();
    // TG-3: unmatched emphasis openers on one long line were quadratic (80 kB took ~3 s each).
    for (const unit of ['**a ', '__a ', '~~a ', '||a ', '<http://', '*a ', '[x]('])
      markdownToTelegramHtml(unit.repeat(20_000));
    expect(performance.now() - t0).toBeLessThan(2_000);
  });
});
