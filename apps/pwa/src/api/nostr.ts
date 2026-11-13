/**
 * Hosted-mode transport placeholder (PLAN §9 Hosting): the hosted PWA reaches daemons over encrypted
 * Nostr control events instead of the localhost WebSocket. Interface only — implementation lands with
 * the channel-nostr control plane. Screens never import this directly; they use the hooks.
 */
import type { Transport } from '@beamhop/client';

/** Minimal signer abstraction covering NIP-07 extensions, NIP-46 bunkers and paired device keys. */
export interface NostrSigner {
  getPublicKey(): Promise<string>;
  /** NIP-44 encrypt/decrypt to the daemon's pubkey. */
  encrypt(peerPubkey: string, plaintext: string): Promise<string>;
  decrypt(peerPubkey: string, ciphertext: string): Promise<string>;
  signEvent<T extends { kind: number; content: string; tags: string[][]; created_at: number }>(
    event: T,
  ): Promise<T & { id: string; pubkey: string; sig: string }>;
}

export interface NostrControlOptions {
  /** Relays to publish control requests to and subscribe for responses/events. */
  relays: string[];
  /** The daemon's control pubkey (hex), learned during device pairing. */
  daemonPubkey: string;
  signer: NostrSigner;
  /** Per-request timeout before failing with RpcError(-32011 timeout). */
  timeoutMs?: number;
  onStatus?: (s: 'connecting' | 'open' | 'closed', relaysUp: number) => void;
}

export interface NostrControlTransport extends Transport {
  /** Connected relays / configured relays — feeds the connection pill. */
  relayHealth(): { up: number; total: number };
}

export const nostrControlTransport = (_opts: NostrControlOptions): NostrControlTransport => {
  throw new Error('Nostr control transport is not implemented yet (hosted mode).');
};
