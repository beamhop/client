// Device pairing (§9 Hosting, JOURNEYS 9): QR payload, safety phrase and the phone-side helper.
// Browser-compatible: keep node-only imports out of this file and everything it imports
// (enforced by test/browser-safe.test.ts). The hosted PWA imports this module.
import type { Logger } from '@beamhop/core';
import { sha256 } from '@noble/hashes/sha2.js';
import { getPublicKey } from 'nostr-tools/pure';
import { hexToBytes } from 'nostr-tools/utils';
import { type ControlClient, createControlClient } from './control-client.ts';
import { decodePubkey, decodeSecretKey, npubEncode } from './keys.ts';
import type { RelayPool, WebSocketCtor } from './pool.ts';
import { WORDLIST } from './wordlist.ts';

/** The hosted PWA's pairing page. The payload goes in the fragment so it never reaches a server log. */
export const PAIR_URL_BASE = 'https://app.beamhop.dev/pair';
export const PAIR_DEEP_LINK_BASE = 'beamhop://pair';
export const SAFETY_PHRASE_WORDS = 4;
const PHRASE_DOMAIN = 'beamhop-pair-v1';
const MAX_PAYLOAD_CHARS = 4096;
const MAX_RELAYS = 8;

/** What the QR code carries: enough for a fresh phone to reach the daemon over Nostr. */
export interface PairingPayload {
  v: 1;
  /** Daemon control-plane pubkey (hex). */
  daemon: string;
  /** Relays the daemon listens on. */
  relays: string[];
  /** One-time pairing code. */
  code: string;
  /** Human name of the computer, e.g. "Alice's MacBook". */
  name?: string;
  /** Expiry, epoch seconds. */
  exp?: number;
}

// ───────────────────────────── base64url (no Buffer) ─────────────────────────────

const toB64u = (s: string): string => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromB64u = (s: string): string => {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('payload is not base64url');
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
};

const isRelayUrl = (u: unknown): u is string =>
  typeof u === 'string' && u.length < 256 && /^wss?:\/\/[^\s/]+[^\s]*$/i.test(u);

// ───────────────────────────── payload ─────────────────────────────

/** Compact base64url encoding of a pairing payload (short keys keep the QR code small). */
export const encodePairingPayload = (p: PairingPayload): string => {
  const daemon = decodePubkey(p.daemon);
  const relays = p.relays.filter(isRelayUrl).slice(0, MAX_RELAYS);
  if (!relays.length) throw new Error('pairing payload needs at least one relay');
  if (!p.code) throw new Error('pairing payload needs a code');
  const wire: Record<string, unknown> = { v: 1, d: daemon, r: relays, c: p.code };
  if (p.name) wire.n = p.name.slice(0, 80);
  if (p.exp) wire.e = p.exp;
  return toB64u(JSON.stringify(wire));
};

/** Decode a payload, a pairing URL (`…/pair#<payload>`) or a `beamhop://pair#<payload>` link. Throws on bad input. */
export const decodePairingPayload = (input: string): PairingPayload => {
  let s = input.trim();
  const hash = s.indexOf('#');
  if (hash >= 0) s = s.slice(hash + 1);
  if (!s || s.length > MAX_PAYLOAD_CHARS) throw new Error('invalid pairing payload');
  let wire: Record<string, unknown>;
  try {
    wire = JSON.parse(fromB64u(s)) as Record<string, unknown>;
  } catch {
    throw new Error('invalid pairing payload');
  }
  if (!wire || typeof wire !== 'object' || wire.v !== 1)
    throw new Error('unsupported pairing payload version');
  if (typeof wire.d !== 'string' || !/^[0-9a-f]{64}$/.test(wire.d)) throw new Error('invalid daemon key');
  if (!Array.isArray(wire.r) || !wire.r.length || wire.r.length > MAX_RELAYS || !wire.r.every(isRelayUrl))
    throw new Error('invalid relay list');
  if (typeof wire.c !== 'string' || !/^[A-Za-z0-9_-]{4,64}$/.test(wire.c)) throw new Error('invalid code');
  const out: PairingPayload = { v: 1, daemon: wire.d, relays: wire.r as string[], code: wire.c };
  if (typeof wire.n === 'string' && wire.n) out.name = wire.n.slice(0, 80);
  if (typeof wire.e === 'number' && Number.isFinite(wire.e)) out.exp = wire.e;
  return out;
};

