import { generateAgentKey } from '@beamhop/channel-nostr';
import { RpcError } from '@beamhop/client';
import type { ServerEvent } from '@beamhop/core';
import { QueryClient } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { deviceIdentity, signerIdentity } from './identity.ts';
import { type NostrTransport, type NostrTransportOptions, nostrTransport } from './nostr.ts';
import { createRuntime } from './provider.tsx';
import {
  beamhopError,
  type FakeDaemon,
  FakeRelay,
  fakeExtensionSigner,
  sleep,
  startFakeDaemon,
  waitFor,
} from './test/hosted-fixtures.ts';

let R: FakeRelay;
const closers: { close(): void }[] = [];

beforeAll(async () => {
  R = await new FakeRelay().start();
});
afterAll(() => R.stop());
afterEach(() => {
  for (const c of closers.splice(0)) c.close();
});

const phoneKey = () => {
  const k = generateAgentKey();
  return { ...k, createdAt: new Date().toISOString() };
};

const setup = async (extra: Partial<NostrTransportOptions> = {}) => {
  const phone = phoneKey();
  const daemon = await startFakeDaemon(R, { allowlist: [phone.pubkey] });
  closers.push(daemon.server);
  const statuses: string[] = [];
  const t = nostrTransport({
    daemonPubkey: daemon.key.pubkey,
    relays: [R.url],
    identity: deviceIdentity(phone),
    pollMs: 20,
    timeoutMs: 1500,
    backoff: { initialMs: 30, maxMs: 100 },
    onStatus: (s) => statuses.push(s),
    ...extra,
  });
  closers.push(t);
  return { t, daemon, phone, statuses };
};

const waitOpen = (t: NostrTransport) => waitFor(() => t.status() === 'open', 5000);

