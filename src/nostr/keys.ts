import { generateSecretKey, getPublicKey, nip19, finalizeEvent } from "nostr-tools";
import type { EventTemplate, Event as NostrEvent } from "nostr-tools";

const STORAGE_KEY = "verity.identity.v1";

/**
 * An identity is either a locally-held secret key, or a delegated NIP-07 signer
 * (a browser extension that holds the key and signs on our behalf).
 */
export type Identity =
  | { kind: "local"; secretKey: Uint8Array; pubkey: string }
  | { kind: "nip07"; pubkey: string };

export type Nip07 = {
  getPublicKey(): Promise<string>;
  signEvent(event: EventTemplate): Promise<NostrEvent>;
  nip04?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>;
    decrypt(pubkey: string, ciphertext: string): Promise<string>;
  };
};

declare global {
  interface Window {
    nostr?: Nip07;
  }
}

export const hasNip07 = (): boolean =>
  typeof window !== "undefined" && typeof window.nostr !== "undefined";

export const createLocalIdentity = (): Identity => {
  const secretKey = generateSecretKey();
  return { kind: "local", secretKey, pubkey: getPublicKey(secretKey) };
};

/** Import from an `nsec1...` bech32 or 64-char hex secret. Throws on invalid input. */
export const importSecret = (input: string): Identity => {
  const trimmed = input.trim();
  let secretKey: Uint8Array;
  if (trimmed.startsWith("nsec")) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== "nsec") throw new Error("Not an nsec key");
    secretKey = decoded.data;
  } else if (/^[0-9a-f]{64}$/i.test(trimmed)) {
    secretKey = hexToBytes(trimmed);
  } else {
    throw new Error("Expected an nsec1… key or 64-char hex");
  }
  return { kind: "local", secretKey, pubkey: getPublicKey(secretKey) };
};

export const connectNip07 = async (): Promise<Identity> => {
  if (!window.nostr) throw new Error("No NIP-07 signer found");
  const pubkey = await window.nostr.getPublicKey();
  return { kind: "nip07", pubkey };
};

export const npubOf = (pubkey: string): string => nip19.npubEncode(pubkey);
export const nsecOf = (secretKey: Uint8Array): string => nip19.nsecEncode(secretKey);

/** Sign an event template with whichever identity is active. */
export const signWith = async (
  identity: Identity,
  template: EventTemplate,
): Promise<NostrEvent> => {
  if (identity.kind === "local") return finalizeEvent(template, identity.secretKey);
  if (!window.nostr) throw new Error("NIP-07 signer disappeared");
  return window.nostr.signEvent(template);
};

/** Persist a local identity (secret key as hex). NIP-07 needs no persistence beyond pubkey. */
export const persist = (identity: Identity): void => {
  const payload =
    identity.kind === "local"
      ? { kind: "local", secretKey: bytesToHex(identity.secretKey) }
      : { kind: "nip07", pubkey: identity.pubkey };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
};

export const loadPersisted = (): Identity | null => {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as
      | { kind: "local"; secretKey: string }
      | { kind: "nip07"; pubkey: string };
    if (parsed.kind === "local") {
      const secretKey = hexToBytes(parsed.secretKey);
      return { kind: "local", secretKey, pubkey: getPublicKey(secretKey) };
    }
    return { kind: "nip07", pubkey: parsed.pubkey };
  } catch {
    return null;
  }
};

export const clearPersisted = (): void => localStorage.removeItem(STORAGE_KEY);

export const shortNpub = (pubkey: string): string => {
  const npub = npubOf(pubkey);
  return `${npub.slice(0, 10)}…${npub.slice(-6)}`;
};

const hexToBytes = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
