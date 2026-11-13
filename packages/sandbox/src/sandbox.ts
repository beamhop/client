import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { SandboxManager, SandboxRuntimeConfigSchema } from '@anthropic-ai/sandbox-runtime';
import {
  BeamhopError,
  type Logger,
  nodeExecEnv,
  type SandboxHandle,
  type SandboxPolicy,
  silentLogger,
} from '@beamhop/core';
import { scrubEnv } from './policy.ts';
import { type SrtConfigOptions, type SrtSettings, toSrtConfig } from './srt-config.ts';
import { parseViolationLine, type Violation } from './violations.ts';

export type SandboxBackend = 'srt' | 'srt-windows' | 'wsl2' | 'none';

export const UNSAFE_NO_SANDBOX_ENV = 'BEAMHOP_UNSAFE_NO_SANDBOX';

export const RUNNER_PATH = fileURLToPath(new URL('./runner.mjs', import.meta.url));

export interface CreateSandboxOptions extends SrtConfigOptions {
  /** Backend to use; `auto` (default) picks the best available one. */
  backend?: 'auto' | SandboxBackend;
  /** Explicit env vars for the sandboxed process (e.g. broker placeholders). */
  env?: Record<string, string>;
  /**
   * Port of the local LLM broker on 127.0.0.1; it is allow-listed through srt's proxy (same as a
   * `127.0.0.1:<port>` entry in `localAllow`).
   */
  brokerPort?: number;
  log?: Logger;
  /** Where per-sandbox config files and sockets live (default: os.tmpdir()). */
  tmpDir?: string;
  /** Environment to read passthrough vars and the unsafe flag from (default: process.env). */
  sourceEnv?: NodeJS.ProcessEnv;
  /** Node binary used to run the host-side runner (default: process.execPath). */
  nodePath?: string;
}

export interface BeamhopSandbox extends SandboxHandle {
  readonly backend: SandboxBackend;
  /** srt settings this sandbox runs with (undefined for `none`). */
  readonly srtConfig: SrtSettings | undefined;
  /** Loud warnings the caller must surface (e.g. running unsandboxed). */
  readonly warnings: string[];
  /** Subscribe to violations (learning mode suggestions). Returns an unsubscribe fn. */
  onViolation(cb: (v: Violation) => void): () => void;
  /** Violations seen so far. */
  violations(): Violation[];
  close(): Promise<void>;
}

const BROKER_NO_PROXY = 'localhost,::1,169.254.0.0/16,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16';

/**
 * Ports of `127.0.0.1:<port>` entries in `localAllow`: the host-loopback services (broker, MCP
 * bridge) the sandbox may reach. Only these get an in-sandbox forwarder on Linux.
 */
export const loopbackForwardPorts = (localAllow: readonly string[]): number[] => {
  const out = new Set<number>();
  for (const e of localAllow) {
    const m = /^127\.0\.0\.1:(\d{1,5})$/.exec(e.trim());
    const port = m?.[1] ? Number(m[1]) : 0;
    if (port > 0 && port < 65536) out.add(port);
  }
  return [...out];
};

