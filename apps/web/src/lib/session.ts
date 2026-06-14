import {
  LocalSigner,
  Nip07Signer,
  detectNip07,
  generateKeyPair,
  keyPairFromNsec,
  encodeNsec,
  encodeNpub,
  type Signer,
  type KeyPair,
} from '@verity/core';

const NSEC_KEY = 'verity:nsec';
const RELAYS_KEY = 'verity:relays';
const SIGNER_KIND_KEY = 'verity:signerKind';

export type SignerKind = 'local' | 'nip07';

export interface Session {
  readonly signer: Signer;
  readonly kind: SignerKind;
  /** Present only for local signers (in-memory key). */
  readonly keyPair?: KeyPair;
}

/** Persist a local secret key and build a session from it. */
export function persistLocalKey(keyPair: KeyPair): Session {
  localStorage.setItem(NSEC_KEY, encodeNsec(keyPair.secretKey));
  localStorage.setItem(SIGNER_KIND_KEY, 'local');
  return { signer: new LocalSigner(keyPair), kind: 'local', keyPair };
}

/** Create a brand new identity and persist it. */
export function createNewIdentity(): Session {
  return persistLocalKey(generateKeyPair());
}

/** Import an existing `nsec…` and persist it. Throws on invalid input. */
export function importNsec(nsec: string): Session {
  const keyPair = keyPairFromNsec(nsec);
  return persistLocalKey(keyPair);
}

/** Connect to a NIP-07 browser extension if available. */
export async function connectNip07(): Promise<Session> {
  const provider = detectNip07();
  if (!provider) throw new Error('No NIP-07 extension detected');
  await provider.getPublicKey();
  localStorage.setItem(SIGNER_KIND_KEY, 'nip07');
  localStorage.removeItem(NSEC_KEY);
  return { signer: new Nip07Signer(provider), kind: 'nip07' };
}

/** Restore a session from persisted storage, or null if none. */
export function restoreSession(): Session | null {
  const kind = localStorage.getItem(SIGNER_KIND_KEY) as SignerKind | null;
  if (kind === 'nip07') {
    const provider = detectNip07();
    if (provider) return { signer: new Nip07Signer(provider), kind: 'nip07' };
    return null;
  }
  const nsec = localStorage.getItem(NSEC_KEY);
  if (!nsec) return null;
  try {
    const keyPair = keyPairFromNsec(nsec);
    return { signer: new LocalSigner(keyPair), kind: 'local', keyPair };
  } catch {
    return null;
  }
}

/** Clear the persisted identity. */
export function clearSession(): void {
  localStorage.removeItem(NSEC_KEY);
  localStorage.removeItem(SIGNER_KIND_KEY);
}

export function loadRelays(): string[] | null {
  const raw = localStorage.getItem(RELAYS_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.every((r) => typeof r === 'string')) return parsed;
  } catch {
    // fall through
  }
  return null;
}

export function saveRelays(relays: readonly string[]): void {
  localStorage.setItem(RELAYS_KEY, JSON.stringify(relays));
}

const READ_KEY = 'verity:read';

/** Map of conversation peer pubkey -> last-read unix timestamp, per identity. */
export function loadReadState(pubkey: string): Record<string, number> {
  const raw = localStorage.getItem(`${READ_KEY}:${pubkey}`);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as Record<string, number>;
  } catch {
    // ignore
  }
  return {};
}

export function saveReadState(pubkey: string, state: Record<string, number>): void {
  localStorage.setItem(`${READ_KEY}:${pubkey}`, JSON.stringify(state));
}

/** Normalize + validate a relay URL (must be ws:// or wss://). Returns null if invalid. */
export function normalizeRelayUrl(input: string): string | null {
  let value = input.trim();
  if (!value) return null;
  // No internal whitespace allowed in a relay URL.
  if (/\s/.test(value)) return null;
  // Reject an explicit non-websocket scheme (e.g. http://, ftp://).
  if (/:\/\//.test(value) && !/^wss?:\/\//i.test(value)) return null;
  if (!/^wss?:\/\//i.test(value)) value = `wss://${value}`;
  try {
    const url = new URL(value);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null;
    if (!url.hostname) return null;
    // Require a dotted host or localhost (rejects bare words like "relay").
    if (!url.hostname.includes('.') && url.hostname !== 'localhost') return null;
    // Drop trailing slash for consistent comparison.
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

/** Convenience: npub for a keypair-backed session. */
export function sessionNpub(session: Session, pubkey: string): string {
  return session.keyPair ? encodeNpub(session.keyPair.publicKey) : encodeNpub(pubkey);
}
