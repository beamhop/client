import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient, httpTransport, type RpcError, wsTransport } from '@beamhop/client';
import { type Deployer, methods, paths } from '@beamhop/core';
import { afterEach, describe, expect, it } from 'vitest';
import { ALL_METHODS } from '../src/api.ts';
import { makeEnv, ownerAlice, setupBot, type TestEnv, tmpHome, until } from './helpers.ts';

let env: TestEnv | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

const code = (e: unknown) => (e as RpcError).beamhopCode ?? (e as { code?: string }).code;

describe('API coverage', () => {
  it('implements every method in the contract', async () => {
    env = await makeEnv();
    const handlers = env.d.apiHandlers.handlers();
    for (const m of Object.keys(methods))
      expect(handlers[m as keyof typeof handlers], m).toBeTypeOf('function');
    expect(ALL_METHODS.length).toBe(Object.keys(methods).length);
  });

  it('system.status / doctor / panic / resume', async () => {
    env = await makeEnv();
    const s = await env.client.call('system.status');
    expect(s.panic).toBe(false);
    expect(s.home).toBe(env.home);
    const doc = await env.client.call('system.doctor');
    expect(doc.checks.some((c) => c.id.startsWith('sandbox'))).toBe(true);
    expect(doc.checks.some((c) => c.id === 'harness.any')).toBe(true);
    await env.client.call('system.panic', { reason: 'x' });
    expect((await env.client.call('system.status')).panic).toBe(true);
    expect(env.d.store.audit.query({ type: 'panic' })).toHaveLength(1);
    await env.client.call('system.resume');
    expect((await env.client.call('system.status')).panic).toBe(false);
  });
});

describe('agents', () => {
  it('CRUD, presets, clone, start/stop, instructions', async () => {
    env = await makeEnv();
    const { presets } = await env.client.call('agent.presets');
    expect(presets.map((p) => p.id)).toContain('public-qa');
    const mount = join(env.home, 'proj');
    mkdirSync(mount);
    writeFileSync(join(mount, 'CLAUDE.md'), '# be nice');
    const a = await env.client.call('agent.create', {
      config: { name: 'qa', harness: 'fake', mounts: [{ path: mount }] },
      preset: 'public-qa',
    });
    expect(a.config.public).toBe(true);
    expect(a.config.sandbox.profile).toBe('strict');
    expect(a.config.preset).toBe('public-qa');
    await expect(
      env.client.call('agent.create', { config: { name: 'qa', harness: 'fake' } }),
    ).rejects.toSatisfy((e) => code(e) === 'conflict');
    await expect(
      env.client.call('agent.create', { config: { name: 'Bad Name', harness: 'fake' } }),
    ).rejects.toSatisfy((e) => code(e) === 'invalid_input');
    await expect(
      env.client.call('agent.create', { config: { name: 'x', harness: 'fake' }, preset: 'nope' }),
    ).rejects.toThrow(/preset/);
    const u = await env.client.call('agent.update', { name: 'qa', patch: { budgets: { dailyUsd: 9 } } });
    expect(u.config.budgets.dailyUsd).toBe(9);
    expect((await env.client.call('agent.list')).agents).toHaveLength(1);
    expect((await env.client.call('agent.get', { name: 'qa' })).status).toBe('idle');
    const files = (await env.client.call('agent.instructions', { name: 'qa' })).files;
    expect(files[0]!.content).toContain('be nice');
    const c = await env.client.call('agent.clone', { name: 'qa', newName: 'qa2' });
    expect(c.config.memberships).toHaveLength(0);
    expect((await env.client.call('agent.stop', { name: 'qa', hard: true })).status).toBe('stopped');
    expect((await env.client.call('agent.start', { name: 'qa' })).status).toBe('idle');
    await env.client.call('agent.delete', { name: 'qa2' });
    await expect(env.client.call('agent.get', { name: 'qa2' })).rejects.toSatisfy(
      (e) => code(e) === 'not_found',
    );
  });

  it('stopped agents ignore inbound messages', async () => {
    env = await makeEnv();
    const conn = await setupBot(env);
    await ownerAlice(env);
    await env.client.call('agent.stop', { name: 'bot' });
    conn.inject({ text: 'hello?' });
    await new Promise((r) => setTimeout(r, 100));
    expect(env.harness.sessions).toHaveLength(0);
  });
});

