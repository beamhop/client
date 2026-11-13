/**
 * The `beamhop` command for people who installed only the desktop app.
 *
 * A drag-to-Applications install runs no installer, so the app does it on launch: it writes a tiny
 * launcher to <beamhop home>/bin/beamhop that runs the bundled CLI on the app's own Electron binary in
 * Node mode (the same way the daemon runs), then makes sure that directory is on the login shell's PATH
 * with a marked block in the shell profile. No admin rights needed.
 *
 * The launcher is rewritten on every launch, so it follows the app when it is updated or moved. A
 * `beamhop` already on PATH from another install (Homebrew, npm, standalone) is left alone.
 * macOS and Linux packages only: Windows and AppImage report `unsupported`.
 */
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';

/** Marks a launcher this app wrote (never touch a `beamhop` without it). */
export const SHIM_MARK = '# beamhop-desktop-cli';
const BLOCK_START = '# >>> beamhop desktop: command line >>>';
const BLOCK_END = '# <<< beamhop desktop: command line <<<';

export interface CliInstallContext {
  platform: NodeJS.Platform;
  /** User home directory. */
  home: string;
  /** Where the launcher goes (<beamhop home>/bin). */
  binDir: string;
  /** The app's executable (run with ELECTRON_RUN_AS_NODE=1). */
  exe: string;
  /** The bundled CLI entry (<resources>/daemon/bin/beamhop.js). */
  entry: string;
  /** Login shell ($SHELL). */
  shell?: string;
  /** PATH of the user's login shell (what a new terminal gets). */
  shellPath?: string;
  /** Set when running from an AppImage (its mount point changes every run). */
  appImage?: string;
}

export type CliStatus =
  /** Our launcher is in place; `onPath`: a new terminal finds it. */
  | { state: 'installed'; path: string; onPath: boolean }
  /** Another `beamhop` (Homebrew, npm, standalone…) comes first on PATH: leave it. */
  | { state: 'other'; path: string }
  | { state: 'absent' }
  | { state: 'unsupported'; reason: string };

export interface InstallResult {
  status: CliStatus;
  /** Shell profile the PATH line was added to (a new terminal is needed to pick it up). */
  profile?: string;
}

const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export const shimPath = (ctx: Pick<CliInstallContext, 'binDir'>): string => join(ctx.binDir, 'beamhop');

/** The launcher script. */
export const shimScript = (exe: string, entry: string): string =>
  [
    '#!/bin/sh',
    SHIM_MARK,
    '# The beamhop command line, run on the beamhop desktop app. The app rewrites this file on every',
    '# launch; turn it off from the app menu ("Command line tool").',
    `exe=${shQuote(exe)}`,
    `entry=${shQuote(entry)}`,
    'if [ ! -x "$exe" ] || [ ! -f "$entry" ]; then',
    '  echo "beamhop: the desktop app moved or was removed. Open it once to repair this command." >&2',
    '  exit 127',
    'fi',
    'ELECTRON_RUN_AS_NODE=1 exec "$exe" "$entry" "$@"',
    '',
  ].join('\n');

