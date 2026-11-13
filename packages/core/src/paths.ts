import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * beamhop home: $BEAMHOP_HOME or ~/.beamhop, always absolute. A relative home would change meaning
 * with the working directory (worktrees, sandbox paths, the status view).
 */
export const beamhopHome = (): string =>
  process.env.BEAMHOP_HOME ? expandHome(process.env.BEAMHOP_HOME) : join(homedir(), '.beamhop');

/**
 * Longest unix socket path we bind: sun_path is 104 bytes on macOS (108 on Linux), including the
 * terminating NUL. Longer paths fail with EINVAL at listen time.
 */
export const MAX_SOCKET_PATH = 103;

const byteLength = (s: string): number => new TextEncoder().encode(s).length;

/** Short, stable tag for a home directory (not a security boundary: the socket dir is checked by owner). */
const homeTag = (home: string): string => {
  // Two FNV-1a rounds with different offsets: 16 hex chars, no node:crypto (core also loads in browsers).
  const fnv = (seed: number) => {
    let h = seed >>> 0;
    for (let i = 0; i < home.length; i++) {
      h ^= home.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  };
  return fnv(0x811c9dc5) + fnv(0x01234567);
};

/**
 * Unix socket for a home: `<home>/beamhop.sock`, or, when that path is too long to bind, a socket in a
 * per-home directory under the temp dir (`beamhop-<hash of home>/beamhop.sock`). Every client must use
 * this (or `paths().socket`) so daemon and clients agree on the location.
 */
export const socketPath = (home: string): string => {
  if (process.platform === 'win32') return '\\\\.\\pipe\\beamhop';
  const own = join(home, 'beamhop.sock');
  if (byteLength(own) <= MAX_SOCKET_PATH) return own;
  const leaf = join(`beamhop-${homeTag(resolve(home))}`, 'beamhop.sock');
  const tmp = process.env.TMPDIR;
  for (const base of [...(tmp && isAbsolute(tmp) ? [tmp] : []), '/tmp']) {
    const p = join(base, leaf);
    if (byteLength(p) <= MAX_SOCKET_PATH) return p;
  }
  return join('/tmp', leaf);
};

export const paths = (home = beamhopHome()) => ({
  home,
  config: join(home, 'config.yaml'),
  agents: join(home, 'agents'),
  channels: join(home, 'channels'),
  db: join(home, 'beamhop.db'),
  vault: join(home, 'vault.age'),
  sessions: join(home, 'sessions'),
  worktrees: join(home, 'worktrees'),
  plugins: join(home, 'plugins'),
  socket: socketPath(home),
  token: join(home, 'api-token'),
  logs: join(home, 'logs'),
});

/** Expand a leading "~" and resolve to an absolute path. */
export const expandHome = (p: string): string => {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return isAbsolute(p) ? p : resolve(p);
};