describe('nostrTransport', () => {
  it('sends requests and resolves with the daemon result; health shows relays + daemon', async () => {
    const { t, daemon, phone, statuses } = await setup();
    daemon.handlers['system.status'] = () => ({ version: '1.4.2' });
    await expect(t.request('system.status', {})).resolves.toEqual({ version: '1.4.2' });
    expect(daemon.calls[0]).toMatchObject({ method: 'system.status', sender: phone.pubkey });
    expect(t.status()).toBe('open');
    expect(statuses[0]).toBe('open');
    const h = t.health();
    expect(h).toMatchObject({ up: 1, total: 1, daemon: 'reachable', queued: 0 });
    expect(h.relays[0]).toMatchObject({ connected: true });
    expect(h.identity).toEqual({ kind: 'device', npub: phone.npub });
    expect(h.daemonNpub).toBe(daemon.key.npub);
  });

  it('maps daemon errors to RpcError with code + data', async () => {
    const { t, daemon } = await setup();
    daemon.handlers['agent.get'] = () => {
      throw beamhopError('not_found', 'agent nope not found');
    };
    const err = (await t.request('agent.get', { name: 'nope' }).catch((e) => e)) as RpcError;
    expect(err).toBeInstanceOf(RpcError);
    expect(err.code).toBe(-32010);
    expect(err.beamhopCode).toBe('not_found');
    expect(err.message).toMatch(/not found/);
  });

  it('delivers pushed server events to subscribers', async () => {
    const { t, daemon } = await setup();
    const got: ServerEvent[] = [];
    t.subscribe?.((e) => got.push(e));
    await t.request('system.ping', {}); // ensures the subscription is live
    const ev = { type: 'panic', on: true } as unknown as ServerEvent;
    await daemon.server.notify(ev);
    await waitFor(() => got.length === 1);
    expect(got[0]).toEqual(ev);
  });

  it('times out when the daemon never answers and marks it unreachable', async () => {
    const { t, daemon } = await setup({ timeoutMs: 300 });
    daemon.silent.add('slow.method');
    const err = (await t.request('slow.method', {}).catch((e) => e)) as RpcError;
    expect(err).toBeInstanceOf(RpcError);
    expect(err.code).toBe(-32000);
    expect(err.beamhopCode).toBe('timeout');
    expect(t.health().daemon).toBe('unreachable');
  });

  it('an unpaired / removed key gets `unauthorized` and health.daemon = unpaired', async () => {
    const daemon = await startFakeDaemon(R, { allowlist: [] });
    closers.push(daemon.server);
    const t = nostrTransport({
      daemonPubkey: daemon.key.pubkey,
      relays: [R.url],
      identity: deviceIdentity(phoneKey()),
      pollMs: 20,
      timeoutMs: 1500,
    });
    closers.push(t);
    const err = (await t.request('system.status', {}).catch((e) => e)) as RpcError;
    expect(err.beamhopCode).toBe('unauthorized');
    expect(daemon.calls).toHaveLength(0);
    expect(t.health().daemon).toBe('unpaired');
  });

  it('queues requests while offline and flushes them when back online', async () => {
    let online = false;
    const { t, daemon } = await setup({ isOnline: () => online });
    daemon.handlers['system.status'] = () => ({ ok: true });
    const p = t.request('system.status', {});
    await waitFor(() => t.health().queued === 1);
    await sleep(100);
    expect(daemon.calls).toHaveLength(0);
    online = true;
    await expect(p).resolves.toEqual({ ok: true });
    expect(t.health().queued).toBe(0);
  });

  it('fails queued requests after queueTimeoutMs with an offline error', async () => {
    const { t } = await setup({ isOnline: () => false, queueTimeoutMs: 150 });
    const err = (await t.request('system.status', {}).catch((e) => e)) as RpcError;
    expect(err.beamhopCode).toBe('offline');
    expect(t.health().queued).toBe(0);
  });

  it('bounds the offline queue', async () => {
    const { t } = await setup({ isOnline: () => false, maxQueue: 2, queueTimeoutMs: 5000 });
    void t.request('a', {}).catch(() => {});
    void t.request('b', {}).catch(() => {});
    const err = (await t.request('c', {}).catch((e) => e)) as RpcError;
    expect(err.beamhopCode).toBe('unavailable');
  });

  it('reconnects after the relay drops: status closed → open, queued calls go out after', async () => {
    let online = true;
    const { t, daemon, statuses } = await setup({ isOnline: () => online });
    daemon.handlers['system.status'] = () => ({ ok: 1 });
    await t.request('system.status', {});
    R.dropAll();
    await waitFor(() => t.status() === 'closed', 3000);
    // Hold the call in the queue until both sides (phone + fake daemon) are back on the relay:
    // control events are ephemeral, so a request published before the daemon resubscribed is lost.
    online = false;
    const p = t.request('system.status', {});
    await waitFor(() => R.connections >= 2 && t.health().up === 1, 8000);
    await sleep(100);
    expect(t.health().queued).toBe(1);
    online = true;
    await waitOpen(t);
    await expect(p).resolves.toEqual({ ok: 1 });
    expect(statuses).toEqual(expect.arrayContaining(['open', 'closed']));
    expect(statuses.at(-1)).toBe('open');
    // events still flow on the resubscribed connection
    const got: ServerEvent[] = [];
    t.subscribe?.((e) => got.push(e));
    await daemon.server.notify({ type: 'panic', on: false } as unknown as ServerEvent);
    await waitFor(() => got.length === 1);
  });

  it('reports `connecting` while no relay was ever reached', async () => {
    const t = nostrTransport({
      daemonPubkey: generateAgentKey().pubkey,
      relays: ['ws://127.0.0.1:1'],
      identity: deviceIdentity(phoneKey()),
      pollMs: 20,
      connectTimeoutMs: 200,
      queueTimeoutMs: 200,
    });
    closers.push(t);
    await sleep(100);
    expect(t.status()).toBe('connecting');
    const err = (await t.request('x', {}).catch((e) => e)) as RpcError;
    expect(err.beamhopCode).toBe('unavailable');
    expect(t.health().up).toBe(0);
  });

  it('works with a NIP-07-style signer, including chunked (large) responses', async () => {
    const sk = generateAgentKey().secretKey;
    const signer = fakeExtensionSigner(sk);
    const id = await signerIdentity(signer, 'nip07');
    const daemon: FakeDaemon = await startFakeDaemon(R, { allowlist: [id.pubkey] });
    closers.push(daemon.server);
    daemon.handlers.big = () => ({ blob: 'y'.repeat(70_000) });
    const t = nostrTransport({ daemonPubkey: daemon.key.pubkey, relays: [R.url], identity: id, pollMs: 20 });
    closers.push(t);
    await expect(t.request('hello', { a: 1 })).resolves.toEqual({ echo: { a: 1 }, method: 'hello' });
    const big = (await t.request('big', {})) as { blob: string };
    expect(big.blob.length).toBe(70_000);
    expect(signer.signed).toBe(2);
    expect(t.health().identity?.kind).toBe('nip07');
    // chunked request too
    const long = 'z'.repeat(45_000);
    await expect(t.request('echo', { long })).resolves.toMatchObject({ echo: { long } });
  });

  it('fails every call with signer_unavailable when the identity cannot load', async () => {
    const t = nostrTransport({
      daemonPubkey: generateAgentKey().pubkey,
      relays: [R.url],
      identity: async () => {
        throw new Error('No Nostr browser extension (NIP-07) found.');
      },
      pollMs: 20,
    });
    closers.push(t);
    const err = (await t.request('x', {}).catch((e) => e)) as RpcError;
    expect(err.beamhopCode).toBe('signer_unavailable');
    expect(t.status()).toBe('closed');
    expect(t.health().error).toMatch(/NIP-07/);
  });

  it('rejects pending and new calls after close()', async () => {
    const { t, daemon } = await setup();
    daemon.silent.add('hang');
    await t.request('warmup', {});
    const p = t.request('hang', {});
    await sleep(50);
    t.close();
    const err = (await p.catch((e) => e)) as RpcError;
    expect(err.code).toBe(-32000);
    await expect(t.request('x', {})).rejects.toBeInstanceOf(RpcError);
    expect(t.status()).toBe('closed');
  });
});

