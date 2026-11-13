import type { SandboxHandle, SessionSpec } from '@beamhop/core';
import { afterEach, describe, expect, it } from 'vitest';
import { checkProviderKey } from '../src/harness-auth.ts';
import { FakeHarnessPlugin, makeEnv, setupBot, type TestEnv, until } from './helpers.ts';

let env: TestEnv | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

/** Stands in for GitHub Copilot: same id, so the catalog's login methods apply (an `env` token). */
class FakeCopilot extends FakeHarnessPlugin {
  readonly network = ['api.githubcopilot.com', '*.githubcopilot.com'];
  readonly homeEnv = 'COPILOT_HOME';
  rejectToken?: string;
  constructor() {
    super(undefined, 'copilot');
  }
  override async start(spec: SessionSpec, _sandbox?: SandboxHandle) {
    if (!spec.env.COPILOT_GITHUB_TOKEN || spec.env.COPILOT_GITHUB_TOKEN === this.rejectToken)
      throw new Error('Authentication required');
    return super.start(spec);
  }
}

const copilotView = async (e: TestEnv) =>
  (await e.client.call('harness.list')).harnesses.find((h) => h.id === 'copilot')!;

describe('harness logins', () => {
  it('an installed harness without a login is needs-login, with the command that fixes it', async () => {
    env = await makeEnv({ harness: new FakeCopilot() });
    const v = await copilotView(env);
    expect(v.status).toBe('needs-login');
    expect(v.login).toMatchObject({ status: 'logged-out' });
    expect(v.message).toMatch(/beamhop harness login copilot/);
    expect(v.login!.methods).toEqual([
      expect.objectContaining({
        id: 'github-token',
        kind: 'env',
        secret: 'COPILOT_GITHUB_TOKEN',
        set: false,
      }),
    ]);
  });

  it('login stores the token, checks it by starting the harness, and every agent on it gets the token', async () => {
    const h = new FakeCopilot();
    env = await makeEnv({ harness: h });
    const v = await env.client.call('harness.login', { id: 'copilot', value: ' gho_valid \n' });
    expect(v.status).toBe('ready');
    expect(v.login).toMatchObject({ status: 'logged-in', method: 'github-token' });
    expect(v.login!.checkedAt).toBeTruthy();
    expect(await env.secrets.get('COPILOT_GITHUB_TOKEN')).toBe('gho_valid');
    // The check session is closed and not kept.
    expect(h.sessions.at(-1)?.spec.sessionId).toMatch(/^logincheck-copilot/);

    const conn = await setupBot(env, { harness: 'copilot' });
    conn.inject({
      conversation: { kind: 'group', id: 'g1' },
      from: { principal: 'fake:bob', displayName: 'Bob' },
      text: '@beambot hi',
      mentionsAgent: true,
    });
    await until(() => h.sessions.some((s) => s.spec.agent === 'bot'));
    expect(h.sessions.find((s) => s.spec.agent === 'bot')!.spec.env.COPILOT_GITHUB_TOKEN).toBe('gho_valid');
    expect(env.d.store.audit.query({ type: 'harness.login' })).toHaveLength(1);
  });

  it('an agent can override the harness login with its own secret', async () => {
    const h = new FakeCopilot();
    env = await makeEnv({ harness: h });
    await env.client.call('harness.login', { id: 'copilot', value: 'gho_owner' });
    await env.secrets.set('TEAM_TOKEN', 'gho_team');
    const conn = await setupBot(env, { harness: 'copilot', secretEnv: ['COPILOT_GITHUB_TOKEN=TEAM_TOKEN'] });
    conn.inject({
      conversation: { kind: 'group', id: 'g1' },
      from: { principal: 'fake:bob', displayName: 'Bob' },
      text: '@beambot hi',
      mentionsAgent: true,
    });
    await until(() => h.sessions.some((s) => s.spec.agent === 'bot'));
    expect(h.sessions.find((s) => s.spec.agent === 'bot')!.spec.env.COPILOT_GITHUB_TOKEN).toBe('gho_team');
  });

  it('a rejected token shows as invalid and needs-login; a new value is re-checked', async () => {
    const h = new FakeCopilot();
    h.rejectToken = 'gho_expired';
    env = await makeEnv({ harness: h });
    const bad = await env.client.call('harness.login', { id: 'copilot', value: 'gho_expired' });
    expect(bad.login).toMatchObject({ status: 'invalid' });
    expect(bad.status).toBe('needs-login');
    expect(bad.message).toMatch(/Login rejected: Authentication required/);
    const good = await env.client.call('harness.login', { id: 'copilot', value: 'gho_fresh' });
    expect(good.login!.status).toBe('logged-in');
  });

  it('logout removes the stored login; check and login on an unmanaged harness explain why not', async () => {
    env = await makeEnv({ harness: new FakeCopilot() });
    await env.client.call('harness.login', { id: 'copilot', value: 'gho_valid' });
    const out = await env.client.call('harness.logout', { id: 'copilot' });
    expect(out.login!.status).toBe('logged-out');
    expect(await env.secrets.get('COPILOT_GITHUB_TOKEN')).toBeUndefined();
    await expect(env.client.call('harness.checkLogin', { id: 'fake' })).rejects.toThrow(/does not manage/);
    await expect(
      env.client.call('harness.login', { id: 'copilot', method: 'nope', value: 'x' }),
    ).rejects.toThrow(/unknown login method nope/);
  });

  it('doctor fails a harness that agents use but that is not logged in', async () => {
    env = await makeEnv({ harness: new FakeCopilot() });
    await setupBot(env, { harness: 'copilot' });
    const { checks } = await env.client.call('system.doctor');
    expect(checks.find((c) => c.id === 'harness.copilot.login')).toMatchObject({
      status: 'fail',
      fix: 'beamhop harness login copilot',
    });
  });
});

describe('checkProviderKey', () => {
  const fakeFetch = (status: number) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      fakeFetch.calls.push({ url: String(url), headers: init?.headers as Record<string, string> });
      return new Response('{}', { status });
    }) as typeof fetch;
  fakeFetch.calls = [] as { url: string; headers: Record<string, string> }[];

  it('accepts, rejects or reports the provider answer without spending tokens', async () => {
    expect(await checkProviderKey('anthropic', 'k', fakeFetch(200))).toMatchObject({ status: 'logged-in' });
    expect(await checkProviderKey('openai', 'k', fakeFetch(401))).toMatchObject({ status: 'invalid' });
    expect(await checkProviderKey('openrouter', 'k', fakeFetch(500))).toMatchObject({ status: 'error' });
    expect(checkProviderKey('harness', 'k', fakeFetch(200))).toBeUndefined();
  });

  it('sends a subscription token as Bearer with the OAuth beta flag', async () => {
    fakeFetch.calls.length = 0;
    await checkProviderKey('anthropic-oauth', 'sk-ant-oat01-x', fakeFetch(200));
    expect(fakeFetch.calls[0]).toMatchObject({
      url: 'https://api.anthropic.com/v1/models?limit=1',
      headers: { authorization: 'Bearer sk-ant-oat01-x', 'anthropic-beta': 'oauth-2025-04-20' },
    });
  });
});
