import { readFileSync } from 'node:fs';
import { createClient, directTransport } from '@beamhop/client';
import { describe, expect, it } from 'vitest';
import { buildProgram, type CliDeps, type CliIO } from '../src/program.ts';

// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI colours for assertions
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

type Handler = (params: Record<string, unknown>) => unknown;

/** A fake daemon answering only the methods in `handlers`. */
const setup = (
  handlers: Record<string, Handler> = {},
  o: { env?: Record<string, string>; deps?: Partial<CliDeps>; stdin?: string } = {},
) => {
  const out: string[] = [];
  const err: string[] = [];
  const calls: [string, Record<string, unknown>][] = [];
  const io: CliIO = {
    out: (l) => out.push(plain(l)),
    err: (l) => err.push(plain(l)),
    readStdin: async () => o.stdin ?? '',
    env: o.env ?? {},
  };
  const program = buildProgram({
    io,
    client: async () =>
      createClient(
        directTransport(async (m, p) => {
          calls.push([m, p as Record<string, unknown>]);
          const h = handlers[m];
          if (!h) throw new Error(`unexpected call ${m}`);
          return h(p as Record<string, unknown>);
        }),
      ),
    ...o.deps,
  });
  const run = async (...args: string[]) => {
    try {
      await program.parseAsync(['node', 'beamhop', ...args]);
    } catch (e) {
      // exitOverride: commander errors are thrown; main() turns them into the exit code.
      io.exitCode = (e as { exitCode?: number }).exitCode ?? 1;
    }
  };
  const methods = () => calls.map(([m]) => m);
  return { out, err, calls, io, run, methods, text: () => [...out, ...err].join('\n') };
};

const check = (id: string, status: string) => ({ id, title: id, status, message: '' });

describe('doctor', () => {
  it('exits 1 when a check fails, 0 with only warnings', async () => {
    const bad = setup({ 'system.doctor': () => ({ checks: [check('a', 'ok'), check('b', 'fail')] }) });
    await bad.run('doctor');
    expect(bad.io.exitCode).toBe(1);
    const warn = setup({ 'system.doctor': () => ({ checks: [check('a', 'ok'), check('b', 'warn')] }) });
    await warn.run('doctor');
    expect(warn.io.exitCode).toBeUndefined();
  });
  it('says an unknown check id is unknown and lists the valid ones', async () => {
    const t = setup({ 'system.doctor': () => ({ checks: [check('srt', 'ok'), check('keys', 'warn')] }) });
    await t.run('doctor', 'nosuchcheck');
    expect(t.text()).toContain('unknown doctor check nosuchcheck. Check ids: srt, keys');
    expect(t.text()).not.toContain('--fix nosuchcheck');
    expect(t.io.exitCode).toBe(1);
  });
  it('shows only the named checks', async () => {
    const t = setup({ 'system.doctor': () => ({ checks: [check('srt', 'ok'), check('keys', 'fail')] }) });
    await t.run('doctor', 'srt');
    expect(t.text()).toContain('srt');
    expect(t.text()).not.toContain('keys');
    expect(t.io.exitCode).toBeUndefined();
  });
});

describe('alerts set', () => {
  it('converts duration units to minutes and rejects garbage', async () => {
    const t = setup({ 'alerts.set': (p) => p });
    await t.run('alerts', 'set', '--heartbeat', '2h', '--spike', '5/10h');
    expect(t.calls[0]).toEqual(['alerts.set', { heartbeatMinutes: 120, spikeEvents: 5, spikeMinutes: 600 }]);
    const g = setup({ 'alerts.set': (p) => p });
    await g.run('alerts', 'set', '--heartbeat', 'soon');
    expect(g.methods()).toEqual([]);
    expect(g.io.exitCode).toBe(1);
  });
});

describe('agent', () => {
  const harnesses = { 'harness.list': () => ({ harnesses: [] }) };
  it('set rejects unknown keys with the valid ones', async () => {
    const t = setup({ ...harnesses, 'agent.update': () => ({}) });
    await t.run('agent', 'set', 'x', 'nosuchkey=1');
    expect(t.methods()).not.toContain('agent.update');
    expect(t.text()).toContain('unknown agent setting "nosuchkey". Valid keys:');
    expect(t.io.exitCode).toBe(1);
    const nested = setup({ ...harnesses, 'agent.update': () => ({}) });
    await nested.run('agent', 'set', 'x', 'budgets={"dailyUsd":3,"bogus":1}');
    expect(nested.text()).toContain('budgets.bogus');
  });
  it('set warns about an unknown harness', async () => {
    const t = setup({ ...harnesses, 'agent.update': () => ({}) });
    await t.run('agent', 'set', 'x', 'harness=nonexist');
    expect(t.text()).toContain('updated x');
    expect(t.text()).toContain('harness "nonexist" is not known');
  });
  it('add rejects a bad mount mode and a folder mounted twice', async () => {
    for (const mounts of [['/data:xx'], ['/data:rw', '/data:ro']]) {
      const t = setup({ ...harnesses, 'agent.create': () => ({}) });
      await t.run('agent', 'add', 'bot', '--harness', 'claude', ...mounts.flatMap((m) => ['--mount', m]));
      expect(t.methods()).not.toContain('agent.create');
      expect(t.io.exitCode).toBe(1);
    }
  });
});

