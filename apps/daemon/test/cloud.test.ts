// Cloud daemons over the Nostr control plane, end to end on an in-process fake relay: the deploy
// provisioning handshake (BEAMHOP_AWAIT_PROVISIONING), heartbeats and offline alerts, and panic /
// resume fan-out to the remote daemon.
import { rmSync } from 'node:fs';
import { createControlClient, generateAgentKey } from '@beamhop/channel-nostr';
import type { Deployer } from '@beamhop/core';
import { silentLogger } from '@beamhop/core';
import { ConfigStore } from '@beamhop/store';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { FakeRelay } from '../../../packages/channel-nostr/test/helpers/fake-relay.ts';
import { CONTROLLER_KEY_REF, HELLO_METHOD, PROVISION_METHOD, provisionKeyRef } from '../src/remote.ts';
import { FakeChannelPlugin, FakeHarnessPlugin, makeEnv, type TestEnv, tmpHome, until } from './helpers.ts';

let R: FakeRelay;
const envs: TestEnv[] = [];
const closers: { close(): void }[] = [];
beforeAll(async () => {
  R = await new FakeRelay().start();
});
afterAll(() => R.stop());
afterEach(async () => {
  for (const c of closers.splice(0)) c.close();
  for (const e of envs.splice(0)) {
    await e.d.remotes.settled();
    await e.close();
    rmSync(e.home, { recursive: true, force: true });
  }
  R.reset();
});

const HEARTBEAT = 1000;
const remoteOpts = { heartbeatMs: HEARTBEAT, missedHeartbeats: 2, helloMs: 0, callTimeoutMs: 3000 };

const fakeDeployer = (): Deployer => ({
  id: 'fakecloud',
  displayName: 'Fake Cloud',
  kind: 'vps',
  sizes: async () => [{ id: 's', label: 'small', monthlyUsd: 4 }],
  regions: async () => [{ id: 'r', label: 'R' }],
  plan: async (s) => ({ provider: s.provider, actions: [], monthlyCostUsd: 4, warnings: [] }),
  apply: async (s) => ({
    id: `fakecloud:${s.agent}`,
    provider: 'fakecloud',
    agent: s.agent,
    status: 'provisioning',
    createdAt: new Date().toISOString(),
  }),
  status: async (id) => ({
    id,
    provider: 'fakecloud',
    agent: 'bot',
    status: 'running',
    createdAt: new Date().toISOString(),
  }),
  logs: async function* () {},
  destroy: async () => {},
});

const daemon = async (opts: { env?: NodeJS.ProcessEnv; deployer?: boolean } = {}) => {
  const home = tmpHome();
  const cs = new ConfigStore({ home, logger: silentLogger });
  cs.ensureDirs();
  cs.saveGlobal({ nostr: { relays: [R.url] } });
  const channel = new FakeChannelPlugin();
  const harness = new FakeHarnessPlugin();
  const e = await makeEnv({
    home,
    channel,
    harness,
    plugins: {
      channels: [channel],
      harnesses: [harness],
      ...(opts.deployer ? { deployers: [fakeDeployer()] } : {}),
    },
    controlPlane: true,
    nostrWebSocket: WebSocket,
    remote: remoteOpts,
    env: opts.env ?? {},
  });
  envs.push(e);
  await e.d.control?.ready();
  return e;
};

/** Local daemon with an owner key, an agent on a fake channel and some secrets. */
const local = async () => {
  const L = await daemon({ deployer: true });
  const { npub: owner } = await L.client.call('identity.ownerCreate');
  await L.client.call('channel.add', {
    name: 'fk',
    provider: 'fake',
    values: {},
    secrets: { token: 'good' },
  });
  await L.client.call('agent.create', {
    config: { name: 'bot', harness: 'fake', memberships: [{ target: 'fk:dm', defaultRole: 'viewer' }] },
  });
  const llmKey = ['sk', 'test', 'x'.repeat(24)].join('-');
  await L.secrets.set('OPENAI_API_KEY', llmKey);
  await L.secrets.set('deploy.fakecloud.token', ['tok', 'y'.repeat(30)].join('_'));
  return { L, owner, llmKey };
};

const cloud = (owner: string, provisioningPubkey: string) =>
  daemon({
    env: {
      BEAMHOP_AWAIT_PROVISIONING: '1',
      BEAMHOP_OWNER_NPUB: owner,
      BEAMHOP_PROVISIONING_PUBKEY: provisioningPubkey,
      BEAMHOP_AGENT: 'bot',
      BEAMHOP_DEPLOY_PROVIDER: 'fakecloud',
      BEAMHOP_DAEMON_NSEC_REF: 'agent.bot.nsec',
    },
  });

