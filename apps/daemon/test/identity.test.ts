// Agent identities, the default agent-keyed nostr channel, onboarding hello and device pairing,
// against the real nostr channel plugin and control plane on an in-process fake relay.
import { rmSync } from 'node:fs';
import {
  ATTESTATION_KIND,
  CAPABILITY_CARD_KIND,
  completePairing,
  createControlClient,
  createNostrChannel,
  decodePairingPayload,
  generateAgentKey,
  type NostrConn,
  safetyPhrase,
  signEvent,
  verifyAttestation,
} from '@beamhop/channel-nostr';
import type { RpcError } from '@beamhop/client';
import { type InboundMsg, silentLogger } from '@beamhop/core';
import { ConfigStore } from '@beamhop/store';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { FakeRelay } from '../../../packages/channel-nostr/test/helpers/fake-relay.ts';
import { FakeChannelPlugin, FakeHarnessPlugin, makeEnv, type TestEnv, tmpHome, until } from './helpers.ts';

let R: FakeRelay;
let env: TestEnv | undefined;
const phones: { close(): unknown }[] = [];

beforeAll(async () => {
  R = await new FakeRelay().start();
});
afterAll(() => R.stop());
afterEach(async () => {
  for (const p of phones.splice(0)) await p.close();
  await env?.d.identity.settled();
  await env?.close();
  env = undefined;
  R.reset();
});

const code = (e: unknown) => (e as RpcError).beamhopCode ?? (e as { code?: string }).code;
const WS = WebSocket as never;

const start = async (opts: { controlPlane?: boolean } = {}) => {
  const home = tmpHome();
  const cs = new ConfigStore({ home, logger: silentLogger });
  cs.ensureDirs();
  cs.saveGlobal({ nostr: { relays: [R.url] } });
  const harness = new FakeHarnessPlugin();
  env = await makeEnv({
    home,
    harness,
    plugins: {
      channels: [createNostrChannel({ WebSocket: WS }), new FakeChannelPlugin()],
      harnesses: [harness],
    },
    controlPlane: opts.controlPlane ?? false,
    nostrWebSocket: WebSocket,
  });
  const close = env.close;
  env.close = async () => {
    await close();
    rmSync(home, { recursive: true, force: true });
  };
  return env;
};

/** A "phone": an independent nostr client holding `nsec` (e.g. the owner's exported key). */
const phone = async (nsec: string) => {
  const conn = (await createNostrChannel({ WebSocket: WS }).connect({
    name: 'phone',
    settings: { relays: [R.url], publishDmRelays: false },
    secrets: { nsec },
    log: silentLogger,
    state: { get: async () => undefined, set: async () => {}, delete: async () => {} },
  })) as NostrConn;
  phones.push(conn);
  const inbox: InboundMsg[] = [];
  void (async () => {
    for await (const m of conn.inbound()) inbox.push(m);
  })();
  return { conn, inbox };
};

const eventsOf = (pubkey: string, kind: number) =>
  R.events.filter((e) => e.pubkey === pubkey && e.kind === kind);