const commandExists = (cmd: string): boolean => {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try {
    return spawnSync(probe, [cmd], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
};

/** Check which backend can run here. Does not consider `none`. */
export const detectBackend = async (): Promise<{ backend: SandboxBackend | null; errors: string[] }> => {
  let errors: string[] = [];
  try {
    const deps = await SandboxManager.checkDependenciesAsync();
    errors = deps.errors;
  } catch (e) {
    errors = [e instanceof Error ? e.message : String(e)];
  }
  if (process.platform === 'win32') {
    if (errors.length === 0) return { backend: 'srt-windows', errors };
    if (commandExists('wsl.exe')) return { backend: 'wsl2', errors };
    return { backend: null, errors };
  }
  if (process.platform === 'linux' || process.platform === 'darwin') {
    return { backend: errors.length === 0 ? 'srt' : null, errors };
  }
  return { backend: null, errors: [`unsupported platform ${process.platform}`, ...errors] };
};

/** Convert a Windows path (C:\x\y) to its WSL mount path (/mnt/c/x/y). */
export const toWslPath = (p: string): string => {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (!m?.[1]) return p.replace(/\\/g, '/');
  return `/mnt/${m[1].toLowerCase()}/${(m[2] ?? '').replace(/\\/g, '/')}`;
};

const startViolationServer = async (
  dir: string,
  onLine: (msg: { line?: string; allowed?: boolean }) => void,
): Promise<{ server: Server; path: string }> => {
  const path =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\beamhop-sbx-${randomBytes(8).toString('hex')}`
      : join(dir, 'v.sock');
  const server = createServer((conn) => {
    const rl = createInterface({ input: conn });
    rl.on('line', (raw) => {
      if (raw.length > 64 * 1024) return;
      try {
        const msg = JSON.parse(raw) as { line?: unknown; allowed?: unknown };
        if (typeof msg.line === 'string') onLine({ line: msg.line, allowed: msg.allowed === true });
      } catch {
        /* ignore malformed */
      }
    });
    conn.on('error', () => rl.close());
  });
  await new Promise<void>((res, rej) => {
    server.once('error', rej);
    server.listen(path, () => res());
  });
  server.unref();
  return { server, path };
};

/**
 * Create a sandbox for a policy. `wrap(cmd, args)` returns the command line to spawn: for
 * srt backends a host-side runner that initializes srt for this sandbox only and execs the
 * command inside it; env is always scrubbed to `policy.env.passthrough` + `opts.env`.
 */
export const createSandbox = async (
  policy: SandboxPolicy,
  opts: CreateSandboxOptions = {},
): Promise<BeamhopSandbox> => {
  const log = opts.log ?? silentLogger;
  const source = opts.sourceEnv ?? process.env;
  const unsafeAllowed = source[UNSAFE_NO_SANDBOX_ENV] === '1';
  const warnings: string[] = [];

  let backend: SandboxBackend;
  const requested = opts.backend ?? 'auto';
  if (requested === 'none') {
    if (!unsafeAllowed) {
      throw new BeamhopError(
        'forbidden',
        `Running without a sandbox requires ${UNSAFE_NO_SANDBOX_ENV}=1 (only for PaaS containers without user namespaces).`,
      );
    }
    backend = 'none';
  } else if (requested === 'auto') {
    const det = await detectBackend();
    if (det.backend) backend = det.backend;
    else if (unsafeAllowed) {
      backend = 'none';
      warnings.push(`sandbox unavailable (${det.errors.join('; ')})`);
    } else {
      throw new BeamhopError('unavailable', `No sandbox backend available: ${det.errors.join('; ')}`, {
        fix: 'Run `beamhop doctor` for fixes. On PaaS without user namespaces set BEAMHOP_UNSAFE_NO_SANDBOX=1.',
      });
    }
  } else backend = requested;

  const env = scrubEnv(policy.env.passthrough, opts.env ?? {}, source);

  if (backend === 'none') {
    const msg =
      'SECURITY WARNING: harness runs WITHOUT a sandbox (BEAMHOP_UNSAFE_NO_SANDBOX=1). Filesystem and network ' +
      'policy are NOT enforced; only env scrubbing and the broker apply. Rely on the container as the boundary.';
    warnings.push(msg);
    log.warn(msg);
    return {
      backend,
      policy,
      srtConfig: undefined,
      warnings,
      wrap: async (cmd, args) => ({ cmd, args: [...args], env: { ...env } }),
      onViolation: () => () => {},
      violations: () => [],
      close: async () => {},
    };
  }

  const localAllow = [...(opts.localAllow ?? [])];
  if (opts.brokerPort) localAllow.push(`127.0.0.1:${opts.brokerPort}`);
  const forwardPorts = loopbackForwardPorts(localAllow);
  const srtConfig = toSrtConfig(policy, { ...opts, localAllow });
  const valid = SandboxRuntimeConfigSchema.safeParse(srtConfig);
  if (!valid.success) {
    throw new BeamhopError('invalid_input', `Invalid sandbox policy: ${valid.error.message}`);
  }

  const dir = realpathSync(mkdtempSync(join(opts.tmpDir ?? tmpdir(), 'bh-sbx-')));
  // The runner's config and the violation socket are host-side only: hide them from the sandbox
  // (the config reveals the full policy; a writable/connectable socket would allow forged
  // learning-mode suggestions on platforms where srt does not block AF_UNIX).
  if (backend !== 'wsl2') {
    srtConfig.filesystem.denyRead.push(dir);
    srtConfig.filesystem.denyWrite.push(dir);
  }
  const seen: Violation[] = [];
  const listeners = new Set<(v: Violation) => void>();
  const vserver = await startViolationServer(dir, (msg) => {
    const v = msg.line ? parseViolationLine(msg.line) : null;
    if (!v) return;
    if (msg.allowed) v.allowed = true;
    if (seen.length < 1000) seen.push(v);
    for (const cb of listeners) {
      try {
        cb(v);
      } catch (e) {
        log.warn('violation listener failed', { error: String(e) });
      }
    }
  });

  const writeConfig = (): string => {
    const commandId = randomBytes(16).toString('base64url');
    const file = join(dir, `cfg-${commandId}.json`);
    const cfg = {
      srt: srtConfig,
      learning: policy.learning,
      violationSocket: vserver.path,
      commandId,
      timeoutMs: policy.proc.maxSessionMinutes * 60_000,
      // Linux: in-sandbox forwarders for each host-loopback port (127.0.0.1 stays in NO_PROXY).
      // macOS: no network namespace, so route 127.0.0.1 through srt's proxy instead.
      ...(forwardPorts.length ? { forwardPorts } : {}),
      ...(forwardPorts.length && process.platform === 'darwin' ? { noProxy: BROKER_NO_PROXY } : {}),
    };
    writeFileSync(file, JSON.stringify(cfg), { mode: 0o600 });
    return file;
  };

  const nodePath = opts.nodePath ?? process.execPath;
  const wrap: SandboxHandle['wrap'] = async (cmd, args) => {
    if (backend === 'wsl2') {
      const file = writeConfig();
      // Requires `srt` installed inside the default WSL distro (npm i -g @anthropic-ai/sandbox-runtime).
      const settings = join(dir, `srt-${randomBytes(6).toString('hex')}.json`);
      writeFileSync(settings, JSON.stringify(srtConfig), { mode: 0o600 });
      rmSync(file, { force: true });
      return {
        cmd: 'wsl.exe',
        args: ['-e', 'srt', '--settings', toWslPath(win32.normalize(settings)), '--', cmd, ...args],
        env: { ...env },
      };
    }
    const file = writeConfig();
    // The runner needs ELECTRON_RUN_AS_NODE under the desktop app; it removes it before the harness starts.
    const runnerEnv = opts.nodePath ? {} : nodeExecEnv();
    return { cmd: nodePath, args: [RUNNER_PATH, file, '--', cmd, ...args], env: { ...env, ...runnerEnv } };
  };

  if (backend === 'srt-windows') warnings.push('Windows sandbox backend is alpha.');
  if (backend === 'wsl2') warnings.push('Using WSL2 fallback: the harness command must exist inside WSL.');

  let closed = false;
  return {
    backend,
    policy,
    srtConfig,
    warnings,
    wrap,
    onViolation: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    violations: () => [...seen],
    close: async () => {
      if (closed) return;
      closed = true;
      listeners.clear();
      await new Promise<void>((r) => vserver.server.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
};
