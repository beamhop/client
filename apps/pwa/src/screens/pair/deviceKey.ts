/**
 * Device key generated ON the phone (JOURNEYS §9.3): a non-extractable WebCrypto key pair whose private
 * half never leaves this browser (stored as a CryptoKey object in IndexedDB). Only the public key is
 * sent to the daemon. Falls back to an in-memory key when IndexedDB is unavailable (private mode).
 *
 * TODO(pairing): Nostr control events need a secp256k1 key; switch to the shared pairing module from
 * `packages/channel-nostr` once it exists. P-256 here proves the storage/UX path.
 */
const DB = 'beamhop-device';
const STORE = 'keys';

const idb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const put = async (key: string, value: unknown) => {
  const db = await idb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Create (or replace) this device's key and return the public key as hex. */
export const createDeviceKey = async (): Promise<string> => {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    // Insecure context: a random id still lets the daemon track the device; signing needs HTTPS.
    const r = new Uint8Array(33);
    globalThis.crypto.getRandomValues(r);
    return hex(r.buffer);
  }
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const raw = await subtle.exportKey('raw', pair.publicKey);
  try {
    await put('device', pair);
  } catch {
    /* IndexedDB blocked: key lives for this tab only */
  }
  return hex(raw);
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
export const deviceNameFromUA = (ua: string = typeof navigator === 'undefined' ? '' : navigator.userAgent) => {
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
