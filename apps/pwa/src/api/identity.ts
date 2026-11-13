/**
 * Hosted identity = "which key talks to the daemon" (device key, NIP-07 or NIP-46) plus a factory for a
 * control-plane client signed by it. The transport (nostr.ts) and pairing (pairing.ts) only use this.
 */
import type { RelayPool } from '@beamhop/channel-nostr';
import { type ControlClient, createControlClient } from '@beamhop/channel-nostr/control-client';
import { npubEncode } from '@beamhop/channel-nostr/keys';
import { type DeviceKey, type KeyStore, loadOrCreateDeviceKey } from './device-key.ts';
import { type NostrSigner, nip07Signer, type SignerKind, SignerUnavailableError } from './signer.ts';
import { createSignerControlClient } from './signer-client.ts';

export interface ConnectOptions {
  daemonPubkey: string;
  relays: string[];
  pool: RelayPool;
  timeoutMs?: number;
}

export interface HostedIdentity {
  kind: SignerKind;
  /** hex */
  pubkey: string;
  npub: string;
  /** Device keys only: lets pairing use `completePairing` from channel-nostr. Never log it. */
  secretKey?: Uint8Array;
  connect(o: ConnectOptions): ControlClient;
}

export const deviceIdentity = (key: DeviceKey): HostedIdentity => ({
  kind: 'device',
  pubkey: key.pubkey,
  npub: key.npub,
  secretKey: key.secretKey,
  connect: (o) =>
    createControlClient({
      key: key.secretKey,
      daemonPubkey: o.daemonPubkey,
      relays: o.relays,
      pool: o.pool,
      ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
    }),
});

export const signerIdentity = async (signer: NostrSigner, kind: SignerKind): Promise<HostedIdentity> => {
  const pubkey = (await signer.getPublicKey()).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(pubkey)) throw new SignerUnavailableError('The signer returned an invalid key.');
  return {
    kind,
    pubkey,
    npub: npubEncode(pubkey),
    connect: (o) =>
      createSignerControlClient({
        signer,
        pubkey,
        daemonPubkey: o.daemonPubkey,
        relays: o.relays,
        pool: o.pool,
        ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
      }),
  };
};

/** Resolve the identity for a saved daemon / a pairing (device key by default). */
export const resolveIdentity = async (
  kind: SignerKind = 'device',
  opts: { keyStore?: KeyStore; signer?: NostrSigner } = {},
): Promise<HostedIdentity> => {
  if (opts.signer) return signerIdentity(opts.signer, kind);
  if (kind === 'device') return deviceIdentity(await loadOrCreateDeviceKey(opts.keyStore));
  if (kind === 'nip07') return signerIdentity(nip07Signer(), 'nip07');
  // TODO(hosted/nip46): restore the bunker from the saved daemon (see signer.ts nip46Signer).
  throw new SignerUnavailableError('Signing in with a NIP-46 bunker is not available yet.');
};
