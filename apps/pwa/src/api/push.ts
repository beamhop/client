/**
 * Web Push for the PWA (§9): subscribe through the service worker registration with the daemon's
 * VAPID key, then hand the subscription to the daemon with `device.pushSubscribe`.
 *
 * The service worker side (`push` / `notificationclick`) lives in `public/push-sw.js`, imported into
 * the generated Workbox worker via `workbox.importScripts` (vite.config.ts).
 *
 * `deviceId` is this device's paired-device id (hosted PWA over Nostr), or `"browser"` for the PWA
 * served by the local daemon.
 */
import type { MethodName, Params, PushCategory, PushPrefs, Result } from '@beamhop/core';

/** The slice of the API client this helper needs (a BeamhopClient fits). */
export interface PushApi {
  call<M extends MethodName>(method: M, params?: Params<M>): Promise<Result<M>>;
}

export type PushSupport = 'supported' | 'unsupported' | 'denied';
export type PushResult = 'subscribed' | 'unsupported' | 'denied';

export const LOCAL_BROWSER_DEVICE = 'browser';

/** base64url → bytes (applicationServerKey). */
export const urlBase64ToUint8Array = (b64url: string): Uint8Array<ArrayBuffer> => {
  const pad = '='.repeat((4 - (b64url.length % 4)) % 4);
  const b64 = (b64url + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
};

const hasPush = (): boolean =>
  typeof navigator !== 'undefined' &&
  'serviceWorker' in navigator &&
  typeof window !== 'undefined' &&
  'PushManager' in window &&
  typeof Notification !== 'undefined';

/** Can this browser receive push right now? (iOS needs 16.4+ and the PWA installed.) */
export const pushSupport = (): PushSupport => {
  if (!hasPush()) return 'unsupported';
  return Notification.permission === 'denied' ? 'denied' : 'supported';
};

const sameKey = (a: ArrayBuffer | null | undefined, b: Uint8Array): boolean => {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
};

/**
 * Ask for permission (must run from a user gesture on iOS), subscribe and register with the daemon.
 * An existing subscription for a different VAPID key is replaced.
 */
export const enablePush = async (api: PushApi, deviceId: string): Promise<PushResult> => {
  if (!hasPush()) return 'unsupported';
  const permission =
    Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  if (permission !== 'granted') return 'denied';
  const { publicKey } = await api.call('device.pushKey', {});
  const key = urlBase64ToUint8Array(publicKey);
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options?.applicationServerKey, key)) {
    await sub.unsubscribe().catch(() => false);
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await api.call('device.pushSubscribe', { id: deviceId, subscription: sub.toJSON() });
  return 'subscribed';
};

/** Unsubscribe locally and tell the daemon to forget the subscription. */
export const disablePush = async (api: PushApi, deviceId: string): Promise<void> => {
  if (hasPush()) {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    await sub?.unsubscribe().catch(() => false);
  }
  await api.call('device.pushSubscribe', { id: deviceId, subscription: null });
};

export const getPushPrefs = async (api: PushApi, deviceId: string): Promise<PushPrefs> =>
  (await api.call('device.pushPrefs', { id: deviceId })).prefs;

export const setPushPref = async (
  api: PushApi,
  deviceId: string,
  category: PushCategory,
  on: boolean,
): Promise<PushPrefs> =>
  (await api.call('device.pushPrefs', { id: deviceId, prefs: { [category]: on } })).prefs;
