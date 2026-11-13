/**
 * Fixes from the full-application test pass: instruction files never follow a symlink out of a mount,
 * an agent's secretEnv cannot hand beamhop's own secrets to a harness, and policy.set refuses hosts the
 * sandbox would reject later.
 */
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SandboxPolicy } from '@beamhop/core';
import { afterEach, describe, expect, it } from 'vitest';
import { sessionCredentials } from '../src/harness-auth.ts';
import { makeEnv, setupBot, type TestEnv } from './helpers.ts';

let env: TestEnv | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

describe('security review fixes', () => {
  it('does not read a symlinked instruction file (it could point at the vault key)', async () => {
    env = await makeEnv();
    const repo = join(env.home, 'repo');
    mkdirSync(repo, { recursive: true });
    const outside = join(env.home, 'outside-secret.txt');
    writeFileSync(outside, 'TOP SECRET');
    symlinkSync(outside, join(repo, 'GEMINI.md'));
    writeFileSync(join(repo, 'AGENTS.md'), 'be nice');
    await setupBot(env, { mounts: [{ path: repo, mode: 'ro' }] });
    const { files } = await env.client.call('agent.instructions', { name: 'bot' });
    expect(files.map((f) => f.content)).toEqual(['be nice']);
    expect(JSON.stringify(files)).not.toContain('TOP SECRET');
  });

  it("refuses beamhop's own secrets in secretEnv, in config and at session start", async () => {
    env = await makeEnv();
    await setupBot(env);
    for (const entry of [
      'K=beamhop.data-key',
      'O=beamhop.owner.nsec',
      'A=agent.other.nsec',
      'T=channel.fk.token',
    ])
      await expect(
        env.client.call('agent.update', { name: 'bot', patch: { secretEnv: [entry] } }),
      ).rejects.toThrow(/keeps that secret for itself/);
    // A hand-written config that slipped past the schema is still refused when the session starts.
    await expect(
      sessionCredentials(env.secrets, { name: 'bot', secretEnv: ['K=beamhop.data-key'] }, 'fake', 'Fake'),
    ).rejects.toThrow(/keeps for itself/);
    // An ordinary secret still works.
    await env.secrets.set('TEAM_TOKEN', 'v');
    await expect(
      sessionCredentials(env.secrets, { name: 'bot', secretEnv: ['GH=TEAM_TOKEN'] }, 'fake', 'Fake'),
    ).resolves.toMatchObject({ GH: 'v' });
  });

  it('policy.set refuses allowlist entries the sandbox would reject later', async () => {
    env = await makeEnv();
    await setupBot(env);
    for (const host of ['*', 'http://x.com/path', '', 'localhost'])
      await expect(
        env.client.call('policy.set', {
          name: 'bot',
          profile: 'workspace',
          policy: SandboxPolicy.parse({ net: { allow: [host] } }),
        }),
      ).rejects.toThrow(/not a host name|loopback/);
    await env.client.call('policy.set', {
      name: 'bot',
      profile: 'workspace',
      policy: SandboxPolicy.parse({ net: { allow: ['Example.COM', '*.example.org', 'example.com'] } }),
    });
    const { userAllow } = await env.client.call('policy.get', { name: 'bot' });
    expect(userAllow).toEqual(['example.com', '*.example.org']);
  });

  it('data.purge keeps the audit log unless includeAudit is set', async () => {
    env = await makeEnv();
    env.d.audit({ type: 'x', severity: 'info', summary: 'kept', actor: 't' });
    await env.client.call('data.purge', {});
    expect(env.d.store.audit.query({ type: 'x' })).toHaveLength(1);
    await env.client.call('data.purge', { includeAudit: true });
    expect(env.d.store.audit.query({ type: 'x' })).toHaveLength(0);
  });
});
