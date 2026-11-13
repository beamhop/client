/**
 * Hooks for Settings → Devices / Connection in hosted mode.
 *
 *   const me = useDeviceIdentity();
 *   devices.map((d) => me.isThisDevice(d.pubkey) && <Badge>this device</Badge>)
 */
import { decodePubkey } from '@beamhop/channel-nostr/keys';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { getActiveDaemon } from './daemons.ts';
import { defaultKeyStore, forgetDeviceKey, getDeviceKey, type KeyStore } from './device-key.ts';

export interface DeviceIdentityInfo {
  status: 'loading' | 'none' | 'ready';
  /** This browser's key for the active daemon (device key, or the NIP-07 key it paired with). */
  npub?: string;
  pubkey?: string;
  /** Compare against `DeviceView.pubkey` (npub or hex). */
  isThisDevice(pubkey: string): boolean;
  /** Delete the local device key (do `device.remove` on every daemon first). */
  forget(): Promise<void>;
}

const hex = (k: string): string | undefined => {
  try {
    return decodePubkey(k);
  } catch {
    return undefined;
  }
};

export const useDeviceIdentity = (store: KeyStore = defaultKeyStore()): DeviceIdentityInfo => {
  const [st, setSt] = useState<{ status: DeviceIdentityInfo['status']; pubkey?: string; npub?: string }>(
    () => {
      const d = getActiveDaemon();
      const pk = d?.deviceNpub ? hex(d.deviceNpub) : undefined;
      return pk && d?.deviceNpub
        ? { status: 'ready', pubkey: pk, npub: d.deviceNpub }
        : { status: 'loading' };
    },
  );
  useEffect(() => {
    if (st.status !== 'loading') return;
    let live = true;
    getDeviceKey(store).then(
      (k) => live && setSt(k ? { status: 'ready', pubkey: k.pubkey, npub: k.npub } : { status: 'none' }),
      () => live && setSt({ status: 'none' }),
    );
    return () => {
      live = false;
    };
  }, [st.status, store]);
  const forget = useCallback(async () => {
    await forgetDeviceKey(store);
    setSt({ status: 'none' });
  }, [store]);
  return useMemo(
    () => ({
      ...st,
      isThisDevice: (pk: string) => !!st.pubkey && hex(pk) === st.pubkey,
      forget,
    }),
    [st, forget],
  );
};
