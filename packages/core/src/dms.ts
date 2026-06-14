import { finalizeEvent, generateSecretKey, getPublicKey, getEventHash } from 'nostr-tools/pure';
import * as nip44 from 'nostr-tools/nip44';
import { Kind } from './types.js';
import { now } from './events.js';
import type { Signer } from './signer.js';
import type { DirectMessage, NostrEvent, NostrEventTemplate, Pubkey } from './types.js';

const TWO_DAYS = 2 * 24 * 60 * 60;

/** Randomize a timestamp up to two days in the past, per NIP-17 guidance. */
function randomizedTimestamp(): number {
  return now() - Math.floor(Math.random() * TWO_DAYS);
}

/** An unsigned NIP-17 rumor (kind 14). */
interface Rumor extends NostrEventTemplate {
  pubkey: Pubkey;
  id: string;
}

function buildRumor(sender: Pubkey, recipients: readonly Pubkey[], content: string, subject?: string): Rumor {
  const tags: string[][] = recipients.map((pk) => ['p', pk]);
  if (subject) tags.push(['subject', subject]);
  const base = { kind: Kind.DirectMessage, created_at: now(), tags, content, pubkey: sender };
  return { ...base, id: getEventHash(base) };
}

/**
 * Produce a NIP-17 gift wrap (kind 1059) addressed to `recipient` that carries
 * a direct message from the signer. Works with any Signer because the inner
 * seal is encrypted/signed by the signer while the outer wrap uses a throwaway
 * ephemeral key generated here.
 */
export async function createGiftWrap(
  signer: Signer,
  recipient: Pubkey,
  rumor: Rumor,
): Promise<NostrEvent> {
  const sender = await signer.getPublicKey();

  // Seal (kind 13): encrypt rumor sender -> recipient, signed by sender.
  const sealedContent = await signer.nip44Encrypt(recipient, JSON.stringify(rumor));
  const seal = await signer.signEvent({
    kind: Kind.Seal,
    created_at: randomizedTimestamp(),
    tags: [],
    content: sealedContent,
  });
  // Guard: a seal must be authored by the message sender.
  if (seal.pubkey !== sender) {
    throw new Error('Seal author does not match sender');
  }

  // Gift wrap (kind 1059): encrypt seal ephemeral -> recipient, signed by ephemeral.
  const ephemeralKey = generateSecretKey();
  const conversationKey = nip44.getConversationKey(ephemeralKey, recipient);
  const wrappedContent = nip44.encrypt(JSON.stringify(seal), conversationKey);
  return finalizeEvent(
    {
      kind: Kind.GiftWrap,
      created_at: randomizedTimestamp(),
      tags: [['p', recipient]],
      content: wrappedContent,
    },
    ephemeralKey,
  );
}

export interface SealedDirectMessage {
  /** Stable id of the inner rumor — the id every decrypted copy will carry. */
  readonly rumorId: string;
  /** Gift wraps to publish (one per recipient plus one for the sender). */
  readonly wraps: readonly NostrEvent[];
}

/**
 * Build the gift wraps needed to send a direct message: one for each recipient
 * and one for the sender's own copy (so messages appear in both inboxes). The
 * returned `rumorId` matches what `openGiftWrap` produces, enabling dedup
 * between an optimistic local copy and the relay echo.
 */
export async function sealDirectMessage(
  signer: Signer,
  recipients: readonly Pubkey[],
  content: string,
  subject?: string,
): Promise<SealedDirectMessage> {
  const sender = await signer.getPublicKey();
  const rumor = buildRumor(sender, recipients, content, subject);

  // Deliver a wrap to each recipient plus one to ourselves for our own history.
  const targets = [...new Set([...recipients, sender])];
  const wraps = await Promise.all(targets.map((target) => createGiftWrap(signer, target, rumor)));
  return { rumorId: rumor.id, wraps };
}

/**
 * Decrypt a kind 1059 gift wrap addressed to the signer into a DirectMessage.
 * Returns null if the wrap is malformed or fails authenticity checks.
 */
export async function openGiftWrap(signer: Signer, giftWrap: NostrEvent): Promise<DirectMessage | null> {
  if (giftWrap.kind !== Kind.GiftWrap) return null;
  try {
    const sealJson = await signer.nip44Decrypt(giftWrap.pubkey, giftWrap.content);
    const seal = JSON.parse(sealJson) as NostrEvent;
    if (seal.kind !== Kind.Seal) return null;

    const rumorJson = await signer.nip44Decrypt(seal.pubkey, seal.content);
    const rumor = JSON.parse(rumorJson) as Rumor;
    if (rumor.kind !== Kind.DirectMessage) return null;

    // Authenticity: the rumor must be authored by whoever sealed it.
    if (rumor.pubkey !== seal.pubkey) return null;

    const to = rumor.tags.filter((t) => t[0] === 'p' && typeof t[1] === 'string').map((t) => t[1] as Pubkey);
    return {
      id: rumor.id,
      from: rumor.pubkey,
      to,
      content: rumor.content,
      createdAt: rumor.created_at,
      wrapId: giftWrap.id,
      legacy: false,
    };
  } catch {
    return null;
  }
}

/**
 * Decrypt a legacy (kind 4) encrypted direct message into a DirectMessage.
 * These use an older, less-secure scheme; we read them for interop but flag
 * them via `legacy: true`. `self` is the viewer, used to pick the counterparty.
 * Returns null if the event isn't a legacy DM or can't be decrypted.
 */
export async function openLegacyDm(signer: Signer, event: NostrEvent, self: Pubkey): Promise<DirectMessage | null> {
  if (event.kind !== Kind.LegacyDirectMessage) return null;
  try {
    const recipient = event.tags.find((t) => t[0] === 'p' && typeof t[1] === 'string')?.[1];
    // The counterparty is the author when we received it, else the p-tag target.
    const peer = event.pubkey === self ? recipient : event.pubkey;
    if (!peer) return null;
    const content = await signer.legacyDecrypt(peer, event.content);
    return {
      id: event.id,
      from: event.pubkey,
      to: recipient ? [recipient] : [],
      content,
      createdAt: event.created_at,
      wrapId: event.id,
      legacy: true,
    };
  } catch {
    return null;
  }
}

/** The other participant in a 1:1 conversation, given the viewer's pubkey. */
export function conversationPeer(message: DirectMessage, self: Pubkey): Pubkey {
  if (message.from !== self) return message.from;
  return message.to.find((pk) => pk !== self) ?? message.from;
}
