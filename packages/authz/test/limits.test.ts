import { describe, expect, it } from 'vitest';
import {
  BudgetTracker,
  budgetKey,
  canRoute,
  canRouteDetailed,
  checkMesh,
  constantTimeEqual,
  createPairingCode,
  emptyMeshThread,
  isWellFormedPairingCode,
  normalizePairingCode,
  PAIRING_ALPHABET,
  utcDay,
  verifyPairingCode,
} from '../src/index.ts';

const clock = (start = Date.parse('2026-11-13T10:00:00Z')) => {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};

describe('BudgetTracker rate limits', () => {
  it('allows a burst up to the limit, then refills continuously', () => {
    const c = clock();
    const b = new BudgetTracker({ now: c.now });
    const budget = { messagesPerMinute: 3 };
    for (let i = 0; i < 3; i++) expect(b.takeMessage('k', budget).ok).toBe(true);
    const denied = b.takeMessage('k', budget);
    expect(denied).toMatchObject({ ok: false, reason: 'rate_limited', retryAfterMs: 20_000 });
    c.advance(19_999);
    expect(b.takeMessage('k', budget).ok).toBe(false);
    c.advance(20_001);
    expect(b.takeMessage('k', budget).ok).toBe(true);
  });
  it('does not overfill after a long idle', () => {
    const c = clock();
    const b = new BudgetTracker({ now: c.now });
    b.takeMessage('k', { messagesPerMinute: 2 });
    c.advance(3_600_000);
    expect(b.takeMessage('k', { messagesPerMinute: 2 }).ok).toBe(true);
    expect(b.takeMessage('k', { messagesPerMinute: 2 }).ok).toBe(true);
    expect(b.takeMessage('k', { messagesPerMinute: 2 }).ok).toBe(false);
  });
  it('keys are independent and no limit means unlimited', () => {
    const b = new BudgetTracker({ now: clock().now });
    expect(b.takeMessage('a', { messagesPerMinute: 1 }).ok).toBe(true);
    expect(b.takeMessage('b', { messagesPerMinute: 1 }).ok).toBe(true);
    for (let i = 0; i < 100; i++) expect(b.takeMessage('c', {}).ok).toBe(true);
  });
  it('a changed limit resets the bucket', () => {
    const b = new BudgetTracker({ now: clock().now });
    expect(b.takeMessage('a', { messagesPerMinute: 1 }).ok).toBe(true);
    expect(b.takeMessage('a', { messagesPerMinute: 5 }).ok).toBe(true);
  });
  it('tolerates a clock going backwards', () => {
    const c = clock();
    const b = new BudgetTracker({ now: c.now });
    b.takeMessage('a', { messagesPerMinute: 1 });
    c.advance(-10_000);
    expect(b.takeMessage('a', { messagesPerMinute: 1 }).ok).toBe(false);
  });
});

