import { createClient, directTransport } from '@beamhop/client';
import type { DoctorCheck, HarnessJob } from '@beamhop/core';
import { describe, expect, it } from 'vitest';
import { isRemoteDaemon, shellLine, sudoArgv } from '../src/doctor-fix.ts';
import { isHeadless } from '../src/jobs.ts';
import { buildProgram, type CliDeps, type CliIO } from '../src/program.ts';

// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI colours for assertions
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

const job = (over: Partial<HarnessJob> = {}): HarnessJob => ({
  id: 'job1',
  harness: 'gemini',
  kind: 'install',
  method: 'brew',
  step: 'resolving',
  startedAt: '2026-11-13T10:00:00Z',
  lines: 0,
  ...over,
});

const gemini = (over: Record<string, unknown> = {}) => ({
  id: 'gemini',
  displayName: 'Gemini CLI',
  command: 'gemini',
  status: 'not-installed',
  protocol: 'acp',
  install: { npm: '@google/gemini-cli', brew: 'gemini-cli', url: 'https://example.com/gemini' },
  installPlan: {
    method: 'brew',
    label: 'Homebrew',
    command: ['brew', 'install', 'gemini-cli'],
    alternatives: ['npm'],
  },
  ...over,
});

type Handler = (params: Record<string, unknown>) => unknown;

/**
 * A fake daemon. `states` is what successive `harness.job.get` calls return (the last one repeats);
 * each state carries the raw lines that appeared since the previous one.
 */
const setup = (
  o: {
    over?: Record<string, Handler>;
    states?: { job: Partial<HarnessJob>; lines?: string[] }[];
    env?: Record<string, string>;
    interactive?: boolean;
    deps?: Partial<CliDeps>;
  } = {},
) => {
  const out: string[] = [];
  const err: string[] = [];
  const calls: [string, Record<string, unknown>][] = [];
  const states = o.states ?? [{ job: { step: 'done' } }];
  let polls = 0;
  let total = 0;
  let interrupt: (() => void) | undefined;
  const base: Record<string, Handler> = {
    'harness.list': () => ({ harnesses: [gemini()] }),
    'harness.install': () => job(),
    'harness.update': () => job({ kind: 'update' }),
    'harness.loginFlow': () => job({ kind: 'login', method: 'flow', step: 'resolving' }),
    'harness.job.get': (p) => {
      const s = states[Math.min(polls, states.length - 1)]!;
      polls++;
      const lines = Number(p.since) < total + (s.lines?.length ?? 0) ? (s.lines ?? []) : [];
      total += lines.length;
      return { job: job(s.job), lines, next: total };
    },
    'harness.job.cancel': () => job({ step: 'cancelled' }),
  };
  const handlers = { ...base, ...o.over };
  const io: CliIO = {
    out: (l) => out.push(plain(l)),
    err: (l) => err.push(plain(l)),
    readStdin: async () => '',
    env: o.env ?? {},
    interactive: o.interactive ?? false,
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
    sleep: async () => {},
    onInterrupt: (fn) => {
      interrupt = fn;
      return () => {
        interrupt = undefined;
      };
    },
    platform: 'darwin',
    ...o.deps,
  });
  const run = (...args: string[]) => program.parseAsync(['node', 'beamhop', ...args]);
  return { out, err, calls, io, run, interrupt: () => interrupt?.() };
};

