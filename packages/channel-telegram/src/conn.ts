import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  type Attachment,
  BeamhopError,
  type Button,
  type ButtonPress,
  type ChannelConn,
  type ChannelContext,
  type InboundMsg,
  type Logger,
  OutboundMsg,
  type OutboundMsgInput,
  type SentMessage,
} from '@beamhop/core';
import {
  type ApiParams,
  BotApi,
  FILE_REF_PREFIX,
  isNotModifiedError,
  isParseEntitiesError,
  isRemovedError,
  parseFileRef,
  TelegramApiError,
  type UploadFile,
} from './api.ts';
import { htmlToPlain, markdownToTelegramHtml, splitHtml, TELEGRAM_TEXT_LIMIT } from './format.ts';
import {
  type BotSelf,
  messageKey,
  normalizeMessage,
  PROVIDER,
  parseMessageKey,
  principalOf,
  ThreadTracker,
} from './normalize.ts';
import { defaultSleep, type RateLimitOptions, SendQueue } from './ratelimit.ts';
import type { TgCallbackQuery, TgChatMemberUpdated, TgMessage, TgUpdate, TgUser } from './types.ts';

export const OFFSET_KEY = 'offset';
export const ALLOWED_UPDATES = ['message', 'channel_post', 'callback_query', 'my_chat_member'];
const CALLBACK_DATA_MAX = 64;
const PHOTO_MAX_BYTES = 10 * 1024 * 1024;
const PHOTO_MIME = /^image\/(jpeg|png|webp|gif)$/;

export interface TelegramConnOptions {
  apiRoot?: string;
  fetch?: typeof fetch;
  /** Long-poll timeout in seconds. Default 30. */
  pollTimeoutSec?: number;
  /** Error backoff: first delay and cap (ms). Defaults 1000 / 30000. */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Backoff while another poller holds getUpdates (409). Default 15000. */
  conflictBackoffMs?: number;
  rateLimit?: RateLimitOptions;
  /** Start the getUpdates loop on connect. Default true. */
  poll?: boolean;
  includeRaw?: boolean;
}

/** Telegram connection; adds `downloadFile` for the daemon/broker on top of `ChannelConn`. */
export interface TelegramConn extends ChannelConn {
  readonly bot: TgUser;
  /** Download an inbound attachment (`telegram-file:<file_id>` or a raw file_id). */
  downloadFile(
    fileIdOrRef: string,
    destPath: string,
    opts?: { maxBytes?: number },
  ): Promise<{ path: string; size: number }>;
}