describe('BudgetTracker daily budgets', () => {
  it('denies once usd or tokens are used up, resets at UTC midnight', () => {
    const c = clock(Date.parse('2026-11-13T23:59:00Z'));
    const b = new BudgetTracker({ now: c.now });
    const budget = { dailyUsd: 1, dailyTokens: 1000 };
    b.record('k', { usd: 0.5, tokens: 100 });
    expect(b.checkDaily('k', budget).ok).toBe(true);
    b.record('k', { usd: 0.5 });
    expect(b.checkDaily('k', budget)).toMatchObject({ ok: false, reason: 'daily_usd' });
    c.advance(60_000);
    expect(b.usage('k')).toEqual({ day: '2026-11-14', tokens: 0, usd: 0, minutes: 0 });
    expect(b.checkDaily('k', budget).ok).toBe(true);
    b.record('k', { tokens: 1000 });
    expect(b.checkDaily('k', budget)).toMatchObject({ ok: false, reason: 'daily_tokens' });
  });
  it('reports 80% and 100% threshold crossings once', () => {
    const b = new BudgetTracker({ now: clock().now });
    const budget = { dailyUsd: 10 };
    expect(b.record('k', { usd: 7 }, budget)).toEqual([]);
    expect(b.record('k', { usd: 1 }, budget)).toEqual([
      { key: 'k', metric: 'usd', threshold: 0.8, used: 8, limit: 10 },
    ]);
    expect(b.record('k', { usd: 1 }, budget)).toEqual([]);
    const crossed = b.record('k', { usd: 5 }, budget);
    expect(crossed.map((x) => x.threshold)).toEqual([1]);
  });
  it('a single big delta crosses both thresholds', () => {
    const b = new BudgetTracker({ now: clock().now });
    expect(b.record('k', { tokens: 500 }, { dailyTokens: 100 }).map((x) => x.threshold)).toEqual([0.8, 1]);
  });
  it('ignores negative deltas', () => {
    const b = new BudgetTracker({ now: clock().now });
    b.record('k', { usd: -5, tokens: -1 });
    expect(b.usage('k')).toMatchObject({ usd: 0, tokens: 0 });
  });
  it('can be seeded from persisted usage', () => {
    const b = new BudgetTracker({ now: clock().now });
    b.load('k', { tokens: 0, usd: 5, minutes: 0 });
    expect(b.checkDaily('k', { dailyUsd: 5 }).ok).toBe(false);
    b.load('old', { day: '2020-01-01', tokens: 0, usd: 99, minutes: 0 });
    expect(b.checkDaily('old', { dailyUsd: 5 }).ok).toBe(true);
    b.reset();
    expect(b.usage('k').usd).toBe(0);
  });
  it('session minutes', () => {
    const c = clock();
    const b = new BudgetTracker({ now: c.now });
    const start = c.now();
    expect(b.checkSession(start, {}).ok).toBe(true);
    c.advance(9 * 60_000);
    expect(b.checkSession(start, { perSessionMinutes: 10 }).ok).toBe(true);
    c.advance(60_000);
    expect(b.checkSession(start, { perSessionMinutes: 10 })).toMatchObject({
      ok: false,
      reason: 'session_minutes',
    });
  });
  it('admit checks all keys and refunds rate tokens when one fails', () => {
    const b = new BudgetTracker({ now: clock().now });
    const agent = { key: budgetKey.agent('a'), budget: { messagesPerMinute: 1 } };
    const peer = { key: budgetKey.peer('a', 'nostr:p'), budget: { messagesPerMinute: 1 } };
    expect(b.admit([agent, peer]).ok).toBe(true);
    // agent bucket now empty; a different peer with fresh bucket fails on the agent key
    const peer2 = { key: budgetKey.peer('a', 'nostr:q'), budget: { messagesPerMinute: 1 } };
    expect(b.admit([peer2, agent]).ok).toBe(false);
    // peer2's token was refunded
    expect(b.takeMessage(peer2.key, peer2.budget).ok).toBe(true);
    b.record(budgetKey.agent('x'), { usd: 3 });
    expect(b.admit([{ key: budgetKey.agent('x'), budget: { dailyUsd: 3 } }])).toMatchObject({
      reason: 'daily_usd',
    });
  });
  it('budget keys are distinct per scope', () => {
    expect(
      new Set([
        budgetKey.agent('a'),
        budgetKey.role('a', 'user'),
        budgetKey.principal('a', 'p'),
        budgetKey.session('s'),
      ]).size,
    ).toBe(4);
    expect(utcDay(0)).toBe('1970-01-01');
  });
});

describe('checkMesh', () => {
  const config = { maxHops: 3, maxTurnsPerThread: 6 };
  it('human messages reset the thread', () => {
    const r = checkMesh({
      thread: { turns: 6, hops: 3, humanRequired: true },
      hops: 0,
      config,
      fromHuman: true,
      now: 't',
    });
    expect(r).toEqual({
      action: 'allow',
      next: { turns: 0, hops: 0, humanRequired: false, lastHumanAt: 't' },
      outgoingHops: 1,
    });
  });
  it('allows peers under the caps and counts turns', () => {
    const r = checkMesh({ thread: emptyMeshThread(), hops: 1, config, fromHuman: false });
    expect(r).toEqual({
      action: 'allow',
      next: { turns: 1, hops: 1, humanRequired: false },
      outgoingHops: 2,
    });
  });
  it('drops at the hop cap and then requires a human', () => {
    const r = checkMesh({ thread: emptyMeshThread(), hops: 3, config, fromHuman: false });
    expect(r).toMatchObject({ action: 'drop', reason: 'hop_cap', next: { humanRequired: true } });
    const r2 = checkMesh({ thread: r.next, hops: 0, config, fromHuman: false });
    expect(r2).toMatchObject({ action: 'drop', reason: 'human_required' });
  });
  it('drops at the turn cap', () => {
    let thread = emptyMeshThread();
    for (let i = 0; i < 6; i++) {
      const r = checkMesh({ thread, hops: 1, config, fromHuman: false });
      expect(r.action).toBe('allow');
      thread = r.next;
    }
    expect(checkMesh({ thread, hops: 1, config, fromHuman: false })).toMatchObject({
      action: 'drop',
      reason: 'turn_cap',
    });
  });
  it('treats invalid hop values as over the cap', () => {
    for (const hops of [Number.NaN, -1, Number.POSITIVE_INFINITY])
      expect(checkMesh({ thread: emptyMeshThread(), hops, config, fromHuman: false })).toMatchObject({
        reason: 'hop_cap',
      });
  });
});