describe('createRuntime (hosted)', () => {
  it('boots a nostr runtime from a saved daemon and exposes hosted health', async () => {
    const phone = phoneKey();
    const daemon = await startFakeDaemon(R, { allowlist: [phone.pubkey] });
    closers.push(daemon.server);
    daemon.handlers['agent.list'] = () => ({ agents: [] });
    const rt = createRuntime(
      {
        kind: 'nostr',
        reason: 'saved-daemon',
        daemon: {
          id: daemon.key.pubkey,
          daemonPubkey: daemon.key.pubkey,
          daemonNpub: daemon.key.npub,
          relays: [R.url],
          name: 'Laptop',
          signer: 'device',
          pairedAt: new Date().toISOString(),
        },
      },
      new QueryClient(),
      undefined,
      { identity: deviceIdentity(phone), nostr: { pollMs: 20 } },
    );
    closers.push(rt);
    await expect(rt.client.call('agent.list')).resolves.toEqual({ agents: [] });
    await waitFor(() => rt.getStatus() === 'open');
    expect(rt.getHosted()).toMatchObject({ up: 1, total: 1, daemon: 'reachable' });
  });

  it('kind none: every call fails with not_paired and status is closed', async () => {
    const rt = createRuntime({ kind: 'none', reason: 'unpaired' }, new QueryClient());
    closers.push(rt);
    const err = (await rt.client.call('agent.list').catch((e) => e)) as RpcError;
    expect(err.beamhopCode).toBe('not_paired');
    await sleep(0);
    expect(rt.getStatus()).toBe('closed');
  });
});
