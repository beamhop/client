import { finalizeEvent } from 'nostr-tools/pure';
import * as nip44 from 'nostr-tools/nip44';
import type { KeyPair } from './keys.js';
import type { NostrEvent, NostrEventTemplate, Pubkey } from './types.js';

/**
 * Abstracts over how events are signed and how NIP-44 payloads are
 * encrypted/decrypted, so the rest of the app does not care whether the
 * key lives in memory (LocalSigner) or in a browser extension (Nip07Signer).
 */
export interface Signer {
  /** Hex public key of the signing identity. */
  getPublicKey(): Promise<Pubkey>;
  /** Sign an event template, producing a fully-formed signed event. */
  signEvent(template: NostrEventTemplate): Promise<NostrEvent>;
  /** Encrypt `plaintext` to `peerPubkey` using NIP-44 v2. */
  nip44Encrypt(peerPubkey: Pubkey, plaintext: string): Promise<string>;
  /** Decrypt a NIP-44 payload received from `peerPubkey`. */
  nip44Decrypt(peerPubkey: Pubkey, ciphertext: string): Promise<string>;
}

/** A Signer backed by an in-memory secret key. */
export class LocalSigner implements Signer {
  readonly #secretKey: Uint8Array;
  readonly #publicKey: Pubkey;

  constructor(keyPair: KeyPair) {
    this.#secretKey = keyPair.secretKey;
    this.#publicKey = keyPair.publicKey;
  }

  /** The underlying secret key. Treat as sensitive — never log or transmit. */
  get secretKey(): Uint8Array {
    return this.#secretKey;
  }

  getPublicKey(): Promise<Pubkey> {
    return Promise.resolve(this.#publicKey);
  }

  signEvent(template: NostrEventTemplate): Promise<NostrEvent> {
    return Promise.resolve(finalizeEvent(template, this.#secretKey));
  }

  nip44Encrypt(peerPubkey: Pubkey, plaintext: string): Promise<string> {
    const conversationKey = nip44.getConversationKey(this.#secretKey, peerPubkey);
    return Promise.resolve(nip44.encrypt(plaintext, conversationKey));
  }

  nip44Decrypt(peerPubkey: Pubkey, ciphertext: string): Promise<string> {
    const conversationKey = nip44.getConversationKey(this.#secretKey, peerPubkey);
    return Promise.resolve(nip44.decrypt(ciphertext, conversationKey));
  }
}

/** The subset of the NIP-07 `window.nostr` API that Verity relies on. */
export interface Nip07Provider {
  getPublicKey(): Promise<Pubkey>;
  signEvent(template: NostrEventTemplate): Promise<NostrEvent>;
  nip44?: {
    encrypt(peerPubkey: Pubkey, plaintext: string): Promise<string>;
    decrypt(peerPubkey: Pubkey, ciphertext: string): Promise<string>;
  };
}

/** A Signer backed by a NIP-07 browser extension (`window.nostr`). */
export class Nip07Signer implements Signer {
  readonly #provider: Nip07Provider;

  constructor(provider: Nip07Provider) {
    this.#provider = provider;
  }

  getPublicKey(): Promise<Pubkey> {
    return this.#provider.getPublicKey();
  }

  signEvent(template: NostrEventTemplate): Promise<NostrEvent> {
    return this.#provider.signEvent(template);
  }

  nip44Encrypt(peerPubkey: Pubkey, plaintext: string): Promise<string> {
    if (!this.#provider.nip44) {
      throw new Error('The connected signer does not support NIP-44 encryption');
    }
    return this.#provider.nip44.encrypt(peerPubkey, plaintext);
  }

  nip44Decrypt(peerPubkey: Pubkey, ciphertext: string): Promise<string> {
    if (!this.#provider.nip44) {
      throw new Error('The connected signer does not support NIP-44 decryption');
    }
    return this.#provider.nip44.decrypt(peerPubkey, ciphertext);
  }
}

/** Read the injected NIP-07 provider if present in the current environment. */
export function detectNip07(): Nip07Provider | undefined {
  const candidate = (globalThis as { nostr?: Nip07Provider }).nostr;
  return candidate;
}