describe('harness install', () => {
  it('shows the plan, follows the steps and finishes', async () => {
    const t = setup({
      states: [
        { job: { step: 'downloading' } },
        { job: { step: 'installing' }, lines: ['==> Pouring gemini-cli'] },
        { job: { step: 'done', message: '0.9.1' } },
      ],
    });
    await t.run('harness', 'install', 'gemini');
    const text = t.out.join('\n');
    expect(text).toContain('Installing Gemini CLI with Homebrew');
    expect(text).toContain('brew install gemini-cli');
    expect(text).toContain('Downloading…');
    expect(text).toContain('Installing…');
    expect(text).not.toContain('Pouring'); // raw lines only with --verbose
    expect(text).toContain('✓ Installed Gemini CLI');
    expect(t.io.exitCode).toBeUndefined();
    expect(t.calls.find(([m]) => m === 'harness.install')?.[1]).toEqual({ id: 'gemini' });
  });

  it('prints raw lines with --verbose and passes --method', async () => {
    const t = setup({
      states: [{ job: { step: 'installing' }, lines: ['added 1 package'] }, { job: { step: 'done' } }],
    });
    await t.run('harness', 'install', 'gemini', '--method', 'npm', '--verbose');
    expect(t.out.join('\n')).toContain('│ added 1 package');
    expect(t.calls.find(([m]) => m === 'harness.install')?.[1]).toEqual({ id: 'gemini', method: 'npm' });
  });

  it('exits 1 with the plain message and the last output when the job fails', async () => {
    const t = setup({
      states: [
        { job: { step: 'installing' }, lines: ['Error: brew lock'] },
        { job: { step: 'failed', message: 'Homebrew is busy with another install. Try again in a minute.' } },
      ],
    });
    await t.run('harness', 'install', 'gemini');
    const text = t.out.join('\n');
    expect(text).toContain('✗ Gemini CLI install failed: Homebrew is busy');
    expect(text).toContain('│ Error: brew lock');
    expect(t.io.exitCode).toBe(1);
  });

  it('cancels the job on Ctrl-C', async () => {
    let t!: ReturnType<typeof setup>;
    let polls = 0;
    t = setup({
      over: {
        'harness.job.get': () => {
          polls++;
          if (polls === 2) t.interrupt();
          const cancelled = t.calls.some(([m]) => m === 'harness.job.cancel');
          return {
            job: job({ step: cancelled && polls > 2 ? 'cancelled' : 'downloading' }),
            lines: [],
            next: 0,
          };
        },
      },
    });
    await t.run('harness', 'install', 'gemini');
    expect(t.calls.find(([m]) => m === 'harness.job.cancel')?.[1]).toEqual({ jobId: 'job1' });
    expect(t.out.join('\n')).toContain('Cancelling the Gemini CLI install');
    expect(t.out.join('\n')).toContain('install cancelled');
    expect(t.io.exitCode).toBe(130);
  });

  it('prints the final job as JSON', async () => {
    const t = setup({ states: [{ job: { step: 'done' }, lines: ['ok'] }] });
    await t.run('--json', 'harness', 'install', 'gemini');
    const r = JSON.parse(t.out.join('\n'));
    expect(r.job.step).toBe('done');
    expect(r.lines).toEqual(['ok']);
  });

  it('says so when the harness is already installed', async () => {
    const t = setup({
      over: { 'harness.list': () => ({ harnesses: [gemini({ status: 'ready', version: '0.9.1' })] }) },
    });
    await t.run('harness', 'install', 'gemini');
    expect(t.out.join('\n')).toContain('Gemini CLI is already installed (0.9.1)');
    expect(t.calls.some(([m]) => m === 'harness.install')).toBe(false);
    expect(t.io.exitCode).toBeUndefined();
  });

  it('explains when no installer applies and points to the vendor page', async () => {
    const t = setup({
      over: {
        'harness.list': () => ({
          harnesses: [
            gemini({ installPlan: { method: 'none', label: 'none', command: [], alternatives: [] } }),
          ],
        }),
      },
    });
    await t.run('harness', 'install', 'gemini');
    expect(t.err.join('\n')).toContain('https://example.com/gemini');
    expect(t.io.exitCode).toBe(1);
  });

  it('--no-follow prints the job id', async () => {
    const t = setup();
    await t.run('harness', 'install', 'gemini', '--no-follow');
    expect(t.out.join('\n')).toContain('beamhop harness job job1');
    expect(t.calls.some(([m]) => m === 'harness.job.get')).toBe(false);
  });

  it('ls shows the install command from the plan, else the package commands', async () => {
    const t = setup({
      over: {
        'harness.list': () => ({
          harnesses: [
            gemini(),
            gemini({ id: 'other', installPlan: undefined, install: { npm: 'other-cli' } }),
          ],
        }),
      },
    });
    await t.run('harness', 'ls');
    const text = t.out.join('\n');
    expect(text).toContain('beamhop harness install gemini  (via Homebrew)');
    expect(text).toContain('npm i -g other-cli');
  });
});

describe('harness update / updates / jobs', () => {
  it('updates and follows', async () => {
    const t = setup({
      over: { 'harness.list': () => ({ harnesses: [gemini({ status: 'ready', version: '0.8.0' })] }) },
      states: [{ job: { kind: 'update', step: 'done' } }],
    });
    await t.run('harness', 'update', 'gemini');
    expect(t.out.join('\n')).toContain('✓ Updated Gemini CLI');
  });

  it('renders the updates table', async () => {
    const t = setup({
      over: {
        'harness.updates': () => ({
          updates: [
            { id: 'gemini', current: '0.8.0', latest: '0.9.1', available: true, required: false },
            { id: 'codex', current: '0.1.0', latest: '0.5.0', available: true, required: true },
            { id: 'claude', current: '2.0.0', latest: '2.0.0', available: false, required: false },
          ],
        }),
      },
    });
    await t.run('harness', 'updates', '--refresh');
    expect(t.calls[0]).toEqual(['harness.updates', { refresh: true }]);
    const lines = t.out.join('\n').split('\n');
    expect(lines[0]).toMatch(/ID\s+CURRENT\s+LATEST\s+REQUIRED/);
    expect(lines.find((l) => l.startsWith('codex'))).toMatch(/0\.1\.0\s+0\.5\.0\s+yes/);
    expect(lines.some((l) => l.startsWith('claude'))).toBe(false);
  });

  it('says when everything is up to date', async () => {
    const t = setup({ over: { 'harness.updates': () => ({ updates: [] }) } });
    await t.run('harness', 'updates');
    expect(t.out.join('\n')).toContain('up to date');
  });

  it('lists jobs and cancels one', async () => {
    const t = setup({ over: { 'harness.job.list': () => ({ jobs: [job({ step: 'downloading' })] }) } });
    await t.run('harness', 'jobs');
    expect(t.out.join('\n')).toMatch(/job1\s+gemini\s+install\s+downloading\s+Homebrew/);
    await t.run('harness', 'job', 'job1', '--cancel');
    expect(t.calls.at(-1)).toEqual(['harness.job.cancel', { jobId: 'job1' }]);
  });
});