describe('agent identities', () => {
  it('agent.create generates a key, connects it on the default nostr channel and publishes profile, attestation and card', async () => {
    const e = await start();
    const { npub: owner } = await e.client.call('identity.ownerCreate');
    expect(owner).toMatch(/^npub1/);
    const g = e.d.global();
    expect(g.nostr.ownerNpub).toBe(owner);
    expect(g.owners).toContain(`nostr:${owner}`);

    const v = await e.client.call('agent.create', {
      config: {
        name: 'rev',
        harness: 'fake',
        description: 'Reviews PRs',
        memberships: [{ target: 'nostr:dm' }],
      },
    });
    const npub = v.config.identity.npub!;
    expect(npub).toMatch(/^npub1/);
    expect(v.config.identity.nostrKeyRef).toBe('agent.rev.nsec');
    expect(await e.secrets.get('agent.rev.nsec')).toMatch(/^nsec1/);

    const ch = (await e.client.call('channel.list')).channels.find((c) => c.config.name === 'nostr');
    expect(ch?.config.settings).toMatchObject({ relays: [R.url], agentKeys: true });
    expect(ch?.status).toBe('connected');
    const conn = e.d.channels.get('nostr@rev') as NostrConn;
    expect(conn.npub).toBe(npub);

    await e.d.identity.settled();
    const pk = conn.pubkey;
    await until(() => eventsOf(pk, 0).length > 0 && eventsOf(pk, CAPABILITY_CARD_KIND).length > 0, 3000);
    const profile = JSON.parse(eventsOf(pk, 0)[0]!.content);
    expect(profile).toMatchObject({ name: 'rev', bot: true });
    expect(profile.about).toContain(`AI agent operated by ${owner}`);
    const att = R.events.find((x) => x.kind === ATTESTATION_KIND);
    expect(att).toBeDefined();
    expect(verifyAttestation(att!, { agentPubkey: pk, ownerPubkey: owner })).toMatchObject({ ok: true });
    const card = eventsOf(pk, CAPABILITY_CARD_KIND)[0]!;
    expect(card.tags).toContainEqual(['t', 'beamhop']);

    const id = await e.client.call('identity.get');
    expect(id).toMatchObject({ npub: owner, ownerKeyHeld: true });
    expect(id.agents).toEqual([{ name: 'rev', npub, attested: true }]);
    const nip05 = await e.client.call('identity.nip05', { domain: 'example.com' });
    expect(JSON.parse(nip05.json).names.rev).toBe(pk);

    // The agent's nsec is withheld by DLP like any other secret.
    expect(await e.d.knownSecrets()).toContain(await e.secrets.get('agent.rev.nsec'));

    // Delete: key gone, connection closed.
    await e.client.call('agent.delete', { name: 'rev' });
    expect(await e.secrets.get('agent.rev.nsec')).toBeUndefined();
    expect(e.d.channels.get('nostr@rev')).toBeUndefined();
  });

  it('with an imported owner npub, exposes the attestation template for the owner device to sign', async () => {
    const e = await start();
    const ownerKey = generateAgentKey();
    await e.client.call('identity.ownerImport', { npub: ownerKey.pubkey });
    expect(e.d.global().nostr.ownerNpub).toBe(ownerKey.npub);
    await expect(e.client.call('identity.ownerExport')).rejects.toSatisfy((x) => code(x) === 'not_found');

    await e.client.call('agent.create', { config: { name: 'rev', harness: 'fake' } });
    await e.d.identity.settled();
    const r = await e.client.call('identity.publish', { name: 'rev' });
    expect(r.attestation).toBe('needs-owner-signature');
    expect(r.published.map((p) => p.kind).sort()).toEqual([0, CAPABILITY_CARD_KIND]);
    expect(R.events.some((x) => x.kind === ATTESTATION_KIND)).toBe(false);

    const t = await e.client.call('identity.attestationTemplate', { name: 'rev' });
    expect(t.ownerNpub).toBe(ownerKey.npub);
    // A forged attestation (signed by someone else) is refused.
    const forged = JSON.parse(JSON.stringify(signEvent(t.template, generateAgentKey().secretKey)));
    await expect(e.client.call('identity.attest', { name: 'rev', event: forged as never })).rejects.toSatisfy(
      (x) => code(x) === 'invalid_input',
    );
    const signed = JSON.parse(JSON.stringify(signEvent(t.template, ownerKey.secretKey)));
    await e.client.call('identity.attest', { name: 'rev', event: signed as never });
    await until(() => R.events.some((x) => x.id === signed.id), 2000);
    expect((await e.client.call('identity.get')).agents[0]!.attested).toBe(true);
  });

  it('owner nsec export: once, and never over the Nostr control plane', async () => {
    const e = await start();
    await e.client.call('identity.ownerCreate');
    await expect(e.client.call('identity.ownerCreate')).rejects.toSatisfy((x) => code(x) === 'conflict');
    const viaNostr = await e.d.dispatch(
      { jsonrpc: '2.0', id: 1, method: 'identity.ownerExport' },
      { caller: `nostr:${e.d.global().nostr.ownerNpub}`, transport: 'nostr' },
    );
    expect('error' in viaNostr && viaNostr.error.message).toMatch(/only be exported on this computer/);
    const { nsec } = await e.client.call('identity.ownerExport');
    expect(nsec).toMatch(/^nsec1/);
    await expect(e.client.call('identity.ownerExport')).rejects.toSatisfy((x) => code(x) === 'forbidden');
    expect(e.d.store.audit.query({ type: 'owner.exported' })).toHaveLength(1);
    expect(JSON.stringify(e.d.store.audit.query({}))).not.toContain(nsec);
  });

  it('one connection per agent key: a DM reaches only the agent it was sent to, and the reply comes from that key', async () => {
    const e = await start();
    await e.client.call('identity.ownerCreate');
    const membership = [{ target: 'nostr:dm', defaultRole: 'viewer' }];
    const a = await e.client.call('agent.create', {
      config: { name: 'alpha', harness: 'fake', memberships: membership },
    });
    const b = await e.client.call('agent.create', {
      config: { name: 'beta', harness: 'fake', memberships: membership },
    });
    expect(a.config.identity.npub).not.toBe(b.config.identity.npub);
    const { nsec } = await e.client.call('identity.ownerExport');
    const p = await phone(nsec);
    await p.conn.send({ conversation: { kind: 'dm', id: b.config.identity.npub! }, markdown: 'hello beta' });
    await until(() => p.inbox.some((m) => m.text.includes('reply: hello beta')), 5000, 'reply from beta');
    const reply = p.inbox.find((m) => m.text.includes('reply: hello beta'))!;
    expect(reply.from.principal).toBe(`nostr:${b.config.identity.npub}`);
    expect(e.harness.sessions).toHaveLength(1);
    expect(e.harness.sessions[0]!.spec.agent).toBe('beta');
    const sessions = (await e.client.call('session.list')).sessions;
    expect(sessions.map((s) => [s.agent, s.channel])).toEqual([['beta', 'nostr@beta']]);
  });

  it('onboarding hello: the agent DMs the owner and the owner reply completes the round trip', async () => {
    const e = await start();
    await e.client.call('identity.ownerCreate');
    await e.client.call('agent.create', {
      config: { name: 'rev', harness: 'fake', memberships: [{ target: 'nostr:dm' }] },
    });
    expect(await e.client.call('onboarding.helloStatus', { agent: 'rev' })).toEqual({
      sent: false,
      replied: false,
    });
    const { nsec } = await e.client.call('identity.ownerExport');
    const p = await phone(nsec);
    const h = await e.client.call('onboarding.hello', { agent: 'rev' });
    expect(h.to).toBe(e.d.global().nostr.ownerNpub);
    await until(() => p.inbox.some((m) => m.text.startsWith("Hi, I'm rev")), 5000, 'hello DM');
    const hello = p.inbox.find((m) => m.text.startsWith("Hi, I'm rev"))!;
    expect((await e.client.call('onboarding.helloStatus', { agent: 'rev' })).replied).toBe(false);
    await p.conn.send({ conversation: hello.conversation, markdown: 'it works' });
    await until(async () => (await e.client.call('onboarding.helloStatus', { agent: 'rev' })).replied, 5000);
    const st = await e.client.call('onboarding.helloStatus', { agent: 'rev' });
    expect(st).toMatchObject({ sent: true, replied: true, text: 'it works', from: `nostr:${h.to}` });
  });

  it('a stranger replying to the hello does not count', async () => {
    const e = await start();
    await e.client.call('identity.ownerCreate');
    const v = await e.client.call('agent.create', { config: { name: 'rev', harness: 'fake' } });
    await e.client.call('onboarding.hello', { agent: 'rev' });
    const p = await phone(generateAgentKey().nsec);
    await p.conn.send({ conversation: { kind: 'dm', id: v.config.identity.npub! }, markdown: 'me too' });
    await new Promise((r) => setTimeout(r, 400));
    expect((await e.client.call('onboarding.helloStatus', { agent: 'rev' })).replied).toBe(false);
  });

  it('agent connections come back after a restart; clones get their own key', async () => {
    const e = await start();
    await e.client.call('agent.create', { config: { name: 'rev', harness: 'fake' } });
    const npub = e.d.agent('rev').identity.npub;
    const c = await e.client.call('agent.clone', { name: 'rev', newName: 'rev2' });
    expect(c.config.identity.npub).toMatch(/^npub1/);
    expect(c.config.identity.npub).not.toBe(npub);
    expect(e.d.channels.get('nostr@rev2')).toBeDefined();
    await e.d.identity.settled();
    await e.d.stop();
    const harness = new FakeHarnessPlugin();
    env = await makeEnv({
      home: e.home,
      secrets: e.secrets,
      harness,
      plugins: { channels: [createNostrChannel({ WebSocket: WS })], harnesses: [harness] },
    });
    env.close = e.close;
    await until(() => !!env?.d.channels.get('nostr@rev') && !!env?.d.channels.get('nostr@rev2'), 3000);
    expect((env.d.channels.get('nostr@rev') as NostrConn).npub).toBe(npub);
  });

  it('agents created with an explicit npub keep it and get no generated key', async () => {
    const e = await start();
    const k = generateAgentKey();
    const v = await e.client.call('agent.create', {
      config: { name: 'ext', harness: 'fake', identity: { npub: k.npub } },
    });
    expect(v.config.identity).toEqual({ npub: k.npub });
    expect(await e.secrets.get('agent.ext.nsec')).toBeUndefined();
    expect(e.d.config.channels.get('nostr')).toBeUndefined();
  });
});

