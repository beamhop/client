import { readFileSync } from 'node:fs';
import { BeamhopError } from '@beamhop/core';
import { Catalog, type CatalogEntry } from './schema.ts';
import { type PublicKeyInput, verifyCatalog } from './signature.ts';

export * from './schema.ts';
export * from './semver.ts';
export * from './signature.ts';

/** URL of the bundled catalog file (shipped with the release, trusted without signature). */
export const BUNDLED_CATALOG_URL = new URL('../catalog.json', import.meta.url);

/**
 * Public keys allowed to sign catalog updates. Empty until the release key is minted;
 * until then, remote updates must pass `pubkeys` explicitly.
 */
export const CATALOG_PUBKEYS: string[] = [];

export interface LoadCatalogOptions {
  /** Raw catalog bytes. Defaults to the bundled catalog.json. */
  json?: string | Uint8Array;
  /** Detached base64 Ed25519 signature over `json`. Required whenever `json` is given. */
  sig?: string;
  /** Allowed signer keys (defaults to CATALOG_PUBKEYS). */
  pubkeys?: PublicKeyInput[];
  /** Reject a catalog whose revision is lower than this (rollback protection). */
  minRevision?: string;
}

/** Parse and validate catalog JSON (no signature check). */
export const parseCatalog = (json: string | Uint8Array): Catalog => {
  let data: unknown;
  try {
    data = JSON.parse(typeof json === 'string' ? json : Buffer.from(json).toString('utf8'));
  } catch (e) {
    throw new BeamhopError('invalid_input', `catalog is not valid JSON: ${(e as Error).message}`);
  }
  const r = Catalog.safeParse(data);
  if (!r.success) throw new BeamhopError('invalid_input', `catalog schema error: ${r.error.message}`);
  const ids = new Set<string>();
  for (const h of r.data.harnesses) {
    if (ids.has(h.id)) throw new BeamhopError('invalid_input', `duplicate harness id ${h.id}`);
    ids.add(h.id);
    const cap = h.auth.loginFlow?.capture;
    if (cap && !h.auth.methods.some((m) => m.id === cap.method))
      throw new BeamhopError(
        'invalid_input',
        `${h.id}: loginFlow captures into unknown method ${cap.method}`,
      );
  }
  return r.data;
};

/**
 * Load a catalog. Without `json`, the bundled catalog is used. External catalog bytes must
 * carry a valid signature from one of `pubkeys`, otherwise this throws `forbidden`.
 */
export const loadCatalog = (opts: LoadCatalogOptions = {}): Catalog => {
  if (opts.json === undefined) return parseCatalog(readFileSync(BUNDLED_CATALOG_URL));
  const keys = opts.pubkeys ?? CATALOG_PUBKEYS;
  if (!opts.sig || keys.length === 0 || !verifyCatalog(opts.json, opts.sig, keys)) {
    throw new BeamhopError('forbidden', 'catalog signature missing or invalid');
  }
  const cat = parseCatalog(opts.json);
  if (opts.minRevision && cat.revision.localeCompare(opts.minRevision, 'en', { numeric: true }) < 0) {
    throw new BeamhopError('forbidden', `catalog revision ${cat.revision} is older than ${opts.minRevision}`);
  }
  return cat;
};

export const findHarness = (catalog: Catalog, id: string): CatalogEntry | undefined =>
  catalog.harnesses.find((h) => h.id === id);

/** Resolve the launch command for one mode of an entry (`command` defaults to the first binary). */
export const launchFor = (
  entry: CatalogEntry,
  mode: keyof CatalogEntry['modes'],
): { command: string; args: string[]; env: Record<string, string>; npm?: string } | undefined => {
  const m = entry.modes[mode];
  if (!m) return undefined;
  return { command: m.command ?? entry.binaries[0]!, args: [...m.args], env: { ...m.env }, npm: m.npm };
};
