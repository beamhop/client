/**
 * Device key generated ON the phone (JOURNEYS §9.3). A Nostr keypair: the public key goes to the
 * daemon, the secret stays in this browser's IndexedDB (falls back to memory for this tab when
 * IndexedDB is blocked, e.g. some private modes). Never logged, never sent.
 */
import { type AgentKey, generateAgentKey } from '@beamhop/channel-nostr/keys';

const DB = 'beamhop-device';
const STORE = 'keys';

const idb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const putSecret = async (secret: Uint8Array) => {
  const db = await idb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(secret, 'device');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

/** Generate a fresh device key (re-pairing replaces the old key, keeps the name — JOURNEYS §9). */
export const newDeviceKey = (): AgentKey => generateAgentKey();

/** Persist the secret once the user commits to pairing. */
export const saveDeviceKey = async (key: AgentKey): Promise<void> => {
  try {
    await putSecret(key.secretKey);
  } catch {
    /* IndexedDB blocked: the key lives for this tab only */
  }
};

const ID_KEY = 'bh.deviceId';
export const rememberDeviceId = (id: string) => {
  try {
    localStorage.setItem(ID_KEY, id);
  } catch {
    /* ignore */
  }
};
export const thisDeviceId = (): string | null => {
  try {
    return localStorage.getItem(ID_KEY);
  } catch {
    return null;
  }
};

/** A friendly default name from the user agent: `iPhone · Safari`, `Pixel · Chrome`, `Mac · Firefox`. */
export const deviceNameFromUA = (
  ua: string = typeof navigator === 'undefined' ? '' : navigator.userAgent,
) => {
  const device = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Pixel/.test(ua)
        ? 'Pixel'
        : /Android/.test(ua)
          ? 'Android'
          : /Macintosh|Mac OS X/.test(ua)
            ? 'Mac'
            : /Windows/.test(ua)
              ? 'Windows PC'
              : /Linux/.test(ua)
                ? 'Linux'
                : 'This device';
  const browser = /Firefox\//.test(ua)
    ? 'Firefox'
    : /Edg\//.test(ua)
      ? 'Edge'
      : /CriOS|Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser';
  return `${device} · ${browser}`;
};
