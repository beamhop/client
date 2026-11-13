import { execFile } from 'node:child_process';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { ALWAYS_DENY_READ, expandHome } from '@beamhop/core';
import { REMOTE_USER, REMOTE_WORKSPACES } from './cloud-init.ts';

/**
 * "Move to cloud" mount planner (§10). Produces argv lists (never shell strings) plus a display
 * form. Nothing is executed here.
 *
 *  - git mounts → `git clone` on the server (run via the control channel), after a push check
 *  - other mounts → one-time rsync over SSH (VPS) or a volume upload note (PaaS)
 *  - optional ongoing sync with Mutagen (VPS only, opt-in per mount)
 *  - ALWAYS_DENY_READ paths are never copied: mounts inside them are skipped, and deny paths
 *    nested in a mount are excluded
 */

export interface SyncMount {
  path: string;
  mode: 'ro' | 'rw';
  /** Opt in to ongoing Mutagen sync for this mount. */
  mutagen?: boolean;
}

export interface GitInfo {
  remote?: string;
  branch?: string;
  /** Uncommitted changes present. */
  dirty?: boolean;
  /** Commits not pushed to the upstream. */
  ahead?: number;
}

export interface SyncTarget {
  kind: 'vps' | 'paas';
  agent: string;
  /** VPS: SSH host (IP or name). Required for rsync/Mutagen. */
  sshHost?: string;
  sshUser?: string;
  /** Remote workspace root. Default /home/beamhop/.beamhop/workspaces. */
  remoteRoot?: string;
}

export type SyncStep =
  | {
      mount: string;
      method: 'git-clone';
      remotePath: string;
      run: 'remote';
      commands: string[][];
      display: string[];
      notes: string[];
    }
  | {
      mount: string;
      method: 'rsync' | 'mutagen';
      remotePath: string;
      run: 'local';
      commands: string[][];
      display: string[];
      notes: string[];
    }
  | {
      mount: string;
      method: 'volume-upload';
      remotePath: string;
      run: 'manual';
      commands: string[][];
      display: string[];
      notes: string[];
    }
  | {
      mount: string;
      method: 'skip';
      remotePath?: undefined;
      run: 'none';
      commands: [];
      display: [];
      notes: string[];
    };

export interface SyncPlan {
  steps: SyncStep[];
  warnings: string[];
}

export interface SyncOptions {
  /** Inspect a local path for git info; default runs `git` via execFile. Return undefined for non-git. */
  inspect?: (path: string) => Promise<GitInfo | undefined>;
  /** Home dir used to expand `~` in ALWAYS_DENY_READ. */
  home?: string;
  /** Extra deny paths (absolute or ~). */
  extraDeny?: string[];
  platform?: NodeJS.Platform;
}

const run = promisify(execFile);

/** Default git inspector. Never throws: a path that is not a git work tree returns undefined. */
export const inspectGit = async (path: string): Promise<GitInfo | undefined> => {
  const git = async (...args: string[]) =>
    (await run('git', ['-C', path, ...args], { timeout: 10_000 })).stdout.trim();
  try {
    if ((await git('rev-parse', '--is-inside-work-tree')) !== 'true') return undefined;
  } catch {
    return undefined;
  }
  const info: GitInfo = {};
  try {
    info.remote = await git('remote', 'get-url', 'origin');
  } catch {}
  try {
    info.branch = await git('rev-parse', '--abbrev-ref', 'HEAD');
  } catch {}
  try {
    info.dirty = (await git('status', '--porcelain')).length > 0;
  } catch {}
  try {
    info.ahead = Number(await git('rev-list', '--count', '@{upstream}..HEAD'));
  } catch {}
  return info;
};

/** Remove userinfo (tokens) from https remotes; ssh/scp-style remotes are returned unchanged. */
export const stripRemoteCredentials = (remote: string): { url: string; hadCredentials: boolean } => {
  try {
    const u = new URL(remote);
    if ((u.protocol === 'https:' || u.protocol === 'http:') && (u.username || u.password)) {
      u.username = '';
      u.password = '';
      return { url: u.toString(), hadCredentials: true };
    }
  } catch {}
  return { url: remote, hadCredentials: false };
};

const norm = (p: string, platform: NodeJS.Platform) => {
  const r = resolve(p);
  return platform === 'win32' || platform === 'darwin' ? r.toLowerCase() : r;
};

/** True when `child` is `parent` or below it. */
const within = (child: string, parent: string): boolean => {
  const rel = relative(parent, child);
  return rel === '' || (rel.split(sep)[0] !== '..' && !isAbsolute(rel));
};

