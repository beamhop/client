import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import type { HarnessDetection, Logger, SandboxHandle } from '@beamhop/core';
import {
  type Catalog,
  type CatalogEntry,
  launchFor,
  loadCatalog,
  parseVersion,
  satisfies,
} from '@beamhop/harness-catalog';
import { minimalEnv, resolveSpawn } from '@beamhop/harness-kit';
import { mapAcpCapabilities, probeAcpCommand } from './acp-probe.ts';
import { isManagedPath, managedDirs } from './install.ts';
import { expandPath, fileExists, findExecutable, type HostInfo, searchDirs } from './paths.ts';

export interface ExtraAcpAgent {
  id: string;
  displayName?: string;
  command: string;
  args?: string[];
}

export interface ScanOptions {
  catalog?: Catalog;
  /** User-registered ACP commands (`beamhop harness add --acp`). Always probed. */
  extraAcp?: ExtraAcpAgent[];
  /** Attempt an ACP `initialize` handshake for ACP harnesses that are installed. */
  probeAcp?: boolean;
  /** Sandbox to run probes in. */
  sandbox?: SandboxHandle;
  /** Include catalog entries that are not installed (status 'not-installed'). Default true. */
  includeMissing?: boolean;
  /** Extra directories to search. */
  extraDirs?: string[];
  /** beamhop home, whose `harnesses/` folder holds beamhop-installed harnesses (default $BEAMHOP_HOME or ~/.beamhop). */
  beamhopHome?: string;
  /** Restrict to these catalog ids. */
  only?: string[];
  versionTimeoutMs?: number;
  probeTimeoutMs?: number;
  /** Host overrides (tests). */
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  home?: string;
  log?: Logger;
}

const DEFAULT_CAPS: Partial<Record<HarnessDetection['protocol'], HarnessDetection['capabilities']>> = {
  'claude-sdk': { streaming: true, permissions: true, resume: true, mcp: true, images: true },
  'codex-app-server': { streaming: true, permissions: true, resume: true, mcp: true, images: true },
  'pi-rpc': { streaming: true, permissions: false, resume: true, mcp: false, images: true },
};

/** Run `<bin> --version` with a timeout; returns trimmed stdout (or stderr). */
export const runVersion = (
  bin: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs = 5000,
): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = resolveSpawn(bin, args);
    execFile(
      r.cmd,
      r.args,
      {
        env,
        timeout: timeoutMs,
        windowsHide: true,
        windowsVerbatimArguments: r.verbatim,
        maxBuffer: 1 << 20,
      },
      (err, stdout, stderr) => {
        const out = `${stdout}`.trim() || `${stderr}`.trim();
        if (err && (err as { killed?: boolean }).killed)
          reject(new Error(`--version timed out after ${timeoutMs}ms`));
        else if (err && !out) reject(err);
        else resolve(out.split(/\r?\n/)[0] ?? '');
      },
    );
  });

export type AuthState = { status: 'ready' | 'needs-login'; message?: string };

/** Decide login state from catalog hints. Only names of env vars are inspected, never values. */
export const detectAuth = (entry: CatalogEntry, host: HostInfo): AuthState => {
  const a = entry.auth;
  const envHit = a.env.find((k) => (host.env[k] ?? '').length > 0);
  if (envHit) return { status: 'ready', message: `API key configured via ${envHit}` };
  for (const f of a.files) {
    const p = expandPath(f, host);
    if (p && fileExists(p)) return { status: 'ready', message: 'logged in' };
  }
  if (a.keychain.includes(host.platform as 'darwin' | 'linux' | 'win32')) {
    return { status: 'ready', message: 'login may be stored in the OS keychain (not verified)' };
  }
  if (a.env.length === 0 && a.files.length === 0) return { status: 'ready', message: 'auth status unknown' };
  return { status: 'needs-login', message: a.login ? `run \`${a.login}\`` : 'not logged in' };
};

const hostFrom = (opts: ScanOptions): HostInfo => ({
  platform: opts.platform ?? process.platform,
  env: opts.env ?? process.env,
  home: opts.home ?? homedir(),
});

/** beamhop home for a scan: the option, else $BEAMHOP_HOME, else ~/.beamhop. */
export const scanBeamhopHome = (
  opts: Pick<ScanOptions, 'beamhopHome' | 'env' | 'home' | 'platform'>,
): string => {
  const host = hostFrom(opts);
  return opts.beamhopHome ?? host.env.BEAMHOP_HOME ?? path.join(host.home, '.beamhop');
};

