/**
 * Saved daemons for hosted mode: the computers / cloud hosts this browser has paired with (laptop +
 * cloud box…). Persisted in localStorage `bh.daemons` — public data only (daemon pubkey, relays, names);
 * the device key lives in IndexedDB (device-key.ts). The active one is what the app boots into.
 */
// nip19 only (bech32): this module is on the boot path, so keep secp256k1 out of the main chunk.
import * as nip19 from 'nostr-tools/nip19';
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { SignerKind } from './signer.ts';

export interface SavedDaemon {
  /** = daemonPubkey (one entry per daemon). */
  id: string;
  /** hex */
  daemonPubkey: string;
  daemonNpub: string;
  relays: string[];
  /** "Alice's MacBook" (from the pairing payload; renameable). */
  name: string;
  /** Which key this browser signs with for this daemon. */
  signer: SignerKind;
  /** This browser's device record on that daemon (from device.pairComplete). */
  deviceId?: string;
  /** This browser's pubkey (npub) as the daemon knows it. */
  deviceNpub?: string;
  pairedAt: string;
  lastUsedAt?: string;
}

export interface SaveDaemonInput {
  daemonPubkey: string;
  relays: string[];
  name?: string;
  signer?: SignerKind;
  deviceId?: string;
  deviceNpub?: string;
}

interface StoreShape {
  v: 1;
  active?: string;
  daemons: SavedDaemon[];
}

const KEY = 'bh.daemons';
const MAX_DAEMONS = 16;
const listeners = new Set<() => void>();
let cache: { raw: string | null; value: StoreShape } | undefined;
/** Used when localStorage is blocked (private mode on some browsers): this tab only. */
let memoryRaw: string | null = null;

const empty = (): StoreShape => ({ v: 1, daemons: [] });

const npubEncode = (hex: string) => nip19.npubEncode(hex);
const decodePubkey = (k: string): string => {
  const s = k.trim().replace(/^nostr:/, '');
  if (/^[0-9a-f]{64}$/i.test(s)) return s.toLowerCase();
  if (s.startsWith('npub1')) {
    const d = nip19.decode(s);
    if (d.type === 'npub') return d.data;
  }
  throw new Error('invalid daemon key (expected npub1… or 64-char hex)');
};

const isRelay = (r: unknown): r is string => typeof r === 'string' && /^wss?:\/\/\S+$/i.test(r);

const valid = (d: unknown): d is SavedDaemon => {
  if (!d || typeof d !== 'object') return false;
  const x = d as SavedDaemon;
  return (
    typeof x.id === 'string' &&
    /^[0-9a-f]{64}$/.test(x.daemonPubkey) &&
    x.id === x.daemonPubkey &&
    Array.isArray(x.relays) &&
    x.relays.length > 0 &&
    x.relays.every(isRelay) &&
    typeof x.name === 'string' &&
    (x.signer === 'device' || x.signer === 'nip07' || x.signer === 'nip46')
  );
};

const read = (): StoreShape => {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    raw = memoryRaw;
  }
  if (cache && cache.raw === raw) return cache.value;
  let value = empty();
  if (raw) {
    try {
      const j = JSON.parse(raw) as Partial<StoreShape>;
      const daemons = Array.isArray(j.daemons) ? j.daemons.filter(valid) : [];
      const active = daemons.some((d) => d.id === j.active) ? j.active : undefined;
      value = { v: 1, daemons, ...(active ? { active } : {}) };
    } catch {
      // corrupt: start over
    }
  }
  cache = { raw, value };
  return value;
};

const write = (s: StoreShape) => {
  const raw = JSON.stringify(s);
  try {
    localStorage.setItem(KEY, raw);
  } catch {
    memoryRaw = raw;
  }
  for (const l of listeners) l();
};

export const listDaemons = (): SavedDaemon[] => read().daemons;

export const getActiveDaemon = (): SavedDaemon | undefined => {
  const s = read();
  return s.daemons.find((d) => d.id === s.active);
};