/** POSIX-quote for display only (commands are argv arrays). */
export const shellQuote = (a: string): string =>
  /^[A-Za-z0-9@%+=:,./_-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
const show = (argv: string[]) => argv.map(shellQuote).join(' ');

const expandWith = (p: string, home?: string): string => {
  if (home && (p === '~' || p.startsWith('~/') || p.startsWith('~\\'))) return resolve(home, p.slice(2));
  return expandHome(p);
};

export const planMountSync = async (
  mounts: SyncMount[],
  target: SyncTarget,
  opts: SyncOptions = {},
): Promise<SyncPlan> => {
  const platform = opts.platform ?? process.platform;
  const inspect = opts.inspect ?? inspectGit;
  const root = (target.remoteRoot ?? REMOTE_WORKSPACES).replace(/\/+$/, '');
  const user = target.sshUser ?? REMOTE_USER;
  const deny = [...ALWAYS_DENY_READ, ...(opts.extraDeny ?? [])].map((d) => expandWith(d, opts.home));
  const steps: SyncStep[] = [];
  const warnings: string[] = [];
  const used = new Set<string>();

  if (target.kind === 'vps' && !target.sshHost && mounts.length) {
    warnings.push('No SSH host given: rsync/Mutagen steps need SSH, which must be opted in at deploy time.');
  }
  if (platform === 'win32') {
    warnings.push('rsync and Mutagen over SSH need WSL2 (or Git for Windows with rsync) on Windows.');
  }

  for (const m of mounts) {
    const local = expandWith(m.path, opts.home);
    const nl = norm(local, platform);

    const covering = deny.find((d) => within(nl, norm(d, platform)));
    if (covering) {
      steps.push({
        mount: m.path,
        method: 'skip',
        run: 'none',
        commands: [],
        display: [],
        notes: [`Never copied: ${m.path} is inside the always-denied path ${covering}.`],
      });
      continue;
    }

    let name = basename(local).replace(/[^A-Za-z0-9._-]/g, '_') || 'mount';
    for (let i = 2; used.has(name); i++) name = `${basename(local)}-${i}`.replace(/[^A-Za-z0-9._-]/g, '_');
    used.add(name);
    const remotePath = `${root}/${name}`;

    const nested = deny
      .filter((d) => {
        const nd = norm(d, platform);
        return nd !== nl && within(nd, nl);
      })
      .map((d) => relative(local, d).split(sep).join('/'));

    const git = await inspect(local);
    if (git?.remote) {
      const { url, hadCredentials } = stripRemoteCredentials(git.remote);
      const notes: string[] = [];
      if (hadCredentials)
        notes.push(
          'Credentials were removed from the remote URL; the server authenticates through the broker.',
        );
      if (git.dirty) notes.push('Uncommitted changes will not be on the server: commit and push them first.');
      if (git.ahead && git.ahead > 0)
        notes.push(`${git.ahead} local commit(s) are not pushed: push them first.`);
      const clone = [
        'git',
        'clone',
        ...(git.branch && git.branch !== 'HEAD' ? ['--branch', git.branch] : []),
        '--',
        url,
        remotePath,
      ];
      steps.push({
        mount: m.path,
        method: 'git-clone',
        run: 'remote',
        remotePath,
        commands: [clone],
        display: [show(clone)],
        notes,
      });
      if (m.mutagen) notes.push('Mutagen is not used for git mounts; push/pull through the remote instead.');
      continue;
    }

    const excludes = nested.flatMap((n) => ['--exclude', `/${n}`]);
    if (target.kind === 'paas') {
      steps.push({
        mount: m.path,
        method: 'volume-upload',
        run: 'manual',
        remotePath,
        commands: [],
        display: [],
        notes: [
          `Copy ${m.path} into the service volume at ${remotePath} (PaaS has no SSH). beamhop streams it over the control channel as a tar archive${nested.length ? `, excluding ${nested.join(', ')}` : ''}.`,
          ...(m.mutagen ? ['Mutagen sync needs SSH and is not available on PaaS.'] : []),
        ],
      });
      continue;
    }

    const dest = `${user}@${target.sshHost ?? '<host>'}:${remotePath}/`;
    const src = `${local.split(sep).join('/').replace(/\/+$/, '')}/`;
    const rsync = [
      'rsync',
      '-a',
      '--compress',
      '--protect-args',
      '--mkpath',
      ...excludes,
      '-e',
      'ssh',
      '--',
      src,
      dest,
    ];
    steps.push({
      mount: m.path,
      method: 'rsync',
      run: 'local',
      remotePath,
      commands: [rsync],
      display: [show(rsync)],
      notes: nested.length ? [`Excluded always-denied paths: ${nested.join(', ')}`] : [],
    });

    if (m.mutagen) {
      const ignores = nested.flatMap((n) => ['--ignore', `/${n}`]);
      const mut = [
        'mutagen',
        'sync',
        'create',
        '--name',
        `beamhop-${target.agent}-${name}`.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
        '--ignore-vcs',
        ...ignores,
        ...(m.mode === 'ro' ? ['--mode', 'one-way-replica'] : []),
        local,
        `${user}@${target.sshHost ?? '<host>'}:${remotePath}`,
      ];
      steps.push({
        mount: m.path,
        method: 'mutagen',
        run: 'local',
        remotePath,
        commands: [mut],
        display: [show(mut)],
        notes: ['Ongoing sync (opt-in). Stop with `mutagen sync terminate`.'],
      });
    }
  }
  return { steps, warnings };
};
