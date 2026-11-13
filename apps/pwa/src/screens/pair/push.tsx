/**
 * Install + push helpers for the phone (JOURNEYS §9 steps 4–5), shared with Settings → Notifications.
 * - Ask for push in context, after a purpose pre-prompt, inside the tap (iOS requires a user gesture).
 * - iOS: push only for installed web apps on 16.4+; no install prompt API → instructions.
 * - Android/Chromium: capture `beforeinstallprompt` and call `prompt()` from our own button.
 */
import type { PushCategory, PushPrefs } from '@beamhop/core';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { apiKey, useApi, useBeamhop, useConnection, useDaemons } from '../../api/index.ts';
import { enablePush, LOCAL_BROWSER_DEVICE, type PushApi, setPushPref } from '../../api/push.ts';
import { useInstall } from '../../lib/install.ts';
import { useThisDevice } from '../settings/DevicesSection.tsx';

export type PushPermission = 'granted' | 'denied' | 'default' | 'unsupported';

export interface PushEnv {
  permission: PushPermission;
  ios: boolean;
  standalone: boolean;
  /** iOS outside the installed app cannot get push at all. */
  needsInstall: boolean;
}

export const readPushEnv = (): PushEnv => {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  const ua = nav?.userAgent ?? '';
  const ios = /iPhone|iPad|iPod/.test(ua);
  const standalone =
    (typeof window !== 'undefined' && window.matchMedia?.('(display-mode: standalone)').matches) ||
    (nav as { standalone?: boolean } | undefined)?.standalone === true;
  const has = typeof window !== 'undefined' && 'Notification' in window;
  const permission: PushPermission = has ? (Notification.permission as PushPermission) : 'unsupported';
  return { permission, ios, standalone: !!standalone, needsInstall: ios && !standalone };
};

export const usePushEnv = (): [PushEnv, () => void] => {
  const [env, setEnv] = useState(readPushEnv);
  return [env, () => setEnv(readPushEnv())];
};

/**
 * Turn push on for `deviceId` (call from a press handler: iOS needs the user gesture).
 * Real daemons: `enablePush` (permission → the daemon's VAPID key from `device.pushKey` → PushManager
 * subscription → `device.pushSubscribe`). The demo daemon's key is not a real VAPID key, so in mock
 * mode we ask for permission, read the key and register a placeholder subscription instead.
 */
export const turnOnPush = async (
  api: PushApi,
  deviceId: string,
  opts: { demo?: boolean } = {},
): Promise<PushPermission> => {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  if (opts.demo) {
    const permission = (await Notification.requestPermission()) as PushPermission;
    if (permission !== 'granted') return permission;
    await api.call('device.pushKey', {});
    await api.call('device.pushSubscribe', { id: deviceId, subscription: { endpoint: null, demo: true } });
    return 'granted';
  }
  const r = await enablePush(api, deviceId);
  return r === 'subscribed' ? 'granted' : r;
};

const PENDING_KEY = 'bh.push.pending';

/** Remember that `deviceId` wants push once a control connection exists (fresh hosted pairing). */
export const rememberPendingPush = (deviceId: string) => {
  try {
    localStorage.setItem(PENDING_KEY, deviceId);
  } catch {
    /* storage blocked: Settings → Notifications can still turn it on */
  }
};

/** Ask for permission inside the tap; the subscription is registered later by <PushResume/>. */
export const askPermissionForLater = async (deviceId: string): Promise<PushPermission> => {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  const permission = (await Notification.requestPermission()) as PushPermission;
  if (permission === 'granted') rememberPendingPush(deviceId);
  return permission;
};

/**
 * Shell effect: finishes a push registration that was granted during pairing, once the app is
 * connected to the paired daemon (permission is already granted, so no gesture is needed).
 */
export const PushResume = () => {
  const conn = useConnection();
  const { client } = useBeamhop();
  useEffect(() => {
    if (conn.kind !== 'nostr' && conn.kind !== 'local') return;
    if (conn.status !== 'open') return;
    let pending: string | null = null;
    try {
      pending = localStorage.getItem(PENDING_KEY);
    } catch {
      return;
    }
    if (!pending || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const id = conn.kind === 'local' ? LOCAL_BROWSER_DEVICE : pending;
    enablePush(client, id)
      .then(() => localStorage.removeItem(PENDING_KEY))
      .catch(() => {
        /* keep the flag; next boot retries */
      });
  }, [conn.kind, conn.status, client]);
  return null;
};

/** Which device id push is registered under: the paired device (hosted), `browser` (local), or demo. */
export const usePushDeviceId = (): string | undefined => {
  const conn = useConnection();
  const { active } = useDaemons();
  const devices = useApi('device.list', undefined, { enabled: conn.kind === 'mock' });
  const demo = useThisDevice(devices.data?.devices);
  if (conn.kind === 'nostr') return active?.deviceId;
  if (conn.kind === 'local') return LOCAL_BROWSER_DEVICE;
  if (conn.kind === 'mock') return demo?.id;
  return undefined;
};

/** Per-device notification categories (`device.pushPrefs`) with optimistic toggles. */
export const usePushPrefs = (deviceId: string | undefined) => {
  const { client } = useBeamhop();
  const qc = useQueryClient();
  const params = { id: deviceId ?? '' };
  const q = useApi('device.pushPrefs', params, { enabled: !!deviceId });
  const set = async (category: PushCategory, on: boolean) => {
    if (!deviceId) return;
    const key = apiKey('device.pushPrefs', params);
    const prev = qc.getQueryData<{ id: string; prefs: PushPrefs }>(key);
    qc.setQueryData(key, { id: deviceId, prefs: { ...prev?.prefs, [category]: on } });
    try {
      const prefs = await setPushPref(client, deviceId, category, on);
      qc.setQueryData(key, { id: deviceId, prefs });
    } catch (err) {
      if (prev) qc.setQueryData(key, prev);
      throw err;
    }
  };
  /** Unset categories default to on (core). */
  const isOn = (c: PushCategory) => q.data?.prefs[c] !== false;
  return { ...q, set, isOn };
};

/** Android/Chromium install prompt (captured at boot by lib/install.ts), for our own button. */
export const useInstallPrompt = () => {
  const { available, prompt } = useInstall();
  return { available, prompt };
};
