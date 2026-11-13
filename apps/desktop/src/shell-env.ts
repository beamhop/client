/**
 * An app opened from Finder / the Dock (or a Linux desktop launcher) does not inherit the user's shell
 * setup: PATH is just /usr/bin:/bin:/usr/sbin:/sbin. Harnesses installed through nvm, npm, Homebrew,
 * pnpm or bun are then invisible to discovery, and Node-script harnesses (Copilot CLI, Gemini CLI, …)
 * could not find `node` to run anyway. So, once at startup, ask the user's login shell for its
 * environment (as editors do) and give the daemon its PATH plus the few tool-manager variables that
 * discovery reads. Nothing else is imported: tokens or other secrets in the shell env stay out.
 */
import { spawn as nodeSpawn } from 'node:child_process';

export const MARK = '__BEAMHOP_SHELL_ENV__';

/** Variables taken from the shell besides PATH (discovery reads them to find CLIs). */
export const IMPORTED_VARS = [
  'NVM_BIN',
  'NVM_DIR',
  'PNPM_HOME',
  'BUN_INSTALL',
  'VOLTA_HOME',
  'npm_config_prefix',
  'NPM_CONFIG_PREFIX',
  'HOMEBREW_PREFIX',
  'LANG',
] as const;

/** Parse `printf MARK; env -0; printf MARK` output. Shell noise around the markers is ignored. */
export const parseShellEnv = (out: string): Record<string, string> | undefined => {
  const start = out.indexOf(MARK);
  const end = out.lastIndexOf(MARK);
  if (start < 0 || end <= start) return undefined;
  const env: Record<string, string> = {};
  for (const entry of out.slice(start + MARK.length, end).split('\0')) {
    const eq = entry.indexOf('=');
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
};

/** The daemon env: the shell's PATH first (then anything only the app had), plus IMPORTED_VARS the app lacks. */
export const mergeShellEnv = (
  base: NodeJS.ProcessEnv,
  shell: Record<string, string> | undefined,
): NodeJS.ProcessEnv => {
  if (!shell) return { ...base };
  const out: NodeJS.ProcessEnv = { ...base };
  const seen = new Set<string>();
  const path: string[] = [];
  for (const d of [...(shell.PATH ?? '').split(':'), ...(base.PATH ?? '').split(':')])
    if (d && !seen.has(d)) {
      seen.add(d);
      path.push(d);
    }
  if (path.length) out.PATH = path.join(':');
  for (const k of IMPORTED_VARS) if (!out[k] && shell[k]) out[k] = shell[k];
  return out;
};

export interface ResolveOptions {
  shell?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  spawn?: typeof nodeSpawn;
}

/**
 * Run the login shell interactively (`-ilc`, so .zshrc / .bashrc run: that is where nvm lives) and read
 * its environment. Resolves undefined on Windows, on failure, or after `timeoutMs` (a shell config that
 * waits for input must not keep beamhop from starting).
 */
export const resolveShellEnv = (opts: ResolveOptions = {}): Promise<Record<string, string> | undefined> => {
  if (process.platform === 'win32') return Promise.resolve(undefined);
  const env = opts.env ?? process.env;
  const shell = opts.shell ?? env.SHELL ?? (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
  const spawn = opts.spawn ?? nodeSpawn;
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v: Record<string, string> | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    let child: ReturnType<typeof nodeSpawn>;
    try {
      child = spawn(shell, ['-ilc', `printf '%s' '${MARK}'; /usr/bin/env -0; printf '%s' '${MARK}'`], {
        // Lets a shell config skip slow or interactive parts when it sees this (optional for users).
        env: { ...env, BEAMHOP_RESOLVING_SHELL_ENV: '1' },
        stdio: ['ignore', 'pipe', 'ignore'],
        detached: true,
      });
    } catch {
      resolve(undefined);
      return;
    }
    const timer = setTimeout(() => {
      try {
        // The whole process group: an interactive shell may have started helpers.
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      finish(undefined);
    }, opts.timeoutMs ?? 10_000);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      out += d;
    });
    child.once('error', () => finish(undefined));
    child.once('close', () => finish(parseShellEnv(out)));
  });
};