describe('canRoute', () => {
  const routes = [
    { from: 'tg:group/-100', to: 'work-slack:channel/C01' },
    { from: 'nostr:dm', to: 'work-slack:channel/*' },
  ];
  it('default is reply-only', () => {
    expect(canRouteDetailed('tg:group/-100', 'tg:group/-100')).toEqual({ ok: true, via: 'reply' });
    expect(canRoute('tg:group/-100', 'tg:group/-200')).toBe(false);
  });
  it('routes are directional and exact', () => {
    expect(canRoute('tg:group/-100', 'work-slack:channel/C01', routes)).toBe(true);
    expect(canRoute('work-slack:channel/C01', 'tg:group/-100', routes)).toBe(false);
    expect(canRoute('tg:group/-1000', 'work-slack:channel/C01', routes)).toBe(false);
  });
  it('supports globs in route targets', () => {
    expect(canRoute('nostr:dm', 'work-slack:channel/C99', routes)).toBe(true);
    expect(canRoute('nostr:dm', 'work-slack:dm', routes)).toBe(false);
  });
  it('channel name and kind are case-insensitive; ids are not', () => {
    expect(canRoute('TG:Group/-100', 'work-slack:CHANNEL/C01', routes)).toBe(true);
    expect(canRoute('tg:group/-100', 'work-slack:channel/c01', routes)).toBe(false);
    expect(canRoute('tg:group/Ab', 'TG:GROUP/Ab')).toBe(true);
    expect(canRoute('tg:group/Ab', 'tg:group/ab')).toBe(false);
  });
});

describe('pairing codes', () => {
  it('creates 6-char codes from the unambiguous alphabet with a 10 minute expiry', () => {
    const now = Date.parse('2026-11-13T10:00:00Z');
    for (let i = 0; i < 200; i++) {
      const p = createPairingCode({ now });
      expect(p.code).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);
      expect(isWellFormedPairingCode(p.code)).toBe(true);
      expect(Date.parse(p.expiresAt) - now).toBe(600_000);
    }
    expect(PAIRING_ALPHABET).not.toMatch(/[01OIL]/);
  });
  it('accepts an injected random source', () => {
    expect(createPairingCode({ random: () => 0 }).code).toBe('AAAAAA');
  });
  it('verifies with normalization', () => {
    const rec = { code: 'ABC234', expiresAt: '2026-11-13T10:10:00Z' };
    const now = Date.parse('2026-11-13T10:05:00Z');
    expect(verifyPairingCode('abc-234', rec, { now })).toEqual({ ok: true });
    expect(verifyPairingCode(' ab c2 34 ', rec, { now })).toEqual({ ok: true });
    expect(verifyPairingCode('ＡＢＣ２３４', rec, { now })).toEqual({ ok: true });
  });
  it('rejects expired, used, malformed, mismatched and over-attempted codes', () => {
    const rec = { code: 'ABC234', expiresAt: '2026-11-13T10:10:00Z' };
    const now = Date.parse('2026-11-13T10:05:00Z');
    expect(verifyPairingCode('ABC234', rec, { now: Date.parse('2026-11-13T10:10:00Z') })).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(verifyPairingCode('ABC234', { ...rec, usedAt: 'x' }, { now })).toEqual({
      ok: false,
      reason: 'used',
    });
    expect(verifyPairingCode('ABC10O', rec, { now })).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyPairingCode('ABC2345', rec, { now })).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyPairingCode('ABC235', rec, { now })).toEqual({ ok: false, reason: 'mismatch' });
    expect(verifyPairingCode('ABC234', { ...rec, attempts: 5 }, { now })).toEqual({
      ok: false,
      reason: 'too_many_attempts',
    });
  });
  it('constant-time compare handles different lengths', () => {
    expect(constantTimeEqual('a', 'a')).toBe(true);
    expect(constantTimeEqual('a', 'ab')).toBe(false);
    expect(normalizePairingCode('a_b-c d')).toBe('ABCD');
  });
});