const isExecutable = (p: string): boolean => {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** First `name` on `pathStr` (POSIX). */
export const findOnPath = (name: string, pathStr: string | undefined): string | undefined => {
  for (const dir of (pathStr ?? '').split(':')) {
    if (!dir) continue;
    const p = join(dir, name);
    if (isExecutable(p)) return p;
  }
  return undefined;
};

export const isOurShim = (p: string): boolean => {
  try {
    return readFileSync(p, 'utf8').split('\n', 3).includes(SHIM_MARK);
  } catch {
    return false;
  }
};

const unsupported = (ctx: CliInstallContext): string | undefined => {
  if (ctx.platform === 'win32') return 'Windows: use the installer or `npm i -g beamhop`';
  if (ctx.platform !== 'darwin' && ctx.platform !== 'linux') return `${ctx.platform} is not supported`;
  if (ctx.appImage) return 'AppImage: its location changes every run; install the .deb or `npm i -g beamhop`';
  return undefined;
};

const samePath = (a: string, b: string): boolean => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

export const cliStatus = (ctx: CliInstallContext): CliStatus => {
  const why = unsupported(ctx);
  if (why) return { state: 'unsupported', reason: why };
  const shim = shimPath(ctx);
  const first = findOnPath('beamhop', ctx.shellPath);
  if (first && !samePath(dirname(first), ctx.binDir) && !isOurShim(first))
    return { state: 'other', path: first };
  if (!isOurShim(shim)) return { state: 'absent' };
  const onPath = (ctx.shellPath ?? '').split(':').some((d) => d && samePath(d, ctx.binDir));
  return { state: 'installed', path: shim, onPath };
};

/** The profile file the PATH block goes in, for the user's login shell. */
export const profileFile = (ctx: Pick<CliInstallContext, 'shell' | 'home' | 'platform'>): string => {
  const sh = (ctx.shell ?? '').split('/').pop() ?? '';
  if (sh === 'zsh') return join(ctx.home, '.zprofile');
  if (sh === 'fish') return join(ctx.home, '.config', 'fish', 'conf.d', 'beamhop.fish');
  if (sh === 'bash') return join(ctx.home, ctx.platform === 'darwin' ? '.bash_profile' : '.bashrc');
  return join(ctx.home, '.profile');
};

/** Every file a block may have been written to (for removal). */
const allProfiles = (home: string): string[] => [
  join(home, '.zprofile'),
  join(home, '.bash_profile'),
  join(home, '.bashrc'),
  join(home, '.profile'),
  join(home, '.config', 'fish', 'conf.d', 'beamhop.fish'),
];

/** `binDir` as the shell should see it: `$HOME/…` when under the home directory. */
const shellDir = (ctx: Pick<CliInstallContext, 'binDir' | 'home'>): string => {
  const rel = relative(ctx.home, ctx.binDir);
  return rel && !rel.startsWith('..') && !rel.startsWith('/') ? `$HOME/${rel}` : ctx.binDir;
};

export const profileBlock = (ctx: Pick<CliInstallContext, 'binDir' | 'home'>, fish: boolean): string => {
  const dir = shellDir(ctx);
  const line = fish ? `fish_add_path --prepend "${dir}"` : `export PATH="${dir}:$PATH"`;
  return `${BLOCK_START}\n${line}\n${BLOCK_END}\n`;
};

const blockRe = new RegExp(
  `\\n?${BLOCK_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${BLOCK_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`,
  'g',
);

/** `text` without our block(s). */
export const stripBlock = (text: string): string => text.replace(blockRe, '');

const read = (p: string): string => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
};

/** Write (or refresh) the launcher and put its directory on PATH. Never replaces another `beamhop`. */
export const installCli = (ctx: CliInstallContext): InstallResult => {
  const before = cliStatus(ctx);
  if (before.state === 'unsupported' || before.state === 'other') return { status: before };

  const shim = shimPath(ctx);
  if (existsSync(shim) && !isOurShim(shim)) return { status: { state: 'other', path: shim } };
  const script = shimScript(ctx.exe, ctx.entry);
  mkdirSync(ctx.binDir, { recursive: true });
  if (read(shim) !== script) writeFileSync(shim, script, { mode: 0o755 });

  let profile: string | undefined;
  const after = cliStatus(ctx);
  if (after.state === 'installed' && !after.onPath) {
    const file = profileFile(ctx);
    const fish = file.endsWith('.fish');
    const current = read(file);
    if (!current.includes(BLOCK_START)) {
      mkdirSync(dirname(file), { recursive: true });
      const sep = current && !current.endsWith('\n') ? '\n' : '';
      writeFileSync(file, `${current}${sep}${current ? '\n' : ''}${profileBlock(ctx, fish)}`);
      profile = file;
    }
  }
  return { status: after, profile };
};

/** Remove the launcher (only ours) and the PATH blocks. */
export const uninstallCli = (ctx: Pick<CliInstallContext, 'binDir' | 'home'>): void => {
  const shim = shimPath(ctx);
  if (isOurShim(shim)) rmSync(shim, { force: true });
  for (const f of allProfiles(ctx.home)) {
    const text = read(f);
    if (!text.includes(BLOCK_START)) continue;
    const next = stripBlock(text);
    if (f.endsWith('beamhop.fish') && !next.trim()) rmSync(f, { force: true });
    else writeFileSync(f, next);
  }
};