/** Async queue backing `inbound()`. */
class Inbox<T> {
  readonly #items: T[] = [];
  readonly #waiters: ((r: IteratorResult<T>) => void)[] = [];
  #closed = false;
  push(v: T) {
    if (this.#closed) return;
    const w = this.#waiters.shift();
    if (w) w({ value: v, done: false });
    else this.#items.push(v);
  }
  close() {
    this.#closed = true;
    for (const w of this.#waiters.splice(0)) w({ value: undefined as never, done: true });
  }
  next(): Promise<IteratorResult<T>> {
    const v = this.#items.shift();
    if (v !== undefined) return Promise.resolve({ value: v, done: false });
    if (this.#closed) return Promise.resolve({ value: undefined as never, done: true });
    return new Promise((r) => this.#waiters.push(r));
  }
}

/** Map a button id to callback_data (≤ 64 bytes); long ids go through a hashed alias. */
class ButtonIds {
  readonly #alias = new Map<string, string>();
  encode(id: string): string {
    if (Buffer.byteLength(id, 'utf8') <= CALLBACK_DATA_MAX && !id.startsWith('~')) return id;
    const alias = `~${createHash('sha256').update(id).digest('base64url').slice(0, 32)}`;
    this.#alias.set(alias, id);
    if (this.#alias.size > 5000) {
      const first = this.#alias.keys().next().value;
      if (first !== undefined) this.#alias.delete(first);
    }
    return alias;
  }
  decode(data: string): string | undefined {
    return data.startsWith('~') ? this.#alias.get(data) : data;
  }
}

export const buildKeyboard = (buttons: Button[], ids: { encode(id: string): string }) => {
  if (buttons.length === 0) return undefined;
  const perRow = buttons.length <= 3 ? 3 : 2;
  const rows: { text: string; callback_data: string }[][] = [];
  buttons.forEach((b, i) => {
    if (i % perRow === 0) rows.push([]);
    const label = b.style === 'danger' ? `⛔ ${b.label}` : b.label;
    rows[rows.length - 1]?.push({ text: label, callback_data: ids.encode(b.id) });
  });
  return { inline_keyboard: rows };
};

export async function connectTelegram(
  ctx: ChannelContext,
  opts: TelegramConnOptions = {},
): Promise<TelegramConn> {
  const token = ctx.secrets.token;
  if (!token) throw new BeamhopError('invalid_input', 'telegram: missing secret "token"');
  const apiRoot =
    opts.apiRoot ?? (typeof ctx.settings.apiRoot === 'string' ? ctx.settings.apiRoot : undefined);
  const api = new BotApi({
    token,
    ...(apiRoot ? { apiRoot } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  const log: Logger = ctx.log.child({ channel: ctx.name, provider: PROVIDER });
  const me = await api.call<TgUser>('getMe');
  const bot: BotSelf = me.username ? { id: me.id, username: me.username } : { id: me.id };
  return new TelegramConnection(ctx, api, me, bot, log, opts);
}

class TelegramConnection implements TelegramConn {
  readonly name: string;
  readonly provider = PROVIDER;
  readonly self: ChannelConn['self'];
  readonly capabilities = { edit: true, buttons: true, typing: true, files: true, threads: true };
  readonly bot: TgUser;

  readonly #ctx: ChannelContext;
  readonly #api: BotApi;
  readonly #me: BotSelf;
  readonly #log: Logger;
  readonly #opts: TelegramConnOptions;
  readonly #threads = new ThreadTracker();
  readonly #buttons = new ButtonIds();
  readonly #queue: SendQueue;
  readonly #inbox = new Inbox<InboundMsg>();
  readonly #buttonHandlers: ((p: ButtonPress) => void)[] = [];
  readonly #removedHandlers: ((conversationId: string) => void)[] = [];
  readonly #abort = new AbortController();
  #inboundTaken = false;
  #loop: Promise<void> | undefined;
  #webhookDeleted = false;

  constructor(
    ctx: ChannelContext,
    api: BotApi,
    me: TgUser,
    bot: BotSelf,
    log: Logger,
    opts: TelegramConnOptions,
  ) {
    this.#ctx = ctx;
    this.#api = api;
    this.#me = bot;
    this.#log = log;
    this.#opts = opts;
    this.#queue = new SendQueue(opts.rateLimit);
    this.name = ctx.name;
    this.bot = me;
    this.self = { principal: principalOf(me.id), displayName: me.first_name };
    if (me.username) this.self.handle = me.username;
    if (opts.poll !== false) this.#loop = this.#pollLoop();
  }

  // ───────────── inbound ─────────────

  inbound(): AsyncIterable<InboundMsg> {
    if (this.#inboundTaken) throw new BeamhopError('conflict', 'telegram: inbound() already consumed');
    this.#inboundTaken = true;
    const inbox = this.#inbox;
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => inbox.next(),
        return: async () => ({ value: undefined, done: true }),
      }),
    };
  }

  onButton(handler: (press: ButtonPress) => void): void {
    this.#buttonHandlers.push(handler);
  }

  onRemoved(handler: (conversationId: string) => void): void {
    this.#removedHandlers.push(handler);
  }

  async #pollLoop(): Promise<void> {
    const signal = this.#abort.signal;
    const timeout = this.#opts.pollTimeoutSec ?? 30;
    const base = this.#opts.backoffBaseMs ?? 1000;
    const max = this.#opts.backoffMaxMs ?? 30_000;
    const conflictMs = this.#opts.conflictBackoffMs ?? 15_000;
    let failures = 0;
    let conflictWarned = false;
    while (!signal.aborted) {
      try {
        const stored = await this.#ctx.state.get<number>(OFFSET_KEY);
        const params: ApiParams = { timeout, allowed_updates: ALLOWED_UPDATES };
        if (typeof stored === 'number') params.offset = stored;
        // Guard against a silently stalled connection: abort a bit after the long-poll timeout.
        const pollSignal = AbortSignal.any([signal, AbortSignal.timeout((timeout + 15) * 1000)]);
        const updates = await this.#api.call<TgUpdate[]>('getUpdates', params, { signal: pollSignal });
        failures = 0;
        if (conflictWarned) this.#log.info('telegram: getUpdates conflict resolved');
        conflictWarned = false;
        for (const u of updates) {
          this.#handleUpdate(u);
          await this.#ctx.state.set(OFFSET_KEY, u.update_id + 1);
        }
      } catch (e) {
        if (signal.aborted) break;
        if (e instanceof TelegramApiError && e.status === 409) {
          if (/webhook/i.test(e.description) && !this.#webhookDeleted) {
            this.#webhookDeleted = true;
            this.#log.warn('telegram: a webhook is set; deleting it to use long-polling');
            await this.#api.call('deleteWebhook', { drop_pending_updates: false }).catch(() => {});
            continue;
          }
          if (!conflictWarned) {
            this.#log.warn('telegram: another getUpdates poller is running for this bot; retrying', {
              description: e.description,
            });
            conflictWarned = true;
          }
          await defaultSleep(conflictMs, signal);
          continue;
        }
        if (e instanceof TelegramApiError && e.status === 401) {
          this.#log.error('telegram: bot token rejected (401); stopping poller');
          break;
        }
        failures++;
        let delay = Math.min(max, base * 2 ** (failures - 1));
        if (e instanceof TelegramApiError && e.status === 429 && e.retryAfter) delay = e.retryAfter * 1000;
        delay = Math.round(delay * (0.8 + Math.random() * 0.4));
        this.#log.warn('telegram: getUpdates failed; backing off', {
          error: e instanceof Error ? this.#api.scrub(e.message) : String(e),
          delayMs: delay,
        });
        await defaultSleep(delay, signal);
      }
    }
    this.#inbox.close();
  }

