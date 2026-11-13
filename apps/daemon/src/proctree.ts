/**
 * Hard-kill every process of a session (§7A panic). Harness processes are not spawned by the
 * daemon directly, so we find them by the `BEAMHOP_SESSION_ID` marker the daemon injects into the
 * sandbox environment, among the daemon's own descendants, and SIGKILL them with their subtrees.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export const SESSION_ENV_MARKER = 'BEAMHOP_SESSION_ID';

interface Proc {
  pid: number;
  ppid: number;
}

const listProcs = (): Proc[] => {
  if (process.platform === 'win32') return [];
  try {
    const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 5000 });
    return out
      .split('\n')
      .map((l) => l.trim().split(/\s+/).map(Number))
      .filter((a) => a.length === 2 && a.every(Number.isInteger))
      .map(([pid, ppid]) => ({ pid: pid!, ppid: ppid! }));
  } catch {
    return [];
  }
};

const envOf = (pid: number): string => {
  if (process.platform === 'linux') {
    try {
      return readFileSync(`/proc/${pid}/environ`, 'utf8');
    } catch {
      return '';
    }
  }
  try {
    return execFileSync('ps', ['eww', '-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 5000,
    });
  } catch {
    return '';
  }
};

const descendants = (procs: Proc[], root: number): number[] => {
  const kids = new Map<number, number[]>();
  for (const p of procs) {
    const list = kids.get(p.ppid) ?? [];
    list.push(p.pid);
    kids.set(p.ppid, list);
  }
  const out: number[] = [];
  const stack = [...(kids.get(root) ?? [])];
  while (stack.length) {
    const pid = stack.pop()!;
    out.push(pid);
    stack.push(...(kids.get(pid) ?? []));
  }
  return out;
};

/** SIGKILL all descendants of this daemon that carry the session marker (and their subtrees). Returns killed pids. */
export const killSessionTree = (sessionId: string): number[] => {
  const procs = listProcs();
  const mine = descendants(procs, process.pid);
  const needle = `${SESSION_ENV_MARKER}=${sessionId}`;
  const roots = mine.filter((pid) => {
    const env = envOf(pid);
    return env.split(/\0|\s/).includes(needle);
  });
  const victims = new Set<number>();
  for (const r of roots) {
    victims.add(r);
    for (const d of descendants(procs, r)) victims.add(d);
  }
  for (const pid of victims) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
  return [...victims];
};