const deployAndProvision = async () => {
  const { L, owner, llmKey } = await local();
  const dep = await L.client.call('deploy.apply', { agent: 'bot', provider: 'fakecloud', mode: 'new' });
  const rec = L.d.store.deployments.get(dep.id)!;
  const P = (rec.data as { provisioningPubkey: string }).provisioningPubkey;
  expect(P).toMatch(/^[0-9a-f]{64}$/);
  expect((await L.client.call('system.status')).remotes).toMatchObject([
    { deployment: dep.id, provisioning: 'pending', online: false },
  ]);
  const C = await cloud(owner, P);
  expect(C.d.cloud.awaiting()).toBe(true);
  expect(C.d.controlAllowlist()).toContain(P);
  // The host announces itself on its tick; the owner's daemon answers with the provisioning call.
  await C.d.tick();
  await until(() => C.d.cloud.provisioned(), 5000, 'provisioned');
  await L.d.remotes.settled();
  return { L, C, owner, llmKey, dep, P };
};

describe('cloud daemon provisioning', () => {
  it('provisions config + secrets over the control plane; provider tokens and internals stay local', async () => {
    const { L, C, llmKey, dep, P } = await deployAndProvision();
    // Remote got the agent, its channel and the secrets those need.
    expect(C.d.config.agents.get('bot')?.harness).toBe('fake');
    expect(C.d.config.channels.get('fk')?.provider).toBe('fake');
    expect(await C.secrets.get('channel.fk.token')).toBe('good');
    expect(await C.secrets.get('OPENAI_API_KEY')).toBe(llmKey);
    expect(await C.secrets.get('agent.bot.nsec')).toBe(await L.secrets.get('agent.bot.nsec'));
    expect(await C.secrets.get('deploy.fakecloud.token')).toBeUndefined();
    expect(await C.secrets.get('beamhop.owner.nsec')).toBeUndefined();
    // Its control key was not replaced by the agent key (BEAMHOP_DAEMON_NSEC_REF).
    expect(C.d.control!.npub).not.toBe(C.d.config.agents.get('bot')?.identity.npub);
    // The provisioning key is retired on both sides; the controller became a paired device.
    expect(C.d.controlAllowlist()).not.toContain(P);
    expect(await L.secrets.get(provisionKeyRef('bot'))).toBeUndefined();
    const controller = (await L.d.remotes.controllerKey()).npub;
    expect(C.d.store.devices.list().map((d) => d.pubkey)).toContain(controller);
    // Nothing on the wire is plaintext.
    expect(R.received.some((e) => e.content.includes(llmKey) || e.content.includes('good'))).toBe(false);
    const rec = L.d.store.deployments.get(dep.id)!;
    expect(rec.data).toMatchObject({ provisioning: 'done', daemonNpub: C.d.control!.npub });
    expect(C.d.store.audit.query({ type: 'cloud.provisioned' })).toHaveLength(1);
    expect(L.d.store.audit.query({ type: 'deploy.provisioned' })[0]!.data.secrets).not.toContain(
      'deploy.fakecloud.token',
    );
    // The remote's channels came up after provisioning.
    await until(() => C.channel.conns.has('fk'), 3000, 'remote channel');
    expect(await L.secrets.get(CONTROLLER_KEY_REF)).toMatch(/^nsec1/);
  });

  it('only the owner or the one-time provisioning key may provision; hellos must match the agent', async () => {
    const { L, owner } = await local();
    await L.client.call('deploy.apply', { agent: 'bot', provider: 'fakecloud', mode: 'new' });
    const P = (L.d.store.deployments.get('fakecloud:bot')!.data as { provisioningPubkey: string })
      .provisioningPubkey;
    const C = await cloud(owner, P);
    const stranger = generateAgentKey();
    const asStranger = createControlClient({
      key: stranger.nsec,
      daemonPubkey: C.d.control!.npub,
      relays: [R.url],
      WebSocket,
      timeoutMs: 2000,
    });
    closers.push(asStranger);
    await asStranger.ready();
    await expect(
      asStranger.call(PROVISION_METHOD, { v: 1, agent: {}, secrets: {}, controllers: [stranger.npub] }),
    ).rejects.toThrow(/not paired/);
    // A hello for another agent is refused by the owner's daemon (nothing is provisioned).
    const impostor = createControlClient({
      key: stranger.nsec,
      daemonPubkey: P,
      relays: [R.url],
      WebSocket,
      timeoutMs: 2000,
    });
    closers.push(impostor);
    await impostor.ready();
    await expect(impostor.call(HELLO_METHOD, { agent: 'other', npub: stranger.npub })).rejects.toThrow(
      /mismatch/,
    );
    expect(C.d.cloud.provisioned()).toBe(false);
    // Bad payloads from the owner's own key are rejected with a reason, nothing written.
    const ownerNsec = (await L.client.call('identity.ownerExport')).nsec;
    const asOwner = createControlClient({
      key: ownerNsec,
      daemonPubkey: C.d.control!.npub,
      relays: [R.url],
      WebSocket,
      timeoutMs: 2000,
    });
    closers.push(asOwner);
    await asOwner.ready();
    await expect(
      asOwner.call(PROVISION_METHOD, {
        v: 1,
        agent: { name: 'bot', harness: 'fake' },
        secrets: { 'beamhop.owner.nsec': 'x'.repeat(10) },
        controllers: [],
      }),
    ).rejects.toThrow(/cannot be provisioned/);
    await expect(
      asOwner.call(PROVISION_METHOD, {
        v: 1,
        agent: { name: 'evil', harness: 'fake' },
        secrets: {},
        controllers: [],
      }),
    ).rejects.toThrow(/runs agent bot/);
    expect(C.d.config.agents.get('bot')).toBeUndefined();
    expect(C.d.cloud.provisioned()).toBe(false);
  });
});

