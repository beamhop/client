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
  return constantTimeEqual(given, normalizePairingCode(record.code)) ? { ok: true } : { ok: false, reason: 'mismatch' };
};
