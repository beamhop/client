import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import type { Logger, SandboxHandle } from '@beamhop/core';

export interface SpawnSpec {
  cmd: string;
  args: string[];
  cwd?: string;
  /** Full environment for the child (already scrubbed). process.env is NOT inherited. */
  env: Record<string, string>;
}

const WIN_SHELL_EXT = /\.(cmd|bat)$/i;

/** Quote one argument for cmd.exe (`/d /s /c "<line>"`). */
const quoteWinArg = (a: string): string => {
  if (a === '') return '""';
  if (!/[\s"&|<>^%!()]/.test(a)) return a;
  return `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
};

/**
 * Node refuses to spawn `.cmd`/`.bat` shims without a shell on Windows (CVE-2024-27980).
 * npm-installed CLIs are such shims, so route them through cmd.exe with careful quoting.
 */
export const resolveSpawn = (
  cmd: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  comspec: string = process.env.ComSpec ?? 'cmd.exe',
): { cmd: string; args: string[]; verbatim: boolean } => {
  if (platform === 'win32' && WIN_SHELL_EXT.test(cmd)) {
    const line = [cmd, ...args].map(quoteWinArg).join(' ');
    return { cmd: comspec, args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
  }
  return { cmd, args, verbatim: false };
};

/** Spawn a process with piped stdio. */
export const spawnProcess = (spec: SpawnSpec): ChildProcessWithoutNullStreams => {
  const r = resolveSpawn(spec.cmd, spec.args);
  return spawn(r.cmd, r.args, {
    cwd: spec.cwd,
    env: spec.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    windowsVerbatimArguments: r.verbatim,
  });
};

/**
 * Wrap a command through the sandbox and spawn it. The child's env is the session env
 * overlaid with whatever the sandbox wrapper requires (e.g. proxy variables).
 */
export const spawnInSandbox = async (
  sandbox: SandboxHandle,
  spec: SpawnSpec,
  log?: Logger,
): Promise<ChildProcessWithoutNullStreams> => {
  const wrapped = await sandbox.wrap(spec.cmd, spec.args);
  log?.debug('spawn harness', { backend: sandbox.backend, cmd: wrapped.cmd, argc: wrapped.args.length });
  return spawnProcess({
    cmd: wrapped.cmd,
    args: wrapped.args,
    cwd: spec.cwd,
    env: { ...spec.env, ...wrapped.env },
  });
};

/** Collect stderr into a bounded ring (last `max` chars) for error messages. */
export const captureStderr = (child: { stderr: NodeJS.ReadableStream }, max = 4000): (() => string) => {
  let tail = '';
  child.stderr.setEncoding?.('utf8');
  child.stderr.on('data', (d: string | Buffer) => {
    tail = (tail + d.toString()).slice(-max);
  });
  return () => tail;
};

/** Kill a child gracefully: close stdin, SIGTERM after `graceMs`, SIGKILL after 2×. */
export const terminate = async (
  child: ChildProcessWithoutNullStreams,
  graceMs = 2000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return new Promise((resolve) => {
    const t1 = setTimeout(() => child.kill('SIGTERM'), graceMs);
    const t2 = setTimeout(() => child.kill('SIGKILL'), graceMs * 2);
    child.once('exit', (code, signal) => {
      clearTimeout(t1);
      clearTimeout(t2);
      resolve({ code, signal });
    });
    try {
      child.stdin.end();
    } catch {
      child.kill('SIGTERM');
    }
  });
};
