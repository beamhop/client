import { nip04 } from "nostr-tools";
import type { Event as NostrEvent, EventTemplate } from "nostr-tools";
import type { Identity } from "./keys.ts";
import { Kind, type DirectMessage } from "./types.ts";
import { nowSeconds } from "./client.ts";

/**
 * NIP-04 encrypted DMs. When a NIP-07 signer exposes nip04 we defer to it so the
 * secret key never leaves the extension; otherwise we encrypt locally.
 */
export const encryptDm = async (
  identity: Identity,
  peerPubkey: string,
  plaintext: string,
): Promise<string> => {
  if (identity.kind === "nip07") {
    if (!window.nostr?.nip04) throw new Error("Signer cannot encrypt DMs");
    return window.nostr.nip04.encrypt(peerPubkey, plaintext);
  }
  return nip04.encrypt(identity.secretKey, peerPubkey, plaintext);
};

export const decryptDm = async (
  identity: Identity,
  peerPubkey: string,
  ciphertext: string,
): Promise<string> => {
  if (identity.kind === "nip07") {
    if (!window.nostr?.nip04) throw new Error("Signer cannot decrypt DMs");
    return window.nostr.nip04.decrypt(peerPubkey, ciphertext);
  }
  return nip04.decrypt(identity.secretKey, peerPubkey, ciphertext);
};

export const buildDm = (peerPubkey: string, ciphertext: string): EventTemplate => ({
  kind: Kind.EncryptedDM,
  created_at: nowSeconds(),
  tags: [["p", peerPubkey]],
  content: ciphertext,
});

/** The conversation partner for a DM event, relative to `me`. */
export const dmPeer = (event: NostrEvent, me: string): string | null => {
  if (event.pubkey === me) return event.tags.find((t) => t[0] === "p")?.[1] ?? null;
  const hasMe = event.tags.some((t) => t[0] === "p" && t[1] === me);
  return hasMe ? event.pubkey : null;
};

export const decodeDm = async (
  identity: Identity,
  me: string,
  event: NostrEvent,
): Promise<DirectMessage | null> => {
  const peer = dmPeer(event, me);
  if (!peer) return null;
  try {
    const content = await decryptDm(identity, peer, event.content);
    return {
      id: event.id,
      pubkey: peer,
      content,
      createdAt: event.created_at,
      fromMe: event.pubkey === me,
    };
  } catch {
    return null;
  }
};
