/**
 * Fixes from a full test pass: sessions on a signed-out harness fail fast, secrets in use cannot be
 * deleted, quorum and owner-key changes that could not work (or lose a key) are refused, an agent's key
 * ref cannot point at another secret, schedules validate their agent, and the daemon copes with a long
 * or relative beamhop home.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { join, relative } from 'node:path';
import { generateAgentKey } from '@beamhop/channel-nostr';
import type { RpcError } from '@beamhop/client';
import { beamhopHome, MAX_SOCKET_PATH, paths, socketPath } from '@beamhop/core';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeHarnessPlugin, makeEnv, setupBot, type TestEnv, tmpHome } from './helpers.ts';

let env: TestEnv | undefined;
const cleanup: string[] = [];
afterEach(async () => {
  await env?.close();
  env = undefined;
  for (const p of cleanup.splice(0)) rmSync(p, { recursive: true, force: true });
});

const code = (e: unknown) => (e as RpcError).beamhopCode ?? (e as { code?: string }).code;

describe('signed-out harness', () => {
  it('fails a schedule run at once, naming the harness and how to sign in', async () => {
    const harness = new FakeHarnessPlugin(undefined, 'claude');
    env = await makeEnv({ harness });
    await setupBot(env, { harness: 'claude' });
    const s = await env.client.call('schedule.add', {
      agent: 'bot',
      kind: 'cron',
      spec: '0 9 * * *',
      prompt: 'hello',
      owner: 'local:owner',
    });
    const r = await env.d.scheduler.run(s.id);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not signed in.*beamhop harness login claude/);
    expect(harness.sessions).toHaveLength(0);
    const [sess] = (await env.client.call('session.list', {})).sessions;
    const events = (await env.client.call('session.events', { id: sess!.id })).events;
    expect(events.some((e) => e.kind === 'error' && /beamhop harness login claude/.test(e.text ?? ''))).toBe(
      true,
    );
  });

  it('starts when the agent brings its own credential for the login variable', async () => {
    const harness = new FakeHarnessPlugin(undefined, 'claude');
    env = await makeEnv({ harness });
    await env.secrets.set('TEAM_KEY', 'k');
    await setupBot(env, { harness: 'claude', secretEnv: ['ANTHROPIC_API_KEY=TEAM_KEY'] });
    const s = await env.client.call('schedule.add', {
      agent: 'bot',
      kind: 'cron',
      spec: '0 9 * * *',
      prompt: 'hello',
      owner: 'local:owner',
    });
    expect((await env.d.scheduler.run(s.id)).ok).toBe(true);
  });
});

describe('secret.delete', () => {
  it('refuses secrets in use and reports missing ones', async () => {
    env = await makeEnv();
    await setupBot(env);
    await env.secrets.set('GHTOKEN', 'x');
    await env.client.call('agent.update', { name: 'bot', patch: { secretEnv: ['GH=GHTOKEN'] } });
    const refused = async (name: string, who: RegExp) => {
      const e = await env!.client.call('secret.delete', { name }).catch((x: unknown) => x);
      expect(code(e)).toBe('conflict');
      expect((e as Error).message).toMatch(who);
    };
    await refused('agent.bot.nsec', /agent bot \(identity key\)/);
    await refused('channel.fk.token', /channel fk/);
    await refused('GHTOKEN', /agent bot \(secretEnv\)/);
    expect(await env.secrets.get('agent.bot.nsec')).toBeDefined();
    await expect(env.client.call('secret.delete', { name: 'NOPE' })).rejects.toSatisfy(
      (e) => code(e) === 'not_found',
    );
    // Once nothing uses it, it can go.
    await env.client.call('agent.update', { name: 'bot', patch: { secretEnv: [] } });
    await env.client.call('secret.delete', { name: 'GHTOKEN' });
    expect(await env.secrets.get('GHTOKEN')).toBeUndefined();
  });
});

describe('approval.quorumSet', () => {
  it('refuses a quorum above the number of possible approvers', async () => {
    env = await makeEnv();
    await setupBot(env);
    const { approvers } = await env.client.call('approval.quorumGet');
    const e = await env.client.call('approval.quorumSet', { quorum: approvers + 3 }).catch((x: unknown) => x);
    expect(code(e)).toBe('invalid_input');
    expect((e as Error).message).toContain(`only ${approvers}`);
    expect((await env.client.call('approval.quorumGet')).quorum).toBe(1);
    await expect(env.client.call('approval.quorumSet', { quorum: approvers })).resolves.toMatchObject({
      quorum: approvers,
    });
  });
});

describe('identity.ownerImport', () => {
  it('needs replace to drop a held owner key, and refuses an agent key', async () => {
    env = await makeEnv();
    await setupBot(env);
    const held = (await env.client.call('identity.ownerCreate', {})).npub;
    const other = generateAgentKey().npub;
    await expect(env.client.call('identity.ownerImport', { npub: other })).rejects.toSatisfy(
      (e) => code(e) === 'conflict',
    );
    expect(await env.client.call('identity.get')).toMatchObject({ npub: held, ownerKeyHeld: true });

    const botNpub = env.d.agent('bot').identity.npub!;
    await expect(env.client.call('identity.ownerImport', { npub: botNpub, replace: true })).rejects.toThrow(
      /agent bot's own key/,
    );

    await env.client.call('identity.ownerImport', { npub: other, replace: true });
    expect(await env.client.call('identity.get')).toMatchObject({ npub: other, ownerKeyHeld: false });
    // Nothing held now: a later import needs no replace.
    const third = generateAgentKey().npub;
    await expect(env.client.call('identity.ownerImport', { npub: third })).resolves.toEqual({ npub: third });
  });
});

describe('agent.update identity', () => {
  it("only allows the agent's own key ref and audits security changes as such", async () => {
    env = await makeEnv();
    await setupBot(env);
    await env.client.call('agent.create', { config: { name: 'other', harness: 'fake' } });
    for (const ref of ['GHTOKEN', 'agent.other.nsec'])
      await expect(
        env.client.call('agent.update', { name: 'bot', patch: { identity: { nostrKeyRef: ref } } }),
      ).rejects.toSatisfy((e) => code(e) === 'forbidden');
    expect(env.d.agent('bot').identity.nostrKeyRef).toBe('agent.bot.nsec');
    await env.client.call('agent.update', {
      name: 'bot',
      patch: { identity: { nostrKeyRef: 'agent.bot.nsec', nip05: 'bot@example.com' } },
    });
    await env.client.call('agent.update', { name: 'bot', patch: { approvalRules: [] } });
    const audit = env.d.store.audit
      .query({ limit: 50 })
      .filter((a: { type: string }) => a.type === 'agent.updated');
    expect(audit.length).toBeGreaterThanOrEqual(2);
    for (const a of audit.slice(0, 2)) expect(a.severity).toBe('security');
  });
});

describe('schedules and missing agents', () => {
  it('validates the agent on update and reports run failures', async () => {
    env = await makeEnv();
    await setupBot(env);
    const s = await env.client.call('schedule.add', {
      agent: 'bot',
      kind: 'cron',
      spec: '0 9 * * *',
      prompt: 'x',
      owner: 'local:owner',
    });
    await expect(
      env.client.call('schedule.update', { id: s.id, patch: { agent: 'nobody' } }),
    ).rejects.toSatisfy((e) => code(e) === 'not_found');
    expect(env.d.config.schedules.require(s.id).agent).toBe('bot');
    await expect(
      env.client.call('schedule.add', {
        agent: 'nobody',
        kind: 'cron',
        spec: '0 9 * * *',
        prompt: 'x',
        owner: 'local:owner',
      }),
    ).rejects.toSatisfy((e) => code(e) === 'not_found');
    // A stopped agent: the run is refused to the caller, not answered ok.
    await env.client.call('agent.stop', { name: 'bot' });
    await expect(env.client.call('schedule.run', { id: s.id })).rejects.toSatisfy(
      (e) => code(e) === 'unavailable',
    );
  });
});

describe('beamhop home', () => {
  it('binds the API socket under a short path when the home is too long', async () => {
    const base = tmpHome();
    cleanup.push(base);
    let home = base;
    while (home.length < 140) home = join(home, 'a-rather-long-directory-name');
    mkdirSync(home, { recursive: true });
    const sock = socketPath(home);
    expect(Buffer.byteLength(sock)).toBeLessThanOrEqual(MAX_SOCKET_PATH);
    expect(sock).not.toContain(home);
    expect(socketPath(home)).toBe(sock);
    expect(paths(home).socket).toBe(sock);
    expect(socketPath(base)).toBe(join(base, 'beamhop.sock'));

    env = await makeEnv({ home, api: { port: 0, host: '127.0.0.1' } });
    await new Promise<void>((ok, fail) => {
      const c = connect(sock, () => {
        c.end();
        ok();
      });
      c.on('error', fail);
    });
  });

  it('resolves a relative home once', async () => {
    const abs = tmpHome();
    cleanup.push(abs);
    env = await makeEnv({ home: relative(process.cwd(), abs) });
    expect(env.d.home).toBe(abs);
    expect((await env.client.call('system.status')).home).toBe(abs);

    const prev = process.env.BEAMHOP_HOME;
    process.env.BEAMHOP_HOME = '.';
    try {
      expect(beamhopHome()).toBe(process.cwd());
    } finally {
      if (prev === undefined) delete process.env.BEAMHOP_HOME;
      else process.env.BEAMHOP_HOME = prev;
    }
  });
});

describe('harness.remove', () => {
  it('removes a custom harness, refuses catalog ones and ones agents use', async () => {
    const env = await makeEnv();
    try {
      await env.client.call('harness.add', { id: 'mine', command: 'my-agent', args: ['--acp'] });
      expect(env.d.store.kv.get('harness-defs', 'acp:mine')).toBeTruthy();
      await env.client.call('harness.remove', { id: 'mine' });
      expect(env.d.store.kv.get('harness-defs', 'acp:mine')).toBeUndefined();
      await expect(env.client.call('harness.remove', { id: 'mine' })).rejects.toThrow(/not a custom harness/);
      await expect(env.client.call('harness.remove', { id: 'fake' })).rejects.toThrow(/not a custom harness/);

      await env.client.call('harness.add', { id: 'used', command: 'my-agent', args: [] });
      await setupBot(env, { harness: 'acp:used' });
      await expect(env.client.call('harness.remove', { id: 'acp:used' })).rejects.toThrow(/used by bot/);
    } finally {
      await env.close();
    }
  });
});
