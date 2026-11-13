// Control-plane wire format (§4). Browser-compatible: no node-only imports.
//
// Events are ephemeral kind 25910 ("beamhop rpc"), p-tagged to the recipient, content =
// NIP-44 v2 ciphertext of a JSON-RPC 2.0 message. Replies carry an `e` tag pointing at the request
// event. Payloads above one NIP-44 frame are split into chunks tagged ["m", msgId, index, total].
import type { Event, VerifiedEvent } from 'nostr-tools/core';
import * as nip44 from 'nostr-tools/nip44';
import { finalizeEvent } from 'nostr-tools/pure';
import { LruMap, SeenSet } from './lru.ts';
import { tagValue } from './tags.ts';

export const CONTROL_KIND = 25910;
/** Accepted clock skew / replay window, seconds. */
export const REPLAY_WINDOW_S = 120;
/** UTF-16 code units per chunk; ≤ 60 000 UTF-8 bytes, below NIP-44's 65 535-byte limit. */
const CHUNK_UNITS = 20_000;
export const MAX_CHUNKS = 64;
/** Reject ciphertexts above this size before attempting decryption. */
const MAX_CIPHERTEXT = 100_000;

const nowSec = () => Math.floor(Date.now() / 1000);

const randomHex = (bytes: number): string => {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
};

export const newRpcId = (): string => randomHex(12);

export const splitChunks = (s: string, size = CHUNK_UNITS): string[] => {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    let end = Math.min(s.length, i + size);
    const last = s.charCodeAt(end - 1);
    if (end < s.length && last >= 0xd800 && last <= 0xdbff) end--; // keep surrogate pairs together
    out.push(s.slice(i, end));
    i = end;
  }
  return out.length ? out : [''];
};

/** Build (and sign) the control event(s) carrying `payload` to `peerPubkey`. */
export const buildControlEvents = (
  secretKey: Uint8Array,
  peerPubkey: string,
  payload: unknown,
  opts: { replyTo?: string; createdAt?: number } = {},
): VerifiedEvent[] => {
  const json = JSON.stringify(payload);
  const chunks = splitChunks(json);
  if (chunks.length > MAX_CHUNKS) throw new Error(`control payload too large (${json.length} chars)`);
  const key = nip44.v2.utils.getConversationKey(secretKey, peerPubkey);
  const msgId = chunks.length > 1 ? randomHex(8) : undefined;
  const created_at = opts.createdAt ?? nowSec();
  return chunks.map((c, i) => {
    const tags: string[][] = [['p', peerPubkey]];
    if (opts.replyTo) tags.push(['e', opts.replyTo]);
    if (msgId) tags.push(['m', msgId, String(i), String(chunks.length)]);
    return finalizeEvent(
      { kind: CONTROL_KIND, created_at, tags, content: nip44.v2.encrypt(c, key) },
      secretKey,
    );
  });
};

/** Replay protection: unique event id + created_at within ±window of now. */
export class ReplayGuard {
  private readonly seen: SeenSet;
  constructor(
    max = 10_000,
    readonly windowS = REPLAY_WINDOW_S,
    private readonly now: () => number = nowSec,
  ) {
    this.seen = new SeenSet(max);
  }
  /** Returns a rejection reason, or undefined if the event is fresh. Records accepted ids. */
  check(ev: Pick<Event, 'id' | 'created_at'>): string | undefined {
    const skew = Math.abs(this.now() - ev.created_at);
    if (!Number.isFinite(skew) || skew > this.windowS) return 'stale';
    if (!this.seen.add(ev.id)) return 'replay';
    return undefined;
  }
}

interface Pending {
  parts: (string | undefined)[];
  got: number;
  firstAt: number;
}

/**
 * Decrypts control events and reassembles chunked messages.
 * Returns the full JSON text once complete, otherwise undefined.
 */
export class ControlDecoder {
  private readonly pending = new LruMap<string, Pending>(128);
  private readonly keys = new LruMap<string, Uint8Array>(256);
  constructor(private readonly secretKey: Uint8Array) {}

  private conversationKey(peer: string): Uint8Array {
    let k = this.keys.get(peer);
    if (!k) {
      k = nip44.v2.utils.getConversationKey(this.secretKey, peer);
      this.keys.set(peer, k);
    }
    return k;
  }

  /** Throws on bad ciphertext. */
  decode(ev: Event): string | undefined {
    if (ev.content.length > MAX_CIPHERTEXT) throw new Error('ciphertext too large');
    const text = nip44.v2.decrypt(ev.content, this.conversationKey(ev.pubkey));
    const m = ev.tags.find((t) => t[0] === 'm');
    if (!m) return text;
    const [, msgId, idxS, totalS] = m;
    const idx = Number(idxS);
    const total = Number(totalS);
    if (!msgId || !Number.isInteger(idx) || !Number.isInteger(total) || total < 1 || total > MAX_CHUNKS) {
      throw new Error('bad chunk tag');
    }
    if (idx < 0 || idx >= total) throw new Error('bad chunk index');
    const key = `${ev.pubkey}:${msgId}:${tagValue(ev.tags, 'e') ?? ''}`;
    let p = this.pending.get(key);
    if (!p) {
      p = { parts: new Array(total).fill(undefined), got: 0, firstAt: Date.now() };
      this.pending.set(key, p);
    }
    if (p.parts.length !== total) throw new Error('chunk total mismatch');
    if (p.parts[idx] === undefined) {
      p.parts[idx] = text;
      p.got++;
    }
    if (p.got < total) return undefined;
    this.pending.delete(key);
    return p.parts.join('');
  }
}
