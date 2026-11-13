/**
 * Path confinement for `channel_send_file` (§7A). The daemon reads the file on the *host*, outside
 * the sandbox, so the path the (untrusted) agent names must be checked here, not by the sandbox:
 *
 *  - relative paths resolve against the first root (the session directory);
 *  - symlinks are resolved (`realpath`) before the containment check, so a link planted inside the
 *    session dir that points at `~/.ssh/id_ed25519` is refused;
 *  - the real path must lie inside one of `roots` and outside every `deny` path (a mount may
 *    *contain* a denied dir, e.g. mounting `~` while `~/.ssh` stays denied);
 *  - only regular files are accepted (no dirs, FIFOs, devices, sockets);
 *  - the file is opened with O_NOFOLLOW and the opened descriptor is re-checked (same inode as the
 *    checked path), so swapping the path for a symlink between check and open does not help.
 *
 * Not covered: a hard link inside a root to a file elsewhere on the same filesystem. Inside the
 * sandbox denied paths are masked, so such links cannot point at denied files; files the agent can
 * read anyway could be copied into the session dir regardless.
 */
import { constants, type Stats } from 'node:fs';
import { type FileHandle, open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { BeamhopError } from '@beamhop/core';

export interface ConfinedFile {
  handle: FileHandle;
  /** Resolved real path (for logs / file name). */
  realPath: string;
  size: number;
}

const within = (child: string, parent: string): boolean => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

const caseFold = (p: string) =>
  process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p;

const realOr = async (p: string): Promise<string> => {
  try {
    return await realpath(p);
  } catch {
    return resolve(p);
  }
};

const violation = (msg: string) => new BeamhopError('sandbox_violation', msg);

/**
 * Open `path` read-only if it is a regular file inside `roots` and outside `deny`. `opts.own` are the
 * session's own dirs, which the sandbox carves out of `deny` (they live in the denied beamhop home):
 * a file inside one is allowed even though a deny entry covers it.
 */
export const openConfinedFile = async (
  path: string,
  roots: readonly string[],
  deny: readonly string[] = [],
  opts: { maxBytes?: number; own?: readonly string[] } = {},
): Promise<ConfinedFile> => {
  if (!path || path.includes('\0')) throw new BeamhopError('invalid_input', 'invalid path');
  if (roots.length === 0) throw violation('no directory is shared for file sending');
  const realRoots = await Promise.all(roots.map(realOr));
  const realDeny = await Promise.all(deny.map(realOr));
  const realOwn = await Promise.all((opts.own ?? []).map(realOr));
  const target = isAbsolute(path) ? path : resolve(realRoots[0] as string, path);

  let real: string;
  try {
    real = await realpath(target);
  } catch {
    throw new BeamhopError('not_found', 'file not found');
  }
  const allowed = (p: string) =>
    realRoots.some((r) => within(caseFold(p), caseFold(r))) &&
    (realOwn.some((o) => within(caseFold(p), caseFold(o))) ||
      !realDeny.some((d) => within(caseFold(p), caseFold(d))));
  if (!allowed(real)) throw violation('path is outside the session directory and agent mounts');

  const before: Stats = await stat(real);
  if (!before.isFile()) throw violation('only regular files can be sent');

  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  let handle: FileHandle;
  try {
    handle = await open(real, flags);
  } catch {
    throw violation('file could not be opened safely');
  }
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.ino !== before.ino || st.dev !== before.dev)
      throw violation('file changed while opening');
    if (process.platform === 'linux') {
      const viaFd = await realpath(`/proc/self/fd/${handle.fd}`).catch(() => real);
      if (!allowed(viaFd)) throw violation('path is outside the session directory and agent mounts');
    }
    if (opts.maxBytes !== undefined && st.size > opts.maxBytes)
      throw new BeamhopError('invalid_input', `file is larger than ${opts.maxBytes} bytes`);
    return { handle, realPath: real, size: st.size };
  } catch (e) {
    await handle.close();
    throw e;
  }
};
