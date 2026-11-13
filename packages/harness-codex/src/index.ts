import type { HarnessDetection, HarnessPlugin } from '@beamhop/core';
import { type CatalogEntry, findHarness, loadCatalog, sandboxTraits } from '@beamhop/harness-catalog';
import { detectHarness, type ScanOptions } from '@beamhop/harness-discovery';
import { type CodexOptions, startCodexAppServer } from './app-server.ts';
import { startCodexExec } from './exec.ts';

export * from './app-server.ts';
export * from './exec.ts';
export * from './toml.ts';

export interface CodexHarnessOptions extends CodexOptions {
  /** 'app-server' (default), 'exec' (fallback only), or 'auto' (app-server, falling back to exec on start failure). */
  mode?: 'app-server' | 'exec' | 'auto';
  scan?: Omit<ScanOptions, 'catalog' | 'only'>;
  catalogEntry?: CatalogEntry;
}

/** Codex CLI harness: `codex app-server` JSON-RPC with `codex exec --json` fallback. */
export const codexHarness = (opts: CodexHarnessOptions = {}): HarnessPlugin => {
  const entry = opts.catalogEntry ?? findHarness(loadCatalog(), 'codex')!;
  let lastPath: string | undefined;
  const command = opts.command ?? (() => lastPath ?? 'codex');
  return {
    id: 'codex',
    displayName: entry.displayName,
    ...sandboxTraits(entry),
    async detect(): Promise<HarnessDetection | null> {
      const d = await detectHarness(entry, opts.scan);
      if (d.path) lastPath = d.path;
      return d.status === 'not-installed' ? null : d;
    },
    async start(spec, sandbox) {
      const o = { ...opts, command };
      if (opts.mode === 'exec') return startCodexExec(o, spec, sandbox);
      try {
        return await startCodexAppServer(o, spec, sandbox);
      } catch (e) {
        if (opts.mode !== 'auto') throw e;
        opts.log?.warn('codex app-server failed; falling back to codex exec --json', {
          error: (e as Error).message,
        });
        return startCodexExec(o, spec, sandbox);
      }
    },
  };
};
