/**
 * Git operations on session worktrees (§6A.5): merge a session branch into its base, push it and
 * build the provider's compare URL. Every call is an `execFile` of `git` with an argument array
 * (no shell); names are validated with `git check-ref-format` and never start with `-`.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { devNull } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { BeamhopError } from '@beamhop/core';
import { errMsg } from './util.ts';

const exec = promisify(execFile);

/**
 * Every daemon-side git call runs without hooks and without an fsmonitor (review wave C GIT-1):
 * these commands run outside the sandbox, in work trees an agent has written to.
 */
export const HARDENED_GIT_ARGS: readonly string[] = [
  '-c',
  `core.hooksPath=${devNull}`,
  '-c',
  'core.fsmonitor=false',
  '-c',
  'protocol.ext.allow=never',
];

const git = async (cwd: string, args: string[], timeout = 60_000): Promise<string> => {
  const { stdout } = await exec('git', [...HARDENED_GIT_ARGS, '-C', cwd, ...args], {
    windowsHide: true,
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' },
  });
  return stdout.trim();
};

const tryGit = async (cwd: string, args: string[]): Promise<string | undefined> => {
  try {
    return await git(cwd, args);
  } catch {
    return undefined;
  }
};

/** Validate a branch name (`git check-ref-format --branch`). */
export const checkBranch = async (cwd: string, name: string): Promise<string> => {
  if (!name || name.startsWith('-') || name.length > 200 || /[\s\0]/.test(name))
    throw new BeamhopError('invalid_input', `invalid branch name ${JSON.stringify(name)}`);
  const ok = await tryGit(cwd, ['check-ref-format', '--branch', name]);
  if (ok === undefined)
    throw new BeamhopError('invalid_input', `invalid branch name ${JSON.stringify(name)}`);
  return name;
};

const readSmall = async (p: string): Promise<string | undefined> => {
  const st = await lstat(p).catch(() => undefined);
  if (!st?.isFile() || st.size > 4096) return undefined;
  return (await readFile(p, 'utf8')).trim();
};

const tampered = (why: string): never => {
  throw new BeamhopError('sandbox_violation', `the session worktree was tampered with (${why})`);
};

/**
 * The repository a session worktree belongs to, checked against the agent's own repositories
 * (review wave C GIT-1). The worktree and its admin dir are writable from inside the sandbox, so
 * nothing in them is trusted: `.git` must be a plain pointer to `<repo>/.git/worktrees/<name>` of
 * one of `repos` (top-levels of the agent's git mounts, resolved outside the worktree), the admin
 * dir must point back at this worktree and at that repository's common dir, carry no per-worktree
 * config, and (with `branch`) have exactly `refs/heads/<branch>` checked out.
 */
export const verifyWorktree = async (
  worktree: string,
  opts: { repos: readonly string[]; branch?: string },
): Promise<{ repo: string; common: string; admin: string }> => {
  const dotGit = join(worktree, '.git');
  const pointer = await readSmall(dotGit);
  if (pointer === undefined) {
    if (!existsSync(worktree)) throw new BeamhopError('not_found', 'the session worktree is gone');
    return tampered('.git is not a worktree pointer file');
  }
  const m = /^gitdir: (.+)$/.exec(pointer);
  if (!m) return tampered('.git is not a worktree pointer file');
  const admin = await realpath(resolve(worktree, m[1]!)).catch(() => tampered('missing admin dir'));
  for (const repo of opts.repos) {
    const commonRaw = await tryGit(repo, ['rev-parse', '--git-common-dir']);
    if (!commonRaw) continue;
    const common = await realpath(resolve(repo, commonRaw)).catch(() => undefined);
    if (!common || dirname(admin) !== join(common, 'worktrees')) continue;
    const commondir = await readSmall(join(admin, 'commondir'));
    if (commondir === undefined) return tampered('missing commondir');
    const commonOfAdmin = await realpath(resolve(admin, commondir)).catch(() => undefined);
    if (commonOfAdmin !== common) return tampered('commondir points elsewhere');
    if (existsSync(join(admin, 'config.worktree'))) return tampered('per-worktree config');
    const back = await readSmall(join(admin, 'gitdir'));
    const realDotGit = await realpath(dotGit);
    if (!back || (await realpath(resolve(admin, back)).catch(() => undefined)) !== realDotGit)
      return tampered('admin dir belongs to another worktree');
    if (
      opts.branch !== undefined &&
      (await readSmall(join(admin, 'HEAD'))) !== `ref: refs/heads/${opts.branch}`
    )
      return tampered(`HEAD is not ${opts.branch}`);
    return { repo: dirname(common), common, admin };
  }
  return tampered("not a worktree of the agent's repositories");
};