describe('harnesses, channels, memberships', () => {
  it('harness scan/list/add', async () => {
    env = await makeEnv();
    const scan = await env.client.call('harness.scan');
    expect(scan.harnesses.find((h) => h.id === 'fake')?.status).toBe('ready');
    expect((await env.client.call('harness.list')).harnesses.map((h) => h.id)).toContain('fake');
    const added = await env.client.call('harness.add', { id: 'mine', command: 'my-agent', args: ['--acp'] });
    expect(added.id).toBe('acp:mine');
    expect((await env.client.call('harness.list')).harnesses.map((h) => h.id)).toContain('acp:mine');
  });

  it('channel providers/validate/add/remove/pair; secrets go to the vault, never to YAML', async () => {
    env = await makeEnv();
    const { providers } = await env.client.call('channel.providers');
    expect(providers[0]!.provider).toBe('fake');
    expect(
      (await env.client.call('channel.validate', { provider: 'fake', values: {}, secrets: { token: 'bad' } }))
        .ok,
    ).toBe(false);
    expect(
      (
        await env.client.call('channel.validate', {
          provider: 'fake',
          values: {},
          secrets: { token: 'good' },
        })
      ).ok,
    ).toBe(true);
    const ch = await env.client.call('channel.add', {
      name: 'fk',
      provider: 'fake',
      values: { a: 1 },
      secrets: { token: 'good' },
    });
    expect(ch.config.secretRefs).toEqual(['channel.fk.token']);
    expect(await env.secrets.get('channel.fk.token')).toBe('good');
    expect(readFileSync(join(paths(env.home).channels, 'fk.yaml'), 'utf8')).not.toContain('good');
    expect(env.channel.lastCtx?.secrets).toEqual({ token: 'good' });
    await until(() => env!.channel.conns.has('fk'));
    expect((await env.client.call('channel.list')).channels[0]!.status).toBe('connected');
    const pair = await env.client.call('channel.pair', { name: 'fk' });
    expect(pair.code).toMatch(/^[A-Z0-9]{6}$/);
    expect(pair.instructions).toContain(`/pair ${pair.code}`);
    await env.client.call('channel.remove', { name: 'fk' });
    expect(await env.secrets.get('channel.fk.token')).toBeUndefined();
    expect(env.channel.conns.get('fk')!.closed).toBe(true);
    await expect(
      env.client.call('channel.add', { name: 'x', provider: 'nope', values: {}, secrets: {} }),
    ).rejects.toSatisfy((e) => code(e) === 'not_found');
  });

  it('membership join/leave', async () => {
    env = await makeEnv();
    await env.client.call('agent.create', { config: { name: 'a', harness: 'fake' } });
    const j = await env.client.call('membership.join', {
      agent: 'a',
      membership: { target: 'fk:group/1', defaultRole: 'user' },
    });
    expect(j.config.memberships[0]!.target).toBe('fk:group/1');
    const l = await env.client.call('membership.leave', { agent: 'a', target: 'fk:group/1' });
    expect(l.config.memberships).toHaveLength(0);
  });
});

describe('sessions', () => {
  it('session.start as local owner, events, send, stop, list', async () => {
    env = await makeEnv();
    await env.client.call('agent.create', { config: { name: 'a', harness: 'fake' } });
    const s = await env.client.call('session.start', { agent: 'a', text: 'hello local', title: 'T' });
    expect(s.channel).toBe('local');
    await until(async () =>
      (await env!.client.call('session.events', { id: s.id })).events.some((e) => e.kind === 'assistant'),
    );
    const evs = (await env.client.call('session.events', { id: s.id })).events;
    expect(evs.find((e) => e.kind === 'assistant')!.text).toContain('reply: hello local');
    expect(evs.find((e) => e.kind === 'user')!.from!.role).toBe('owner');
    const after = evs.at(-1)!.seq;
    await env.client.call('session.send', { id: s.id, text: 'more' });
    await until(async () =>
      (await env!.client.call('session.events', { id: s.id, afterSeq: after })).events.some(
        (e) => e.kind === 'assistant',
      ),
    );
    expect((await env.client.call('session.list', { agent: 'a' })).sessions).toHaveLength(1);
    await env.client.call('session.stop', { id: s.id });
    expect((await env.client.call('session.list')).sessions[0]!.status).toBe('ended');
    expect(env.events.some((e) => e.type === 'session.updated')).toBe(true);
  });
});

