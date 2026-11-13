// Browser-compatible: no node-only imports in this file.

import * as nip19 from 'nostr-tools/nip19';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';

export interface AgentKey {
  /** 32-byte secret key. Never log this. */
  secretKey: Uint8Array;
  /** hex public key */
  pubkey: string;
  npub: string;
  /** bech32 secret. Never log this. */
  nsec: string;
}

const HEX64 = /^[0-9a-f]{64}$/i;

/** Generate a fresh agent keypair. */
export const generateAgentKey = (): AgentKey => keyFromSecret(generateSecretKey());

export const keyFromSecret = (secretKey: Uint8Array): AgentKey => {
  const pubkey = getPublicKey(secretKey);
  return { secretKey, pubkey, npub: nip19.npubEncode(pubkey), nsec: nip19.nsecEncode(secretKey) };
};

/** Accept an `nsec1…` string, 64-char hex, or raw bytes. Throws on anything else. */
export const decodeSecretKey = (key: string | Uint8Array): Uint8Array => {
  if (key instanceof Uint8Array) {
    if (key.length !== 32) throw new Error('secret key must be 32 bytes');
    return key;
  }
  const k = key.trim();
  if (k.startsWith('nsec1')) {
    const d = nip19.decode(k);
    if (d.type !== 'nsec') throw new Error('not an nsec');
    return d.data;
  }
  if (HEX64.test(k)) return hexToBytes(k.toLowerCase());
  throw new Error('invalid secret key (expected nsec1… or 64-char hex)');
};

/** Accept `npub1…`, `nprofile1…`, `nostr:` URIs or 64-char hex; returns lowercase hex. */
export const decodePubkey = (key: string): string => {
  let k = key.trim();
  if (k.startsWith('nostr:')) k = k.slice(6);
  if (HEX64.test(k)) return k.toLowerCase();
  if (k.startsWith('npub1') || k.startsWith('nprofile1')) {
    const d = nip19.decode(k);
    if (d.type === 'npub') return d.data;
    if (d.type === 'nprofile') return d.data.pubkey;
  }
  throw new Error('invalid public key (expected npub1… or 64-char hex)');
};

export const tryDecodePubkey = (key: string): string | undefined => {
  try {
    return decodePubkey(key);
  } catch {
    return undefined;
  }
};

export const npubEncode = (pubkeyHex: string): string => nip19.npubEncode(pubkeyHex);
export const nsecEncode = (secretKey: Uint8Array): string => nip19.nsecEncode(secretKey);
export const secretKeyToHex = (secretKey: Uint8Array): string => bytesToHex(secretKey);
export const pubkeyOf = (secretKey: Uint8Array): string => getPublicKey(secretKey);
