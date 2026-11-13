/**
 * This device's Nostr key for hosted mode (JOURNEYS §9: "a device key generated *on the phone*").
 *
 * Storage: IndexedDB database `beamhop`, store `keys`, record `device`.
 *
 * ⚠ Risk (documented in README § Hosted mode): WebCrypto has no secp256k1, so the key cannot be a
 * non-extractable CryptoKey. Where possible we encrypt the 32-byte secret with a **non-extractable
 * AES-GCM key** that lives in the same IndexedDB record. That keeps the raw secret out of disk dumps and
 * backups of the browser profile, but any script running on this origin (XSS, a malicious extension) can
 * still ask WebCrypto to decrypt it. Mitigations: strict CSP and no third-party scripts in the PWA, the
 * key is per device and only reaches the daemons it was paired with, and Settings → Devices removes it
 * from every daemon's allowlist in one step (§7A lost phone). The key never leaves the device and is
 * never logged.
 */

import { npubEncode } from '@beamhop/channel-nostr/keys';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';

export interface DeviceKey {
  /** 32-byte secret. Never log, display or send it. */
  secretKey: Uint8Array;
  /** hex */
  pubkey: string;
  npub: string;
  createdAt: string;
}

/** What is persisted. Exactly one of `wrapped` / `raw` is set. */
export interface StoredDeviceKey {
  v: 1;
  pubkey: string;
  createdAt: string;
  wrapped?: { key: CryptoKey; iv: Uint8Array; data: ArrayBuffer };
  /** Fallback when WebCrypto or CryptoKey storage is unavailable. */
  raw?: Uint8Array;
}

export interface KeyStore {
  get(): Promise<StoredDeviceKey | undefined>;
  put(rec: StoredDeviceKey): Promise<void>;
  delete(): Promise<void>;
}

const DB = 'beamhop';
const STORE = 'keys';
const RECORD = 'device';

const req = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

/** IndexedDB-backed store. `factory` is injectable for tests (fake-indexeddb). */
export const idbKeyStore = (factory?: IDBFactory, dbName = DB): KeyStore => {
  let dbP: Promise<IDBDatabase> | undefined;
  const open = (): Promise<IDBDatabase> => {
    const f = factory ?? (typeof indexedDB === 'undefined' ? undefined : indexedDB);
    if (!f) return Promise.reject(new Error('IndexedDB is not available in this browser'));
    dbP ??= new Promise((resolve, reject) => {
      const r = f.open(dbName, 1);
      r.onupgradeneeded = () => {
        if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE);
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return dbP;
  };
  const tx = async (mode: IDBTransactionMode) => (await open()).transaction(STORE, mode).objectStore(STORE);
  return {
    async get() {
      return (await req((await tx('readonly')).get(RECORD))) as StoredDeviceKey | undefined;
    },
    async put(rec) {
      await req((await tx('readwrite')).put(rec, RECORD));
    },
    async delete() {
      await req((await tx('readwrite')).delete(RECORD));
    },
  };
};

/** In-memory store (tests, or browsers without IndexedDB — the key then lives for this tab only). */
export const memoryKeyStore = (): KeyStore => {
  let rec: StoredDeviceKey | undefined;
  return {
    get: async () => rec,
    put: async (r) => {
      rec = r;
    },
    delete: async () => {
      rec = undefined;
    },
  };
};

let defaultStore: KeyStore | undefined;
/** IndexedDB when available, otherwise memory. */
export const defaultKeyStore = (): KeyStore => {
  defaultStore ??= typeof indexedDB === 'undefined' ? memoryKeyStore() : idbKeyStore();
  return defaultStore;
};

const subtle = (): SubtleCrypto | undefined => globalThis.crypto?.subtle;

const toKey = (secretKey: Uint8Array, createdAt: string): DeviceKey => {
  const pubkey = getPublicKey(secretKey);
  return { secretKey, pubkey, npub: npubEncode(pubkey), createdAt };
};

const seal = async (secretKey: Uint8Array, createdAt: string): Promise<StoredDeviceKey> => {
  const pubkey = getPublicKey(secretKey);
  const s = subtle();
  if (s) {
    try {
      const key = await s.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const data = await s.encrypt({ name: 'AES-GCM', iv }, key, new Uint8Array(secretKey));
      return { v: 1, pubkey, createdAt, wrapped: { key, iv, data } };
    } catch {
      // fall through to raw storage
    }
  }
  return { v: 1, pubkey, createdAt, raw: secretKey };
};

const unseal = async (rec: StoredDeviceKey): Promise<DeviceKey> => {
  let sk: Uint8Array;
  if (rec.wrapped) {
    const s = subtle();
    if (!s) throw new Error('WebCrypto is unavailable; cannot unlock the device key');
    const { key, iv, data } = rec.wrapped;
    sk = new Uint8Array(await s.decrypt({ name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer> }, key, data));
  } else if (rec.raw) sk = new Uint8Array(rec.raw);
  else throw new Error('stored device key is empty');
  const k = toKey(sk, rec.createdAt);
  if (k.pubkey !== rec.pubkey) throw new Error('stored device key is corrupt');
  return k;
};

const inflight = new WeakMap<KeyStore, Promise<DeviceKey>>();

/** The device key, or undefined if this device never paired. */
export const getDeviceKey = async (store: KeyStore = defaultKeyStore()): Promise<DeviceKey | undefined> => {
  const rec = await store.get();
  return rec ? unseal(rec) : undefined;
};

/** The device key, generated (and persisted) on first use. Concurrent callers share one key. */
export const loadOrCreateDeviceKey = (store: KeyStore = defaultKeyStore()): Promise<DeviceKey> => {
  const hit = inflight.get(store);
  if (hit) return hit;
  const p = (async () => {
    const existing = await getDeviceKey(store);
    if (existing) return existing;
    const createdAt = new Date().toISOString();
    const sk = generateSecretKey();
    let rec = await seal(sk, createdAt);
    try {
      await store.put(rec);
    } catch (err) {
      // Some engines cannot structured-clone CryptoKey into IndexedDB: store raw instead.
      if (!rec.wrapped) throw err;
      rec = { v: 1, pubkey: rec.pubkey, createdAt, raw: sk };
      await store.put(rec);
    }
    return toKey(sk, createdAt);
  })();
  inflight.set(store, p);
  p.catch(() => inflight.delete(store));
  return p;
};

/**
 * Delete this device's key (after Settings → Devices removed it from the daemons). The next pairing
 * generates a fresh key. Saved daemons signed with it stop working.
 */
export const forgetDeviceKey = async (store: KeyStore = defaultKeyStore()): Promise<void> => {
  inflight.delete(store);
  await store.delete();
};
