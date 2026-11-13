/**
 * Hosted mode (Nostr control plane) API for screens: pairing, saved daemons, this device's key, signers.
 * Separate from `api/index.ts` on purpose: importing it from a lazy screen keeps nostr-tools and the
 * pairing word list out of the main chunk. (`useDaemons` & co. are also re-exported from index.ts.)
 *
 *   import { usePairing, useDaemons, useDeviceIdentity } from '../../api/hosted.ts';
 */
export {
  getActiveDaemon,
  listDaemons,
  removeDaemon,
  renameDaemon,
  type SavedDaemon,
  saveDaemon,
  setActiveDaemon,
  type UseDaemons,
  useDaemons,
} from './daemons.ts';
export {
  type DeviceKey,
  defaultKeyStore,
  forgetDeviceKey,
  getDeviceKey,
  idbKeyStore,
  type KeyStore,
  loadOrCreateDeviceKey,
  memoryKeyStore,
} from './device-key.ts';
export { type DeviceIdentityInfo, useDeviceIdentity } from './hosted-hooks.ts';
export { deviceIdentity, type HostedIdentity, resolveIdentity, signerIdentity } from './identity.ts';
export {
  type HostedHealth,
  isUnpairedError,
  type NostrTransport,
  type NostrTransportOptions,
  nostrTransport,
  type RelayState,
} from './nostr.ts';
export {
  createPairingController,
  DEMO_PAIRING_PAYLOAD,
  defaultDeviceName,
  formatSafetyPhrase,
  type PairingController,
  type PairingPayload,
  type PairingPhase,
  type PairingState,
  pairingSafetyPhrase,
  parsePairingInput,
  type SimulatedOutcome,
  takePairingInputFromUrl,
  type UsePairing,
  type UsePairingOptions,
  usePairing,
} from './pairing.ts';
export {
  hasNip07,
  type NostrSigner,
  nip07Signer,
  nip46Signer,
  parseBunkerUrl,
  type SignerKind,
  SignerUnavailableError,
} from './signer.ts';
