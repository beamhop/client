import { createClient, directTransport, RpcError } from '@beamhop/client';
import { describe, expect, it } from 'vitest';
import { buildProgram, type CliIO, table } from '../src/program.ts';

const setup = (
  handler: (method: string, params: unknown) => Promise<unknown>,
  env: Record<string, string> = {},
) => {
  const out: string[] = [];
  const err: string[] = [];
  const calls: [string, unknown][] = [];
  const io: CliIO = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    readStdin: async () => 'from-stdin\n',
    env,
  };
  const program = buildProgram({
    io,
    client: async () =>
      createClient(
        directTransport(async (m, p) => {
          calls.push([m, p]);
          return handler(m, p);
        }),
      ),
  });
  const run = (...args: string[]) => program.parseAsync(['node', 'beamhop', ...args]);
  return { out, err, calls, io, run };
};

describe('cli', () => {
  it('renders tables', () => {
    expect(table([{ a: 1, b: 'x' }], ['a', 'b'])).toContain('x');
  });

  it('lists agents as json', async () => {
    const t = setup(async () => ({ agents: [] }));
    await t.run('--json', 'agent', 'ls');
    expect(JSON.parse(t.out.join(''))).toEqual([]);
    expect(t.calls[0]?.[0]).toBe('agent.list');
  });

  it('creates an agent with mounts', async () => {
    const t = setup(async (_m, p) => ({
      config: { name: 'bot', harness: 'claude', sandbox: { profile: 'workspace' } },
      params: p,
    }));
    await t.run(
      'agent',
      'add',
      'bot',
      '--harness',
      'claude',
      '--mount',
      '~/code:rw',
      '--mount',
      '/data',
      '--preset',
      'team-dev-bot',
    );
    expect(t.calls[0]).toEqual([
      'agent.create',
      {
        config: {
          name: 'bot',
          harness: 'claude',
          mounts: [
            { path: '~/code', mode: 'rw' },
            { path: '/data', mode: 'ro' },
          ],
        },
        preset: 'team-dev-bot',
      },
    ]);
    expect(t.out.join('\n')).toContain('created');
  });

  it('adds a channel reading the token from env, never from args', async () => {
    const t = setup(
      async (m) =>
        m === 'channel.validate'
          ? { ok: true, message: 'ok', identity: { name: 'Bot', handle: '@bot' } }
          : { config: { name: 'mybot' } },
      { TG: 'secret-token' },
    );
    await t.run('channel', 'add', 'telegram', '--name', 'mybot', '--token-env', 'TG');
    expect(t.calls.map((c) => c[0])).toEqual(['channel.validate', 'channel.add']);
    expect((t.calls[1]![1] as { secrets: { token: string } }).secrets.token).toBe('secret-token');
    expect(t.out.join('\n')).not.toContain('secret-token');
  });

  it('fails cleanly when the env var is empty', async () => {
    const t = setup(async () => ({}));
    await t.run('channel', 'add', 'telegram', '--name', 'x', '--token-env', 'MISSING');
    expect(t.io.exitCode).toBe(1);
    expect(t.err.join('')).toContain('MISSING');
  });

  it('reads secrets from stdin', async () => {
    const t = setup(async () => ({ ok: true }));
    await t.run('secret', 'set', 'GITHUB_TOKEN');
    expect(t.calls[0]).toEqual(['secret.set', { name: 'GITHUB_TOKEN', value: 'from-stdin' }]);
  });

  it('maps rpc errors to exit code 1', async () => {
    const t = setup(async () => {
      throw new RpcError(-32004, 'agent nope not found', { code: 'not_found' });
    });
    await t.run('agent', 'show', 'nope');
    expect(t.io.exitCode).toBe(1);
    expect(t.err.join('')).toContain('not found');
  });

  it('approves with options', async () => {
    const t = setup(async () => ({ id: 'a1' }));
    await t.run('approve', 'a1', '--always');
    expect(t.calls[0]).toEqual([
      'approval.decide',
      { id: 'a1', allow: true, always: false, session: true, grantRole: undefined },
    ]);
  });

  it('approves forever with a rule', async () => {
    const t = setup(async () => ({ id: 'a1' }));
    await t.run('approve', 'a1', '--forever', '*.npmjs.org');
    expect(t.calls[0]).toEqual([
      'approval.decide',
      { id: 'a1', allow: true, always: true, rule: '*.npmjs.org', grantRole: undefined },
    ]);
  });

  it('patches config values with JSON parsing', async () => {
    const t = setup(async () => ({}));
    await t.run('agent', 'set', 'bot', 'model=gpt-5', 'public=true', 'budgets={"dailyUsd":3}');
    expect(t.calls[0]).toEqual([
      'agent.update',
      { name: 'bot', patch: { model: 'gpt-5', public: true, budgets: { dailyUsd: 3 } } },
    ]);
  });

  it('expands dotted keys into nested patches', async () => {
    const t = setup(async () => ({}));
    await t.run(
      'agent',
      'set',
      'bot',
      'budgets.dailyUsd=3',
      'sandbox.policy.learning=true',
      'sandbox.profile=strict',
    );
    expect(t.calls[0]).toEqual([
      'agent.update',
      {
        name: 'bot',
        patch: { budgets: { dailyUsd: 3 }, sandbox: { policy: { learning: true }, profile: 'strict' } },
      },
    ]);
    const bad = setup(async () => ({}));
    await bad.run('agent', 'set', 'bot', '__proto__.x=1');
    expect(bad.calls).toEqual([]);
    expect(bad.io.exitCode).toBe(1);
  });

  it('joins with triggers', async () => {
    const t = setup(async () => ({}));
    await t.run(
      'join',
      'bot',
      'mybot:group/-100',
      '--role',
      'user',
      '--trigger',
      'mention',
      '--trigger',
      'reply',
    );
    expect(t.calls[0]).toEqual([
      'membership.join',
      {
        agent: 'bot',
        membership: { target: 'mybot:group/-100', defaultRole: 'user', triggers: ['mention', 'reply'] },
      },
    ]);
  });

  it('panics', async () => {
    const t = setup(async () => ({ ok: true }));
    await t.run('panic', '--reason', 'test');
    expect(t.calls[0]).toEqual(['system.panic', { reason: 'test' }]);
    expect(t.out.join('')).toContain('panic engaged');
  });

  it('resume is a no-op outside panic', async () => {
    const t = setup(async (m) => (m === 'system.status' ? { panic: false } : { ok: true }));
    await t.run('resume');
    expect(t.calls.map((c) => c[0])).toEqual(['system.status']);
    expect(t.out.join('')).toContain('nothing to resume');
  });

  it('join warns when the channel does not exist', async () => {
    const t = setup(async (m) => (m === 'channel.list' ? { channels: [] } : {}));
    await t.run('join', 'bot', 'mybot:dm', '--role', 'owner');
    expect(t.out.join('\n')).toContain('no channel named "mybot"');
  });

  it('agent add warns about a harness that is not ready and a missing mount', async () => {
    const t = setup(async (m) =>
      m === 'harness.list'
        ? {
            harnesses: [
              {
                id: 'claude',
                displayName: 'Claude Code',
                command: 'claude',
                status: 'needs-login',
                protocol: 'claude-sdk',
                message: 'run `claude /login`',
              },
            ],
          }
        : { config: { name: 'bot', harness: 'claude', sandbox: { profile: 'workspace' } } },
    );
    await t.run('agent', 'add', 'bot', '--harness', 'claude', '--mount', '/does/not/exist-beamhop');
    const out = t.out.join('\n');
    expect(out).toContain('mount /does/not/exist-beamhop does not exist');
    expect(out).toContain(
      'Claude Code is not logged in (run `claude /login`); that is fine once beamhop holds',
    );
    expect(out).toContain('beamhop session start bot');
  });

  it('alerts set parses the PWA-style flags', async () => {
    const t = setup(async (_m, p) => p as Record<string, unknown>);
    await t.run(
      'alerts',
      'set',
      '--budget',
      '70,95',
      '--spike',
      '5/10m',
      '--heartbeat',
      '15m',
      '--no-nostr-dm',
    );
    expect(t.calls[0]).toEqual([
      'alerts.set',
      {
        budgetWarn: 70,
        budgetAlert: 95,
        spikeEvents: 5,
        spikeMinutes: 10,
        heartbeatMinutes: 15,
        nostrDm: false,
      },
    ]);
    const u = setup(async () => ({}));
    await u.run('alerts', 'set');
    expect(u.err.join('')).toContain('nothing to change');
  });

  it('session start warns when no model key is stored', async () => {
    const t = setup(async (m) =>
      m === 'secret.list' ? { backend: 'memory', secrets: [] } : { id: 'ses_1', agent: 'bot' },
    );
    await t.run('session', 'start', 'bot', 'hi');
    expect(t.out.join('\n')).toContain('no model key is stored in beamhop');
    const k = setup(async (m) =>
      m === 'secret.list' ? { backend: 'memory', secrets: [{ name: 'OPENAI_API_KEY' }] } : { id: 'ses_1' },
    );
    await k.run('session', 'start', 'bot', 'hi');
    expect(k.out.join('\n')).not.toContain('no model key');
  });
});
