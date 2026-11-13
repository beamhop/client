// Browser-compatible. Strict NIP-17 / NIP-59 unwrapping.
import type { Event } from 'nostr-tools/core';
import * as nip44 from 'nostr-tools/nip44';
import { getEventHash, verifyEvent } from 'nostr-tools/pure';

/** An unsigned NIP-59 rumor whose author and id have been checked. */
export interface Rumor {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
/** Gift wraps above this size are refused before decryption (NIP-44 frames are ≤ 64 KiB). */
const MAX_WRAP_CONTENT = 200_000;

const isTags = (t: unknown): t is string[][] =>
  Array.isArray(t) && t.every((x) => Array.isArray(x) && x.every((y) => typeof y === 'string'));

const parseJson = (s: string, what: string): Record<string, unknown> => {
  const v: unknown = JSON.parse(s);
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${what} is not an object`);
  return v as Record<string, unknown>;
};

/**
 * Unwrap a kind-1059 gift wrap addressed to `sk`, enforcing everything the sender's identity rests
 * on, independently of the nostr-tools version in use:
 *  - the seal (kind 13) carries a valid signature;
 *  - the rumor's `pubkey` equals the seal's signer (otherwise anyone could seal a rumor that claims
 *    to be from the owner);
 *  - the rumor's `id` is the hash of its content (otherwise a sender could reuse someone else's
 *    event id and poison dedupe so that a real message is dropped);
 *  - every field has the expected type.
 * Throws on any violation.
 */
export const unwrapGiftWrap = (wrap: Event, sk: Uint8Array): Rumor => {
  if (wrap.kind !== 1059) throw new Error(`not a gift wrap (kind ${wrap.kind})`);
  if (typeof wrap.content !== 'string' || wrap.content.length > MAX_WRAP_CONTENT)
    throw new Error('gift wrap too large');
  const seal = parseJson(
    nip44.v2.decrypt(wrap.content, nip44.v2.utils.getConversationKey(sk, wrap.pubkey)),
    'seal',
  );
  if (seal.kind !== 13) throw new Error(`unexpected seal kind ${String(seal.kind)}`);
  if (!verifyEvent(seal as unknown as Event)) throw new Error('seal signature is invalid');
  const sealer = seal.pubkey as string;
  const r = parseJson(
    nip44.v2.decrypt(seal.content as string, nip44.v2.utils.getConversationKey(sk, sealer)),
    'rumor',
  );
  if (
    typeof r.pubkey !== 'string' ||
    !HEX64.test(r.pubkey) ||
    typeof r.id !== 'string' ||
    typeof r.content !== 'string' ||
    typeof r.kind !== 'number' ||
    !Number.isInteger(r.kind) ||
    typeof r.created_at !== 'number' ||
    !Number.isSafeInteger(r.created_at) ||
    !isTags(r.tags)
  )
    throw new Error('malformed rumor');
  if (r.pubkey !== sealer) throw new Error('rumor author does not match seal signer');
  const rumor: Rumor = {
    id: r.id,
    pubkey: r.pubkey,
    created_at: r.created_at,
    kind: r.kind,
    tags: r.tags,
    content: r.content,
  };
  if (getEventHash(rumor) !== rumor.id) throw new Error('rumor id does not match its content');
  return rumor;
};
