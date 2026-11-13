// Per-chat send queue: ~1 msg/s per chat, 20 msgs/min in groups, and 429 `retry_after` handling.

import { TelegramApiError } from './api.ts';

export interface RateLimitOptions {
  /** Minimum gap between sends in one chat (ms). Default 1000. */
  perChatIntervalMs?: number;
  /** Max sends per minute in a group chat. Default 20. */
  groupPerMinute?: number;
  /** Window for the group limit (ms). Default 60_000. */
  groupWindowMs?: number;
  /** How many times to retry a call that hit 429. Default 3. */
  maxRetries?: number;
  /** Upper bound on a single `retry_after` wait (s). Default 120. */
  maxRetryAfterSec?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

interface ChatState {
  tail: Promise<unknown>;
  last: number;
  recent: number[];
  /** Chat-wide pause after a 429. */
  pausedUntil: number;
}

/** Group chats have negative ids in the Bot API. */
export const isGroupChatId = (chatId: string | number): boolean => String(chatId).startsWith('-');

export class SendQueue {
  readonly #chats = new Map<string, ChatState>();
  readonly #o: Required<Omit<RateLimitOptions, 'now' | 'sleep'>> & {
    now: () => number;
    sleep: (ms: number) => Promise<void>;
  };

  constructor(opts: RateLimitOptions = {}) {
    this.#o = {
      perChatIntervalMs: opts.perChatIntervalMs ?? 1000,
      groupPerMinute: opts.groupPerMinute ?? 20,
      groupWindowMs: opts.groupWindowMs ?? 60_000,
      maxRetries: opts.maxRetries ?? 3,
      maxRetryAfterSec: opts.maxRetryAfterSec ?? 120,
      now: opts.now ?? Date.now,
      sleep: opts.sleep ?? ((ms) => defaultSleep(ms)),
    };
  }

  /** Run `fn` in the chat's queue, after the rate-limit delay; retries on 429. */
  run<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
    let st = this.#chats.get(chatId);
    if (!st) {
      st = { tail: Promise.resolve(), last: Number.NEGATIVE_INFINITY, recent: [], pausedUntil: 0 };
      this.#chats.set(chatId, st);
    }
    const state = st;
    const job = state.tail.then(async () => {
      await this.#wait(chatId, state);
      return this.#withRetry(state, fn);
    });
    state.tail = job.catch(() => {});
    return job;
  }

  async #wait(chatId: string, st: ChatState): Promise<void> {
    const o = this.#o;
    for (;;) {
      const now = o.now();
      let until = Math.max(st.last + o.perChatIntervalMs, st.pausedUntil);
      if (isGroupChatId(chatId)) {
        st.recent = st.recent.filter((t) => t > now - o.groupWindowMs);
        if (st.recent.length >= o.groupPerMinute)
          until = Math.max(until, (st.recent[0] ?? now) + o.groupWindowMs);
      }
      if (until <= now) break;
      await o.sleep(until - now);
    }
    const t = o.now();
    st.last = t;
    if (isGroupChatId(chatId)) st.recent.push(t);
  }

  async #withRetry<T>(st: ChatState, fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if (!(e instanceof TelegramApiError) || e.status !== 429 || attempt >= this.#o.maxRetries) throw e;
        const sec = Math.min(Math.max(e.retryAfter ?? 1, 1), this.#o.maxRetryAfterSec);
        st.pausedUntil = this.#o.now() + sec * 1000;
        await this.#o.sleep(sec * 1000);
        st.last = this.#o.now();
      }
    }
  }
}