export const pairingUrl = (p: PairingPayload | string, base = PAIR_URL_BASE): string =>
  `${base}#${typeof p === 'string' ? p : encodePairingPayload(p)}`;

export const pairingDeepLink = (p: PairingPayload | string): string => pairingUrl(p, PAIR_DEEP_LINK_BASE);

// ───────────────────────────── safety phrase ─────────────────────────────

/**
 * The 4-word safety phrase both sides show (JOURNEYS 9). Derived from the two pubkeys only, so it
 * is deterministic and symmetric: sha256("beamhop-pair-v1" ‖ min(a,b) ‖ max(a,b)), first 44 bits,
 * 11 bits per word from the fixed BIP-39 English list (2^44 possible phrases).
 */
export const safetyPhrase = (pubkeyA: string, pubkeyB: string): string[] => {
  const a = decodePubkey(pubkeyA);
  const b = decodePubkey(pubkeyB);
  if (a === b) throw new Error('safety phrase needs two different keys');
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const domain = new TextEncoder().encode(PHRASE_DOMAIN);
  const input = new Uint8Array(domain.length + 64);
  input.set(domain, 0);
  input.set(hexToBytes(lo), domain.length);
  input.set(hexToBytes(hi), domain.length + 32);
  const h = sha256(input);
  const words: string[] = [];
  for (let i = 0; i < SAFETY_PHRASE_WORDS; i++) {
    let idx = 0;
    for (let bit = i * 11; bit < i * 11 + 11; bit++) {
      const byte = h[bit >> 3] ?? 0;
      idx = (idx << 1) | ((byte >> (7 - (bit & 7))) & 1);
    }
    words.push(WORDLIST[idx]!);
  }
  return words;
};

/** "AMBER · RELAY · OTTER · NINE" */
export const formatSafetyPhrase = (words: readonly string[]): string =>
  words.map((w) => w.toUpperCase()).join(' · ');

// ───────────────────────────── phone side ─────────────────────────────

export interface CompletePairingOptions {
  /** Device name shown in Settings → Devices, e.g. "iPhone · Safari". */
  name: string;
  WebSocket?: WebSocketCtor;
  pool?: RelayPool;
  log?: Logger;
  timeoutMs?: number;
  /** Reuse an existing control client (it is not closed). */
  client?: ControlClient;
  /** Keep the created control client open and return it (default: close it). */
  keepOpen?: boolean;
  /** Seconds clock (tests). */
  now?: () => number;
}

export interface PairedDevice {
  id: string;
  name: string;
  pubkey: string;
  pairedAt: string;
  lastSeenAt?: string;
  pushEnabled: boolean;
}

export interface CompletePairingResult {
  device: PairedDevice;
  /** Same words the computer shows; the user compares them there. */
  safetyPhrase: string[];
  daemonPubkey: string;
  client?: ControlClient;
}

/**
 * Pair this device with a daemon (phone side): send `device.pairComplete` over the Nostr control
 * plane signed with the device key. The device key never leaves the device.
 */
export const completePairing = async (
  payload: PairingPayload | string,
  deviceKey: string | Uint8Array,
  opts: CompletePairingOptions,
): Promise<CompletePairingResult> => {
  const p = typeof payload === 'string' ? decodePairingPayload(payload) : payload;
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  if (p.exp && p.exp <= now()) throw new Error('this pairing code has expired; ask for a new one');
  const sk = decodeSecretKey(deviceKey);
  const pubkey = getPublicKey(sk);
  const phrase = safetyPhrase(p.daemon, pubkey);
  const client =
    opts.client ??
    createControlClient({
      key: sk,
      daemonPubkey: p.daemon,
      relays: p.relays,
      ...(opts.WebSocket ? { WebSocket: opts.WebSocket } : {}),
      ...(opts.pool ? { pool: opts.pool } : {}),
      ...(opts.log ? { log: opts.log } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    });
  try {
    await client.ready();
    const device = await client.call<PairedDevice>(
      'device.pairComplete',
      { code: p.code, pubkey: npubEncode(pubkey), name: opts.name },
      opts.timeoutMs,
    );
    return {
      device,
      safetyPhrase: phrase,
      daemonPubkey: p.daemon,
      ...(opts.keepOpen && !opts.client ? { client } : {}),
    };
  } finally {
    if (!opts.client && !opts.keepOpen) client.close();
  }
};