export const repoOfWorktree = async (
  worktree: string,
  opts: { repos: readonly string[]; branch?: string },
): Promise<string> => (await verifyWorktree(worktree, opts)).repo;

/**
 * What a sandboxed session may write in the repository behind its worktree (review wave C GIT-1):
 * objects, its own `beamhop/*` branches (and their reflogs) and its own admin dir. Never the
 * repository's config, hooks, info/, other branches or other worktrees' admin dirs.
 */
export const sandboxGitWritePaths = async (worktree: string, repo: string): Promise<string[]> => {
  const { common, admin } = await verifyWorktree(worktree, { repos: [repo] });
  const out = [
    join(common, 'objects'),
    join(common, 'refs', 'heads', 'beamhop'),
    join(common, 'logs', 'refs', 'heads', 'beamhop'),
    admin,
  ];
  for (const p of out) await mkdir(p, { recursive: true });
  return out;
};

export const currentBranch = (cwd: string): Promise<string | undefined> =>
  tryGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);

/** Worktree path that has `branch` checked out, if any. */
const checkedOutAt = async (repo: string, branch: string): Promise<string | undefined> => {
  const list = (await tryGit(repo, ['worktree', 'list', '--porcelain'])) ?? '';
  let path: string | undefined;
  for (const line of list.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) path = line.slice(9);
    else if (line === `branch refs/heads/${branch}`) return path;
  }
  return undefined;
};

const identityArgs = async (cwd: string): Promise<string[]> =>
  (await tryGit(cwd, ['config', 'user.email']))
    ? []
    : ['-c', 'user.name=beamhop', '-c', 'user.email=beamhop@localhost'];

/** Commit uncommitted worktree changes (if any). Returns true when a commit was made. */
export const commitPending = async (worktree: string, message: string): Promise<boolean> => {
  const status = await git(worktree, ['status', '--porcelain']);
  if (!status) return false;
  await git(worktree, ['add', '-A']);
  await git(worktree, [...(await identityArgs(worktree)), 'commit', '--no-verify', '-q', '-m', message]);
  return true;
};

export interface MergeResult {
  base: string;
  commit: string;
  fastForward: boolean;
}

/**
 * Merge `branch` into `base`. When `base` is checked out somewhere it must be clean and gets a
 * `--no-ff` merge (aborted on conflicts); otherwise it can only be fast-forwarded.
 */