/** Add or update a daemon (by pubkey) and make it active. */
export const saveDaemon = (input: SaveDaemonInput, now: () => Date = () => new Date()): SavedDaemon => {
  const hex = decodePubkey(input.daemonPubkey);
  const relays = [...new Set(input.relays.filter(isRelay))].slice(0, 8);
  if (!relays.length) throw new Error('a saved daemon needs at least one relay');
  const s = read();
  const old = s.daemons.find((d) => d.id === hex);
  const d: SavedDaemon = {
    id: hex,
    daemonPubkey: hex,
    daemonNpub: npubEncode(hex),
    relays,
    name: (input.name ?? old?.name ?? 'Computer').slice(0, 80),
    signer: input.signer ?? old?.signer ?? 'device',
    pairedAt: now().toISOString(),
    lastUsedAt: now().toISOString(),
    ...((input.deviceId ?? old?.deviceId) ? { deviceId: input.deviceId ?? old?.deviceId } : {}),
    ...((input.deviceNpub ?? old?.deviceNpub) ? { deviceNpub: input.deviceNpub ?? old?.deviceNpub } : {}),
  };
  const rest = s.daemons.filter((x) => x.id !== hex);
  write({ v: 1, active: hex, daemons: [d, ...rest].slice(0, MAX_DAEMONS) });
  return d;
};

export const setActiveDaemon = (id: string | undefined): void => {
  const s = read();
  if (id !== undefined && !s.daemons.some((d) => d.id === id)) throw new Error(`unknown daemon ${id}`);
  const daemons = s.daemons.map((d) => (d.id === id ? { ...d, lastUsedAt: new Date().toISOString() } : d));
  write({ v: 1, daemons, ...(id ? { active: id } : {}) });
};

/**
 * Forget a daemon in this browser. This does NOT remove the device from that daemon's allowlist —
 * call `device.remove` over the connection first (Settings → Devices).
 */
export const removeDaemon = (id: string): void => {
  const s = read();
  const daemons = s.daemons.filter((d) => d.id !== id);
  const active = s.active === id ? undefined : s.active;
  write({ v: 1, daemons, ...(active ? { active } : {}) });
};

export const renameDaemon = (id: string, name: string): void => {
  const s = read();
  const trimmed = name.trim().slice(0, 80);
  if (!trimmed) throw new Error('name must not be empty');
  write({ ...s, daemons: s.daemons.map((d) => (d.id === id ? { ...d, name: trimmed } : d)) });
};

export const subscribeDaemons = (fn: () => void): (() => void) => {
  listeners.add(fn);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) fn();
  };
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(fn);
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
};

/** Reload into the newly active daemon. The runtime is created once at boot (main.tsx). */
const defaultReload = () => window.location.assign('/');

export interface UseDaemons {
  daemons: SavedDaemon[];
  active: SavedDaemon | undefined;
  /** Make `id` active and reload the app into it (pass `{ reload: false }` to only persist). */
  switchTo(id: string, opts?: { reload?: boolean }): void;
  /** Forget locally (see removeDaemon). Removing the active daemon reloads into the next one / pairing. */
  remove(id: string, opts?: { reload?: boolean }): void;
  rename(id: string, name: string): void;
}

export const useDaemons = (reload: () => void = defaultReload): UseDaemons => {
  const snap = useSyncExternalStore(subscribeDaemons, read, read);
  const switchTo = useCallback<UseDaemons['switchTo']>(
    (id, opts) => {
      setActiveDaemon(id);
      if (opts?.reload !== false) reload();
    },
    [reload],
  );
  const remove = useCallback<UseDaemons['remove']>(
    (id, opts) => {
      const wasActive = read().active === id;
      removeDaemon(id);
      if (wasActive) {
        const next = read().daemons[0];
        if (next) setActiveDaemon(next.id);
        if (opts?.reload !== false) reload();
      }
    },
    [reload],
  );
  return useMemo(
    () => ({
      daemons: snap.daemons,
      active: snap.daemons.find((d) => d.id === snap.active),
      switchTo,
      remove,
      rename: renameDaemon,
    }),
    [snap, switchTo, remove],
  );
};
