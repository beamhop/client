import { describe, expect, it } from 'vitest';
import { TelegramApiError } from '../src/api.ts';
import { isGroupChatId, SendQueue } from '../src/ratelimit.ts';

const fakeClock = () => {
  let t = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
    get t() {
      return t;
    },
  };
};

describe('SendQueue', () => {
  it('spaces sends in one chat ~1/s and runs them in order', async () => {
    const c = fakeClock();
    const q = new SendQueue({ now: c.now, sleep: c.sleep });
    const order: number[] = [];
    const stamps: number[] = [];
    await Promise.all(
      [1, 2, 3].map((n) =>
        q.run('42', async () => {
          order.push(n);
          stamps.push(c.t);
        }),
      ),
    );
    expect(order).toEqual([1, 2, 3]);
    expect(stamps[1]! - stamps[0]!).toBe(1000);
    expect(stamps[2]! - stamps[1]!).toBe(1000);
  });

  it('does not delay different chats against each other', async () => {
    const c = fakeClock();
    const q = new SendQueue({ now: c.now, sleep: c.sleep });
    await q.run('1', async () => {});
    await q.run('2', async () => {});
    expect(c.sleeps).toEqual([]);
  });

  it('limits groups to 20 per minute', async () => {
    const c = fakeClock();
    const q = new SendQueue({ now: c.now, sleep: c.sleep, perChatIntervalMs: 0 });
    const stamps: number[] = [];
    for (let i = 0; i < 21; i++) await q.run('-100123', async () => void stamps.push(c.t));
    expect(stamps[19]! - stamps[0]!).toBe(0);
    expect(stamps[20]! - stamps[0]!).toBe(60_000);
    expect(isGroupChatId('-100123')).toBe(true);
    expect(isGroupChatId('42')).toBe(false);
  });

  it('waits retry_after on 429 and retries', async () => {
    const c = fakeClock();
    const q = new SendQueue({ now: c.now, sleep: c.sleep });
    let calls = 0;
    const r = await q.run('42', async () => {
      calls++;
      if (calls < 3) throw new TelegramApiError('sendMessage', 429, 'Too Many Requests: retry after 7', 7);
      return 'sent';
    });
    expect(r).toBe('sent');
    expect(c.sleeps.filter((s) => s === 7000)).toHaveLength(2);
  });

  it('gives up after maxRetries and does not retry other errors', async () => {
    const c = fakeClock();
    const q = new SendQueue({ now: c.now, sleep: c.sleep, maxRetries: 1 });
    let n = 0;
    await expect(
      q.run('42', async () => {
        n++;
        throw new TelegramApiError('sendMessage', 429, 'Too Many Requests', 1);
      }),
    ).rejects.toThrow(/429/);
    expect(n).toBe(2);
    let m = 0;
    await expect(
      q.run('42', async () => {
        m++;
        throw new TelegramApiError('sendMessage', 400, 'Bad Request');
      }),
    ).rejects.toThrow(/400/);
    expect(m).toBe(1);
    // the queue keeps working after failures
    await expect(q.run('42', async () => 'ok')).resolves.toBe('ok');
  });
});
