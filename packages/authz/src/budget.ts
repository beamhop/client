import type { Budget } from '@beamhop/core';

export type Clock = () => number;

export type BudgetDenial = 'rate_limited' | 'daily_usd' | 'daily_tokens' | 'session_minutes';

export type BudgetCheck =
  | { ok: true }
  | { ok: false; reason: BudgetDenial; retryAfterMs?: number; message: string };

export interface UsageDelta {
  tokens?: number;
  usd?: number;
  minutes?: number;
}

export interface DailyUsage {
  day: string;
  tokens: number;
  usd: number;
  minutes: number;
}

/** Alert thresholds (§9B): 80% and 100% of a daily budget. */
export const ALERT_THRESHOLDS = [0.8, 1] as const;

export interface ThresholdCrossing {
  key: string;
  metric: 'usd' | 'tokens';
  threshold: number;
  used: number;
  limit: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
  capacity: number;
}

/**
 * Sanitize a spend amount: negative → 0 (no refunds through `record`), and NaN / non-numbers →
 * Infinity, so a corrupt usage figure exhausts the budget instead of disabling it.
 */
const spend = (v: unknown): number => {
  if (v === undefined || v === null) return 0;
  if (typeof v !== 'number' || Number.isNaN(v)) return Number.POSITIVE_INFINITY;
  return Math.max(0, v);
};

/** UTC calendar day for a timestamp, e.g. "2026-11-13". */
export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Conventional budget keys. */
export const budgetKey = {
  agent: (agent: string) => `agent:${agent}`,
  principal: (agent: string, principal: string) => `principal:${agent}:${principal}`,
  peer: (agent: string, peer: string) => `peer:${agent}:${peer}`,
  role: (agent: string, role: string) => `role:${agent}:${role}`,
  session: (session: string) => `session:${session}`,
};

/**
 * In-memory budgets and rate limits (§6, §6A.6, §7A spend abuse).
 * - `messagesPerMinute`: token bucket per key (capacity = limit, refills continuously).
 * - `dailyUsd` / `dailyTokens`: per key, reset at UTC midnight.
 * - `perSessionMinutes`: checked against a session start time.
 * The clock is injectable for tests. Persisted rollups live in @beamhop/store (`usage`); seed with `load`.
 */
export class BudgetTracker {
  private readonly now: Clock;
  private readonly buckets = new Map<string, Bucket>();
  private readonly daily = new Map<string, DailyUsage>();

  constructor(opts: { now?: Clock } = {}) {
    this.now = opts.now ?? Date.now;
  }

  /** Consume one message from the key's rate limit. Does nothing when the budget has no rate limit. */
  takeMessage(key: string, budget: Budget): BudgetCheck {
    const limit = budget.messagesPerMinute;
    if (!limit) return { ok: true };
    const now = this.now();
    let b = this.buckets.get(key);
    if (!b || b.capacity !== limit) {
      b = { tokens: limit, updatedAt: now, capacity: limit };
      this.buckets.set(key, b);
    }
    const ratePerMs = limit / 60_000;
    b.tokens = Math.min(limit, b.tokens + Math.max(0, now - b.updatedAt) * ratePerMs);
    b.updatedAt = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true };
    }
    const retryAfterMs = Math.ceil((1 - b.tokens) / ratePerMs);
    return {
      ok: false,
      reason: 'rate_limited',
      retryAfterMs,
      message: `rate limit of ${limit}/min reached; try again in ${Math.ceil(retryAfterMs / 1000)}s`,
    };
  }

  /** Today's usage for a key (zeros if nothing recorded today). */
  usage(key: string): DailyUsage {
    const day = utcDay(this.now());
    const u = this.daily.get(key);
    return u && u.day === day ? { ...u } : { day, tokens: 0, usd: 0, minutes: 0 };
  }

  /** Seed today's usage (e.g. from the store after a restart). */
  load(key: string, usage: Omit<DailyUsage, 'day'> & { day?: string }): void {
    const day = usage.day ?? utcDay(this.now());
    this.daily.set(key, {
      day,
      tokens: spend(usage.tokens),
      usd: spend(usage.usd),
      minutes: spend(usage.minutes),
    });
  }

  /** Is there daily budget left for this key? */
  checkDaily(key: string, budget: Budget): BudgetCheck {
    const u = this.usage(key);
    // Written as `!(used < limit)` so a NaN usage (or limit) fails closed instead of disabling the cap.
    if (budget.dailyUsd !== undefined && !(u.usd < budget.dailyUsd))
      return {
        ok: false,
        reason: 'daily_usd',
        message: `daily budget of $${budget.dailyUsd} used ($${u.usd.toFixed(2)})`,
      };
    if (budget.dailyTokens !== undefined && !(u.tokens < budget.dailyTokens))
      return {
        ok: false,
        reason: 'daily_tokens',
        message: `daily budget of ${budget.dailyTokens} tokens used`,
      };
    return { ok: true };
  }

  /** Has a session exceeded its minute budget? */
  checkSession(startedAtMs: number, budget: Budget): BudgetCheck {
    if (!budget.perSessionMinutes) return { ok: true };
    const minutes = (this.now() - startedAtMs) / 60_000;
    if (!(minutes < budget.perSessionMinutes))
      return {
        ok: false,
        reason: 'session_minutes',
        message: `session limit of ${budget.perSessionMinutes} minutes reached`,
      };
    return { ok: true };
  }

  /**
   * Check every limit for one inbound message, consuming a rate-limit token only if all daily checks pass.
   * `keys` pairs each key with the budget that applies to it (agent, role, principal, peer...).
   */
  admit(entries: readonly { key: string; budget: Budget }[]): BudgetCheck {
    for (const { key, budget } of entries) {
      const d = this.checkDaily(key, budget);
      if (!d.ok) return d;
    }
    const taken: string[] = [];
    for (const { key, budget } of entries) {
      const r = this.takeMessage(key, budget);
      if (!r.ok) {
        for (const k of taken) this.refund(k);
        return r;
      }
      if (budget.messagesPerMinute) taken.push(key);
    }
    return { ok: true };
  }

  private refund(key: string): void {
    const b = this.buckets.get(key);
    if (b) b.tokens = Math.min(b.capacity, b.tokens + 1);
  }

  /**
   * Record spend against a key; returns the alert thresholds crossed by this delta (80%/100%).
   */
  record(key: string, delta: UsageDelta, budget: Budget = {}): ThresholdCrossing[] {
    const before = this.usage(key);
    const after: DailyUsage = {
      day: before.day,
      tokens: before.tokens + spend(delta.tokens),
      usd: before.usd + spend(delta.usd),
      minutes: before.minutes + spend(delta.minutes),
    };
    this.daily.set(key, after);
    const out: ThresholdCrossing[] = [];
    const cross = (metric: 'usd' | 'tokens', limit: number | undefined) => {
      if (!limit) return;
      for (const t of ALERT_THRESHOLDS) {
        if (before[metric] < limit * t && after[metric] >= limit * t)
          out.push({ key, metric, threshold: t, used: after[metric], limit });
      }
    };
    cross('usd', budget.dailyUsd);
    cross('tokens', budget.dailyTokens);
    return out;
  }

  /** Drop all state (e.g. after `beamhop resume`). */
  reset(): void {
    this.buckets.clear();
    this.daily.clear();
  }
}
