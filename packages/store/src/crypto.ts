import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { BeamhopError } from '@beamhop/core';

export const DATA_KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const PREFIX = 'e1:';

/** A fresh random 256-bit data key (the daemon stores it in the keychain). */
export const generateDataKey = (): Buffer => randomBytes(DATA_KEY_BYTES);

/** Parse a data key from base64 / base64url / hex. */
export const parseDataKey = (s: string): Buffer => {
  const t = s.trim();
  const buf = /^[0-9a-f]{64}$/i.test(t) ? Buffer.from(t, 'hex') : Buffer.from(t, 'base64');
  if (buf.length !== DATA_KEY_BYTES) throw new BeamhopError('invalid_input', 'data key must be 32 bytes');
  return buf;
};

export const encodeDataKey = (key: Uint8Array): string => Buffer.from(key).toString('base64');

/**
 * AES-256-GCM column encryption. Ciphertext format: "e1:" + base64(iv | tag | ciphertext).
 * Each value is bound to its column (`scope`, e.g. "session_events.text") via AAD,
 * so ciphertext can't be swapped between columns.
 */
export class DataCipher {
  private readonly key: Buffer;

  constructor(key: Uint8Array) {
    if (!key || key.length !== DATA_KEY_BYTES)
      throw new BeamhopError('invalid_input', `data key must be ${DATA_KEY_BYTES} bytes`);
    this.key = Buffer.from(key);
  }

  encrypt(scope: string, plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(`beamhop:${scope}`, 'utf8'));
    const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
    return PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
  }

  decrypt(scope: string, value: string): string {
    if (!value.startsWith(PREFIX)) throw new BeamhopError('internal', `unencrypted value in ${scope}`);
    const raw = Buffer.from(value.slice(PREFIX.length), 'base64');
    if (raw.length < IV_BYTES + TAG_BYTES) throw new BeamhopError('internal', `corrupt value in ${scope}`);
    const d = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, IV_BYTES));
    d.setAAD(Buffer.from(`beamhop:${scope}`, 'utf8'));
    d.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    try {
      return Buffer.concat([d.update(raw.subarray(IV_BYTES + TAG_BYTES)), d.final()]).toString('utf8');
    } catch {
      throw new BeamhopError('unauthorized', `cannot decrypt ${scope}: wrong data key or tampered data`);
    }
  }

  encryptOpt(scope: string, v: string | undefined | null): string | null {
    return v == null ? null : this.encrypt(scope, v);
  }

  decryptOpt(scope: string, v: unknown): string | undefined {
    return typeof v === 'string' ? this.decrypt(scope, v) : undefined;
  }

  encryptJson(scope: string, v: unknown): string | null {
    return v === undefined ? null : this.encrypt(scope, JSON.stringify(v));
  }

  decryptJson<T = unknown>(scope: string, v: unknown): T | undefined {
    return typeof v === 'string' ? (JSON.parse(this.decrypt(scope, v)) as T) : undefined;
  }
}
