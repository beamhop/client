/** Git worktrees per session for git rw mounts (§6A.5). */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { slugify } from './util.ts';

const exec = promisify(execFile);

const git = async (cwd: string, args: string[]): Promise<string> => {
  const { stdout } = await exec('git', ['-C', cwd, ...args], { windowsHide: true, timeout: 60_000 });
  return stdout.trim();
};

/** Top-level of the git work tree containing `path`, or undefined if not a git repo. */
export const gitTopLevel = async (path: string): Promise<string | undefined> => {
  if (!existsSync(path)) return undefined;
  try {
    const inside = await git(path, ['rev-parse', '--is-inside-work-tree']);
    if (inside !== 'true') return undefined;
    return resolve(await git(path, ['rev-parse', '--show-toplevel']));
  } catch {
    return undefined;
  }
};

const branchExists = async (repo: string, branch: string): Promise<boolean> => {
  try {
    await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
};

export interface Worktree {
  repo: string;
  path: string;
  branch: string;
  /** Path that corresponds to the original mount inside the worktree. */
  mountPath: string;
}

/**
 * `git worktree add <dir> -b beamhop/<thread>`; if the branch already exists (an earlier session
 * of the same thread), a numbered suffix is used. If `dir` already is a worktree it is reused.
 */
export const addWorktree = async (opts: {
  mount: string;
  repo: string;
  dir: string;
  thread: string;
}): Promise<Worktree> => {
  const sub = relative(opts.repo, resolve(opts.mount));
  if (existsSync(join(opts.dir, '.git'))) {
    const branch = await git(opts.dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return { repo: opts.repo, path: opts.dir, branch, mountPath: join(opts.dir, sub) };
  }
  const base = `beamhop/${slugify(opts.thread, 50)}`;
  let branch = base;
  for (let i = 2; await branchExists(opts.repo, branch); i++) branch = `${base}-${i}`;
  mkdirSync(join(opts.dir, '..'), { recursive: true });
  // Repos without commits cannot have worktrees; --orphan needs newer git, so require HEAD.
  await git(opts.repo, ['worktree', 'add', opts.dir, '-b', branch]);
  return { repo: opts.repo, path: opts.dir, branch, mountPath: join(opts.dir, sub) };
};

export const removeWorktree = async (repo: string, dir: string): Promise<void> => {
  try {
    await git(repo, ['worktree', 'remove', '--force', dir]);
  } catch {
    /* already gone */
  }
};
