import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import type { Pubkey } from './types.js';

/** A Nostr identity: a secret key and its derived public key. */
export interface KeyPair {
  readonly secretKey: Uint8Array;
  readonly publicKey: Pubkey;
}

/** Generate a fresh random identity. */
export function generateKeyPair(): KeyPair {
  const secretKey = generateSecretKey();
  return { secretKey, publicKey: getPublicKey(secretKey) };
}

/** Derive the public key (hex) from a secret key. */
export function publicKeyFromSecret(secretKey: Uint8Array): Pubkey {
  return getPublicKey(secretKey);
}

/** Encode a secret key as an `nsec1…` bech32 string. */
export function encodeNsec(secretKey: Uint8Array): string {
  return nip19.nsecEncode(secretKey);
}

/** Encode a public key as an `npub1…` bech32 string. */
export function encodeNpub(publicKey: Pubkey): string {
  return nip19.npubEncode(publicKey);
}

/** Parse an `nsec1…` string into a key pair. Throws on malformed input. */
export function keyPairFromNsec(nsec: string): KeyPair {
  const decoded = nip19.decode(nsec.trim());
  if (decoded.type !== 'nsec') {
    throw new Error(`Expected an nsec key, received "${decoded.type}"`);
  }
  const secretKey = decoded.data;
  return { secretKey, publicKey: getPublicKey(secretKey) };
}

/** Parse an `npub1…` string into a hex public key. Throws on malformed input. */
export function pubkeyFromNpub(npub: string): Pubkey {
  const decoded = nip19.decode(npub.trim());
  if (decoded.type !== 'npub') {
    throw new Error(`Expected an npub key, received "${decoded.type}"`);
  }
  return decoded.data;
}

/**
 * Accept either an `npub1…` or a 64-char hex pubkey and normalize to hex.
 * Useful for user-facing inputs where either form may be pasted.
 */
export function normalizePubkey(input: string): Pubkey {
  const value = input.trim();
  if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
  if (value.startsWith('npub1')) return pubkeyFromNpub(value);
  if (value.startsWith('nprofile1')) {
    const decoded = nip19.decode(value);
    if (decoded.type === 'nprofile') return decoded.data.pubkey;
  }
  throw new Error(`Cannot interpret "${input}" as a public key`);
}

/** Resolve an `npub1…`/`nprofile1…` token to a hex pubkey, or null. */
export function pubkeyFromBech32(token: string): Pubkey | null {
  try {
    const decoded = nip19.decode(token);
    if (decoded.type === 'npub') return decoded.data;
    if (decoded.type === 'nprofile') return decoded.data.pubkey;
  } catch {
    // ignore
  }
  return null;
}

/** Encode an event id as a `note1…` bech32 string. */
export function encodeNote(eventId: string): string {
  return nip19.noteEncode(eventId);
}

/** Encode an event id (with optional author/relay hints) as an `nevent1…` string. */
export function encodeNevent(eventId: string, author?: Pubkey, relays?: readonly string[]): string {
  return nip19.neventEncode({
    id: eventId,
    ...(author ? { author } : {}),
    ...(relays && relays.length > 0 ? { relays: [...relays] } : {}),
  });
}

/** Resolve a `note1…`/`nevent1…` token, or a 64-char hex id, to a hex event id, or null. */
export function eventIdFromBech32(token: string): string | null {
  const value = token.trim();
  if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
  try {
    const decoded = nip19.decode(value);
    if (decoded.type === 'note') return decoded.data;
    if (decoded.type === 'nevent') return decoded.data.id;
  } catch {
    // ignore malformed input
  }
  return null;
}

/** Encode the secret key bytes as lowercase hex. */
export function secretKeyToHex(secretKey: Uint8Array): string {
  return Array.from(secretKey, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Decode a 64-char hex secret key into bytes. */
export function secretKeyFromHex(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) {
    throw new Error('Secret key must be 64 hex characters');
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
