import type { HarnessDetection, HarnessPlugin, Logger } from '@beamhop/core';
import { BeamhopError } from '@beamhop/core';
import {
  type Catalog,
  type CatalogEntry,
  findHarness,
  launchFor,
  loadCatalog,
} from '@beamhop/harness-catalog';
import {
  detectHarness,
  mapAcpCapabilities,
  probeAcpCommand,
  type ScanOptions,
} from '@beamhop/harness-discovery';
import { createAcpHarness } from './harness.ts';

export interface CatalogAcpOptions {
  log?: Logger;
  /** Options forwarded to detection (env/home overrides, probe). */
  scan?: Omit<ScanOptions, 'catalog' | 'only'>;
}

/**
 * Build an ACP HarnessPlugin from a catalog entry. The binary path found by `detect()` is used
 * to launch; before detection the bare command name is resolved through the session's PATH.
 */
export const acpHarnessFromCatalog = (entry: CatalogEntry, opts: CatalogAcpOptions = {}): HarnessPlugin => {
  const launch = launchFor(entry, 'acp');
  if (!launch) throw new BeamhopError('invalid_input', `${entry.id} has no ACP launch mode`);
  let lastPath: string | undefined;
  const plugin = createAcpHarness({
    id: entry.id,
    displayName: entry.displayName,
    command: () => (launch.npm ? launch.command : (lastPath ?? launch.command)),
    args: launch.args,
    env: launch.env,
    log: opts.log,
    detect: async () => {
      const d = await detectHarness(entry, opts.scan);
      if (d.path) lastPath = d.path;
      return d.status === 'not-installed' ? null : { ...d, protocol: 'acp' };
    },
  });
  return {
    ...plugin,
    ...(entry.network.length ? { network: [...entry.network] } : {}),
    ...(entry.homeEnv ? { homeEnv: entry.homeEnv } : {}),
    ...(entry.macosTrustd ? { macosTrustd: true } : {}),
  };
};

const fromBundled = (id: string, opts: CatalogAcpOptions, catalog?: Catalog): HarnessPlugin => {
  const entry = findHarness(catalog ?? loadCatalog(), id);
  if (!entry) throw new BeamhopError('not_found', `catalog has no ${id}`);
  return acpHarnessFromCatalog(entry, opts);
};

export const geminiHarness = (opts: CatalogAcpOptions = {}, catalog?: Catalog) =>
  fromBundled('gemini', opts, catalog);
export const copilotHarness = (opts: CatalogAcpOptions = {}, catalog?: Catalog) =>
  fromBundled('copilot', opts, catalog);
export const opencodeHarness = (opts: CatalogAcpOptions = {}, catalog?: Catalog) =>
  fromBundled('opencode', opts, catalog);

/** All catalog entries whose preferred protocol is ACP. */
export const acpHarnessesFromCatalog = (catalog: Catalog = loadCatalog(), opts: CatalogAcpOptions = {}) =>
  catalog.harnesses
    .filter((h) => h.protocol === 'acp' && h.modes.acp)
    .map((h) => acpHarnessFromCatalog(h, opts));

/** A user-registered ACP command (`beamhop harness add --acp "<cmd>"`). */
export const customAcpHarness = (opts: {
  id: string;
  displayName?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  log?: Logger;
  probeEnv?: Record<string, string>;
}): HarnessPlugin =>
  createAcpHarness({
    id: opts.id,
    displayName: opts.displayName ?? opts.id,
    command: opts.command,
    args: opts.args,
    env: opts.env,
    log: opts.log,
    detect: async (): Promise<HarnessDetection | null> => {
      const p = await probeAcpCommand(opts.command, opts.args ?? [], { env: opts.probeEnv });
      return {
        id: opts.id,
        displayName: opts.displayName ?? p.agentInfo?.title ?? p.agentInfo?.name ?? opts.id,
        command: opts.command,
        version: p.agentInfo?.version,
        status: p.ok ? 'ready' : 'error',
        protocol: 'acp',
        message: p.error,
        capabilities: p.ok ? mapAcpCapabilities(p.agentCapabilities) : undefined,
      };
    },
  });