describe('harness', () => {
  const view = (over: Record<string, unknown> = {}) => ({
    id: 'acp:x',
    displayName: 'x',
    command: 'sh',
    status: 'ready',
    protocol: 'acp',
    ...over,
  });
  const env = { PATH: process.env.PATH ?? '/bin:/usr/bin' };
  it('add validates the id', async () => {
    const t = setup({ 'harness.add': () => view() }, { env });
    await t.run('harness', 'add', 'Bad Id', '--acp', 'sh');
    expect(t.methods()).toEqual([]);
    expect(t.text()).toContain('invalid harness id "Bad Id"');
    expect(t.io.exitCode).toBe(1);
  });
  it('add refuses a command that does not exist, before registering', async () => {
    const t = setup({ 'harness.add': () => view() }, { env });
    await t.run('harness', 'add', 'x', '--acp', 'no-such-binary-beamhop --acp');
    expect(t.methods()).toEqual([]);
    expect(t.text()).toContain('command not found');
    expect(t.io.exitCode).toBe(1);
  });
  it('add exits 1 when the probe fails', async () => {
    const t = setup({ 'harness.add': () => view({ status: 'error', message: 'EPIPE' }) }, { env });
    await t.run('harness', 'add', 'x', '--acp', 'sh -c true');
    expect(t.text()).toContain('did not answer the ACP handshake (EPIPE)');
    expect(t.io.exitCode).toBe(1);
    const ok = setup({ 'harness.add': () => view() }, { env });
    await ok.run('harness', 'add', 'x', '--acp', 'sh');
    expect(ok.text()).toContain('ready acp:x');
    expect(ok.io.exitCode).toBeUndefined();
  });

  const gemini = {
    id: 'gemini',
    displayName: 'Gemini CLI',
    command: 'gemini',
    status: 'ready',
    protocol: 'acp',
    login: {
      status: 'logged-out',
      methods: [{ id: 'gemini-key', label: 'API key', kind: 'broker', secret: 'GEMINI_API_KEY', set: false }],
    },
  };
  const list = { 'harness.list': () => ({ harnesses: [gemini] }) };
  it('login names an unknown harness or method before reading stdin', async () => {
    const t = setup(list);
    await t.run('harness', 'login', 'nosuch');
    expect(t.text()).toContain('no harness nosuch');
    expect(t.text()).not.toContain('empty value');
    expect(t.io.exitCode).toBe(1);
    const m = setup(list);
    await m.run('harness', 'login', 'gemini', '--method', 'bogus');
    expect(m.text()).toContain('Gemini CLI has no login method bogus; one of: gemini-key');
    expect(m.methods()).not.toContain('harness.login');
  });
  it('install of an unknown id fails before announcing it', async () => {
    const t = setup(list);
    await t.run('harness', 'install', 'nosuch');
    expect(t.out.join('\n')).not.toContain('Installing');
    expect(t.text()).toContain('no harness nosuch');
    expect(t.io.exitCode).toBe(1);
  });
});

describe('session send', () => {
  const session = (status: string) => ({
    'session.list': () => ({
      sessions: [
        {
          id: 's1',
          agent: 'bot',
          channel: 'local',
          conversationId: 'owner',
          threadId: 't',
          title: 'x',
          status,
          startedAt: '',
          lastActivityAt: '',
          usage: { inputTokens: 0, outputTokens: 0, usd: 0 },
        },
      ],
    }),
    'session.send': () => ({ ok: true }),
  });
  it('says it resumed an ended session', async () => {
    const t = setup(session('ended'));
    await t.run('session', 'send', 's1', 'hi');
    expect(t.text()).toContain('s1 had ended; resumed it');
    const r = setup(session('idle'));
    await r.run('session', 'send', 's1', 'hi');
    expect(r.text()).toBe('sent');
  });
});

describe('removing things that do not exist', () => {
  it('secret rm fails for an unknown name', async () => {
    const t = setup({
      'secret.list': () => ({ backend: 'file', secrets: [{ name: 'A', updatedAt: '' }] }),
      'secret.delete': () => ({ ok: true }),
    });
    await t.run('secret', 'rm', 'nosuch');
    expect(t.text()).toContain('no secret named nosuch');
    expect(t.methods()).not.toContain('secret.delete');
    expect(t.io.exitCode).toBe(1);
  });
  it('role revoke fails when no grant was removed', async () => {
    let grants: Record<string, string> = { 'telegram:1': 'user' };
    const handlers = {
      'role.list': () => ({ roles: [], grants }),
      'role.revoke': (p: Record<string, unknown>) => {
        grants = Object.fromEntries(Object.entries(grants).filter(([k]) => k !== p.principal));
        return { ok: true };
      },
    };
    const miss = setup(handlers);
    await miss.run('role', 'revoke', 'telegram:2');
    expect(miss.text()).toContain('telegram:2 has no role grant');
    expect(miss.io.exitCode).toBe(1);
    const hit = setup(handlers);
    await hit.run('role', 'revoke', 'telegram:1');
    expect(hit.text()).toBe('revoked telegram:1');
    expect(hit.io.exitCode).toBeUndefined();
  });
});

describe('misc', () => {
  it('daemon --port rejects a non-number before starting', async () => {
    let started = false;
    const runDaemon = async () => {
      started = true;
    };
    const t = setup({}, { deps: { runDaemon } });
    await t.run('daemon', '--port', 'abc');
    expect(started).toBe(false);
    expect(t.text()).toContain('port must be a number from 1 to 65535');
    expect(t.io.exitCode).toBe(1);
  });
  it('shows the vault key under BEAMHOP_HOME', async () => {
    const t = setup(
      { 'secret.list': () => ({ backend: 'file', keySource: 'file', secrets: [] }) },
      { env: { BEAMHOP_HOME: '/srv/bh' } },
    );
    await t.run('secret', 'keychain');
    expect(t.text()).toContain('vault key in /srv/bh/vault.key');
  });
  it('reports the package version', async () => {
    const t = setup();
    await t.run('--version');
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(t.out.join('')).toBe(pkg.version);
  });
});
