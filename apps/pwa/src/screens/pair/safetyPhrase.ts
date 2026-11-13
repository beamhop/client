/**
 * Pairing helpers for the PWA, on top of the shared, browser-safe `@beamhop/channel-nostr/pairing`
 * (payload decoding, the 4-word safety phrase derived from the daemon + device pubkeys).
 * DESIGN §12: the phrase is a *match* check, never recall.
 */
import { decodePairingPayload, type PairingPayload, safetyPhrase } from '@beamhop/channel-nostr/pairing';

export { decodePairingPayload, safetyPhrase, type PairingPayload };

/** Uppercase for display: `AMBER · RELAY · OTTER · NINE`. */
export const phraseWords = (words: readonly string[] | undefined): string[] | undefined =>
  words?.map((w) => w.toUpperCase());

/** Format a manual code as `AMBR-RLY8`; returns null when it isn't 8 letters/digits. */
export const formatPairCode = (raw: string): string | null => {
  const s = raw.replace(/[\s-]/g, '').toUpperCase();
  return /^[A-Z0-9]{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4)}` : null;
};

/** Payload from a URL fragment, or undefined when it isn't a valid pairing payload. */
export const tryDecodePayload = (input: string): PairingPayload | undefined => {
  if (!input) return undefined;
  try {
    return decodePairingPayload(input);
  } catch {
    return undefined;
  }
};

/** Phrase for (daemon, device) or undefined when either key is missing/invalid. */
export const tryPhrase = (daemon?: string, device?: string): string[] | undefined => {
  if (!daemon || !device) return undefined;
  try {
    return phraseWords(safetyPhrase(daemon, device));
  } catch {
    return undefined;
  }
};
