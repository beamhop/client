import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { HarnessJob } from '@beamhop/core';
import { findHarness, loadCatalog } from '@beamhop/harness-catalog';
import { managedNpmPrefix, scanHarnesses } from '@beamhop/harness-discovery';
import { afterEach, describe, expect, it } from 'vitest';
import { doctorActionTable, elevatedArgv, elevatedFailure, shQuote } from '../src/doctor-fix.ts';
import {
  type InstallerDeps,
  loginBody,
  parseLoginLine,
  ptyArgv,
  updateMethodFor,
} from '../src/harness-install.ts';
import {
  type ChildLike,
  friendlyError,
  HarnessJobs,
  MAX_JOB_LINES,
  type SpawnFn,
  stripAnsi,
} from '../src/harness-jobs.ts';
import { makeEnv, type TestEnv, until } from './helpers.ts';

// ───────────────────────────── fake processes ─────────────────────────────

class FakeChild extends EventEmitter implements ChildLike {
  pid = undefined;
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed?: NodeJS.Signals;
  constructor(
    readonly cmd: string,
    readonly args: string[],
  ) {
    super();
  }
  out(text: string) {
    this.stdout.write(text);
  }
  err(text: string) {
    this.stderr.write(text);
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null) {
    this.stdout.end();
    this.stderr.end();
    // Let the stream data events drain first.
    setTimeout(() => this.emit('exit', code, signal), 5);
  }
  kill(signal: NodeJS.Signals = 'SIGTERM') {
    if (this.killed) return true;
    this.killed = signal;
    this.exit(null, signal);
    return true;
  }
}

/** Records spawns; `script` decides what each child does. */
const fakeSpawn = (script: (c: FakeChild) => void) => {
  const children: FakeChild[] = [];
  const spawn: SpawnFn = (cmd, args) => {
    const c = new FakeChild(cmd, args);
    children.push(c);
    setTimeout(() => script(c), 1);
    return c;
  };
  return { spawn, children };
};

const finished = (j: HarnessJob) => ['done', 'failed', 'cancelled'].includes(j.step);

const waitJob = async (jobs: HarnessJobs, id: string) => {
  await until(() => finished(jobs.get(id).job), 3000, `job ${id}`);
  return jobs.get(id);
};

// ───────────────────────────── job runner ─────────────────────────────