describe('heartbeats and panic fan-out', () => {
  it('heartbeats mark the remote online; missed beats mark it offline and alert once', async () => {
    const { L, C, dep } = await deployAndProvision();
    C.clock.t += HEARTBEAT;
    await C.d.tick();
    await until(() => L.d.remotes.views()[0]?.lastHeartbeatAt !== undefined, 3000, 'first heartbeat');
    let v = (await L.client.call('system.status')).remotes![0]!;
    expect(v).toMatchObject({ deployment: dep.id, provisioning: 'done', online: true, remotePanic: false });
    expect(v.npub).toBe(C.d.control!.npub);
    // No beats for > 2 intervals → offline + one alert.
    L.clock.t += 2 * HEARTBEAT + 1;
    L.d.tick();
    await L.d.tick();
    v = (await L.client.call('system.status')).remotes![0]!;
    expect(v.online).toBe(false);
    expect(L.d.store.audit.query({ type: 'remote.offline' })).toHaveLength(1);
    // Back: the next beat brings it online again.
    C.clock.t += HEARTBEAT;
    await C.d.tick();
    await until(() => L.d.remotes.views()[0]!.online, 3000, 'online again');
    expect(L.d.store.audit.query({ type: 'remote.online' })).toHaveLength(1);
  });

  it('system.panic / system.resume reach the cloud daemon; status shows the outcome per remote', async () => {
    const { L, C } = await deployAndProvision();
    await L.client.call('system.panic', { reason: 'drill' });
    expect(L.d.isPanic()).toBe(true);
    expect(C.d.isPanic()).toBe(true);
    expect(C.d.store.audit.query({ type: 'panic' })[0]!.summary).toContain('drill');
    let v = (await L.client.call('system.status')).remotes![0]!;
    expect(v.command).toMatchObject({ kind: 'panic', state: 'acked' });
    expect(v.remotePanic).toBe(true);
    // Heartbeats keep flowing during a panic and report it.
    C.clock.t += HEARTBEAT;
    await C.d.tick();
    await until(() => L.d.remotes.views()[0]!.remotePanic === true, 3000, 'panic beat');
    await L.client.call('system.resume');
    expect(C.d.isPanic()).toBe(false);
    v = (await L.client.call('system.status')).remotes![0]!;
    expect(v.command).toMatchObject({ kind: 'resume', state: 'acked' });
  });

  it('an unreachable remote shows a failed command but the local panic still completes', async () => {
    const { L, C } = await deployAndProvision();
    await C.close();
    envs.splice(envs.indexOf(C), 1);
    rmSync(C.home, { recursive: true, force: true });
    await L.client.call('system.panic', {});
    expect(L.d.isPanic()).toBe(true);
    const v = (await L.client.call('system.status')).remotes![0]!;
    expect(v.command).toMatchObject({ kind: 'panic', state: 'failed' });
    expect(v.command?.error).toMatch(/timed out/);
  }, 15_000);
});
