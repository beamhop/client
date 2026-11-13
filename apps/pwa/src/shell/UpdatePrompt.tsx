/**
 * Service-worker update prompt (vite-plugin-pwa, registerType "prompt"): a persistent toast with Reload.
 * Never reloads on its own — an approval in progress must not vanish under the user's finger.
 * Long-lived installed apps check for a new version hourly and whenever they come back to the
 * foreground, so a phone that stays open for days still learns about updates.
 */

import { useRegisterSW } from 'virtual:pwa-register/react';
import { useEffect } from 'react';
import { t } from '../i18n/index.ts';
import { useToast } from '../ui/Toast.tsx';

const HOUR = 60 * 60 * 1000;

export const UpdatePrompt = () => {
  const toast = useToast();
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW: (_url, reg) => {
      if (!reg) return;
      const check = () => {
        if (navigator.onLine) void reg.update().catch(() => undefined);
      };
      window.setInterval(check, HOUR);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check();
      });
    },
    onRegisterError: (e) => console.warn('[beamhop] service worker registration failed', e),
  });
  useEffect(() => {
    if (!needRefresh) return;
    toast.show({
      message: t('update.ready'),
      durationMs: Number.POSITIVE_INFINITY,
      action: { label: t('update.reload'), onPress: () => void updateServiceWorker(true) },
    });
  }, [needRefresh, toast, updateServiceWorker]);
  return null;
};
