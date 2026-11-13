/**
 * Service-worker update prompt (vite-plugin-pwa, registerType "prompt"): a persistent toast with Reload.
 * Never reloads on its own — an approval in progress must not vanish under the user's finger.
 */

import { useRegisterSW } from 'virtual:pwa-register/react';
import { useEffect } from 'react';
import { t } from '../i18n/index.ts';
import { useToast } from '../ui/Toast.tsx';

export const UpdatePrompt = () => {
  const toast = useToast();
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
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
