// Recorded-style Bot API update payloads (shapes copied from real getUpdates responses, ids changed).

import type { TgUpdate } from '../src/types.ts';

export const BOT = { id: 777000111, is_bot: true, first_name: 'Beam Test', username: 'beam_test_bot' };
export const ALICE = {
  id: 4242,
  is_bot: false,
  first_name: 'Alice',
  last_name: 'Liddell',
  username: 'alice',
  language_code: 'en',
};
export const BOB = { id: 5353, is_bot: false, first_name: 'Bob' };
export const DM_CHAT = {
  id: 4242,
  first_name: 'Alice',
  last_name: 'Liddell',
  username: 'alice',
  type: 'private' as const,
};
export const GROUP = { id: -1001234567890, title: 'Beam Lab', type: 'supergroup' as const };
export const FORUM = { id: -1009876543210, title: 'Beam Forum', type: 'supergroup' as const, is_forum: true };

export const dmText = (update_id: number, text = 'hello agent'): TgUpdate => ({
  update_id,
  message: { message_id: 10 + update_id, from: ALICE, chat: DM_CHAT, date: 1_731_000_000, text },
});

export const groupMention: TgUpdate = {
  update_id: 200,
  message: {
    message_id: 501,
    from: BOB,
    chat: GROUP,
    date: 1_731_000_100,
    text: 'hey @Beam_Test_Bot can you look?',
    entities: [{ offset: 4, length: 14, type: 'mention' }],
  },
};

export const groupTextMention: TgUpdate = {
  update_id: 201,
  message: {
    message_id: 502,
    from: BOB,
    chat: GROUP,
    date: 1_731_000_101,
    text: 'Beam Test please summarize',
    entities: [{ offset: 0, length: 9, type: 'text_mention', user: BOT }],
  },
};

export const groupCommand: TgUpdate = {
  update_id: 202,
  message: {
    message_id: 503,
    from: BOB,
    chat: GROUP,
    date: 1_731_000_102,
    text: '/status@beam_test_bot now',
    entities: [{ offset: 0, length: 21, type: 'bot_command' }],
  },
};

export const groupOtherMention: TgUpdate = {
  update_id: 203,
  message: {
    message_id: 504,
    from: BOB,
    chat: GROUP,
    date: 1_731_000_103,
    text: '@someone_else_bot hi /status@other_bot',
    entities: [
      { offset: 0, length: 17, type: 'mention' },
      { offset: 21, length: 17, type: 'bot_command' },
    ],
  },
};

/** Bob replies to a message the bot sent (id 900) which itself replied to 501. */
export const groupReplyToBot: TgUpdate = {
  update_id: 204,
  message: {
    message_id: 505,
    from: BOB,
    chat: GROUP,
    date: 1_731_000_104,
    text: 'thanks, and the other file?',
    reply_to_message: { message_id: 900, from: BOT, chat: GROUP, date: 1_731_000_050, text: 'Done.' },
  },
};

export const groupReplyChain: TgUpdate = {
  update_id: 205,
  message: {
    message_id: 506,
    from: ALICE,
    chat: GROUP,
    date: 1_731_000_105,
    text: '+1',
    reply_to_message: { message_id: 505, from: BOB, chat: GROUP, date: 1_731_000_104, text: 'thanks' },
  },
};

export const topicMessage: TgUpdate = {
  update_id: 206,
  message: {
    message_id: 77,
    message_thread_id: 55,
    is_topic_message: true,
    from: ALICE,
    chat: FORUM,
    date: 1_731_000_106,
    text: '@beam_test_bot in a topic',
    entities: [{ offset: 0, length: 14, type: 'mention' }],
    reply_to_message: { message_id: 55, from: ALICE, chat: FORUM, date: 1_731_000_000 },
  },
};

export const photoMessage: TgUpdate = {
  update_id: 207,
  message: {
    message_id: 600,
    from: ALICE,
    chat: DM_CHAT,
    date: 1_731_000_107,
    caption: 'look at this',
    photo: [
      { file_id: 'PHOTO_S', file_unique_id: 'ps', width: 90, height: 60, file_size: 1200 },
      { file_id: 'PHOTO_L', file_unique_id: 'pl', width: 1280, height: 853, file_size: 98000 },
      { file_id: 'PHOTO_M', file_unique_id: 'pm', width: 320, height: 213, file_size: 14000 },
    ],
  },
};

export const documentMessage: TgUpdate = {
  update_id: 208,
  message: {
    message_id: 601,
    from: ALICE,
    chat: DM_CHAT,
    date: 1_731_000_108,
    document: {
      file_id: 'DOC_1',
      file_unique_id: 'd1',
      file_name: 'report.pdf',
      mime_type: 'application/pdf',
      file_size: 2048,
    },
  },
};

export const serviceMessage: TgUpdate = {
  update_id: 209,
  message: { message_id: 602, from: ALICE, chat: GROUP, date: 1_731_000_109 },
};

export const callback = (data: string, messageId = 1000, chat = DM_CHAT): TgUpdate => ({
  update_id: 300,
  callback_query: {
    id: '4382bfdwdsb323b2d9',
    from: ALICE,
    message: { message_id: messageId, from: BOT, chat, date: 1_731_000_200, text: 'Approve?' },
    data,
  },
});

export const kicked: TgUpdate = {
  update_id: 400,
  my_chat_member: {
    chat: GROUP,
    from: ALICE,
    date: 1_731_000_300,
    old_chat_member: { user: BOT, status: 'member' },
    new_chat_member: { user: BOT, status: 'kicked' },
  },
};

export const left: TgUpdate = {
  update_id: 401,
  my_chat_member: {
    chat: FORUM,
    from: ALICE,
    date: 1_731_000_301,
    old_chat_member: { user: BOT, status: 'administrator' },
    new_chat_member: { user: BOT, status: 'left' },
  },
};

export const promoted: TgUpdate = {
  update_id: 402,
  my_chat_member: {
    chat: GROUP,
    from: ALICE,
    date: 1_731_000_302,
    old_chat_member: { user: BOT, status: 'member' },
    new_chat_member: { user: BOT, status: 'administrator' },
  },
};
