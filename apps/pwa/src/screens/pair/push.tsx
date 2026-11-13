/**
 * Install + push helpers for the phone (JOURNEYS §9 steps 4–5), shared with Settings → Notifications.
 * - Ask for push in context, after a purpose pre-prompt, inside the tap (iOS requires a user gesture).
 * - iOS: push only for installed web apps on 16.4+; no install prompt API → instructions.
 * - Android/Chromium: capture `beforeinstallprompt` and call `prompt()` from our own button.
 */
import { useEffect, useState } from 'react';

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
 * Must be called from a press handler. Returns the resulting permission.
 * TODO(core): send a real PushSubscription once the daemon exposes its VAPID public key
 * (`pushManager.subscribe({ applicationServerKey })`). Today we tell the daemon the permission only.
 */
export const requestPush = async (): Promise<{ permission: PushPermission; subscription: unknown }> => {
  if (typeof window === 'undefined' || !('Notification' in window))
    return { permission: 'unsupported', subscription: null };
  const permission = (await Notification.requestPermission()) as PushPermission;
  return { permission, subscription: permission === 'granted' ? { permission, endpoint: null } : null };
};

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** Android/Chromium install prompt, captured so our own button can show it. */
export const useInstallPrompt = () => {
  const [evt, setEvt] = useState<BeforeInstallPromptEvent | null>(null);
  useEffect(() => {
    const on = (e: Event) => {
      e.preventDefault();
      setEvt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', on);
    return () => window.removeEventListener('beforeinstallprompt', on);
  }, []);
  return {
    available: !!evt,
    prompt: async () => {
      if (!evt) return false;
      await evt.prompt();
      const choice = await evt.userChoice;
      setEvt(null);
      return choice.outcome === 'accepted';
    },
  };
};