describe('HarnessJobs', () => {
  it('captures stdout and stderr as lines, strips ANSI, pages with since/next', async () => {
    const { spawn } = fakeSpawn((c) => {
      c.out('\x1b[32mone\x1b[0m\ntwo\r\nthr');
      c.err('warn: x\n');
      c.out('ee\n');
      c.exit(0);
    });
    const jobs = new HarnessJobs({ spawn });
    const job = jobs.start(
      { harness: 'gemini', displayName: 'Gemini CLI', kind: 'install', method: 'npm' },
      async (rt) => {
        rt.step('installing');
        const r = await rt.run('npm', ['i']);
        expect(r.code).toBe(0);
        return 'Installed.';
      },
    );
    expect(job).toMatchObject({ harness: 'gemini', displayName: 'Gemini CLI', step: 'installing', lines: 0 });
    const end = await waitJob(jobs, job.id);
    expect(end.job).toMatchObject({ step: 'done', message: 'Installed.' });
    expect(end.job.endedAt).toBeDefined();
    expect([...end.lines].sort()).toEqual(['one', 'three', 'two', 'warn: x']);
    expect(end.next).toBe(4);
    const page = jobs.get(job.id, 2);
    expect(page.lines).toHaveLength(2);
    expect(page.next).toBe(4);
    expect(jobs.get(job.id, 4).lines).toEqual([]);
    expect(jobs.list().map((j) => j.id)).toEqual([job.id]);
  });

  it('caps stored lines but keeps counting', async () => {
    const { spawn } = fakeSpawn((c) => {
      c.out(Array.from({ length: MAX_JOB_LINES + 50 }, (_, i) => `l${i}`).join('\n') + '\n');
      c.exit(0);
    });
    const jobs = new HarnessJobs({ spawn });
    const job = jobs.start({ harness: 'x', kind: 'install' }, async (rt) => {
      await rt.run('npm', []);
      return undefined;
    });
    const end = await waitJob(jobs, job.id);
    expect(end.job.lines).toBe(MAX_JOB_LINES + 50);
    expect(end.lines).toHaveLength(MAX_JOB_LINES);
    expect(end.lines[0]).toBe('l50');
    expect(jobs.get(job.id, 10).lines[0]).toBe('l50');
    expect(jobs.get(job.id, MAX_JOB_LINES + 49).lines).toEqual([`l${MAX_JOB_LINES + 49}`]);
  });

  it('allows one job per harness', async () => {
    const { spawn } = fakeSpawn(() => {});
    const jobs = new HarnessJobs({ spawn });
    const a = jobs.start({ harness: 'gemini', kind: 'install' }, async (rt) => {
      await rt.run('npm', []);
      return undefined;
    });
    expect(() => jobs.start({ harness: 'gemini', kind: 'update' }, async () => undefined)).toThrow(/busy/);
    // Another harness is fine.
    jobs.start({ harness: 'codex', kind: 'install' }, async () => undefined);
    await jobs.cancel(a.id);
    jobs.start({ harness: 'gemini', kind: 'install' }, async () => undefined);
  });

  it('cancel kills the child and runs cleanups', async () => {
    const { spawn, children } = fakeSpawn((c) => c.out('working\n'));
    const killed: (string | undefined)[] = [];
    const jobs = new HarnessJobs({
      spawn,
      kill: (c, sig) => {
        killed.push(sig);
        c.kill(sig);
      },
    });
    let cleaned = false;
    let afterRun = false;
    const ends: HarnessJob[] = [];
    const job = jobs.start({ harness: 'gemini', kind: 'install', onEnd: (j) => ends.push(j) }, async (rt) => {
      rt.onCleanup(() => {
        cleaned = true;
      });
      await rt.run('npm', []);
      afterRun = true;
      return 'nope';
    });
    await until(() => jobs.get(job.id).lines.includes('working'));
    const c = await jobs.cancel(job.id);
    expect(c.step).toBe('cancelled');
    expect(killed[0]).toBe('SIGTERM');
    expect(children[0]!.killed).toBe('SIGTERM');
    expect(cleaned).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(afterRun).toBe(false);
    expect(jobs.get(job.id).job.step).toBe('cancelled');
    expect(ends.map((e) => e.step)).toEqual(['cancelled']);
  });

  it('maps common failures to plain language and keeps the raw lines', async () => {
    const { spawn } = fakeSpawn((c) => {
      c.err('npm ERR! code EACCES\nnpm ERR! syscall mkdir\n');
      c.exit(1);
    });
    const jobs = new HarnessJobs({ spawn });
    const job = jobs.start({ harness: 'gemini', kind: 'install' }, async (rt) => {
      const r = await rt.run('npm', []);
      if (r.code !== 0) throw new Error(`npm exited with ${r.code}`);
      return undefined;
    });
    const end = await waitJob(jobs, job.id);
    expect(end.job.step).toBe('failed');
    expect(end.job.message).toMatch(/isn't allowed/);
    expect(end.lines).toContain('npm ERR! code EACCES');
  });

  it('fails on timeout', async () => {
    const { spawn } = fakeSpawn(() => {});
    const jobs = new HarnessJobs({ spawn });
    const job = jobs.start({ harness: 'g', kind: 'login', timeoutMs: 20 }, async (rt) => {
      await rt.run('x', []);
      return undefined;
    });
    const end = await waitJob(jobs, job.id);
    expect(end.job).toMatchObject({ step: 'failed', message: expect.stringMatching(/too long/) });
  });

  it('a missing tool is a clear error', async () => {
    const jobs = new HarnessJobs({
      spawn: () => {
        const c = new FakeChild('nope', []);
        setTimeout(
          () => c.emit('error', Object.assign(new Error('spawn nope ENOENT'), { code: 'ENOENT' })),
          1,
        );
        return c;
      },
    });
    const job = jobs.start({ harness: 'g', kind: 'install' }, async (rt) => {
      await rt.run('nope', []);
      return undefined;
    });
    expect((await waitJob(jobs, job.id)).job.message).toMatch(/nope could not be started/);
  });
});

describe('friendlyError', () => {
  it.each([
    ['Error: Another active Homebrew update process is already in progress.', /Homebrew is busy/],
    ['Error: A `brew install` process has already locked /opt/homebrew/Cellar', /Homebrew is busy/],
    ['npm ERR! code E404\nnpm ERR! 404 Not Found - GET https://registry.npmjs.org/@x%2fy', /couldn't find/],
    ['getaddrinfo ENOTFOUND registry.npmjs.org', /internet/],
    ['curl: (6) Could not resolve host: claude.ai', /internet/],
    ['sha256 mismatch', /checksum/],
    ['EACCES: permission denied, mkdir', /isn't allowed/],
    ['the operation timed out', /too long/],
  ])('%s', (text, re) => {
    expect(friendlyError(text)).toMatch(re);
  });
  it('returns undefined for unknown output', () => expect(friendlyError('weird')).toBeUndefined());
});

it('stripAnsi drops colours, cursor moves and OSC links', () => {
  expect(stripAnsi('^D\b\bcols=50')).toBe('cols=50');
  expect(stripAnsi('\x1b[1;32mok\x1b[0m \x1b[2K\x1b[1Gdone \x1b]8;;https://x\x07link\x1b]8;;\x07')).toBe(
    'ok done link',
  );
});

// ───────────────────────────── login flows ─────────────────────────────

describe('login output', () => {
  it('finds the first https URL and a device code', () => {
    expect(parseLoginLine('Open https://example.com/device?x=1, then enter WDJB-MJHT')).toEqual({
      url: 'https://example.com/device?x=1',
      code: 'WDJB-MJHT',
    });
    expect(parseLoginLine('Visit (https://claude.ai/oauth/authorize?code=true&state=ab-CD)')).toEqual({
      url: 'https://claude.ai/oauth/authorize?code=true&state=ab-CD',
    });
    expect(parseLoginLine('no url, http://insecure.example and a date 2026-11-13')).toEqual({});
    // A code inside the URL is not a device code.
    expect(parseLoginLine('https://x.example/ABCD-1234/path')).toEqual({
      url: 'https://x.example/ABCD-1234/path',
    });
  });

  it('runs the login under a wide pseudo-terminal via script', () => {
    expect(ptyArgv('darwin', '/usr/bin/script', '/bin/claude', ['setup-token'])).toEqual({
      cmd: '/usr/bin/script',
      args: [
        '-q',
        '/dev/null',
        'sh',
        '-c',
        'stty cols 1000 rows 50 2>/dev/null; exec "$0" "$@"',
        '/bin/claude',
        'setup-token',
      ],
    });
    const linux = ptyArgv('linux', '/usr/bin/script', "/home/o'brien/bin/x", ['login']);
    expect(linux.cmd).toBe('/usr/bin/script');
    expect(linux.args[0]).toBe('-qefc');
    expect(linux.args[1]).toBe(
      `sh -c 'stty cols 1000 rows 50 2>/dev/null; exec "$0" "$@"' '/home/o'\\''brien/bin/x' login`,
    );
    expect(linux.args[2]).toBe('/dev/null');
    expect(ptyArgv('win32', undefined, 'C:\\x.exe', ['login'])).toEqual({
      cmd: 'C:\\x.exe',
      args: ['login'],
    });
  });

  const deps = (opened: string[]): InstallerDeps => ({
    platform: 'darwin',
    arch: 'arm64',
    env: { PATH: '/usr/bin' },
    home: '/home/u',
    beamhopHome: '/home/u/.beamhop',
    which: (c) => (c === 'script' ? '/usr/bin/script' : undefined),
    fetch: (() => Promise.reject(new Error('no network'))) as never,
    openUrl: (u) => opened.push(u),
    capture: async () => ({ code: 1, stdout: '' }),
  });

  it('captures a token into the vault, opens the browser once, and never stores the token in lines', async () => {
    const token = `sk-ant-oat01-${'Ab3_-'.repeat(20)}`;
    const { spawn, children } = fakeSpawn((c) => {
      c.out('Opening browser to sign in…\r\n');
      c.out('\x1b[2mhttps://claude.ai/oauth/authorize?state=1\x1b[0m\r\n');
      c.out("Browser didn't open? https://claude.ai/oauth/authorize?state=1\r\n");
      setTimeout(
        () =>
          c.out(`Your OAuth token (valid for 1 year):\r\n\r\n${token}\r\n\r\nStore this token securely.\r\n`),
        10,
      );
    });
    const jobs = new HarnessJobs({ spawn });
    const entry = findHarness(loadCatalog(), 'claude')!;
    const stored: [string, string][] = [];
    const opened: string[] = [];
    const job = jobs.start(
      { harness: 'claude', kind: 'login', method: 'flow' },
      loginBody(
        entry,
        entry.auth.loginFlow!,
        deps(opened),
        {
          binary: '/bin/claude',
          storeLogin: async (m, v) => {
            stored.push([m, v]);
          },
          loggedIn: () => false,
        },
        true,
      ),
    );
    const end = await waitJob(jobs, job.id);
    expect(end.job).toMatchObject({ step: 'done', url: 'https://claude.ai/oauth/authorize?state=1' });
    expect(stored).toEqual([['claude-subscription', token]]);
    expect(opened).toEqual(['https://claude.ai/oauth/authorize?state=1']);
    expect(children[0]!.cmd).toBe('/usr/bin/script');
    expect(children[0]!.args.slice(-2)).toEqual(['/bin/claude', 'setup-token']);
    expect(children[0]!.killed).toBe('SIGTERM');
    expect(JSON.stringify(end)).not.toContain(token);
    expect(JSON.stringify(end)).not.toContain('sk-ant-oat01-Ab3');
  });

  it('a browser login finishes on exit when the login check passes, with a device code', async () => {
    const { spawn } = fakeSpawn((c) => {
      c.out('Go to https://auth.example.com/activate and enter ABCD-EFGH\n');
      setTimeout(() => c.exit(0), 10);
    });
    const jobs = new HarnessJobs({ spawn });
    const entry = {
      ...findHarness(loadCatalog(), 'auggie')!,
    };
    const flow = { args: ['login'], kind: 'device-code' as const };
    const opened: string[] = [];
    let ok = false;
    const job = jobs.start(
      { harness: 'auggie', kind: 'login' },
      loginBody(
        entry,
        flow,
        deps(opened),
        { binary: '/bin/auggie', storeLogin: async () => {}, loggedIn: () => ok },
        false,
      ),
    );
    await until(() => jobs.get(job.id).job.step === 'waiting-browser');
    expect(jobs.get(job.id).job).toMatchObject({
      url: 'https://auth.example.com/activate',
      code: 'ABCD-EFGH',
    });
    expect(opened).toEqual([]);
    ok = true;
    expect((await waitJob(jobs, job.id)).job.step).toBe('done');
  });

  it('fails when the command exits without the login check passing', async () => {
    const { spawn } = fakeSpawn((c) => c.exit(1));
    const jobs = new HarnessJobs({ spawn });
    const entry = findHarness(loadCatalog(), 'auggie')!;
    const job = jobs.start(
      { harness: 'auggie', kind: 'login' },
      loginBody(
        entry,
        { args: ['login'], kind: 'browser' },
        deps([]),
        { binary: '/x', storeLogin: async () => {}, loggedIn: () => false },
        false,
      ),
    );
    expect((await waitJob(jobs, job.id)).job).toMatchObject({
      step: 'failed',
      message: expect.stringMatching(/didn't finish/),
    });
  });
});

// ───────────────────────────── doctor fixes ─────────────────────────────

describe('doctor fixes', () => {
  it('has a fixed table: sandbox fixes plus resume', () => {
    const t = doctorActionTable({});
    expect(Object.keys(t)).toEqual(['system.resume']);
    expect(t['system.resume']!.admin).toBe(false);
  });

  it('elevates through the OS prompt', () => {
    const cmd = ['sh', '-c', `printf '%s\\n' 'a=0' > /etc/x && echo "hi"`];
    const mac = elevatedArgv('darwin', cmd, () => undefined);
    expect(mac.cmd).toBe('/usr/bin/osascript');
    expect(mac.args[0]).toBe('-e');
    expect(mac.args[1]).toBe(
      `do shell script "sh -c '${`printf '\\\\''%s\\\\n'\\\\'' '\\\\''a=0'\\\\'' > /etc/x && echo \\"hi\\"`}'" with administrator privileges`,
    );
    expect(
      elevatedArgv('linux', ['apt-get', 'install', '-y', 'socat'], (c) =>
        c === 'pkexec' ? '/usr/bin/pkexec' : undefined,
      ),
    ).toEqual({
      cmd: '/usr/bin/pkexec',
      args: ['apt-get', 'install', '-y', 'socat'],
    });
    expect(() => elevatedArgv('linux', ['x'], () => undefined)).toThrow(/beamhop doctor --fix/);
    expect(shQuote("it's")).toBe(`'it'\\''s'`);
    expect(elevatedFailure('linux', { code: 126, output: '' })).toMatch(/cancelled/);
    expect(elevatedFailure('linux', { code: 127, output: '' })).toMatch(/polkit/);
    expect(elevatedFailure('darwin', { code: 1, output: 'execution error: User canceled. (-128)' })).toMatch(
      /cancelled/,
    );
  });
});

// ───────────────────────────── through the API ─────────────────────────────

let env: TestEnv | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

const REMOTE = { caller: 'nostr:npub1someone', transport: 'nostr' as const };
const call = async (
  e: TestEnv,
  method: string,
  params: unknown,
  ctx: { caller: string; transport: 'nostr' | 'ws' | 'http' | 'direct' } = REMOTE,
) => e.d.dispatch({ jsonrpc: '2.0', id: 1, method, params }, ctx);

describe('harness install API', () => {
  it('refuses callers that are not on this computer', async () => {
    env = await makeEnv();
    for (const [method, params] of [
      ['harness.install', { id: 'gemini' }],
      ['harness.update', { id: 'gemini' }],
      ['harness.loginFlow', { id: 'claude' }],
      ['harness.job.cancel', { jobId: 'job_x' }],
      ['system.doctorFix', { id: 'system.resume' }],
    ] as const) {
      for (const ctx of [REMOTE, { caller: 'nostr:npub1x', transport: 'ws' as const }]) {
        const r = await call(env, method, params, ctx);
        expect('error' in r && r.error, method).toMatchObject({
          data: { code: 'forbidden' },
          message: expect.stringMatching(/only on the computer running beamhop/),
        });
      }
    }
    // Read-only job and update calls stay open.
    const list = await call(env, 'harness.job.list', {});
    expect('result' in list && list.result).toEqual({ jobs: [] });
  });

  it('installs with npm into beamhop’s own prefix, re-scans, and audits it', async () => {
    if (process.platform === 'win32') return;
    let home = '';
    const { spawn, children } = fakeSpawn((c) => {
      // Stand in for npm: put a gemini binary where npm would.
      const bin = join(managedNpmPrefix(home), 'bin');
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, 'gemini'), '#!/bin/sh\necho 0.99.1\n');
      chmodSync(join(bin, 'gemini'), 0o755);
      c.out('added 1 package in 1s\n');
      c.exit(0);
    });
    env = await makeEnv({
      plugins: {
        discovery: {
          scan: () => scanHarnesses({ beamhopHome: home, env: { PATH: '' }, home, only: ['gemini'] }),
        },
      },
      harnessTools: {
        spawn,
        installer: {
          platform: 'darwin',
          env: { PATH: '/usr/bin' },
          which: (c) => (c === 'npm' ? '/usr/local/bin/npm' : undefined),
        },
      },
    });
    home = env.home;
    const before = (await env.client.call('harness.scan')).harnesses.find((h) => h.id === 'gemini')!;
    expect(before.status).toBe('not-installed');
    expect(before.installPlan).toEqual({
      method: 'npm',
      label: 'npm',
      command: ['npm', 'install', '-g', '--prefix', join(home, 'harnesses', 'npm'), '@google/gemini-cli'],
      alternatives: [],
    });
    const job = await env.client.call('harness.install', { id: 'gemini' });
    expect(job).toMatchObject({
      harness: 'gemini',
      kind: 'install',
      method: 'npm',
      displayName: 'Gemini CLI',
    });
    await until(
      async () => finished((await env!.client.call('harness.job.get', { jobId: job.id })).job),
      5000,
    );
    const got = await env.client.call('harness.job.get', { jobId: job.id });
    expect(got.job).toMatchObject({ step: 'done', message: 'Installed Gemini CLI 0.99.1 via npm.' });
    expect(children[0]!.cmd).toBe('/usr/local/bin/npm');
    expect(children[0]!.args).toEqual([
      'install',
      '-g',
      '--prefix',
      join(home, 'harnesses', 'npm'),
      '@google/gemini-cli',
    ]);
    const after = (await env.client.call('harness.list')).harnesses.find((h) => h.id === 'gemini')!;
    expect(after).toMatchObject({ managed: true, version: '0.99.1' });
    expect(env.d.store.audit.query({ type: 'harness.installed' })[0]?.summary).toBe(
      'Installed Gemini CLI 0.99.1 via npm.',
    );
    // Updates: beamhop's own npm copy can be updated.
    const upd = await env.client.call('harness.update', { id: 'gemini' });
    expect(upd.method).toBe('npm');
    await until(
      async () => finished((await env!.client.call('harness.job.get', { jobId: upd.id })).job),
      5000,
    );
    expect(children[1]!.args.at(-1)).toBe('@google/gemini-cli@latest');
  });

  it('explains when nothing can install a harness', async () => {
    env = await makeEnv({ harnessTools: { installer: { platform: 'darwin', which: () => undefined } } });
    await expect(env.client.call('harness.install', { id: 'gemini' })).rejects.toThrow(
      /Needs Homebrew or Node.js; neither was found/,
    );
    await expect(env.client.call('harness.install', { id: 'nope' })).rejects.toThrow(/not a harness/);
  });

  it('rescans when the catalog changed since the stored scan', async () => {
    env = await makeEnv();
    env.d.store.kv.set('harness', 'scan', [
      { id: 'goose', displayName: 'goose', command: 'goose', status: 'ready', protocol: 'acp' },
    ]);
    env.d.store.kv.set('harness', 'scanCatalog', '2000.01.01');
    const { harnesses } = await env.client.call('harness.list');
    expect(harnesses.map((h) => h.id)).not.toContain('goose');
    expect(env.d.store.kv.get('harness', 'scanCatalog')).toBe(loadCatalog().revision);
  });

  it('reports updates, cached for a day', async () => {
    let lookups = 0;
    env = await makeEnv({
      harnessTools: {
        installer: {
          platform: 'darwin',
          which: (c) => (c === 'brew' ? '/opt/homebrew/bin/brew' : undefined),
          capture: async (_cmd, args) => {
            lookups++;
            expect(args).toEqual(['info', '--json=v2', 'gemini-cli']);
            return { code: 0, stdout: JSON.stringify({ formulae: [{ versions: { stable: '0.40.0' } }] }) };
          },
        },
      },
    });
    env.d.store.kv.set('harness', 'scan', [
      {
        id: 'gemini',
        displayName: 'Gemini CLI',
        command: 'gemini',
        status: 'unsupported-version',
        protocol: 'acp',
        version: '0.20.0',
        path: '/opt/homebrew/bin/gemini',
      },
    ]);
    env.d.store.kv.set('harness', 'scanCatalog', loadCatalog().revision);
    const r = await env.client.call('harness.updates');
    expect(r.updates.find((u) => u.id === 'gemini')).toEqual({
      id: 'gemini',
      current: '0.20.0',
      latest: '0.40.0',
      available: true,
      required: true,
    });
    await env.client.call('harness.updates');
    expect(lookups).toBe(1);
    await env.client.call('harness.updates', { refresh: true });
    expect(lookups).toBe(2);
  });

  it('only updates what beamhop or Homebrew installed', () => {
    const entry = findHarness(loadCatalog(), 'gemini')!;
    const d = {
      beamhopHome: '/h/.beamhop',
      platform: 'linux' as const,
      which: (c: string) => `/usr/bin/${c}`,
    };
    expect(updateMethodFor({ path: '/h/.beamhop/harnesses/npm/bin/gemini' }, entry, d)).toBe('npm');
    expect(updateMethodFor({ path: '/home/linuxbrew/.linuxbrew/bin/gemini' }, entry, d)).toBe('brew');
    expect(updateMethodFor({ path: '/usr/lib/node_modules/.bin/gemini' }, entry, d)).toBeUndefined();
  });

  it('doctorFix: resume runs without admin; admin fixes need the OS prompt', async () => {
    const ran: string[][] = [];
    env = await makeEnv({
      harnessTools: {
        installer: { platform: 'linux', which: (c) => (c === 'pkexec' ? '/usr/bin/pkexec' : undefined) },
        sandboxActions: {
          'linux.pkg.socat': {
            id: 'linux.pkg.socat',
            label: 'Install socat',
            summary: 'Installs socat.',
            admin: true,
            command: ['apt-get', 'install', '-y', 'socat'],
          },
        },
        fixRunner: async (cmd, args) => {
          ran.push([cmd, ...args]);
          return { code: 0, output: 'Setting up socat\n' };
        },
      },
    });
    await env.client.call('system.panic', { reason: 'test' });
    const doc = await env.client.call('system.doctor');
    expect(doc.checks.find((c) => c.id === 'panic')?.action).toMatchObject({
      id: 'system.resume',
      admin: false,
    });
    const r = await env.client.call('system.doctorFix', { id: 'system.resume', elevate: 'none' });
    expect(env.d.isPanic()).toBe(false);
    expect(r.checks.some((c) => c.id === 'panic')).toBe(false);
    await expect(
      env.client.call('system.doctorFix', { id: 'linux.pkg.socat', elevate: 'none' }),
    ).rejects.toThrow(/needs administrator rights/);
    const fixed = await env.client.call('system.doctorFix', { id: 'linux.pkg.socat' });
    expect(fixed.output).toMatch(/socat/);
    expect(ran).toEqual([['/usr/bin/pkexec', 'apt-get', 'install', '-y', 'socat']]);
    expect(env.d.store.audit.query({ type: 'doctor.fixed' })[0]?.summary).toBe('Ran fix linux.pkg.socat');
    await expect(env.client.call('system.doctorFix', { id: 'rm -rf /' })).rejects.toThrow(/no fix/);
  });

  it('a login flow needs an installed harness with a flow', async () => {
    env = await makeEnv();
    await expect(env.client.call('harness.loginFlow', { id: 'copilot' })).rejects.toThrow(
      /can't be signed in from the app/,
    );
    await expect(env.client.call('harness.loginFlow', { id: 'claude' })).rejects.toThrow(/not installed/);
    expect(existsSync(join(env.home, 'harnesses'))).toBe(false);
  });
});