describe('approvals, roles, owners', () => {
  it('approval.list/decide/undo via API (owner = local)', async () => {
    env = await makeEnv({ approvalUndoMs: 300 });
    const conn = await setupBot(env);
    conn.inject({
      conversation: { kind: 'group', id: 'g1' },
      from: { principal: 'fake:bob' },
      text: '@b RUN_SHELL',
      mentionsAgent: true,
    });
    await until(async () => (await env!.client.call('approval.list')).approvals.length === 1);
    const [a] = (await env.client.call('approval.list')).approvals;
    const d = await env.client.call('approval.decide', { id: a!.id, allow: false });
    expect(d.status).toBe('denied');
    const u = await env.client.call('approval.undo', { id: a!.id });
    expect(u.status).toBe('pending');
    await env.client.call('approval.decide', { id: a!.id, allow: true });
    await expect(env.client.call('approval.decide', { id: a!.id, allow: true })).rejects.toSatisfy(
      (e) => code(e) === 'conflict',
    );
    expect((await env.client.call('approval.list', { status: 'all' })).approvals).toHaveLength(1);
    await until(() => conn.textsTo('g1').some((t) => t.includes('shell allowed')), 3000);
    await expect(env.client.call('approval.undo', { id: a!.id })).rejects.toSatisfy(
      (e) => code(e) === 'conflict',
    );
  });

  it('quorum 2 needs two owners', async () => {
    env = await makeEnv({ approvalUndoMs: 10 });
    const conn = await setupBot(env);
    await env.client.call('owner.add', { principal: 'fake:alice' });
    env.d.updateGlobal((c) => ({ ...c, approvals: { quorum: 2 } }));
    conn.inject({
      conversation: { kind: 'group', id: 'g1' },
      from: { principal: 'fake:bob' },
      text: '@b RUN_SHELL',
      mentionsAgent: true,
    });
    await until(() => env!.d.store.approvals.list().length === 1);
    const id = env.d.store.approvals.list()[0]!.id;
    expect((await env.client.call('approval.decide', { id, allow: true })).status).toBe('pending');
    await env.d.approvals.decide(id, 'fake:alice', true, {});
    await until(() => conn.textsTo('g1').some((t) => t.includes('shell allowed')), 3000);
  });

  it('roles, grants, links, owners (last owner protected)', async () => {
    env = await makeEnv();
    await env.client.call('agent.create', { config: { name: 'a', harness: 'fake' } });
    const r = await env.client.call('role.list');
    expect(r.roles.map((x) => x.name)).toEqual(
      expect.arrayContaining(['owner', 'admin', 'user', 'viewer', 'agent']),
    );
    await env.client.call('role.grant', { principal: 'fake:bob', role: 'user' });
    expect((await env.client.call('role.list')).grants['fake:bob']).toBe('user');
    await env.client.call('role.grant', { principal: 'fake:bob', role: 'admin', agent: 'a' });
    expect(env.d.agent('a').grants['fake:bob']).toBe('admin');
    await expect(env.client.call('role.grant', { principal: 'fake:bob', role: 'nope' })).rejects.toThrow(
      /unknown role/,
    );
    await env.client.call('role.revoke', { principal: 'fake:bob' });
    await env.client.call('role.revoke', { principal: 'fake:bob', agent: 'a' });
    expect((await env.client.call('role.list')).grants['fake:bob']).toBeUndefined();
    await env.client.call('principal.link', { person: 'bob', principal: 'fake:bob' });
    expect(env.d.global().people.bob).toEqual(['fake:bob']);
    await env.client.call('owner.add', { principal: 'fake:o1' });
    await env.client.call('owner.add', { principal: 'fake:o2' });
    await env.client.call('owner.remove', { principal: 'fake:o1' });
    await expect(env.client.call('owner.remove', { principal: 'fake:o2' })).rejects.toThrow(
      /at least one owner/,
    );
    expect(env.d.store.audit.query({ type: 'role.grant' }).length).toBe(2);
  });
});