  #handleUpdate(u: TgUpdate): void {
    try {
      const m = u.message ?? u.channel_post;
      if (m) this.#handleMessage(m);
      else if (u.callback_query) this.#handleCallback(u.callback_query);
      else if (u.my_chat_member) this.#handleMember(u.my_chat_member);
    } catch (e) {
      this.#log.error('telegram: failed to handle update', {
        update_id: u.update_id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  #handleMessage(m: TgMessage): void {
    const msg = normalizeMessage(m, {
      channel: this.name,
      bot: this.#me,
      threads: this.#threads,
      includeRaw: this.#opts.includeRaw ?? false,
    });
    if (msg) this.#inbox.push(msg);
  }

  #handleCallback(q: TgCallbackQuery): void {
    void this.#api
      .call('answerCallbackQuery', { callback_query_id: q.id })
      .catch((e) => this.#log.debug('telegram: answerCallbackQuery failed', { error: (e as Error).message }));
    const buttonId = q.data !== undefined ? this.#buttons.decode(q.data) : undefined;
    if (!buttonId || !q.message) return;
    const press: ButtonPress = {
      messageId: messageKey(q.message.chat.id, q.message.message_id),
      buttonId,
      principal: principalOf(q.from.id),
      conversationId: String(q.message.chat.id),
    };
    for (const h of this.#buttonHandlers) h(press);
  }

  #handleMember(c: TgChatMemberUpdated): void {
    if (c.new_chat_member.user.id !== this.#me.id) return;
    const status = c.new_chat_member.status;
    if (status === 'left' || status === 'kicked') this.#emitRemoved(String(c.chat.id));
  }

  #emitRemoved(conversationId: string): void {
    this.#log.info('telegram: removed from chat', { conversationId });
    for (const h of this.#removedHandlers) h(conversationId);
  }

  // ───────────── outbound ─────────────

  /** Route for a send: thread/topic + reply target. */
  #target(chatId: string, threadId: string | undefined, replyToId: string | undefined): ApiParams {
    const p: ApiParams = {};
    if (threadId && threadId !== chatId && this.#threads.isTopic(chatId, threadId)) {
      p.message_thread_id = Number(threadId);
    }
    let replyTo = replyToId ? parseMessageKey(replyToId)?.messageId : undefined;
    // Reply-chain threads in groups: anchor to the thread root when no explicit reply target.
    if (replyTo === undefined && threadId && threadId !== chatId && p.message_thread_id === undefined) {
      const n = Number(threadId);
      if (Number.isInteger(n) && n > 0) replyTo = n;
    }
    if (replyTo !== undefined)
      p.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };
    return p;
  }

  async #call<T>(
    chatId: string,
    method: string,
    params: ApiParams,
    files?: Record<string, UploadFile>,
  ): Promise<T> {
    try {
      return await this.#queue.run(chatId, () =>
        this.#api.call<T>(
          method,
          params,
          files ? { files, signal: this.#abort.signal } : { signal: this.#abort.signal },
        ),
      );
    } catch (e) {
      if (isRemovedError(e)) this.#emitRemoved(chatId);
      throw e;
    }
  }

  /** Send one HTML chunk, falling back to plain text if Telegram can't parse it. */
  async #sendChunk(chatId: string, html: string, extra: ApiParams): Promise<TgMessage> {
    try {
      return await this.#call<TgMessage>(chatId, 'sendMessage', {
        chat_id: chatId,
        text: html,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...extra,
      });
    } catch (e) {
      if (!isParseEntitiesError(e)) throw e;
      this.#log.debug('telegram: HTML rejected, sending plain text', { error: (e as Error).message });
      return this.#call<TgMessage>(chatId, 'sendMessage', {
        chat_id: chatId,
        text: htmlToPlain(html),
        link_preview_options: { is_disabled: true },
        ...extra,
      });
    }
  }

  async #editChunk(chatId: string, messageId: number, html: string, markup: unknown): Promise<void> {
    const base: ApiParams = {
      chat_id: chatId,
      message_id: messageId,
      link_preview_options: { is_disabled: true },
    };
    if (markup) base.reply_markup = markup;
    try {
      await this.#call(chatId, 'editMessageText', { ...base, text: html, parse_mode: 'HTML' });
    } catch (e) {
      if (isNotModifiedError(e)) return;
      if (!isParseEntitiesError(e)) throw e;
      try {
        await this.#call(chatId, 'editMessageText', { ...base, text: htmlToPlain(html) });
      } catch (e2) {
        if (!isNotModifiedError(e2)) throw e2;
      }
    }
  }

  #chunks(markdown: string): string[] {
    const html = markdownToTelegramHtml(markdown);
    return html.trim() ? splitHtml(html, TELEGRAM_TEXT_LIMIT) : [];
  }

  async send(input: OutboundMsgInput): Promise<SentMessage> {
    const msg = OutboundMsg.parse(input);
    const chatId = msg.conversation.id;
    const target = this.#target(chatId, msg.threadId, msg.replyToId);
    const keyboard = buildKeyboard(msg.buttons, this.#buttons);
    const chunks = this.#chunks(msg.markdown);
    const ids: number[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const extra: ApiParams = { ...(i === 0 ? target : { message_thread_id: target.message_thread_id }) };
      if (i === chunks.length - 1 && keyboard && msg.attachments.length === 0) extra.reply_markup = keyboard;
      const sent = await this.#sendChunk(chatId, chunks[i] ?? '', extra);
      ids.push(sent.message_id);
    }
    const fileIds: number[] = [];
    for (let i = 0; i < msg.attachments.length; i++) {
      const a = msg.attachments[i] as Attachment;
      const extra: ApiParams = { ...(ids.length === 0 && i === 0 ? target : {}) };
      if (target.message_thread_id !== undefined) extra.message_thread_id = target.message_thread_id;
      if (i === msg.attachments.length - 1 && keyboard) extra.reply_markup = keyboard;
      const sent = await this.#sendFile(chatId, a, extra);
      fileIds.push(sent.message_id);
    }
    if (ids.length === 0 && fileIds.length === 0) {
      throw new BeamhopError(
        'invalid_input',
        'telegram: nothing to send (empty markdown and no attachments)',
      );
    }
    const textKeyboard = msg.attachments.length === 0 ? keyboard : undefined;
    const primary = ids[ids.length - 1] ?? fileIds[0] ?? 0;
    const handle: SentMessage = { id: messageKey(chatId, primary) };
    if (ids.length > 0) handle.edit = (md: string) => this.#edit(chatId, ids, md, textKeyboard, target);
    return handle;
  }

  /** Edit a (possibly multi-part) message in place; extra parts are sent/deleted as needed. */
  async #edit(
    chatId: string,
    ids: number[],
    markdown: string,
    keyboard: unknown,
    target: ApiParams,
  ): Promise<void> {
    const chunks = this.#chunks(markdown);
    if (chunks.length === 0) chunks.push('…');
    const n = Math.max(chunks.length, ids.length);
    const next: number[] = [];
    for (let i = 0; i < n; i++) {
      const id = ids[i];
      const chunk = chunks[i];
      const last = i === chunks.length - 1;
      if (chunk !== undefined && id !== undefined) {
        await this.#editChunk(chatId, id, chunk, last ? keyboard : undefined);
        next.push(id);
      } else if (chunk !== undefined) {
        const extra: ApiParams = {};
        if (target.message_thread_id !== undefined) extra.message_thread_id = target.message_thread_id;
        if (last && keyboard) extra.reply_markup = keyboard;
        next.push((await this.#sendChunk(chatId, chunk, extra)).message_id);
      } else if (id !== undefined) {
        await this.#call(chatId, 'deleteMessage', { chat_id: chatId, message_id: id }).catch(() => {});
      }
    }
    ids.splice(0, ids.length, ...next);
  }

  async #sendFile(chatId: string, a: Attachment, extra: ApiParams): Promise<TgMessage> {
    let isPhoto = PHOTO_MIME.test(a.mime) && (a.size ?? 0) <= PHOTO_MAX_BYTES;
    let ref: string | undefined;
    let file: UploadFile | undefined;
    if (a.localPath) {
      const st = await stat(a.localPath);
      if (st.size > PHOTO_MAX_BYTES) isPhoto = false;
      file = { name: a.name || basename(a.localPath), mime: a.mime, data: await readFile(a.localPath) };
    } else if (a.url?.startsWith(FILE_REF_PREFIX)) {
      ref = parseFileRef(a.url);
    } else if (a.url && /^https?:\/\//i.test(a.url)) {
      ref = a.url;
    } else {
      throw new BeamhopError(
        'invalid_input',
        `telegram: attachment "${a.name}" has no localPath or usable url`,
      );
    }
    const method = isPhoto ? 'sendPhoto' : 'sendDocument';
    const field = isPhoto ? 'photo' : 'document';
    const params: ApiParams = { chat_id: chatId, ...extra };
    if (ref) params[field] = ref;
    return this.#call<TgMessage>(chatId, method, params, file ? { [field]: file } : undefined);
  }

  async typing(conversationId: string): Promise<void> {
    await this.#api
      .call('sendChatAction', { chat_id: conversationId, action: 'typing' }, { signal: this.#abort.signal })
      .catch((e) => {
        if (isRemovedError(e)) this.#emitRemoved(conversationId);
        this.#log.debug('telegram: sendChatAction failed', { error: (e as Error).message });
      });
  }

  downloadFile(fileIdOrRef: string, destPath: string, opts?: { maxBytes?: number }) {
    return this.#api.downloadFile(fileIdOrRef, destPath, { ...opts, signal: this.#abort.signal });
  }

  async close(): Promise<void> {
    this.#abort.abort();
    await this.#loop?.catch(() => {});
    this.#inbox.close();
  }
}