/** Directories to search for `entry`: PATH and the usual places, its install dirs, then beamhop's own. */
export const harnessSearchDirs = (entry: CatalogEntry, opts: ScanOptions = {}): string[] => {
  const host = hostFrom(opts);
  return searchDirs(host, [
    ...(opts.extraDirs ?? []),
    ...entry.installDirs,
    ...managedDirs(scanBeamhopHome(opts), entry.id, host.platform),
  ]);
};

/** A detection plus whether beamhop installed it (under <beamhop home>/harnesses). */
export type DiscoveredHarness = HarnessDetection & { managed?: boolean };

const childEnv = (host: HostInfo): Record<string, string> => minimalEnv(host.env as NodeJS.ProcessEnv);

/** Detect a single catalog entry. */
export const detectHarness = async (
  entry: CatalogEntry,
  opts: ScanOptions = {},
  dirs: string[] = harnessSearchDirs(entry, opts),
): Promise<DiscoveredHarness> => {
  const host = hostFrom(opts);
  const base: HarnessDetection = {
    id: entry.id,
    displayName: entry.displayName,
    command: entry.binaries[0]!,
    status: 'not-installed',
    protocol: entry.protocol,
    install: { ...entry.install },
  };
  const found = findExecutable(entry.binaries, dirs, host);
  if (!found) return base;
  const det: DiscoveredHarness = { ...base, path: found, capabilities: DEFAULT_CAPS[entry.protocol] };
  if (isManagedPath(found, scanBeamhopHome(opts), host.platform)) det.managed = true;
  const env = childEnv(host);
  try {
    const out = await runVersion(found, entry.versionArgs, env, opts.versionTimeoutMs ?? 5000);
    const v = parseVersion(out);
    det.version = v ? v.join('.') : out.slice(0, 80);
  } catch (e) {
    return { ...det, status: 'error', message: `version check failed: ${(e as Error).message}` };
  }
  if (entry.versionRange && !satisfies(det.version ?? '', entry.versionRange)) {
    return { ...det, status: 'unsupported-version', message: `requires ${entry.versionRange}` };
  }
  const auth = detectAuth(entry, host);
  det.status = auth.status;
  det.message = auth.message;
  const acpMode = launchFor(entry, 'acp');
  if (opts.probeAcp && entry.protocol === 'acp' && acpMode && !acpMode.npm) {
    const probe = await probeAcpCommand(found, acpMode.args, {
      env: { ...env, ...acpMode.env },
      timeoutMs: opts.probeTimeoutMs,
      sandbox: opts.sandbox,
    });
    if (probe.ok) det.capabilities = probe.capabilities;
    else det.message = `${det.message ? `${det.message}; ` : ''}ACP handshake failed: ${probe.error}`;
  }
  return det;
};

/** Scan the machine for known harnesses (and user-registered ACP commands). */
export const scanHarnesses = async (opts: ScanOptions = {}): Promise<DiscoveredHarness[]> => {
  const catalog = opts.catalog ?? loadCatalog();
  const host = hostFrom(opts);
  const entries = catalog.harnesses.filter((h) => !opts.only || opts.only.includes(h.id));
  const results = await Promise.all(
    entries.map((e) =>
      detectHarness(e, opts).catch(
        (err): HarnessDetection => ({
          id: e.id,
          displayName: e.displayName,
          command: e.binaries[0]!,
          status: 'error',
          protocol: e.protocol,
          message: (err as Error).message,
        }),
      ),
    ),
  );
  const extra = await Promise.all(
    (opts.extraAcp ?? []).map(async (x): Promise<HarnessDetection> => {
      const probe = await probeAcpCommand(x.command, x.args ?? [], {
        env: childEnv(host),
        timeoutMs: opts.probeTimeoutMs,
        sandbox: opts.sandbox,
      });
      return {
        id: x.id,
        displayName: x.displayName ?? probe.agentInfo?.title ?? probe.agentInfo?.name ?? x.id,
        command: x.command,
        version: probe.agentInfo?.version,
        status: probe.ok ? 'ready' : 'error',
        protocol: 'acp',
        message: probe.ok ? undefined : probe.error,
        capabilities: probe.ok ? mapAcpCapabilities(probe.agentCapabilities) : undefined,
      };
    }),
  );
  opts.log?.debug('harness scan done', { found: results.filter((r) => r.status !== 'not-installed').length });
  return [...results.filter((r) => opts.includeMissing !== false || r.status !== 'not-installed'), ...extra];
};
