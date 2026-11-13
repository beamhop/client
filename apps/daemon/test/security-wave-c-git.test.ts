// Regression tests for docs/security/REVIEW-wave-c.md GIT-1: a session's git worktree must not let
// a sandboxed agent plant config/hooks that unsandboxed git (the daemon's merge/PR, or the owner)
// later runs, and daemon-side git must refuse a tampered worktree.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RpcError } from '@beamhop/client';
import { compilePolicy, createSandbox } from '@beamhop/sandbox';
import { afterEach, describe, expect, it } from 'vitest';
import { repoOfWorktree, sandboxGitWritePaths } from '../src/git-ops.ts';
import { addWorktree } from '../src/worktree.ts';
import { FakeHarnessPlugin, makeEnv, ownerAlice, setupBot, type TestEnv, tmpHome, until } from './helpers.ts';

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@x',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@x',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: gitEnv }).trim();
const code = (e: unknown) => (e as RpcError).beamhopCode ?? (e as { code?: string }).code;

const newRepo = (root: string) => {
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), 'hi\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
  return repo;
};

/** Make `wt/.git` point at a fake repository inside the worktree whose config runs `marker`. */
const plantFakeGitdir = (wt: string, marker: string) => {
  const evil = join(wt, '.evil');
  mkdirSync(join(evil, 'objects'), { recursive: true });
  mkdirSync(join(evil, 'refs', 'heads'), { recursive: true });
  writeFileSync(join(evil, 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(
    join(evil, 'config'),
    `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tfsmonitor = "touch ${marker}; false"\n`,
  );
  writeFileSync(join(wt, '.git'), 'gitdir: .evil\n');
};

let env: TestEnv | undefined;
const roots: string[] = [];
afterEach(async () => {
  await env?.close();
  env = undefined;
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const tmp = () => {
  const r = realpathSync(mkdtempSync(join(tmpdir(), 'bh-wc-git-')));
  roots.push(r);
  return r;
};

describe('GIT-1: worktree verification', () => {
  it('precondition: plain `git status` in a planted worktree runs the attacker command', () => {
    const root = tmp();
    const wt = join(root, 'wt');
    mkdirSync(wt);
    const marker = join(root, 'pwned');
    plantFakeGitdir(wt, marker);
    writeFileSync(join(wt, 'a.txt'), 'x');
    spawnSync('git', ['-C', wt, 'status', '--porcelain'], { env: gitEnv });
    expect(existsSync(marker)).toBe(true);
  });

  it('accepts a fresh worktree and refuses a rewritten .git pointer, commondir or HEAD', async () => {
    const root = tmp();
    const repo = newRepo(root);
    const wt = await addWorktree({ mount: repo, repo, dir: join(root, 'wts', 's1'), thread: 't' });
    expect(await repoOfWorktree(wt.path, { repos: [repo], branch: wt.branch })).toBe(repo);
    // Not one of the agent's repositories.
    const other = newRepo(join(root, 'other'));
    await expect(repoOfWorktree(wt.path, { repos: [other] })).rejects.toThrow(/tampered/);
    // HEAD moved onto main: a daemon-side commit would land on the owner's branch.
    const admin = git(wt.path, 'rev-parse', '--absolute-git-dir');
    writeFileSync(join(admin, 'HEAD'), 'ref: refs/heads/main\n');
    await expect(repoOfWorktree(wt.path, { repos: [repo], branch: wt.branch })).rejects.toThrow(/HEAD/);
    writeFileSync(join(admin, 'HEAD'), `ref: refs/heads/${wt.branch}\n`);
    // commondir redirected to a directory the agent controls.
    const commondir = readFileSync(join(admin, 'commondir'), 'utf8');
    writeFileSync(join(admin, 'commondir'), `${join(wt.path, '.evil')}\n`);
    await expect(repoOfWorktree(wt.path, { repos: [repo] })).rejects.toThrow(/tampered/);
    writeFileSync(join(admin, 'commondir'), commondir);
    // A per-worktree config file.
    writeFileSync(join(admin, 'config.worktree'), '[core]\n');
    await expect(repoOfWorktree(wt.path, { repos: [repo] })).rejects.toThrow(/per-worktree config/);
    rmSync(join(admin, 'config.worktree'));
    // The pointer itself rewritten to a fake gitdir: refused without running git there.
    const marker = join(root, 'pwned');
    plantFakeGitdir(wt.path, marker);
    await expect(repoOfWorktree(wt.path, { repos: [repo] })).rejects.toThrow(/tampered/);
    await expect(addWorktree({ mount: repo, repo, dir: wt.path, thread: 't' })).rejects.toThrow(/tampered/);
    expect(existsSync(marker)).toBe(false);
  });

  it('the sandbox write set never includes the repository config, hooks or other branches', async () => {
    const root = tmp();
    const repo = newRepo(root);
    const wt = await addWorktree({ mount: repo, repo, dir: join(root, 'wts', 's1'), thread: 't' });
    const paths = await sandboxGitWritePaths(wt.path, repo);
    const dotGit = join(repo, '.git');
    expect(paths).not.toContain(dotGit);
    for (const bad of ['config', 'hooks', 'info', join('refs', 'heads', 'main'), 'packed-refs'])
      expect(paths.some((p) => join(dotGit, bad).startsWith(p))).toBe(false);
    expect(paths).toContain(join(dotGit, 'objects'));
  });
});

const hasBwrap = process.platform === 'linux' && spawnSync('which', ['bwrap']).status === 0;

describe.skipIf(!hasBwrap)('GIT-1: real sandbox', () => {
  it('an agent can still commit on its branch but cannot write the repo config or hooks', async () => {
    const root = tmp();
    const home = join(root, 'home');
    mkdirSync(home);
    const repo = newRepo(join(home, 'code'));
    const wt = await addWorktree({ mount: repo, repo, dir: join(home, 'wts', 's1'), thread: 't' });
    const write = await sandboxGitWritePaths(wt.path, repo);
    const policy = compilePolicy('workspace', [{ path: wt.path, mode: 'rw' }], { fs: { write } }, { home });
    const sbx = await createSandbox(policy, {
      backend: 'srt',
      sourceEnv: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home },
      home,
      tmpDir: root,
    });
    try {
      const sh = [
        `cd ${wt.path}`,
        'echo agent > agent.txt',
        'git add agent.txt',
        'git -c user.name=a -c user.email=a@b commit -qm agent && echo commit-ok',
        `(echo '[core]' >> ${repo}/.git/config && echo cfg-written) 2>/dev/null`,
        `(echo 'touch x' > ${repo}/.git/hooks/post-commit && echo hook-written) 2>/dev/null`,
        `(echo x > ${repo}/.git/refs/heads/main && echo main-written) 2>/dev/null`,
        'true',
      ].join('; ');
      const w = await sbx.wrap('sh', ['-c', sh]);
      const out = await new Promise<string>((res, rej) => {
        const c = spawn(w.cmd, w.args, { env: w.env, stdio: ['ignore', 'pipe', 'pipe'] });
        let s = '';
        c.stdout.on('data', (d) => {
          s += d;
        });
        c.on('error', rej);
        c.on('close', () => res(s));
      });
      expect(out).toContain('commit-ok');
      expect(out).not.toContain('cfg-written');
      expect(out).not.toContain('hook-written');
      expect(out).not.toContain('main-written');
      expect(git(repo, 'log', '-1', '--format=%s', wt.branch)).toBe('agent');
    } finally {
      await sbx.close();
    }
  }, 60_000);
});

describe('GIT-1: session.merge on a tampered worktree', () => {
  it('refuses, and the planted fsmonitor never runs', async () => {
    const root = tmpHome();
    const repo = newRepo(root);
    const harness = new FakeHarnessPlugin(async function* (s) {
      writeFileSync(join(s.spec.cwd, 'feature.txt'), 'from the agent\n');
      yield { type: 'text', delta: 'wrote it' };
      yield { type: 'done', stopReason: 'end_turn' };
    });
    env = await makeEnv({ harness });
    await setupBot(env, { mounts: [{ path: repo, mode: 'rw' }] });
    await ownerAlice(env);
    env.conn().inject({ text: 'add a feature' });
    await until(() => (env!.conn().textsTo('alice').at(-1) ?? '').includes('wrote it'), 5000, 'reply');
    const [s] = env.d.store.sessions.list();
    await until(() => env!.d.store.sessions.get(s!.id)!.status !== 'running', 3000, 'idle');
    const session = env.d.store.sessions.get(s!.id)!;
    const marker = join(root, 'pwned');
    plantFakeGitdir(session.worktree!.path, marker);
    await expect(env.client.call('session.merge', { id: session.id })).rejects.toSatisfy(
      (e) => code(e) === 'sandbox_violation',
    );
    await expect(env.client.call('session.openPr', { id: session.id })).rejects.toSatisfy(
      (e) => code(e) === 'sandbox_violation',
    );
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(repo, 'feature.txt'))).toBe(false);
  });
});