describe('policy, secrets, schedules', () => {
  it('policy get/set/suggestions/applySuggestion', async () => {
    env = await makeEnv();
    await env.client.call('agent.create', { config: { name: 'a', harness: 'fake' } });
    const p = await env.client.call('policy.get', { name: 'a' });
    expect(p.profile).toBe('workspace');
    expect(p.effective.fs.deny.length).toBeGreaterThan(0);
    await env.client.call('policy.set', {
      name: 'a',
      profile: 'custom',
      policy: { net: { allow: ['example.com'], deny: [], denyPrivateIps: true } } as never,
    });
    expect((await env.client.call('policy.get', { name: 'a' })).effective.net.allow).toContain('example.com');
    const sug = env.d.store.policySuggestions.record('a', 'net.allow', 'api.example.org');
    expect((await env.client.call('policy.suggestions', { name: 'a' })).suggestions).toHaveLength(1);
    await env.client.call('policy.applySuggestion', { id: sug.id, accept: true });
    expect((await env.client.call('policy.get', { name: 'a' })).effective.net.allow).toContain(
      'api.example.org',
    );
  });

  it('secrets: names only, internal names reserved', async () => {
    env = await makeEnv();
    await env.client.call('secret.set', { name: 'GITHUB_TOKEN', value: 'v-123456789' });
    const l = await env.client.call('secret.list');
    expect(l.secrets.map((s) => s.name)).toEqual(['GITHUB_TOKEN']);
    expect(JSON.stringify(l)).not.toContain('v-123456789');
    await expect(env.client.call('secret.set', { name: 'beamhop.data-key', value: 'x' })).rejects.toSatisfy(
      (e) => code(e) === 'forbidden',
    );
    await env.client.call('secret.delete', { name: 'GITHUB_TOKEN' });
    expect((await env.client.call('secret.list')).secrets).toHaveLength(0);
  });

  it('cron schedules fire on the clock and post to their target; routes enforced', async () => {
    env = await makeEnv();
    const conn = await setupBot(env);
    await expect(
      env.client
        .call('schedule.add', {
          agent: 'bot',
          kind: 'cron',
          spec: '0 9 * * *',
          prompt: 'x',
          owner: 'local:owner',
          postTo: 'fk:group/other',
        })
        .then((s) => env!.client.call('schedule.run', { id: s.id })),
    ).resolves.toBeDefined();
    const s = await env.client.call('schedule.add', {
      agent: 'bot',
      kind: 'cron',
      spec: '*/5 * * * *',
      prompt: 'daily digest',
      owner: 'local:owner',
      postTo: 'fk:group/g1',
    });
    expect((await env.client.call('schedule.list', { agent: 'bot' })).schedules).toHaveLength(2);
    env.clock.t += 6 * 60_000;
    await env.d.tick();
    await until(() => conn.textsTo('g1').some((t) => t.includes('daily digest')), 3000);
    await until(() => env!.d.store.audit.query({ type: 'route.denied' }).length === 1);
    expect(conn.textsTo('other')).toHaveLength(0);
    const up = await env.client.call('schedule.update', { id: s.id, patch: { paused: true } });
    expect(up.paused).toBe(true);
    await expect(
      env.client.call('schedule.add', {
        agent: 'bot',
        kind: 'cron',
        spec: 'bad',
        prompt: 'x',
        owner: 'local:owner',
      }),
    ).rejects.toSatisfy((e) => code(e) === 'invalid_input');
    await env.client.call('schedule.remove', { id: s.id });
  });

  it('webhook schedules over the real HTTP server; bad secret rejected', async () => {
    env = await makeEnv({ api: { port: 0 }, socket: false });
    const conn = await setupBot(env);
    const s = await env.client.call('schedule.add', {
      agent: 'bot',
      kind: 'webhook',
      spec: 'deploy',
      prompt: 'deploy finished',
      owner: 'local:owner',
      postTo: 'fk:group/g1',
    });
    expect(s.webhook?.url).toContain(`/hooks/${s.id}`);
    const bad = await fetch(s.webhook!.url, {
      method: 'POST',
      body: '{}',
      headers: { 'x-beamhop-secret': 'nope' },
    });
    expect(bad.status).toBe(401);
    const payload = '{"status":"green"}';
    const sig = `sha256=${createHmac('sha256', s.webhook!.secret).update(payload).digest('hex')}`;
    const ok = await fetch(s.webhook!.url, {
      method: 'POST',
      body: payload,
      headers: { 'x-beamhop-signature': sig },
    });
    expect(ok.status).toBe(202);
    await until(
      () => conn.textsTo('g1').some((t) => t.includes('deploy finished') && t.includes('green')),
      3000,
    );
    expect(env.d.store.audit.query({ type: 'webhook.rejected' })).toHaveLength(1);
  });

  it('file-change schedules watch a mount glob', async () => {
    env = await makeEnv();
    const mount = join(env.home, 'notes');
    mkdirSync(mount);
    const conn = await setupBot(env, { mounts: [{ path: mount, mode: 'ro' }] });
    await env.client.call('schedule.add', {
      agent: 'bot',
      kind: 'file-change',
      spec: '**/*.md',
      prompt: 'summarize changes',
      owner: 'local:owner',
      postTo: 'fk:group/g1',
    });
    await new Promise((r) => setTimeout(r, 100));
    writeFileSync(join(mount, 'todo.md'), '- x');
    writeFileSync(join(mount, 'ignored.txt'), 'x');
    await until(
      () => conn.textsTo('g1').some((t) => t.includes('summarize changes') && t.includes('todo.md')),
      6000,
    );
    expect(conn.textsTo('g1').join('\n')).not.toContain('ignored.txt');
  });
});

