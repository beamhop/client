import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { ALWAYS_DENY_READ, BeamhopError, type SessionSpec } from '@beamhop/core';

type Mount = SessionSpec['mounts'][number];

const expandHome = (p: string): string =>
  p === '~' || p.startsWith('~/') ? path.join(homedir(), p.slice(1)) : p;

/** realpath of the longest existing ancestor + the non-existing remainder. Resolves symlinks. */
const realpathLoose = (p: string): string => {
  const abs = path.resolve(p);
  let cur = abs;
  const rest: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(cur);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
};

const norm = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);

/** True if `child` equals `parent` or is inside it (both absolute, normalized). */
export const isWithin = (parent: string, child: string): boolean => {
  const rel = path.relative(norm(parent), norm(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

export interface MountCheckOptions {
  /** Additional denied paths (policy.fs.deny). `~` is expanded. */
  deny?: string[];
  /** Base for relative paths (normally the session cwd). */
  cwd?: string;
}

/**
 * Resolve `target` and check it is inside one of `mounts` with sufficient mode.
 * Symlinks are resolved, so a link inside a mount pointing outside is rejected.
 * Returns the resolved absolute path; throws `BeamhopError('forbidden')` otherwise.
 */
export const resolveInMounts = (
  target: string,
  mounts: Mount[],
  need: 'read' | 'write',
  opts: MountCheckOptions = {},
): string => {
  if (typeof target !== 'string' || target.length === 0 || target.includes('\0')) {
    throw new BeamhopError('invalid_input', 'invalid path');
  }
  const abs = path.isAbsolute(target) ? target : path.resolve(opts.cwd ?? process.cwd(), target);
  const real = realpathLoose(abs);
  const denies = [...ALWAYS_DENY_READ, ...(opts.deny ?? [])].map((d) => realpathLoose(expandHome(d)));
  if (denies.some((d) => isWithin(d, real))) {
    throw new BeamhopError('forbidden', `access denied: ${target}`);
  }
  const ok = mounts.some((m) => {
    if (need === 'write' && m.mode !== 'rw') return false;
    return isWithin(realpathLoose(expandHome(m.path)), real);
  });
  if (!ok)
    throw new BeamhopError(
      'forbidden',
      `path outside ${need === 'write' ? 'writable ' : ''}mounts: ${target}`,
    );
  return real;
};
