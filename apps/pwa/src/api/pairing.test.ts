import { generateAgentKey, npubEncode } from '@beamhop/channel-nostr';
import { encodePairingPayload, safetyPhrase } from '@beamhop/channel-nostr/pairing';
import type { DeviceView } from '@beamhop/core';
import { act, renderHook, waitFor as waitForHook } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getActiveDaemon, listDaemons } from './daemons.ts';
import { deviceIdentity, signerIdentity } from './identity.ts';
import {
  createPairingController,
  DEMO_PAIRING_PAYLOAD,
  defaultDeviceName,
  type PairingDeps,
  parsePairingInput,
  usePairing,
} from './pairing.ts';
import {
  beamhopError,
  type FakeDaemon,
  FakeRelay,
  fakeExtensionSigner,
  startFakeDaemon,
  waitFor,
} from './test/hosted-fixtures.ts';

let R: FakeRelay;
const closers: { close(): void }[] = [];
beforeAll(async () => {
  R = await new FakeRelay().start();
});
afterAll(() => R.stop());
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  for (const c of closers.splice(0)) c.close();
});

/** A fake daemon with the device.pairComplete / device.list semantics of apps/daemon/src/pairing.ts. */
const pairingDaemon = async (opts: { requireConfirm?: boolean; code?: string } = {}) => {
  const d: FakeDaemon = await startFakeDaemon(R);
  closers.push(d.server);
  const code = opts.code ?? 'ABCD2345';
  const devices: DeviceView[] = [];
  const pending: DeviceView[] = [];
  let used = false;
  d.handlers['device.pairComplete'] = (p) => {
    const params = p as { code: string; pubkey: string; name: string };
    if (used) throw beamhopError('unauthorized', 'pairing code used');
    if (params.code !== code) throw beamhopError('unauthorized', 'pairing code unknown');
    used = true;
    const dev: DeviceView = {
      id: `dev_${devices.length + pending.length + 1}`,
      name: params.name,
      pubkey: params.pubkey,
      pairedAt: new Date().toISOString(),
      pushEnabled: false,
    };
    if (opts.requireConfirm) pending.push(dev);
    else confirm(dev);
    return dev;
  };
  d.handlers['device.list'] = () => ({ devices });
  const confirm = (dev = pending.shift()) => {
    if (!dev) throw new Error('nothing pending');
    devices.push(dev);
    d.server.setAllowlist([...d.server.allowlist(), dev.pubkey]);
  };
  /** Computer said yes, then removed the device anyway: allowlisted but not listed. */
  const allowWithoutListing = () => {
    const dev = pending.shift()!;
    d.server.setAllowlist([...d.server.allowlist(), dev.pubkey]);
  };
  const payload = (extra: { exp?: number; name?: string } = {}) =>
    encodePairingPayload({
      v: 1,
      daemon: d.key.pubkey,
      relays: [R.url],
      code,
      name: 'Alice’s MacBook',
      ...extra,
    });
  return { d, payload, confirm, allowWithoutListing, pending, devices };
};

const fastDeps = (key = generateAgentKey(), extra: Partial<PairingDeps> = {}): Partial<PairingDeps> => ({
  identity: async () => deviceIdentity({ ...key, createdAt: new Date().toISOString() }),
  pollIntervalMs: 40,
  probeTimeoutMs: 600,
  callTimeoutMs: 1500,
  confirmGraceMs: 60_000,
  ...extra,
});