describe('deploy, audit, usage, devices, identity, data', () => {
  it('deploy: unavailable without deployers; delegates when registered', async () => {
    env = await makeEnv();
    expect((await env.client.call('deploy.providers')).providers).toEqual([]);
    await expect(env.client.call('deploy.options', { provider: 'fly' })).rejects.toThrow(/not installed/);
    const fake: Deployer = {
      id: 'fakecloud',
      displayName: 'Fake Cloud',
      kind: 'vps',
      sizes: async () => [{ id: 's', label: 'small', monthlyUsd: 4 }],
      regions: async () => [{ id: 'r', label: 'R' }],
      plan: async (s) => ({
        provider: s.provider,
        actions: [{ op: 'create', resource: 'vm', detail: s.agent }],
        monthlyCostUsd: 4,
        warnings: [],
      }),
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
        agent: 'a',
        status: 'running',
        createdAt: new Date().toISOString(),
      }),
      logs: async function* () {},
      destroy: async () => {},
    };
    env.d.registry.addDeployer(fake);
    await env.client.call('agent.create', { config: { name: 'a', harness: 'fake' } });
    expect((await env.client.call('deploy.providers')).providers[0]).toMatchObject({
      id: 'fakecloud',
      configured: false,
    });
    expect((await env.client.call('deploy.options', { provider: 'fakecloud' })).sizes).toHaveLength(1);
    expect(
      (await env.client.call('deploy.plan', { agent: 'a', provider: 'fakecloud', mode: 'new' }))
        .monthlyCostUsd,
    ).toBe(4);
    const dep = await env.client.call('deploy.apply', { agent: 'a', provider: 'fakecloud', mode: 'new' });
    expect(dep.status).toBe('provisioning');
    expect((await env.client.call('deploy.list')).deployments[0]!.status).toBe('running');
    await env.client.call('deploy.destroy', { id: dep.id });
    expect((await env.client.call('deploy.list')).deployments).toHaveLength(0);
  });

  it('audit.query, usage.query', async () => {
    env = await makeEnv();
    await env.client.call('secret.set', { name: 'X_TOKEN', value: 'abcdefghij' });
    const { events } = await env.client.call('audit.query', { severity: 'security' });
    expect(events[0]!.type).toBe('secret.set');
    expect(JSON.stringify(events)).not.toContain('abcdefghij');
    expect((await env.client.call('usage.query', { days: 7 })).rows).toEqual([]);
  });

  it('device pairing with codes and QR URI; remove', async () => {
    env = await makeEnv();
    const { npubEncode, decodePairingPayload } = await import('@beamhop/channel-nostr');
    const start = await env.client.call('device.pairStart', { name: 'Phone' });
    expect(start.uri).toMatch(/^https:\/\/app\.beamhop\.dev\/pair#[A-Za-z0-9_-]+$/);
    expect(start.link).toMatch(/^beamhop:\/\/pair#/);
    expect(decodePairingPayload(start.uri).code).toBe(start.code);
    await expect(
      env.client.call('device.pairComplete', { code: 'WRONG1', pubkey: 'a'.repeat(64), name: 'x' }),
    ).rejects.toSatisfy((e) => code(e) === 'unauthorized');
    const dev = await env.client.call('device.pairComplete', {
      code: start.code,
      pubkey: 'a'.repeat(64),
      name: 'Phone',
    });
    const npub = npubEncode('a'.repeat(64));
    expect(dev.pubkey).toBe(npub);
    expect((await env.client.call('device.list')).devices).toHaveLength(1);
    expect(env.d.controlAllowlist()).toContain(npub);
    await env.client.call('device.pushSubscribe', {
      id: dev.id,
      subscription: { endpoint: 'https://push.example/x' },
    });
    expect((await env.client.call('device.list')).devices[0]!.pushEnabled).toBe(true);
    await env.client.call('device.remove', { id: dev.id });
    expect(env.d.controlAllowlist()).not.toContain(npub);
    await expect(
      env.client.call('device.pairComplete', { code: start.code, pubkey: 'b'.repeat(64), name: 'x' }),
    ).rejects.toThrow(/used/);
  });

  it('identity get + nip05 via nostr helpers', async () => {
    env = await makeEnv();
    const { generateAgentKey } = await import('@beamhop/channel-nostr');
    const k = generateAgentKey();
    await env.client.call('agent.create', {
      config: { name: 'rev', harness: 'fake', identity: { npub: k.npub } },
    });
    expect((await env.client.call('identity.get')).agents[0]!.npub).toBe(k.npub);
    const n = await env.client.call('identity.nip05', { domain: 'example.com' });
    expect(JSON.parse(n.json).names.rev).toBe(k.pubkey);
    expect(Object.keys(n.snippets)).toContain('nginx');
  });

  it('data export (0600) and purge', async () => {
    env = await makeEnv();
    await env.client.call('agent.create', { config: { name: 'a', harness: 'fake' } });
    const s = await env.client.call('session.start', { agent: 'a', text: 'hi' });
    await until(() => env!.d.store.sessions.events(s.id).some((e) => e.kind === 'assistant'));
    const { path } = await env.client.call('data.export', { agent: 'a' });
    expect(existsSync(path)).toBe(true);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).toContain('reply: hi');
    await env.client.call('session.stop', { id: s.id });
    expect((await env.client.call('data.purge', { agent: 'a' })).deleted).toBeGreaterThan(0);
    expect((await env.client.call('session.list')).sessions).toHaveLength(0);
  });

  it('retention runs from tick (hourly)', async () => {
    env = await makeEnv();
    await env.client.call('agent.create', {
      config: { name: 'a', harness: 'fake', retention: { transcriptDays: 1, auditDays: 1 } },
    });
    const s = await env.client.call('session.start', { agent: 'a', text: 'hi' });
    await until(() => env!.d.store.sessions.events(s.id).some((e) => e.kind === 'assistant'));
    await env.client.call('session.stop', { id: s.id });
    env.clock.t += 3 * 86_400_000;
    await env.d.tick();
    expect(env.d.store.sessions.list()).toHaveLength(0);
  });
});

