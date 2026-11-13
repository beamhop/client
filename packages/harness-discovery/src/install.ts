/**
 * Installing harnesses from the catalog: which method applies on this computer, and the exact argv each
 * method runs. Nothing here runs a program; the daemon's job runner does (with these argv, never a shell
 * string built from catalog values).
 */
import path from 'node:path';
import type { CatalogEntry, NativeInstaller } from '@beamhop/harness-catalog';
import { findExecutable, type HostInfo } from './paths.ts';

export type InstallMethod = 'native' | 'brew' | 'npm' | 'winget';
export const INSTALL_METHODS: readonly InstallMethod[] = ['native', 'brew', 'npm', 'winget'];

export interface InstallPlan {
  method: InstallMethod | 'none';
  label: string;
  command: string[];
  alternatives: InstallMethod[];
  /** Method `none`: why, in plain words. */
  reason?: string;
}

export interface InstallHost {
  platform: NodeJS.Platform;
  arch: string;
  /** beamhop home (`~/.beamhop`). */
  beamhopHome: string;
  /** The user's home, to shorten paths for display. */
  home?: string;
  /** Absolute path of a tool on the daemon's PATH, or undefined. */
  which(cmd: string): string | undefined;
}

// ───────────────────────────── names ─────────────────────────────

/** npm package names: optional scope, lowercase, no spaces, no leading dot/dash, no version or URL. */
const NPM_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
/** Homebrew formula/cask, optionally tap-qualified (`sst/tap/opencode`). */
const BREW_RE = /^([a-z0-9][a-z0-9._-]*\/){0,2}[a-z0-9][a-z0-9@._+-]*$/;
/** winget package id (`Anthropic.ClaudeCode`). */
const WINGET_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

export const isValidPackageName = (method: 'npm' | 'brew' | 'winget', name: string): boolean => {
  if (name.length > 214 || name.includes('..')) return false;
  return (method === 'npm' ? NPM_RE : method === 'brew' ? BREW_RE : WINGET_RE).test(name);
};

// ───────────────────────────── paths ─────────────────────────────

const P = (platform: NodeJS.Platform) => (platform === 'win32' ? path.win32 : path.posix);

/** Where beamhop installs harnesses: `<beamhop home>/harnesses`. */
export const managedRoot = (beamhopHome: string, platform: NodeJS.Platform = process.platform): string =>
  P(platform).join(beamhopHome, 'harnesses');

/** npm prefix for harnesses beamhop installs (`npm i -g --prefix …`). */
export const managedNpmPrefix = (beamhopHome: string, platform: NodeJS.Platform = process.platform): string =>
  P(platform).join(managedRoot(beamhopHome, platform), 'npm');

/** Directory a native archive of harness `id` unpacks into. */
export const managedHarnessDir = (
  beamhopHome: string,
  id: string,
  platform: NodeJS.Platform = process.platform,
): string => P(platform).join(managedRoot(beamhopHome, platform), id);

/** Directories discovery searches for beamhop-installed copies of harness `id`. */
export const managedDirs = (
  beamhopHome: string,
  id: string,
  platform: NodeJS.Platform = process.platform,
): string[] => {
  const p = P(platform);
  const npm = managedNpmPrefix(beamhopHome, platform);
  const own = managedHarnessDir(beamhopHome, id, platform);
  // npm puts bin shims in <prefix>/bin on POSIX and in <prefix> itself on Windows.
  return [platform === 'win32' ? npm : p.join(npm, 'bin'), p.join(own, 'bin'), own];
};

/** The binary at `file` was installed by beamhop. */
export const isManagedPath = (
  file: string | undefined,
  beamhopHome: string,
  platform: NodeJS.Platform = process.platform,
): boolean => {
  if (!file) return false;
  const p = P(platform);
  const root = managedRoot(beamhopHome, platform) + p.sep;
  const f = p.normalize(file);
  return platform === 'win32' ? f.toLowerCase().startsWith(root.toLowerCase()) : f.startsWith(root);
};

/** Installed by Homebrew (pass the resolved path: Intel Macs link brew binaries into /usr/local/bin). */
export const isBrewPath = (file: string | undefined): boolean =>
  !!file && /(^\/opt\/homebrew\/|\/Cellar\/|\/Caskroom\/|^\/home\/linuxbrew\/)/.test(file);

const shorten = (p: string, home?: string): string =>
  home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p;

/** Look a tool up on PATH (plus Homebrew's usual places, which a GUI-launched PATH can lack). */
export const toolWhich =
  (host: HostInfo) =>
  (cmd: string): string | undefined => {
    const sep = host.platform === 'win32' ? ';' : ':';
    const dirs = (host.env.PATH ?? host.env.Path ?? '').split(sep).filter(Boolean);
    if (cmd === 'brew' && host.platform !== 'win32')
      dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin');
    return findExecutable([cmd], dirs, host);
  };

// ───────────────────────────── plans ─────────────────────────────

export const nativeFor = (entry: CatalogEntry, platform: NodeJS.Platform): NativeInstaller | undefined =>
  entry.install.native?.[platform as 'darwin' | 'linux' | 'win32'];

/** URL of a native archive for this arch, with its pinned sha256 (undefined: no build pinned). */
export const archiveFor = (
  n: Extract<NativeInstaller, { kind: 'archive' }>,
  arch: string,
): { url: string; sha256: string } | undefined => {
  const sha256 = n.sha256[arch];
  return sha256 ? { url: n.url.split('{arch}').join(arch), sha256 } : undefined;
};

