import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';

export interface HostInfo {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
}

const pathMod = (platform: NodeJS.Platform) => (platform === 'win32' ? path.win32 : path.posix);

/** Expand `~`, `$XDG_CONFIG_HOME`, `$XDG_DATA_HOME`, `%APPDATA%`, `%LOCALAPPDATA%`, `%USERPROFILE%`. */
export const expandPath = (p: string, host: HostInfo): string | undefined => {
  const P = pathMod(host.platform);
  const { env, home } = host;
  let out = p;
  if (out === '~' || out.startsWith('~/')) out = P.join(home, out.slice(1));
  const xdgConfig =
    env.XDG_CONFIG_HOME || (host.platform === 'win32' ? env.APPDATA : P.join(home, '.config'));
  const xdgData =
    env.XDG_DATA_HOME || (host.platform === 'win32' ? env.LOCALAPPDATA : P.join(home, '.local', 'share'));
  const vars: Record<string, string | undefined> = {
    $XDG_CONFIG_HOME: xdgConfig,
    $XDG_DATA_HOME: xdgData,
    '%APPDATA%': env.APPDATA,
    '%LOCALAPPDATA%': env.LOCALAPPDATA,
    '%USERPROFILE%': env.USERPROFILE ?? home,
  };
  for (const [k, v] of Object.entries(vars)) {
    if (out.includes(k)) {
      if (!v) return undefined;
      out = out.split(k).join(v);
    }
  }
  // Windows-only tokens make no sense elsewhere, and vice versa for ~/.config paths is fine.
  return P.normalize(out);
};

/** Directories that commonly contain globally installed CLIs, in priority order (PATH first). */
export const searchDirs = (host: HostInfo, extra: string[] = []): string[] => {
  const P = pathMod(host.platform);
  const { env, home } = host;
  const sep = host.platform === 'win32' ? ';' : ':';
  const pathVar = env.PATH ?? env.Path ?? '';
  const dirs: (string | undefined)[] = [...pathVar.split(sep)];
  const npmPrefix = env.npm_config_prefix ?? env.NPM_CONFIG_PREFIX;
  if (host.platform === 'win32') {
    dirs.push(
      npmPrefix,
      env.APPDATA && P.join(env.APPDATA, 'npm'),
      env.PNPM_HOME,
      env.LOCALAPPDATA && P.join(env.LOCALAPPDATA, 'pnpm'),
      P.join(env.BUN_INSTALL ?? P.join(home, '.bun'), 'bin'),
      env.LOCALAPPDATA && P.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'),
      env.LOCALAPPDATA && P.join(env.LOCALAPPDATA, 'Volta', 'bin'),
      P.join(home, 'scoop', 'shims'),
      P.join(home, '.local', 'bin'),
    );
  } else {
    dirs.push(
      npmPrefix && P.join(npmPrefix, 'bin'),
      env.NVM_BIN,
      env.PNPM_HOME,
      host.platform === 'darwin' ? P.join(home, 'Library', 'pnpm') : P.join(home, '.local', 'share', 'pnpm'),
      P.join(env.BUN_INSTALL ?? P.join(home, '.bun'), 'bin'),
      P.join(home, '.npm-global', 'bin'),
      P.join(home, '.local', 'bin'),
      P.join(home, '.volta', 'bin'),
      P.join(home, '.yarn', 'bin'),
      '/usr/local/bin',
      host.platform === 'darwin' ? '/opt/homebrew/bin' : '/home/linuxbrew/.linuxbrew/bin',
      '/usr/bin',
    );
  }
  for (const e of extra) dirs.push(expandPath(e, host));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of dirs) {
    if (!d?.trim()) continue;
    const n = P.normalize(d.trim().replace(/^"(.*)"$/, '$1'));
    const key = host.platform === 'win32' ? n.toLowerCase() : n;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
};

const isExecutableFile = (p: string, platform: NodeJS.Platform): boolean => {
  try {
    if (!statSync(p).isFile()) return false;
    if (platform !== 'win32') accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** Candidate file names for `name` (applies PATHEXT on Windows). */
export const executableNames = (name: string, host: HostInfo): string[] => {
  if (host.platform !== 'win32') return [name];
  const exts = (host.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim())
    .filter(Boolean);
  if (exts.some((e) => name.toLowerCase().endsWith(e.toLowerCase()))) return [name];
  // Prefer .exe/.cmd over the extensionless npm shell shim (which Windows cannot run).
  return exts.map((e) => name + e.toLowerCase());
};

/** Find the first executable among `names` in `dirs`. */
export const findExecutable = (names: string[], dirs: string[], host: HostInfo): string | undefined => {
  const P = pathMod(host.platform);
  for (const dir of dirs) {
    for (const name of names) {
      for (const file of executableNames(name, host)) {
        const p = P.join(dir, file);
        if (isExecutableFile(p, host.platform)) return p;
      }
    }
  }
  return undefined;
};

export const fileExists = (p: string): boolean => {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
};
