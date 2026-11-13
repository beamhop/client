import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type GitInfo, inspectGit, planMountSync, stripRemoteCredentials } from '../src/index.ts';

const HOME = join(tmpdir(), 'fakehome');

const inspector =
  (map: Record<string, GitInfo>) =>
  async (p: string): Promise<GitInfo | undefined> =>
    map[p];

describe('planMountSync', () => {
  it('git mounts become a remote clone; credentials are stripped and unpushed work is flagged', async () => {
    const repo = join(HOME, 'src', 'app');
    const plan = await planMountSync(
      [{ path: repo, mode: 'rw' }],
      { kind: 'vps', agent: 'reviewer', sshHost: '203.0.113.7' },
      {
        home: HOME,
        inspect: inspector({
          [repo]: {
            remote: 'https://user:ghp_secret123@github.com/me/app.git',
            branch: 'main',
            dirty: true,
            ahead: 2,
          },
        }),
      },
    );
    const step = plan.steps[0]!;
    expect(step.method).toBe('git-clone');
    expect(step.run).toBe('remote');
    expect(step.commands[0]).toEqual([
      'git',
      'clone',
      '--branch',
      'main',
      '--',
      'https://github.com/me/app.git',
      '/home/beamhop/.beamhop/workspaces/app',
    ]);
    expect(JSON.stringify(plan)).not.toContain('ghp_secret123');
    expect(step.notes.join(' ')).toMatch(/Credentials were removed/);
    expect(step.notes.join(' ')).toMatch(/Uncommitted/);
    expect(step.notes.join(' ')).toMatch(/2 local commit/);
  });

  it('non-git mounts on a VPS use rsync over SSH and exclude always-denied paths nested inside', async () => {
    const plan = await planMountSync(
      [{ path: HOME, mode: 'ro', mutagen: true }],
      { kind: 'vps', agent: 'reviewer', sshHost: 'host.example' },
      { home: HOME, inspect: inspector({}) },
    );
    const rsync = plan.steps.find((s) => s.method === 'rsync')!;
    const argv = rsync.commands[0]!;
    expect(argv[0]).toBe('rsync');
    expect(argv).toContain('--protect-args');
    expect(argv.at(-1)).toBe('beamhop@host.example:/home/beamhop/.beamhop/workspaces/fakehome/');
    const excludes = argv.flatMap((a, i) => (argv[i - 1] === '--exclude' ? [a] : []));
    for (const d of ['/.ssh', '/.aws', '/.gnupg', '/.beamhop', '/.config/gh', '/.netrc', '/.npmrc']) {
      expect(excludes).toContain(d);
    }
    const mut = plan.steps.find((s) => s.method === 'mutagen')!;
    expect(mut.commands[0]).toContain('one-way-replica');
    expect(mut.commands[0]).toContain('/.ssh');
    expect(mut.commands[0]!.slice(0, 3)).toEqual(['mutagen', 'sync', 'create']);
  });

  it('never copies a mount that lies inside an always-denied path', async () => {
    const plan = await planMountSync(
      [
        { path: join(HOME, '.ssh'), mode: 'ro' },
        { path: join(HOME, '.aws', 'creds-dir'), mode: 'ro' },
        { path: '~/.beamhop', mode: 'ro' },
      ],
      { kind: 'vps', agent: 'a', sshHost: 'h' },
      { home: HOME, inspect: inspector({}) },
    );
    expect(plan.steps.map((s) => s.method)).toEqual(['skip', 'skip', 'skip']);
    expect(plan.steps.every((s) => s.commands.length === 0)).toBe(true);
  });

  it('PaaS gets a volume upload note and no Mutagen; duplicate basenames are disambiguated', async () => {
    const a = join(HOME, 'x', 'docs');
    const b = join(HOME, 'y', 'docs');
    const plan = await planMountSync(
      [
        { path: a, mode: 'ro', mutagen: true },
        { path: b, mode: 'rw' },
      ],
      { kind: 'paas', agent: 'a' },
      { home: HOME, inspect: inspector({}) },
    );
    expect(plan.steps.map((s) => [s.method, s.remotePath])).toEqual([
      ['volume-upload', '/home/beamhop/.beamhop/workspaces/docs'],
      ['volume-upload', '/home/beamhop/.beamhop/workspaces/docs-2'],
    ]);
    expect(plan.steps[0]!.notes.join(' ')).toMatch(/Mutagen sync needs SSH/);
  });

  it('warns about missing SSH host and Windows tooling', async () => {
    const plan = await planMountSync(
      [{ path: join(HOME, 'p'), mode: 'ro' }],
      { kind: 'vps', agent: 'a' },
      { home: HOME, inspect: inspector({}), platform: 'win32' },
    );
    expect(plan.warnings.join(' ')).toMatch(/SSH/);
    expect(plan.warnings.join(' ')).toMatch(/WSL2/);
  });
});

describe('helpers', () => {
  it('stripRemoteCredentials leaves ssh remotes alone', () => {
    expect(stripRemoteCredentials('git@github.com:me/app.git')).toEqual({
      url: 'git@github.com:me/app.git',
      hadCredentials: false,
    });
    expect(stripRemoteCredentials('https://x-access-token:abc@github.com/me/a.git').hadCredentials).toBe(
      true,
    );
  });

  it('inspectGit returns undefined for a non-git directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'beamhop-nogit-'));
    expect(await inspectGit(dir)).toBeUndefined();
  });
});