describe('harness login --browser', () => {
  const withFlow = {
    'harness.list': () => ({
      harnesses: [gemini({ status: 'needs-login', loginFlow: { kind: 'device-code' } })],
    }),
  };
  const states = [
    {
      job: {
        kind: 'login' as const,
        step: 'waiting-browser' as const,
        url: 'https://login.example/device',
        code: 'ABCD-1234',
      },
    },
    { job: { kind: 'login' as const, step: 'done' as const } },
  ];

  it('over SSH asks the daemon not to open a browser and prints the URL and code', async () => {
    const t = setup({ over: withFlow, states, env: { SSH_CONNECTION: '1.2.3.4 5 6.7.8.9 22' } });
    await t.run('harness', 'login', 'gemini', '--browser');
    expect(t.calls.find(([m]) => m === 'harness.loginFlow')?.[1]).toEqual({
      id: 'gemini',
      openBrowser: false,
    });
    const text = t.out.join('\n');
    expect(text).toContain('Open this page on any device: https://login.example/device');
    expect(text).toContain('Code: ABCD-1234');
    expect(text).toContain('✓ Logged in Gemini CLI');
  });

  it('lets the daemon open the browser on a desktop, and --no-open turns that off', async () => {
    const t = setup({ over: withFlow, states });
    await t.run('harness', 'login', 'gemini', '--browser');
    expect(t.calls.find(([m]) => m === 'harness.loginFlow')?.[1]).toEqual({
      id: 'gemini',
      openBrowser: true,
    });
    expect(t.out.join('\n')).toContain('If it does not open: https://login.example/device');
    const u = setup({ over: withFlow, states });
    await u.run('harness', 'login', 'gemini', '--no-open');
    expect(u.calls.find(([m]) => m === 'harness.loginFlow')?.[1]).toEqual({
      id: 'gemini',
      openBrowser: false,
    });
  });

  it('refuses to mix --browser with the stored-login options', async () => {
    const t = setup({ over: withFlow });
    await t.run('harness', 'login', 'gemini', '--browser', '--from-env', 'X');
    expect(t.io.exitCode).toBe(1);
    expect(t.calls.some(([m]) => m === 'harness.loginFlow')).toBe(false);
  });

  it('explains the vault methods when there is no browser login', async () => {
    const t = setup({
      over: {
        'harness.list': () => ({
          harnesses: [
            gemini({
              status: 'needs-login',
              login: {
                status: 'logged-out',
                methods: [
                  {
                    id: 'api-key',
                    label: 'Gemini API key',
                    kind: 'env',
                    secret: 'GEMINI_API_KEY',
                    set: false,
                  },
                ],
              },
            }),
          ],
        }),
      },
    });
    await t.run('harness', 'login', 'gemini', '--browser');
    expect(t.err.join('\n')).toContain('api-key: Gemini API key');
    expect(t.err.join('\n')).toContain('beamhop harness status gemini');
  });
});