describe('device pairing over the Nostr control plane', () => {
  it('pairs a phone: payload → pairComplete over Nostr → safety phrase → confirm → allowlisted; remove revokes', async () => {
    const e = await start({ controlPlane: true });
    await e.d.control!.ready();
    const s = await e.client.call('device.pairStart', { name: 'Phone', requireConfirm: true });
    const payload = decodePairingPayload(s.uri);
    expect(payload.daemon).toBe(e.d.control!.pubkey);
    expect(payload.relays).toEqual([R.url]);
    expect(s.daemonNpub).toBe(e.d.control!.npub);
    expect((await e.client.call('device.pairStatus', { pairingId: s.pairingId! })).status).toBe('waiting');

    const dk = generateAgentKey();
    const now = () => Math.floor(e.clock.t / 1000);
    const r = await completePairing(s.payload!, dk.nsec, { name: 'iPhone · Safari', WebSocket: WS, now });
    expect(r.device).toMatchObject({ name: 'iPhone · Safari', pubkey: dk.npub });
    const st = await e.client.call('device.pairStatus', { pairingId: s.pairingId! });
    expect(st.status).toBe('awaiting-confirm');
    expect(st.safetyPhrase).toEqual(r.safetyPhrase);
    expect(st.safetyPhrase).toEqual(safetyPhrase(e.d.control!.npub, dk.npub));
    // Not usable until confirmed on the computer.
    expect(e.d.controlAllowlist()).not.toContain(dk.npub);

    const ok = await e.client.call('device.pairConfirm', { pairingId: s.pairingId!, accept: true });
    expect(ok.status).toBe('paired');
    expect(e.d.controlAllowlist()).toContain(dk.npub);
    expect(e.d.global().people.owner).toContain(`nostr:${dk.npub}`);

    const c = createControlClient({
      key: dk.secretKey,
      daemonPubkey: s.daemonNpub!,
      relays: [R.url],
      WebSocket: WS,
      timeoutMs: 3000,
    });
    phones.push(c);
    await c.ready();
    expect(await c.call<{ version: string }>('system.status')).toMatchObject({ version: expect.any(String) });

    await e.client.call('device.remove', { id: r.device.id });
    expect(e.d.controlAllowlist()).not.toContain(dk.npub);
    expect(e.d.global().people.owner ?? []).not.toContain(`nostr:${dk.npub}`);
    await expect(c.call('system.status')).rejects.toThrow(/not paired/);
  });

  it('a phrase mismatch cancels the pairing; the device never reaches the allowlist', async () => {
    const e = await start({ controlPlane: true });
    await e.d.control!.ready();
    const s = await e.client.call('device.pairStart', { name: 'Phone', requireConfirm: true });
    const dk = generateAgentKey();
    await completePairing(s.payload!, dk.nsec, {
      name: 'Phone',
      WebSocket: WS,
      now: () => Math.floor(e.clock.t / 1000),
    });
    const st = await e.client.call('device.pairConfirm', { pairingId: s.pairingId!, accept: false });
    expect(st.status).toBe('rejected');
    expect((await e.client.call('device.list')).devices).toEqual([]);
    expect(e.d.controlAllowlist()).not.toContain(dk.npub);
    expect(e.d.store.audit.query({ type: 'pairing.failed' })).toHaveLength(1);
  });

  it('a pairing request must be signed by the device key it pairs', async () => {
    const e = await start({ controlPlane: true });
    const s = await e.client.call('device.pairStart', { name: 'Phone' });
    const res = await e.d.dispatch(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'device.pairComplete',
        params: { code: s.code, pubkey: generateAgentKey().npub, name: 'x' },
      },
      { caller: `nostr:${generateAgentKey().npub}`, transport: 'nostr' },
    );
    expect('error' in res && res.error.message).toMatch(/signed by the device key/);
  });

  it('unconfirmed pairings expire and the pending device is dropped', async () => {
    const e = await start({ controlPlane: true });
    await e.d.control!.ready();
    const s = await e.client.call('device.pairStart', { name: 'Phone', requireConfirm: true });
    await completePairing(s.payload!, generateAgentKey().nsec, {
      name: 'Phone',
      WebSocket: WS,
      now: () => Math.floor(e.clock.t / 1000),
    });
    expect((await e.client.call('device.list')).devices).toHaveLength(1);
    e.clock.t += 16 * 60_000;
    await e.d.tick();
    expect((await e.client.call('device.list')).devices).toEqual([]);
    expect((await e.client.call('device.pairStatus', { pairingId: s.pairingId! })).status).toBe('expired');
    await expect(
      e.client.call('device.pairConfirm', { pairingId: s.pairingId!, accept: true }),
    ).rejects.toSatisfy((x) => code(x) === 'conflict');
  });
});

