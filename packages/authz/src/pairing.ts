import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

/** No 0/O, 1/I/L, so codes survive being read aloud or typed on a phone. */
export const PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const PAIRING_CODE_LENGTH = 6;
export const PAIRING_TTL_MS = 10 * 60_000;
export const PAIRING_MAX_ATTEMPTS = 5;

export interface PairingCode {
  code: string;
  createdAt: string;
  expiresAt: string;
}

export interface PairingRecord {
  code: string;
  expiresAt: string;
  usedAt?: string;
  attempts?: number;
}

export const createPairingCode = (
  opts: { now?: number; ttlMs?: number; random?: (max: number) => number } = {},
): PairingCode => {
  const now = opts.now ?? Date.now();
  const rand = opts.random ?? ((max: number) => randomInt(max));
  let code = '';
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) code += PAIRING_ALPHABET[rand(PAIRING_ALPHABET.length)];
  return {
    code,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + (opts.ttlMs ?? PAIRING_TTL_MS)).toISOString(),
  };
};

/** Canonical form of user input: upper-case, separators and whitespace removed. */
export const normalizePairingCode = (input: string): string =>
  input
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[\s_-]+/g, '');

export const isWellFormedPairingCode = (code: string): boolean =>
  code.length === PAIRING_CODE_LENGTH && [...code].every((c) => PAIRING_ALPHABET.includes(c));

/** Constant-time string equality (hashes first so differing lengths don't leak either). */
export const constantTimeEqual = (a: string, b: string): boolean => {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
};

export type PairingVerification =
  | { ok: true }
  | { ok: false; reason: 'malformed' | 'expired' | 'used' | 'mismatch' | 'too_many_attempts' };

/** Verify user input against a stored code. Callers must increment `attempts` on every failure. */
export const verifyPairingCode = (
  input: string,
  record: PairingRecord,
  opts: { now?: number; maxAttempts?: number } = {},
): PairingVerification => {
  const now = opts.now ?? Date.now();
  if ((record.attempts ?? 0) >= (opts.maxAttempts ?? PAIRING_MAX_ATTEMPTS))
    return { ok: false, reason: 'too_many_attempts' };
  if (record.usedAt) return { ok: false, reason: 'used' };
  if (now >= Date.parse(record.expiresAt)) return { ok: false, reason: 'expired' };
  const given = normalizePairingCode(input);
  if (!isWellFormedPairingCode(given)) return { ok: false, reason: 'malformed' };
  return constantTimeEqual(given, normalizePairingCode(record.code))
    ? { ok: true }
    : { ok: false, reason: 'mismatch' };
};

export const PAIRING_FAIL_LIMIT = 5;
export const PAIRING_FAIL_GLOBAL_LIMIT = 20;
export const PAIRING_FAIL_WINDOW_MS = 10 * 60_000;

export type PairingLimit = { ok: true } | { ok: false; retryAfterMs: number; scope: 'sender' | 'global' };

/**
 * Brute-force guard for pairing codes. Codes are stored hashed and looked up by hash, so a wrong
 * guess cannot be charged to one code; instead failures are counted per sender and globally in a
 * sliding window. Once either limit is hit, every attempt (even a correct one) is refused until
 * the window moves on. With a 31^6 code space and 20 global failures per 10 minutes, guessing a
 * live code is out of reach.
 */
export class PairingLimiter {
  private readonly bySender = new Map<string, number[]>();
  private global: number[] = [];
  constructor(
    private readonly opts: {
      perSender?: number;
      global?: number;
      windowMs?: number;
      now?: () => number;
    } = {},
  ) {}

  private get windowMs(): number {
    return this.opts.windowMs ?? PAIRING_FAIL_WINDOW_MS;
  }
  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }
  private prune(list: number[]): number[] {
    const t = this.now();
    return list.filter((s) => t - s < this.windowMs);
  }

  /** May `sender` attempt a pairing now? */
  check(sender: string): PairingLimit {
    this.global = this.prune(this.global);
    const mine = this.prune(this.bySender.get(sender) ?? []);
    if (mine.length) this.bySender.set(sender, mine);
    else this.bySender.delete(sender);
    const retry = (list: number[]) => this.windowMs - (this.now() - (list[0] ?? this.now()));
    if (mine.length >= (this.opts.perSender ?? PAIRING_FAIL_LIMIT))
      return { ok: false, retryAfterMs: retry(mine), scope: 'sender' };
    if (this.global.length >= (this.opts.global ?? PAIRING_FAIL_GLOBAL_LIMIT))
      return { ok: false, retryAfterMs: retry(this.global), scope: 'global' };
    return { ok: true };
  }

  /** Record a failed attempt. */
  fail(sender: string): void {
    const t = this.now();
    this.global.push(t);
    const mine = this.bySender.get(sender) ?? [];
    mine.push(t);
    this.bySender.set(sender, mine);
    if (this.bySender.size > 10_000) this.bySender.delete(this.bySender.keys().next().value as string);
  }
}