describe('real HTTP + WS server, token file, lock', () => {
  it('serves the API with the token from <home>/api-token (0600) and pushes events over WS', async () => {
    const home = tmpHome();
    env = await makeEnv({ home, api: { port: 0 } });
    const tokenFile = paths(home).token;
    const token = readFileSync(tokenFile, 'utf8').trim();
    if (process.platform !== 'win32') expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    const http = createClient(httpTransport(env.d.api!.url, token));
    expect((await http.call('system.status')).version).toBeTruthy();
    await expect(createClient(httpTransport(env.d.api!.url, 'nope')).call('system.status')).rejects.toThrow(
      /Unauthorized/,
    );
    const ws = createClient(wsTransport(env.d.api!.url, token, { reconnect: false }));
    const got: string[] = [];
    ws.on((e) => got.push(e.type));
    await ws.call('agent.create', { config: { name: 'w', harness: 'fake' } });
    await until(() => got.includes('agent.updated'));
    ws.close();
    // unix socket for the container healthcheck
    if (process.platform !== 'win32') expect(existsSync(paths(home).socket)).toBe(true);
    // a home locked by another live process is refused
    const other = tmpHome();
    writeFileSync(join(other, 'daemon.lock'), String(process.ppid));
    await expect(makeEnv({ home: other })).rejects.toThrow(/another beamhop daemon/);
  });
});
