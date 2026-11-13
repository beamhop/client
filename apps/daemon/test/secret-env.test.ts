import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SandboxHandle, SessionSpec } from '@beamhop/core';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeHarnessPlugin, makeEnv, setupBot, type TestEnv, until } from './helpers.ts';

let env: TestEnv | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

/** A harness like GitHub Copilot: its own service host, a relocatable home, and a token from the env. */
class ServiceHarness extends FakeHarnessPlugin {
  readonly network = ['api.githubcopilot.com', '*.githubcopilot.com'];
  readonly homeEnv = 'COPILOT_HOME';
  policies: SandboxHandle['policy'][] = [];
  override async start(spec: SessionSpec, sandbox?: SandboxHandle) {
    if (sandbox) this.policies.push(sandbox.policy);
    return super.start(spec);
  }
}

const dm = (conn: Awaited<ReturnType<typeof setupBot>>) =>
  conn.inject({
    conversation: { kind: 'group', id: 'g1' },
    from: { principal: 'fake:bob', displayName: 'Bob' },
    text: '@beambot hi',
    mentionsAgent: true,
  });

describe('secretEnv, harness network and harness home', () => {
  it('passes opted-in secrets to the harness env, allows its service hosts, and relocates its home', async () => {
    const h = new ServiceHarness();
    env = await makeEnv({ harness: h });
    await env.secrets.set('COPILOT_GITHUB_TOKEN', 'gho_test_value');
    const conn = await setupBot(env, { secretEnv: ['COPILOT_GITHUB_TOKEN'] });
    dm(conn);
    await until(() => h.sessions.length === 1);
    const spec = h.latest().spec;
    expect(spec.env.COPILOT_GITHUB_TOKEN).toBe('gho_test_value');
    expect(spec.env.COPILOT_HOME).toBe(join(spec.env.BEAMHOP_SESSION_DIR!, 'harness-home'));
    expect(existsSync(spec.env.COPILOT_HOME!)).toBe(true);
    const policy = h.policies[0]!;
    expect(policy.net.allow).toEqual(
      expect.arrayContaining(['api.githubcopilot.com', '*.githubcopilot.com']),
    );
    // The harness home is inside the session dir, which is the session's own carve-out.
    expect(policy.fs.own).toContain(spec.env.BEAMHOP_SESSION_DIR);
  });

  it('does not pass secrets an agent did not opt into', async () => {
    const h = new ServiceHarness();
    env = await makeEnv({ harness: h });
    await env.secrets.set('COPILOT_GITHUB_TOKEN', 'gho_test_value');
    const conn = await setupBot(env);
    dm(conn);
    await until(() => h.sessions.length === 1);
    expect(h.latest().spec.env.COPILOT_GITHUB_TOKEN).toBeUndefined();
  });

  it('an agent net.deny wins over the harness hosts', async () => {
    const h = new ServiceHarness();
    env = await makeEnv({ harness: h });
    const conn = await setupBot(env, {
      sandbox: { profile: 'workspace', policy: { net: { deny: ['api.githubcopilot.com'] } } },
    });
    dm(conn);
    await until(() => h.sessions.length === 1);
    expect(h.policies[0]!.net.allow).not.toContain('api.githubcopilot.com');
    expect(h.policies[0]!.net.allow).toContain('*.githubcopilot.com');
  });

  it('a missing opted-in secret fails the session with the command that fixes it', async () => {
    const h = new ServiceHarness();
    env = await makeEnv({ harness: h });
    const conn = await setupBot(env, { secretEnv: ['COPILOT_GITHUB_TOKEN'] });
    dm(conn);
    await until(() => env!.d.store.audit.query({ type: 'agent.crash' }).length > 0);
    expect(h.sessions).toHaveLength(0);
    expect(env.d.store.audit.query({ type: 'agent.crash' })[0]!.summary).toMatch(
      /beamhop secret set COPILOT_GITHUB_TOKEN/,
    );
  });
});