export const mergeBranch = async (opts: {
  repo: string;
  branch: string;
  base?: string;
  message: string;
}): Promise<MergeResult> => {
  const { repo, branch } = opts;
  const base = opts.base ?? (await currentBranch(repo));
  if (!base) throw new BeamhopError('invalid_input', 'the repository has no checked-out branch; pass `base`');
  await checkBranch(repo, base);
  if (base === branch) throw new BeamhopError('invalid_input', 'cannot merge a branch into itself');
  if ((await tryGit(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${base}`])) === undefined)
    throw new BeamhopError('not_found', `branch ${base} does not exist`);
  const at = await checkedOutAt(repo, base);
  if (at) {
    const dirty = await git(at, ['status', '--porcelain', '--untracked-files=no']);
    if (dirty)
      throw new BeamhopError(
        'conflict',
        `${base} has uncommitted changes in ${at}; commit or stash them first`,
      );
    try {
      await git(
        at,
        [
          ...(await identityArgs(at)),
          'merge',
          '--no-ff',
          '--no-edit',
          '-m',
          opts.message,
          `refs/heads/${branch}`,
        ],
        120_000,
      );
    } catch (e) {
      await tryGit(at, ['merge', '--abort']);
      throw new BeamhopError(
        'conflict',
        `merge of ${branch} into ${base} has conflicts; resolve them by hand (${errMsg(e).split('\n')[0]})`,
      );
    }
    return { base, commit: await git(at, ['rev-parse', 'HEAD']), fastForward: false };
  }
  const head = await git(repo, ['rev-parse', `refs/heads/${branch}`]);
  const old = await git(repo, ['rev-parse', `refs/heads/${base}`]);
  if ((await tryGit(repo, ['merge-base', '--is-ancestor', old, head])) === undefined)
    throw new BeamhopError(
      'conflict',
      `${base} is not checked out and cannot be fast-forwarded to ${branch}; check it out to merge`,
    );
  await git(repo, ['update-ref', '-m', opts.message, `refs/heads/${base}`, head, old]);
  return { base, commit: head, fastForward: true };
};

/** Remote URL without credentials (`https://user:pw@host/x` → `https://host/x`). */
export const remoteUrl = async (cwd: string, remote: string): Promise<string> => {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(remote) || remote.startsWith('-'))
    throw new BeamhopError('invalid_input', 'invalid remote name');
  const url = await tryGit(cwd, ['remote', 'get-url', remote]);
  if (!url) throw new BeamhopError('not_found', `no git remote named ${remote}`);
  return stripCredentials(url);
};

export const stripCredentials = (url: string): string => {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = '';
      u.password = '';
    }
    return u.toString();
  } catch {
    return url; // scp-like `git@host:owner/repo.git`
  }
};

/** Default base for a PR: the remote's HEAD branch, else the repo's checked-out branch. */
export const defaultBase = async (repo: string, remote: string): Promise<string | undefined> => {
  const head = await tryGit(repo, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`]);
  if (head?.startsWith(`${remote}/`)) return head.slice(remote.length + 1);
  return currentBranch(repo);
};

export const pushBranch = async (worktree: string, remote: string, branch: string): Promise<void> => {
  await checkBranch(worktree, branch);
  await git(worktree, ['push', '--porcelain', remote, `refs/heads/${branch}:refs/heads/${branch}`], 180_000);
};

/** Provider compare / new-PR URL for well-known hosts, else undefined. */
export const compareUrl = (remote: string, base: string, branch: string): string | undefined => {
  let host: string;
  let path: string;
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(remote);
  if (scp) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    try {
      const u = new URL(remote);
      if (!['https:', 'http:', 'ssh:', 'git:'].includes(u.protocol)) return undefined;
      host = u.hostname;
      path = u.pathname;
    } catch {
      return undefined;
    }
  }
  const repoPath = path
    .replace(/^\/+/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
  if (!/^[\w.-]+(\/[\w.-]+)+$/.test(repoPath)) return undefined;
  const e = encodeURIComponent;
  const h = host.toLowerCase();
  if (h === 'github.com') return `https://github.com/${repoPath}/compare/${e(base)}...${e(branch)}?expand=1`;
  if (h === 'gitlab.com' || h.startsWith('gitlab.'))
    return `https://${h}/${repoPath}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${e(branch)}&merge_request%5Btarget_branch%5D=${e(base)}`;
  if (h === 'bitbucket.org')
    return `https://bitbucket.org/${repoPath}/pull-requests/new?source=${e(branch)}&dest=${e(base)}`;
  if (h === 'codeberg.org' || h.startsWith('gitea.') || h.startsWith('forgejo.'))
    return `https://${h}/${repoPath}/compare/${e(base)}...${e(branch)}`;
  return undefined;
};
