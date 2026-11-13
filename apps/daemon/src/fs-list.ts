/**
 * `fs.list` for the PWA path picker: directories only (never file contents), confined to the home
 * directory and configured roots, with hidden entries and ALWAYS_DENY_READ paths left out.
 */
import { existsSync } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, normalize, relative, sep } from 'node:path';
import { BeamhopError, type FsEntry } from '@beamhop/core';
import { absPath, isDenied, within } from './rules.ts';

const MAX_ENTRIES = 500;

/** `/home/a/code` → `~/code` (forward slashes after `~`). */
export const toTilde = (abs: string, home = normalize(homedir())): string => {
  if (abs === home) return '~';
  if (within(abs, home)) return `~/${relative(home, abs).split(sep).join('/')}`;
  return abs;
};

const realOr = async (p: string): Promise<string | undefined> => {
  try {
    return await realpath(p);
  } catch {
    return undefined;
  }
};

export interface FsListResult {
  path: string;
  parent?: string;
  roots: string[];
  entries: FsEntry[];
}

export const listDirs = async (
  raw: string | undefined,
  extraRoots: readonly string[] = [],
): Promise<FsListResult> => {
  const home = normalize(homedir());
  const roots = [home, ...extraRoots.map((r) => absPath(r))];
  const realRoots = await Promise.all(roots.map(realOr));
  const requested = absPath(raw?.trim() || '~');
  if (isDenied(requested)) throw new BeamhopError('forbidden', 'that directory is always denied');
  const real = await realOr(requested);
  if (!real) throw new BeamhopError('not_found', 'directory not found');
  const root = roots.find((r, i) => within(requested, r) && realRoots[i] && within(real, realRoots[i]!));
  if (!root) throw new BeamhopError('forbidden', 'only directories under your home folder can be listed');
  if (isDenied(real)) throw new BeamhopError('forbidden', 'that directory is always denied');
  if (!(await stat(real)).isDirectory()) throw new BeamhopError('invalid_input', 'not a directory');

  const entries: FsEntry[] = [];
  let dirents: import('node:fs').Dirent[] = [];
  try {
    dirents = await readdir(real, { withFileTypes: true });
  } catch {
    throw new BeamhopError('forbidden', 'cannot read that directory');
  }
  for (const d of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entries.length >= MAX_ENTRIES) break;
    if (d.name.startsWith('.')) continue;
    if (!d.isDirectory() && !d.isSymbolicLink()) continue;
    const shown = join(requested, d.name);
    const child = join(real, d.name);
    if (isDenied(shown) || isDenied(child)) continue;
    if (d.isSymbolicLink()) {
      // A link must stay inside the allowed roots and point at a directory.
      const target = await realOr(child);
      if (!target || isDenied(target) || !realRoots.some((r) => r && within(target, r))) continue;
      const st = await stat(target).catch(() => undefined);
      if (!st?.isDirectory()) continue;
    }
    entries.push({ name: d.name, path: toTilde(shown, home), git: existsSync(join(child, '.git')) });
  }
  const parent = requested === root ? undefined : toTilde(dirname(requested), home);
  return {
    path: toTilde(requested, home),
    ...(parent ? { parent } : {}),
    roots: roots.map((r) => toTilde(r, home)),
    entries,
  };
};
