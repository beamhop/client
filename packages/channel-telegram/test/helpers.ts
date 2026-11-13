import { type ChannelContext, type KV, silentLogger } from '@beamhop/core';
import { FAKE_TOKEN } from './fake-bot-api.ts';

export class MemoryKV implements KV {
  readonly data = new Map<string, unknown>();
  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }
  async set(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

export const makeCtx = (state = new MemoryKV(), token = FAKE_TOKEN): ChannelContext => ({
  name: 'mybot',
  settings: {},
  secrets: { token },
  log: silentLogger,
  state,
});

/** Collect the next `n` items from an async iterator. */
export const take = async <T>(it: AsyncIterator<T>, n: number, timeoutMs = 5000): Promise<T[]> => {
  const out: T[] = [];
  const deadline = Date.now() + timeoutMs;
  while (out.length < n) {
    const r = await Promise.race([
      it.next(),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('take: timeout')), Math.max(1, deadline - Date.now())),
      ),
    ]);
    if (r.done) break;
    out.push(r.value);
  }
  return out;
};

export const until = async (cond: () => boolean, timeoutMs = 5000): Promise<void> => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('until: timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
};