describe('pairing controller (fake relay + control server)', () => {
  it('pairs without confirmation, shows the shared safety phrase, saves the daemon', async () => {
    const { d, payload } = await pairingDaemon();
    const key = generateAgentKey();
    const c = createPairingController(fastDeps(key));
    closers.push({ close: () => c.dispose() });
    const ready = await c.setInput(`https://app.beamhop.dev/pair#${payload()}`);
    expect(ready.phase).toBe('ready');
    expect(ready.computerName).toBe('Alice’s MacBook');
    expect(ready.safetyPhrase).toEqual(safetyPhrase(d.key.pubkey, key.pubkey));
    expect(ready.safetyPhraseText).toMatch(/^[A-Z]+( · [A-Z]+){3}$/);
    expect(ready.deviceNpub).toBe(key.npub);
    const done = await c.pair({ name: 'iPhone · Safari' });
    expect(done.phase).toBe('paired');
    expect(done.device).toMatchObject({ name: 'iPhone · Safari', pubkey: key.npub });
    expect(d.calls.find((x) => x.method === 'device.pairComplete')?.sender).toBe(key.pubkey);
    // persisted: next boot is hosted mode on this daemon
    expect(getActiveDaemon()).toMatchObject({
      daemonPubkey: d.key.pubkey,
      daemonNpub: d.key.npub,
      relays: [R.url],
      name: 'Alice’s MacBook',
      signer: 'device',
      deviceId: done.device?.id,
      deviceNpub: key.npub,
    });
    expect(done.daemon?.id).toBe(d.key.pubkey);
    // the pairing connection stays usable for the push step
    await expect(
      c.call('device.pushSubscribe', { id: done.device?.id, subscription: {} }),
    ).resolves.toMatchObject({
      method: 'device.pushSubscribe',
    });
  });

  it('waits in awaiting-confirm until the computer confirms the safety phrase', async () => {
    const { payload, confirm } = await pairingDaemon({ requireConfirm: true });
    const c = createPairingController(fastDeps());
    closers.push({ close: () => c.dispose() });
    await c.setInput(payload());
    const done = c.pair({ name: 'Pixel · Chrome' });
    await waitFor(() => c.getState().phase === 'awaiting-confirm', 5000);
    expect(c.getState().confirmDeadline).toBeGreaterThan(Date.now());
    await new Promise((r) => setTimeout(r, 300));
    expect(c.getState().phase).toBe('awaiting-confirm');
    expect(listDaemons()).toHaveLength(0);
    confirm();
    expect((await done).phase).toBe('paired');
    expect(listDaemons()).toHaveLength(1);
  });

  it('rejected: the code was already used / unknown', async () => {
    const { payload } = await pairingDaemon();
    const first = createPairingController(fastDeps());
    closers.push({ close: () => first.dispose() });
    await first.setInput(payload());
    expect((await first.pair({ name: 'a' })).phase).toBe('paired');
    localStorage.clear();
    const second = createPairingController(fastDeps());
    closers.push({ close: () => second.dispose() });
    await second.setInput(payload());
    const s = await second.pair({ name: 'b' });
    expect(s.phase).toBe('rejected');
    expect(s.error).toMatch(/already used/);
    expect(listDaemons()).toHaveLength(0);
  });

  it('rejected: the daemon answers but no longer lists the device', async () => {
    const { payload, allowWithoutListing } = await pairingDaemon({ requireConfirm: true });
    const c = createPairingController(fastDeps());
    closers.push({ close: () => c.dispose() });
    await c.setInput(payload());
    const done = c.pair({ name: 'x' });
    await waitFor(() => c.getState().phase === 'awaiting-confirm', 5000);
    allowWithoutListing();
    const s = await done;
    expect(s.phase).toBe('rejected');
    expect(listDaemons()).toHaveLength(0);
  });

  it('expired: the payload is past its expiry (no network call)', async () => {
    const { d, payload } = await pairingDaemon();
    const c = createPairingController(fastDeps());
    const s = await c.setInput(payload({ exp: Math.floor(Date.now() / 1000) - 5 }));
    expect(s.phase).toBe('expired');
    expect(await c.pair({ name: 'x' })).toMatchObject({ phase: 'expired' });
    expect(d.calls).toHaveLength(0);
  });

  it('expired: the computer never confirms within the grace window', async () => {
    const { payload } = await pairingDaemon({ requireConfirm: true });
    const c = createPairingController(fastDeps(undefined, { confirmGraceMs: 400 }));
    closers.push({ close: () => c.dispose() });
    await c.setInput(payload());
    const s = await c.pair({ name: 'x' });
    expect(s.phase).toBe('expired');
    expect(listDaemons()).toHaveLength(0);
  });

  it('error (retryable) when nobody answers, then pairs on retry', async () => {
    const { d, payload } = await pairingDaemon();
    d.silent.add('device.pairComplete');
    const c = createPairingController(fastDeps(undefined, { callTimeoutMs: 400 }));
    closers.push({ close: () => c.dispose() });
    await c.setInput(payload());
    const s = await c.pair({ name: 'x' });
    expect(s.phase).toBe('error');
    expect(s.error).toMatch(/did not answer/);
    d.silent.delete('device.pairComplete');
    expect((await c.pair({ name: 'x' })).phase).toBe('paired');
  });

  it('cancel() stops waiting and returns to ready', async () => {
    const { payload } = await pairingDaemon({ requireConfirm: true });
    const c = createPairingController(fastDeps());
    await c.setInput(payload());
    const done = c.pair({ name: 'x' });
    await waitFor(() => c.getState().phase === 'awaiting-confirm', 5000);
    c.cancel();
    expect(c.getState().phase).toBe('ready');
    await done;
    expect(c.getState().phase).toBe('ready');
  });

  it('pairs with a NIP-07 signer (signer-client path, no secret key in the PWA)', async () => {
    const { d, payload } = await pairingDaemon();
    const sk = generateAgentKey().secretKey;
    const signer = fakeExtensionSigner(sk);
    const c = createPairingController(
      fastDeps(undefined, { identity: () => signerIdentity(signer, 'nip07') }),
    );
    closers.push({ close: () => c.dispose() });
    await c.setSigner('nip07');
    const ready = await c.setInput(payload());
    expect(ready.signer).toBe('nip07');
    const s = await c.pair({ name: 'Firefox' });
    expect(s.phase).toBe('paired');
    expect(getActiveDaemon()?.signer).toBe('nip07');
    expect(d.calls[0]?.params).toMatchObject({
      pubkey: npubEncode((await signer.getPublicKey()).toLowerCase()),
    });
  });

  it('bad payloads are `invalid` with a friendly message', async () => {
    const c = createPairingController(fastDeps());
    for (const bad of ['garbage!!', 'https://app.beamhop.dev/pair#eyJ2IjoyfQ', `#${btoa('{"v":1}')}`]) {
      const s = await c.setInput(bad);
      expect(s.phase).toBe('invalid');
      expect(s.error).toBeTruthy();
    }
    expect((await c.setInput('')).phase).toBe('empty');
    expect(parsePairingInput('nope')).toMatchObject({ ok: false });
  });
});

