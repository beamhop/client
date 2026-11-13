export {
  type ConnectionConfig,
  type ConnectionKind,
  type ConnectionStatus,
  forgetToken,
  resolveConnection,
} from './connection.ts';
// Saved daemons are light (no crypto) and needed at boot. Everything else hosted-mode lives in
// `api/hosted.ts` (pairing, device key, signers) so it is code-split away from the main chunk.
export {
  getActiveDaemon,
  listDaemons,
  type SavedDaemon,
  type UseDaemons,
  useDaemons,
} from './daemons.ts';
export * from './derive.ts';
export { applyServerEvent } from './events.ts';
export { useApi, useCall, useMutationApi, useServerEvent } from './hooks.ts';
export { apiKey, methodKey } from './keys.ts';
export type { HostedHealth, RelayState } from './nostr.ts';
export {
  BeamhopProvider,
  type BeamhopRuntime,
  createRuntime,
  type RuntimeOptions,
  useBeamhop,
  useConnection,
  useMaybeBeamhop,
} from './provider.tsx';
export type { SignerKind } from './signer.ts';
