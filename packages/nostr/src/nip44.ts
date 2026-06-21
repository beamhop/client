import { nip44 } from "nostr-tools";
import type { Identity } from "./keys.ts";

export const encrypt = async (plaintext: string, identity: Identity): Promise<string> => {
  if (identity.kind === "local") {
    const conversationKey = nip44.getConversationKey(identity.secretKey, identity.pubkey);
    return nip44.encrypt(plaintext, conversationKey);
  }
  if (!window.nostr?.nip44) {
    throw new Error(
      "NIP-07 extension does not support NIP-44. Please use an extension that supports NIP-44 (e.g. Alby, nos2x).",
    );
  }
  return window.nostr.nip44.encrypt(identity.pubkey, plaintext);
};

export const decrypt = async (ciphertext: string, identity: Identity): Promise<string> => {
  if (identity.kind === "local") {
    const conversationKey = nip44.getConversationKey(identity.secretKey, identity.pubkey);
    return nip44.decrypt(ciphertext, conversationKey);
  }
  if (!window.nostr?.nip44) {
    throw new Error(
      "NIP-07 extension does not support NIP-44. Please use an extension that supports NIP-44 (e.g. Alby, nos2x).",
    );
  }
  return window.nostr.nip44.decrypt(identity.pubkey, ciphertext);
};