describe('doctor --fix', () => {
  const bwrap = (status: DoctorCheck['status']): DoctorCheck => ({
    id: 'bwrap',
    title: 'bubblewrap',
    status,
    message: status === 'ok' ? 'found' : 'missing',
    fix: 'sudo apt-get install bubblewrap',
    action: {
      id: 'linux.apt.bubblewrap',
      label: 'Install bubblewrap',
      summary: 'Installs bubblewrap, which beamhop uses to keep each agent in its folder.',
      admin: true,
      command: ['apt-get', 'install', '-y', 'bubblewrap'],
    },
  });
  const keys = (status: DoctorCheck['status']): DoctorCheck => ({
    id: 'srt',
    title: 'srt runtime',
    status,
    message: '',
    action: {
      id: 'srt.install',
      label: 'Install srt',
      summary: 'Installs the sandbox runtime.',
      admin: false,
      command: [],
    },
  });
  const doctor = (fixed: () => boolean) => ({
    'system.doctor': () => ({ checks: [bwrap(fixed() ? 'ok' : 'fail'), keys('ok')] }),
  });

  it('plain doctor shows the --fix hint', async () => {
    const t = setup({ over: doctor(() => false) });
    await t.run('doctor');
    expect(t.out.join('\n')).toContain('fix: beamhop doctor --fix bwrap');
    expect(t.out.join('\n')).toContain('or by hand: sudo apt-get install bubblewrap');
  });

  it('asks, then runs sudo with the fixed command and inherited stdio', async () => {
    let ran = false;
    const argvs: string[][] = [];
    const asked: string[] = [];
    const t = setup({
      over: doctor(() => ran),
      interactive: true,
      deps: {
        confirm: async (m) => {
          asked.push(m);
          return true;
        },
        runInherit: async (argv) => {
          argvs.push(argv);
          ran = true;
          return 0;
        },
      },
    });
    await t.run('doctor', '--fix');
    expect(asked).toHaveLength(1);
    expect(argvs).toEqual([['sudo', '--', 'apt-get', 'install', '-y', 'bubblewrap']]);
    expect(t.out.join('\n')).toContain('sudo apt-get install -y bubblewrap');
    expect(t.out.join('\n')).toContain('✓ Install bubblewrap');
    expect(t.calls.filter(([m]) => m === 'system.doctor')).toHaveLength(2);
    expect(t.io.exitCode).toBeUndefined();
  });

  it('--yes skips the question', async () => {
    let ran = false;
    let asked = false;
    const t = setup({
      over: doctor(() => ran),
      deps: {
        confirm: async () => {
          asked = true;
          return false;
        },
        runInherit: async () => {
          ran = true;
          return 0;
        },
      },
    });
    await t.run('doctor', '--fix', 'bwrap', '--yes');
    expect(asked).toBe(false);
    expect(ran).toBe(true);
  });

  it('without a terminal and without --yes prints the command instead', async () => {
    let ran = false;
    const t = setup({
      over: doctor(() => false),
      deps: {
        runInherit: async () => {
          ran = true;
          return 0;
        },
      },
    });
    await t.run('doctor', '--fix');
    expect(ran).toBe(false);
    expect(t.out.join('\n')).toContain('needs administrator rights. Run:');
    expect(t.out.join('\n')).toContain('sudo apt-get install -y bubblewrap');
    expect(t.io.exitCode).toBe(1);
  });

  it('runs non-admin fixes through the daemon, never sudo', async () => {
    let fixed = false;
    const t = setup({
      over: {
        'system.doctor': () => ({ checks: [keys(fixed ? 'ok' : 'warn')] }),
        'system.doctorFix': () => {
          fixed = true;
          return { checks: [keys('ok')], output: 'installed' };
        },
      },
      deps: { runInherit: async () => 99 },
    });
    await t.run('doctor', '--fix', 'srt');
    expect(t.calls.find(([m]) => m === 'system.doctorFix')?.[1]).toEqual({
      id: 'srt.install',
      elevate: 'none',
    });
    expect(t.out.join('\n')).toContain('✓ Install srt');
    expect(t.io.exitCode).toBeUndefined();
  });

  it('rejects unknown check ids', async () => {
    const t = setup({ over: doctor(() => false) });
    await t.run('doctor', '--fix', 'nope');
    expect(t.err.join('\n')).toContain('no doctor check nope');
    expect(t.io.exitCode).toBe(1);
  });
});

describe('helpers', () => {
  it('detects headless sessions', () => {
    expect(isHeadless({}, 'darwin')).toBe(false);
    expect(isHeadless({ SSH_TTY: '/dev/pts/0' }, 'darwin')).toBe(true);
    expect(isHeadless({}, 'linux')).toBe(true);
    expect(isHeadless({ DISPLAY: ':0' }, 'linux')).toBe(false);
    expect(isHeadless({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux')).toBe(false);
  });
  it('quotes and builds sudo argv', () => {
    expect(shellLine(['echo', 'a b'])).toBe("echo 'a b'");
    expect(sudoArgv(['apt-get', 'install'])).toEqual(['sudo', '--', 'apt-get', 'install']);
    expect(() => sudoArgv([])).toThrow();
  });
  it('knows a remote daemon', () => {
    expect(isRemoteDaemon({})).toBe(false);
    expect(isRemoteDaemon({ BEAMHOP_URL: 'http://127.0.0.1:7878' })).toBe(false);
    expect(isRemoteDaemon({ BEAMHOP_URL: 'http://box.lan:7878' })).toBe(true);
  });
});