describe('pairing codes: expiry and brute force', () => {
  it('expired codes are refused', async () => {
    const e = await start();
    const s = await e.client.call('device.pairStart', { name: 'Phone' });
    e.clock.t += 11 * 60_000;
    await expect(
      e.client.call('device.pairComplete', { code: s.code, pubkey: generateAgentKey().npub, name: 'x' }),
    ).rejects.toThrow(/expired/);
  });

  it('locks out after repeated wrong codes, even for the right code', async () => {
    const e = await start();
    const s = await e.client.call('device.pairStart', { name: 'Phone' });
    const pk = generateAgentKey().npub;
    for (let i = 0; i < 5; i++)
      await expect(
        e.client.call('device.pairComplete', { code: `WRONG${i + 2}`, pubkey: pk, name: 'x' }),
      ).rejects.toSatisfy((x) => code(x) === 'unauthorized');
    await expect(
      e.client.call('device.pairComplete', { code: s.code, pubkey: pk, name: 'x' }),
    ).rejects.toSatisfy((x) => code(x) === 'rate_limited');
    expect(e.d.store.audit.query({ type: 'pairing.locked' })).toHaveLength(1);
    // The lock lifts once the window has passed (the old code has expired by then: get a new one).
    e.clock.t += 10 * 60_000 + 1;
    const s2 = await e.client.call('device.pairStart', { name: 'Phone' });
    expect(
      (await e.client.call('device.pairComplete', { code: s2.code, pubkey: pk, name: 'x' })).pubkey,
    ).toBe(pk);
  });
});
