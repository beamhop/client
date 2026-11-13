// Telegram update → normalized InboundMsg (§5 "Common mapping").

import { type Attachment, type InboundMsg, safeFileName } from '@beamhop/core';
import { fileRef } from './api.ts';
import type { TgChat, TgEntity, TgMessage, TgUser } from './types.ts';

export const PROVIDER = 'telegram';
export const principalOf = (id: number | string): string => `${PROVIDER}:${id}`;

/** Message ids are only unique per chat, so beamhop ids are `<chatId>:<messageId>`. */
export const messageKey = (chatId: number | string, messageId: number | string): string =>
  `${chatId}:${messageId}`;
export const parseMessageKey = (key: string): { chatId?: string; messageId: number } | undefined => {
  const m = /^(?:(-?\d+):)?(\d+)$/.exec(key);
  if (!m) return undefined;
  return m[1] ? { chatId: m[1], messageId: Number(m[2]) } : { messageId: Number(m[2]) };
};

export const conversationKind = (chat: TgChat): InboundMsg['conversation']['kind'] =>
  chat.type === 'private' ? 'dm' : chat.type === 'channel' ? 'channel' : 'group';

export const chatTitle = (chat: TgChat): string | undefined =>
  chat.title ?? ([chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || undefined);

const userName = (u: TgUser): string =>
  [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || '';

/**
 * Remembers which thread each message belongs to so reply chains map to one thread (the chain's
 * root), and which threads are forum topics (sent back with `message_thread_id`). Bounded LRU.
 */
export class ThreadTracker {
  readonly #roots = new Map<string, string>();
  readonly #topics = new Set<string>();
  constructor(readonly max = 10_000) {}

  rootOf(chatId: number | string, messageId: number): string | undefined {
    return this.#roots.get(messageKey(chatId, messageId));
  }
  remember(chatId: number | string, messageId: number, threadId: string): void {
    const k = messageKey(chatId, messageId);
    this.#roots.delete(k);
    this.#roots.set(k, threadId);
    if (this.#roots.size > this.max) {
      const first = this.#roots.keys().next().value;
      if (first !== undefined) this.#roots.delete(first);
    }
  }
  markTopic(chatId: number | string, threadId: string): void {
    this.#topics.add(messageKey(chatId, threadId));
    if (this.#topics.size > this.max) {
      const first = this.#topics.values().next().value;
      if (first !== undefined) this.#topics.delete(first);
    }
  }
  isTopic(chatId: number | string, threadId: string): boolean {
    return this.#topics.has(messageKey(chatId, threadId));
  }
}

export interface BotSelf {
  id: number;
  username?: string;
}

/** Slice by UTF-16 offsets, as Telegram entity offsets are UTF-16 code units. */
const entityText = (text: string, e: TgEntity): string => text.slice(e.offset, e.offset + e.length);

export const detectMention = (text: string, entities: TgEntity[] | undefined, bot: BotSelf): boolean => {
  const uname = bot.username?.toLowerCase();
  for (const e of entities ?? []) {
    if (e.type === 'text_mention' && e.user?.id === bot.id) return true;
    if (e.type === 'mention' && uname && entityText(text, e).toLowerCase() === `@${uname}`) return true;
    if (e.type === 'bot_command' && uname) {
      const at = entityText(text, e).split('@')[1];
      if (at && at.toLowerCase() === uname) return true;
    }
  }
  return false;
};

/** `/cmd@thisbot args` → `/cmd args`, so in-channel commands (§6A.7) look the same everywhere. */
export const stripOwnCommandSuffix = (text: string, bot: BotSelf): string => {
  if (!bot.username) return text;
  const re = new RegExp(`^(/[A-Za-z0-9_]+)@${bot.username.replace(/[^A-Za-z0-9_]/g, '')}(?=\\s|$)`, 'i');
  return text.replace(re, '$1');
};

export const extractAttachments = (m: TgMessage): Attachment[] => {
  const out: Attachment[] = [];
  if (m.photo && m.photo.length > 0) {
    const best = m.photo.reduce((a, b) =>
      (b.file_size ?? b.width * b.height) > (a.file_size ?? a.width * a.height) ? b : a,
    );
    const a: Attachment = {
      name: safeFileName(`photo_${best.file_unique_id}.jpg`),
      mime: 'image/jpeg',
      url: fileRef(best.file_id),
    };
    if (best.file_size !== undefined) a.size = best.file_size;
    out.push(a);
  }
  if (m.document) {
    const d = m.document;
    const a: Attachment = {
      name: safeFileName(d.file_name ?? `file_${d.file_unique_id}`),
      mime: d.mime_type ?? 'application/octet-stream',
      url: fileRef(d.file_id),
    };
    if (d.file_size !== undefined) a.size = d.file_size;
    out.push(a);
  }
  return out;
};

export interface NormalizeOptions {
  channel: string;
  bot: BotSelf;
  threads: ThreadTracker;
  includeRaw?: boolean;
}

const toIso = (unix: unknown): string => {
  const d = new Date(typeof unix === 'number' ? unix * 1000 : Number.NaN);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
};

/** Returns undefined for messages with nothing to act on (service messages, etc.). */
export const normalizeMessage = (m: TgMessage, o: NormalizeOptions): InboundMsg | undefined => {
  const text = m.text ?? m.caption ?? '';
  const entities = m.text !== undefined ? m.entities : m.caption_entities;
  const attachments = extractAttachments(m);
  if (!text && attachments.length === 0) return undefined;

  // A message sent on behalf of a chat (a channel, or the group itself for anonymous admins) has
  // `from` set to a shared service account (Channel_Bot 136817688, GroupAnonymousBot 1087968824,
  // Telegram 777000). Those ids are shared by everyone posting that way, so the authenticated
  // sender is `sender_chat`, never `from`.
  const sender = m.sender_chat ? undefined : m.from;
  const senderId = sender ? sender.id : m.sender_chat?.id;
  // No attributable sender (or a malformed id): drop it rather than invent "telegram:unknown".
  if (typeof senderId !== 'number' || !Number.isSafeInteger(senderId)) return undefined;
  const from: InboundMsg['from'] = sender
    ? { principal: principalOf(senderId), displayName: userName(sender), isBot: sender.is_bot === true }
    : {
        principal: principalOf(senderId),
        displayName: chatTitle(m.sender_chat!) ?? '',
        isBot: false,
      };
  if (from.displayName === '') delete from.displayName;

  const chatId = String(m.chat.id);
  const kind = conversationKind(m.chat);
  let threadId: string;
  if (m.is_topic_message && m.message_thread_id !== undefined) {
    threadId = String(m.message_thread_id);
    o.threads.markTopic(chatId, threadId);
  } else if (kind === 'dm') {
    threadId = chatId;
  } else if (m.reply_to_message) {
    const parent = m.reply_to_message;
    threadId = o.threads.rootOf(chatId, parent.message_id) ?? String(parent.message_id);
  } else {
    threadId = String(m.message_id);
  }
  o.threads.remember(chatId, m.message_id, threadId);

  const conversation: InboundMsg['conversation'] = { kind, id: chatId };
  const title = chatTitle(m.chat);
  if (title) conversation.title = title;

  const reply = m.reply_to_message;
  const msg: InboundMsg = {
    id: messageKey(chatId, m.message_id),
    channel: o.channel,
    provider: PROVIDER,
    conversation,
    threadId,
    from,
    text: stripOwnCommandSuffix(text, o.bot),
    attachments,
    mentionsAgent: detectMention(text, entities, o.bot),
    replyToAgent: reply?.from?.id === o.bot.id,
    hops: 0,
    receivedAt: toIso(m.date),
  };
  // A reply to a topic's root service message isn't a real reply.
  if (reply && !(m.is_topic_message && reply.message_id === m.message_thread_id)) {
    msg.replyToId = messageKey(chatId, reply.message_id);
  }
  if (o.includeRaw) msg.raw = m;
  return msg;
};