describe('usePairing (hook)', () => {
  it('reads the payload from the URL fragment, strips it, and pairs', async () => {
    const { payload } = await pairingDaemon();
    history.replaceState(null, '', `/pair#${payload()}`);
    const { result, unmount } = renderHook(() => usePairing({ deps: fastDeps() }));
    await waitForHook(() => expect(result.current.phase).toBe('ready'));
    expect(window.location.hash).toBe('');
    expect(sessionStorage.getItem('bh.pairPayload')).toBe(payload());
    expect(result.current.safetyPhrase).toHaveLength(4);
    let final: Awaited<ReturnType<typeof result.current.pair>> | undefined;
    await act(async () => {
      final = await result.current.pair({ name: result.current.defaultName });
    });
    expect(final?.phase).toBe('paired');
    expect(result.current.phase).toBe('paired');
    expect(result.current.daemon?.relays).toEqual([R.url]);
    expect(sessionStorage.getItem('bh.pairPayload')).toBeNull();
    unmount();
  });

  it('demo payload runs the simulated flow without network or persistence', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { result, unmount } = renderHook(() =>
        usePairing({ input: DEMO_PAIRING_PAYLOAD, deps: { identity: fastDeps().identity! } }),
      );
      await waitForHook(() => expect(result.current.phase).toBe('ready'));
      expect(result.current.simulated).toBe(true);
      let p: Promise<unknown> | undefined;
      act(() => {
        p = result.current.pair({ name: 'Demo phone' });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
        await p;
      });
      expect(result.current.phase).toBe('paired');
      expect(listDaemons()).toHaveLength(0);
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('simulate: "rejected" ends rejected', async () => {
    const { result } = renderHook(() =>
      usePairing({
        input: DEMO_PAIRING_PAYLOAD,
        simulate: 'rejected',
        deps: { ...fastDeps(), simulate: { outcome: 'rejected', delayMs: 50 } },
      }),
    );
    await waitForHook(() => expect(result.current.phase).toBe('ready'));
    await act(async () => {
      await result.current.pair({ name: 'x' });
    });
    expect(result.current.phase).toBe('rejected');
  });

  it('starts empty without a payload and accepts a pasted link later', async () => {
    const { payload } = await pairingDaemon();
    history.replaceState(null, '', '/pair');
    const { result } = renderHook(() => usePairing({ deps: fastDeps() }));
    expect(result.current.phase).toBe('empty');
    await act(async () => {
      await result.current.setInput('not a link');
    });
    expect(result.current.phase).toBe('invalid');
    await act(async () => {
      await result.current.setInput(`beamhop://pair#${payload()}`);
    });
    expect(result.current.phase).toBe('ready');
  });
});

describe('defaultDeviceName', () => {
  it('derives "device · browser" from the user agent', () => {
    expect(
      defaultDeviceName(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('iPhone · Safari');
    expect(
      defaultDeviceName(
        'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
      ),
    ).toBe('Android · Chrome');
    expect(defaultDeviceName('')).toBe('Browser');
  });
});
