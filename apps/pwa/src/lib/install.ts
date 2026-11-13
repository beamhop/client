/**
 * Install state for the PWA (DESIGN §11 "Install prompt", JOURNEYS §9.4).
 * `beforeinstallprompt` fires once, early, and only if someone listens: this module is on the boot path
 * and captures it at import so any later screen (pairing, the Home install banner) can show the
 * browser's prompt from its own button. iOS has no prompt API → instructions instead.
 */
import { useSyncExternalStore } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    installed = true;
    deferred = null;
    emit();
  });
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

export const isStandalone = (): boolean =>
  typeof window !== 'undefined' &&
  (window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as { standalone?: boolean }).standalone === true);

export const isIos = (): boolean =>
  typeof navigator !== 'undefined' && /iPhone|iPad|iPod/.test(navigator.userAgent);

/** `available`: the browser offered an install prompt we can show. */
export const useInstall = () => {
  const available = useSyncExternalStore(
    subscribe,
    () => !!deferred,
    () => false,
  );
  const done = useSyncExternalStore(
    subscribe,
    () => installed,
    () => false,
  );
  return {
    available,
    installed: done || isStandalone(),
    ios: isIos(),
    prompt: async (): Promise<boolean> => {
      const e = deferred;
      if (!e) return false;
      await e.prompt();
      const choice = await e.userChoice;
      deferred = null;
      emit();
      return choice.outcome === 'accepted';
    },
  };
};
