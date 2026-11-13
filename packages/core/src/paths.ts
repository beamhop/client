import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/** beamhop home: $BEAMHOP_HOME or ~/.beamhop */
export const beamhopHome = (): string => process.env.BEAMHOP_HOME ?? join(homedir(), '.beamhop');

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
  socket: process.platform === 'win32' ? '\\\\.\\pipe\\beamhop' : join(home, 'beamhop.sock'),
  token: join(home, 'api-token'),
  logs: join(home, 'logs'),
});

/** Expand a leading "~" and resolve to an absolute path. */
export const expandHome = (p: string): string => {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return isAbsolute(p) ? p : resolve(p);
};
