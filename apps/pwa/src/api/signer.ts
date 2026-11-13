/**
 * Signers for hosted mode (PLAN §9 Hosting): the hosted PWA talks to daemons as one Nostr key.
 *
 *  - **device key** (default): generated on this device, kept in IndexedDB (device-key.ts). It signs and
 *    encrypts locally through `createControlClient` from `@beamhop/channel-nostr`.
 *  - **NIP-07** (`window.nostr` browser extension): the extension holds the key; we ask it to sign and to
 *    NIP-44 encrypt/decrypt every control event (signer-client.ts).
 *  - **NIP-46** bunker: interface only for now (see `nip46Signer`).
 *
 * Browser-safe: no node-only imports.
 */
import type { EventTemplate, VerifiedEvent } from 'nostr-tools/core';

/** Minimal signer covering NIP-07 extensions and NIP-46 bunkers. All keys are hex. */
export interface NostrSigner {
  getPublicKey(): Promise<string>;
  /** NIP-44 v2 encrypt to `peerPubkey`. */
  encrypt(peerPubkey: string, plaintext: string): Promise<string>;
  /** NIP-44 v2 decrypt from `peerPubkey`. */
  decrypt(peerPubkey: string, ciphertext: string): Promise<string>;
  signEvent(event: EventTemplate): Promise<VerifiedEvent>;
}

export type SignerKind = 'device' | 'nip07' | 'nip46';

/** The NIP-07 surface we use (`window.nostr`). nip44 is required: the control plane is NIP-44 only. */
export interface Nip07Provider {
  getPublicKey(): Promise<string>;
  signEvent(event: EventTemplate): Promise<VerifiedEvent>;
  nip44?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>;
    decrypt(pubkey: string, ciphertext: string): Promise<string>;
  };
}

const nip07Provider = (): Nip07Provider | undefined =>
  typeof window === 'undefined' ? undefined : (window as { nostr?: Nip07Provider }).nostr;

/** True when a NIP-07 extension with NIP-44 support is installed (show "Use my Nostr extension" first). */
export const hasNip07 = (provider: Nip07Provider | undefined = nip07Provider()): boolean =>
  !!provider && typeof provider.getPublicKey === 'function' && !!provider.nip44;

export class SignerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignerUnavailableError';
  }
}

/**
 * Wrap a NIP-07 extension. Extensions usually prompt the user on first use; some prompt for every
 * event, which makes hosted mode chatty — the device key is the recommended default.
 */
export const nip07Signer = (provider: Nip07Provider | undefined = nip07Provider()): NostrSigner => {
  if (!provider) throw new SignerUnavailableError('No Nostr browser extension (NIP-07) found.');
  if (!provider.nip44)
    throw new SignerUnavailableError('Your Nostr extension does not support NIP-44 encryption.');
  const nip44 = provider.nip44;
  return {
    getPublicKey: () => provider.getPublicKey(),
    encrypt: (peer, text) => nip44.encrypt(peer, text),
    decrypt: (peer, ct) => nip44.decrypt(peer, ct),
    signEvent: (ev) => provider.signEvent(ev),
  };
};

/** Parsed `bunker://<remote-signer-pubkey>?relay=wss://…&secret=…` URL. */
export interface BunkerPointer {
  pubkey: string;
  relays: string[];
  /** One-time connect secret. Never log it. */
  secret?: string;
}

/** Validate a NIP-46 bunker URL (the Pair screen's `bunker://…` field). Throws on bad input. */
export const parseBunkerUrl = (input: string): BunkerPointer => {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error('Not a bunker URL (expected bunker://…)');
  }
  if (url.protocol !== 'bunker:') throw new Error('Not a bunker URL (expected bunker://…)');
  const pubkey = (url.hostname || url.pathname.replace(/^\/+/, '')).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(pubkey)) throw new Error('The bunker URL has no valid signer key');
  const relays = url.searchParams.getAll('relay').filter((r) => /^wss?:\/\/\S+$/i.test(r));
  if (!relays.length) throw new Error('The bunker URL lists no relay');
  const secret = url.searchParams.get('secret') ?? undefined;
  return { pubkey, relays, ...(secret ? { secret } : {}) };
};

/**
 * NIP-46 remote signer ("bunker") — interface is ready, implementation is not.
 *
 * TODO(hosted/nip46): implement with `BunkerSigner` from `nostr-tools/nip46`: generate a local client key
 * (device-key.ts store, separate record), `BunkerSigner.fromBunker(clientKey, pointer, { pool })`,
 * `await connect()`, then map `nip44Encrypt`/`nip44Decrypt`/`signEvent`/`getPublicKey` onto NostrSigner.
 * Persist the pointer (without the one-time secret) on the SavedDaemon so the bunker is reused at boot.
 */
export const nip46Signer = (pointer: BunkerPointer): NostrSigner => {
  void pointer;
  throw new SignerUnavailableError('Signing in with a NIP-46 bunker is not available yet.');
};
