import { generateAgentKey } from '@beamhop/channel-nostr';
import { act, renderHook } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveConnection } from './connection.ts';
import {
  getActiveDaemon,
  listDaemons,
  removeDaemon,
  renameDaemon,
  saveDaemon,
  setActiveDaemon,
  useDaemons,
} from './daemons.ts';
import {
  forgetDeviceKey,
  getDeviceKey,
  idbKeyStore,
  loadOrCreateDeviceKey,
  memoryKeyStore,
} from './device-key.ts';
import { useDeviceIdentity } from './hosted-hooks.ts';
import { hasNip07, nip07Signer, nip46Signer, parseBunkerUrl, SignerUnavailableError } from './signer.ts';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  history.replaceState(null, '', '/');
});

const laptop = generateAgentKey();
const cloud = generateAgentKey();

describe('device key', () => {
  it('is generated once, persisted in IndexedDB and reloaded by a fresh store', async () => {
    const factory = new IDBFactory();
    const a = await loadOrCreateDeviceKey(idbKeyStore(factory));
    expect(a.pubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(a.npub.startsWith('npub1')).toBe(true);
    expect(a.secretKey).toHaveLength(32);
    // a "reload": new store on the same database
    const b = await getDeviceKey(idbKeyStore(factory));
    expect(b?.pubkey).toBe(a.pubkey);
    expect(Array.from(b!.secretKey)).toEqual(Array.from(a.secretKey));
  });

  it('wraps the secret with a non-extractable AES-GCM key when WebCrypto allows it', async () => {
    const store = memoryKeyStore();
    const k = await loadOrCreateDeviceKey(store);
    const rec = await store.get();
    expect(rec?.pubkey).toBe(k.pubkey);
    expect(rec?.wrapped).toBeDefined();
    expect(rec?.raw).toBeUndefined();
    expect(rec?.wrapped?.key.extractable).toBe(false);
    // the stored ciphertext is not the raw key
    expect(new Uint8Array(rec!.wrapped!.data).slice(0, 32)).not.toEqual(k.secretKey);
  });

  it('concurrent first use yields one key; forget deletes it', async () => {
    const store = memoryKeyStore();
    const [a, b] = await Promise.all([loadOrCreateDeviceKey(store), loadOrCreateDeviceKey(store)]);
    expect(a.pubkey).toBe(b.pubkey);
    await forgetDeviceKey(store);
    expect(await getDeviceKey(store)).toBeUndefined();
    const c = await loadOrCreateDeviceKey(store);
    expect(c.pubkey).not.toBe(a.pubkey);
  });

  it('rejects a corrupt record (pubkey mismatch)', async () => {
    const store = memoryKeyStore();
    const k = await loadOrCreateDeviceKey(store);
    const rec = (await store.get())!;
    await store.put({ ...rec, pubkey: laptop.pubkey });
    await expect(getDeviceKey(store)).rejects.toThrow(/corrupt/);
    expect(k).toBeDefined();
  });
});

describe('saved daemons', () => {
  it('saves (upsert by pubkey), activates, lists, renames and removes', () => {
    const a = saveDaemon({
      daemonPubkey: laptop.npub,
      relays: ['wss://r1.example', 'bogus'],
      name: 'Laptop',
    });
    expect(a).toMatchObject({
      id: laptop.pubkey,
      daemonNpub: laptop.npub,
      relays: ['wss://r1.example'],
      signer: 'device',
    });
    saveDaemon({ daemonPubkey: cloud.pubkey, relays: ['wss://r2.example'], name: 'Cloud' });
    expect(listDaemons().map((d) => d.name)).toEqual(['Cloud', 'Laptop']);
    expect(getActiveDaemon()?.name).toBe('Cloud');
    saveDaemon({ daemonPubkey: laptop.pubkey, relays: ['wss://r3.example'] });
    expect(listDaemons()).toHaveLength(2);
    expect(getActiveDaemon()).toMatchObject({ name: 'Laptop', relays: ['wss://r3.example'] });
    renameDaemon(laptop.pubkey, '  MacBook  ');
    expect(getActiveDaemon()?.name).toBe('MacBook');
    setActiveDaemon(cloud.pubkey);
    expect(getActiveDaemon()?.name).toBe('Cloud');
    expect(() => setActiveDaemon(generateAgentKey().pubkey)).toThrow();
    removeDaemon(cloud.pubkey);
    expect(getActiveDaemon()).toBeUndefined();
    expect(listDaemons()).toHaveLength(1);
    expect(() => saveDaemon({ daemonPubkey: cloud.pubkey, relays: [] })).toThrow(/relay/);
  });

  it('ignores corrupt storage', () => {
    localStorage.setItem('bh.daemons', '{nope');
    expect(listDaemons()).toEqual([]);
    localStorage.setItem('bh.daemons', JSON.stringify({ v: 1, active: 'x', daemons: [{ id: 'x' }] }));
    expect(listDaemons()).toEqual([]);
    expect(getActiveDaemon()).toBeUndefined();
  });

  it('useDaemons: switch reloads into the chosen daemon; removing the active one picks the next', () => {
    saveDaemon({ daemonPubkey: laptop.pubkey, relays: ['wss://r1.example'], name: 'Laptop' });
    saveDaemon({ daemonPubkey: cloud.pubkey, relays: ['wss://r2.example'], name: 'Cloud' });
    const reload = vi.fn();
    const { result } = renderHook(() => useDaemons(reload));
    expect(result.current.daemons).toHaveLength(2);
    expect(result.current.active?.name).toBe('Cloud');
    act(() => result.current.switchTo(laptop.pubkey));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(result.current.active?.name).toBe('Laptop');
    act(() => result.current.rename(laptop.pubkey, 'Work laptop'));
    expect(result.current.active?.name).toBe('Work laptop');
    act(() => result.current.remove(laptop.pubkey));
    expect(result.current.active?.name).toBe('Cloud');
    expect(reload).toHaveBeenCalledTimes(2);
    act(() => result.current.switchTo(cloud.pubkey, { reload: false }));
    expect(reload).toHaveBeenCalledTimes(2);
  });
});

describe('boot: resolveConnection', () => {
  it('saved daemon → nostr; mock param wins; #token wins over the saved daemon', () => {
    saveDaemon({ daemonPubkey: laptop.pubkey, relays: ['wss://r1.example'], name: 'Laptop' });
    expect(resolveConnection(window.location, { dev: false })).toMatchObject({
      kind: 'nostr',
      reason: 'saved-daemon',
      daemon: { daemonPubkey: laptop.pubkey, relays: ['wss://r1.example'] },
    });
    history.replaceState(null, '', '/?mock=1');
    expect(resolveConnection(window.location, { dev: false }).kind).toBe('mock');
    sessionStorage.clear();
    const tok = ['t', 'x'.repeat(8)].join('_');
    history.replaceState(null, '', `/#token=${tok}`);
    expect(resolveConnection(window.location, { dev: false })).toMatchObject({
      kind: 'local',
      reason: 'token',
    });
    // a stored token alone loses against the saved daemon
    history.replaceState(null, '', '/');
    expect(resolveConnection(window.location, { dev: false }).kind).toBe('nostr');
  });

  it('nothing saved: dev → mock (default), production → none (pair prompt)', () => {
    expect(resolveConnection(window.location, { dev: true })).toMatchObject({
      kind: 'mock',
      reason: 'no-token',
    });
    expect(resolveConnection(window.location, { dev: false })).toEqual({ kind: 'none', reason: 'unpaired' });
  });
});

describe('signers', () => {
  it('NIP-07 detection and adapter', async () => {
    expect(hasNip07(undefined)).toBe(false);
    expect(() => nip07Signer(undefined)).toThrow(SignerUnavailableError);
    const ext = {
      getPublicKey: async () => laptop.pubkey,
      signEvent: vi.fn(),
      nip44: { encrypt: vi.fn(async () => 'ct'), decrypt: vi.fn(async () => 'pt') },
    };
    expect(hasNip07({ getPublicKey: ext.getPublicKey, signEvent: ext.signEvent })).toBe(false);
    expect(() => nip07Signer({ getPublicKey: ext.getPublicKey, signEvent: ext.signEvent })).toThrow(/NIP-44/);
    expect(hasNip07(ext)).toBe(true);
    const s = nip07Signer(ext);
    expect(await s.getPublicKey()).toBe(laptop.pubkey);
    expect(await s.encrypt(cloud.pubkey, 'hi')).toBe('ct');
    expect(ext.nip44.encrypt).toHaveBeenCalledWith(cloud.pubkey, 'hi');
  });

  it('NIP-46: bunker URLs are validated; the signer is a clear stub', () => {
    const p = parseBunkerUrl(`bunker://${laptop.pubkey}?relay=wss://relay.example&relay=nope`);
    expect(p).toEqual({ pubkey: laptop.pubkey, relays: ['wss://relay.example'] });
    expect(() => parseBunkerUrl('https://x')).toThrow(/bunker/);
    expect(() => parseBunkerUrl('bunker://abc?relay=wss://r')).toThrow(/key/);
    expect(() => parseBunkerUrl(`bunker://${laptop.pubkey}`)).toThrow(/relay/);
    expect(() => nip46Signer(p)).toThrow(/not available yet/);
  });
});

describe('useDeviceIdentity', () => {
  it('reports this device from the active daemon and matches npub or hex', () => {
    const me = generateAgentKey();
    saveDaemon({ daemonPubkey: laptop.pubkey, relays: ['wss://r1.example'], deviceNpub: me.npub });
    const { result } = renderHook(() => useDeviceIdentity(memoryKeyStore()));
    expect(result.current.status).toBe('ready');
    expect(result.current.isThisDevice(me.npub)).toBe(true);
    expect(result.current.isThisDevice(me.pubkey)).toBe(true);
    expect(result.current.isThisDevice(laptop.npub)).toBe(false);
  });
});