const methodApplies = (entry: CatalogEntry, m: InstallMethod, host: InstallHost): boolean => {
  const i = entry.install;
  switch (m) {
    case 'native': {
      const n = nativeFor(entry, host.platform);
      if (!n) return false;
      if (n.kind === 'archive')
        return !!archiveFor(n, host.arch) && (host.platform === 'win32' || !!host.which('tar'));
      return host.platform !== 'win32' && !!host.which('bash');
    }
    case 'brew':
      return (
        host.platform !== 'win32' && !!i.brew && isValidPackageName('brew', i.brew) && !!host.which('brew')
      );
    case 'npm':
      return !!i.npm && isValidPackageName('npm', i.npm) && !!host.which('npm');
    case 'winget':
      return (
        host.platform === 'win32' &&
        !!i.winget &&
        isValidPackageName('winget', i.winget) &&
        !!host.which('winget')
      );
  }
};

/** Methods that work on this computer, best first: native → brew → npm → winget. */
export const availableMethods = (entry: CatalogEntry, host: InstallHost): InstallMethod[] =>
  INSTALL_METHODS.filter((m) => methodApplies(entry, m, host));

const LABELS: Record<InstallMethod, string> = {
  native: 'installer',
  brew: 'Homebrew',
  npm: 'npm',
  winget: 'winget',
};

export const methodLabel = (entry: Pick<CatalogEntry, 'displayName'>, m: InstallMethod | 'none'): string =>
  m === 'none' ? 'Manual install' : m === 'native' ? `${entry.displayName} installer` : LABELS[m];

/** What one method runs. `cmd` is the tool name (resolve it with `which` before spawning). */
export interface InstallCommand {
  method: InstallMethod;
  /** argv to run; empty for native archives (the daemon downloads and unpacks them itself). */
  argv: string[];
  /** argv for display ("Show details", the CLI). */
  display: string[];
  env?: Record<string, string>;
}

/**
 * The command for `method` (`update`: upgrade in place). Throws on an invalid package name, so a bad
 * catalog value never reaches a package manager.
 */
export const installCommand = (
  entry: CatalogEntry,
  method: InstallMethod,
  host: Pick<InstallHost, 'platform' | 'arch' | 'beamhopHome' | 'home'>,
  update = false,
): InstallCommand => {
  const i = entry.install;
  const name = (m: 'npm' | 'brew' | 'winget'): string => {
    const v = i[m];
    if (!v) throw new Error(`${entry.displayName} has no ${LABELS[m]} package`);
    if (!isValidPackageName(m, v)) throw new Error(`invalid ${LABELS[m]} package name ${JSON.stringify(v)}`);
    return v;
  };
  switch (method) {
    case 'npm': {
      const pkg = name('npm');
      const prefix = managedNpmPrefix(host.beamhopHome, host.platform);
      const argv = ['npm', 'install', '-g', '--prefix', prefix, update ? `${pkg}@latest` : pkg];
      return {
        method,
        argv,
        display: argv.map((a) => (a === prefix ? shorten(prefix, host.home) : a)),
        env: {
          npm_config_yes: 'true',
          npm_config_fund: 'false',
          npm_config_audit: 'false',
          npm_config_update_notifier: 'false',
        },
      };
    }
    case 'brew': {
      const argv = ['brew', update ? 'upgrade' : 'install', name('brew')];
      return { method, argv, display: argv, env: { HOMEBREW_NO_ENV_HINTS: '1' } };
    }
    case 'winget': {
      const argv = [
        'winget',
        update ? 'upgrade' : 'install',
        '--id',
        name('winget'),
        '-e',
        '--silent',
        '--accept-source-agreements',
        '--accept-package-agreements',
      ];
      return { method, argv, display: argv };
    }
    case 'native': {
      const n = nativeFor(entry, host.platform);
      if (!n) throw new Error(`${entry.displayName} has no installer for ${host.platform}`);
      if (n.kind === 'script')
        return { method, argv: [], display: ['bash', '-c', `curl -fsSL ${n.url} | bash`] };
      const a = archiveFor(n, host.arch);
      if (!a) throw new Error(`${entry.displayName} has no installer for ${host.platform}-${host.arch}`);
      const dir = shorten(managedHarnessDir(host.beamhopHome, entry.id, host.platform), host.home);
      return { method, argv: [], display: ['download', a.url, 'sha256', a.sha256, 'unpack', dir] };
    }
  }
};

/** Why no method applies, in plain words. */
export const noneReason = (entry: CatalogEntry, host: Pick<InstallHost, 'platform'>): string => {
  const i = entry.install;
  const needs: string[] = [];
  if (i.brew && host.platform !== 'win32') needs.push('Homebrew');
  if (i.npm) needs.push('Node.js');
  if (i.winget && host.platform === 'win32') needs.push('winget');
  const site = i.url ? ' Install it from its website.' : '';
  if (!needs.length) return `${entry.displayName} has no automatic installer for this computer.${site}`;
  if (needs.length === 1) return `Needs ${needs[0]}, which was not found.${site}`;
  const list = `${needs.slice(0, -1).join(', ')} or ${needs.at(-1)}`;
  return `Needs ${list}; ${needs.length === 2 ? 'neither was' : 'none were'} found.${site}`;
};

/** What `harness.install` would do here (HarnessView.installPlan). */
export const installPlan = (entry: CatalogEntry, host: InstallHost, update = false): InstallPlan => {
  const methods = availableMethods(entry, host);
  const first = methods[0];
  if (!first)
    return {
      method: 'none',
      label: methodLabel(entry, 'none'),
      command: [],
      alternatives: [],
      reason: noneReason(entry, host),
    };
  return {
    method: first,
    label: methodLabel(entry, first),
    command: installCommand(entry, first, host, update).display,
    alternatives: methods.slice(1),
  };
};
