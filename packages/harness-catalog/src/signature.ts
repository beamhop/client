import { createPrivateKey, createPublicKey, generateKeyPairSync, KeyObject, sign, verify } from 'node:crypto';

/** DER prefix of an Ed25519 SubjectPublicKeyInfo; the raw 32-byte key follows. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export type PublicKeyInput = KeyObject | string | Uint8Array;

/**
 * Accepts a KeyObject, a PEM string, or a raw 32-byte Ed25519 key (Uint8Array, hex or base64).
 * Throws if the input is not an Ed25519 public key.
 */
export const toEd25519PublicKey = (key: PublicKeyInput): KeyObject => {
  let ko: KeyObject;
  if (key instanceof KeyObject) ko = key;
  else if (typeof key === 'string' && key.includes('BEGIN PUBLIC KEY')) ko = createPublicKey(key);
  else {
    const raw =
      typeof key === 'string'
        ? /^[0-9a-f]{64}$/i.test(key)
          ? Buffer.from(key, 'hex')
          : Buffer.from(key, 'base64')
        : Buffer.from(key);
    if (raw.length !== 32) throw new Error('ed25519 public key must be 32 bytes');
    ko = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
  }
  if (ko.asymmetricKeyType !== 'ed25519') throw new Error('catalog key must be ed25519');
  return ko;
};

const toBytes = (data: string | Uint8Array): Buffer =>
  typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);

/**
 * Verify a detached Ed25519 signature over the exact catalog bytes.
 * `sig` is base64 (or a Uint8Array). Never throws on bad input: returns false.
 */
export const verifyCatalog = (
  json: string | Uint8Array,
  sig: string | Uint8Array,
  pubkey: PublicKeyInput | PublicKeyInput[],
): boolean => {
  const sigBytes = typeof sig === 'string' ? Buffer.from(sig.trim(), 'base64') : Buffer.from(sig);
  if (sigBytes.length !== 64) return false;
  const keys = Array.isArray(pubkey) ? pubkey : [pubkey];
  for (const k of keys) {
    try {
      if (verify(null, toBytes(json), toEd25519PublicKey(k), sigBytes)) return true;
    } catch {
      // bad key: try the next one
    }
  }
  return false;
};

/** Sign catalog bytes (release tooling / tests). Accepts a PEM or raw 32-byte seed. */
export const signCatalog = (
  json: string | Uint8Array,
  privateKey: KeyObject | string | Uint8Array,
): string => {
  let ko: KeyObject;
  if (privateKey instanceof KeyObject) ko = privateKey;
  else if (typeof privateKey === 'string' && privateKey.includes('PRIVATE KEY'))
    ko = createPrivateKey(privateKey);
  else {
    const raw = typeof privateKey === 'string' ? Buffer.from(privateKey, 'base64') : Buffer.from(privateKey);
    ko = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, raw]), format: 'der', type: 'pkcs8' });
  }
  return sign(null, toBytes(json), ko).toString('base64');
};

/** Generate a throwaway key pair; `publicKeyRaw` is base64 of the 32-byte key. */
export const generateCatalogKeyPair = (): {
  privateKey: KeyObject;
  publicKey: KeyObject;
  publicKeyRaw: string;
} => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return { privateKey, publicKey, publicKeyRaw: der.subarray(ED25519_SPKI_PREFIX.length).toString('base64') };
};
