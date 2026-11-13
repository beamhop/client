/** Pure argument parsers and validators for the CLI (no daemon calls, so they are easy to test). */
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { AgentConfig } from '@beamhop/core';

/** A whole non-negative number, nothing else ("10m" or "1.5" are not counts). */
export const parseCount = (v: string | undefined, what: string): number => {
  const s = String(v ?? '').trim();
  if (!/^\d+$/.test(s)) throw new Error(`${what}: expected a whole number, got "${v ?? ''}"`);
  return Number(s);
};

const MINUTES_PER: Record<string, number> = { s: 1 / 60, m: 1, h: 60, d: 1440 };

/** `15m`, `2h`, `1d`, `120s` or a bare number (minutes) → whole minutes. */
export const parseMinutes = (v: string | undefined, what: string): number => {
  const s = String(v ?? '').trim();
  const m = /^(\d+(?:\.\d+)?)\s*([smhd])?$/i.exec(s);
  if (!m)
    throw new Error(
      `${what}: expected a duration like 15m, 2h or 1d (s, m, h, d; default minutes), got "${v ?? ''}"`,
    );
  const minutes = Number(m[1]) * MINUTES_PER[(m[2] ?? 'm').toLowerCase()]!;
  // Alert rules are stored in whole minutes; rounding silently would change what the user asked for.
  if (!Number.isInteger(minutes) || minutes < 1)
    throw new Error(`${what}: "${s}" is not a whole number of minutes (at least 1m)`);
  return minutes;
};

/** A TCP port for `--port`. */
export const parsePort = (v: string): number => {
  const n = /^\d+$/.test(v.trim()) ? Number(v.trim()) : Number.NaN;
  if (!Number.isInteger(n) || n < 1 || n > 65535)
    throw new Error(`port must be a number from 1 to 65535, got "${v}"`);
  return n;
};

/** Ids of user-added harnesses: what `harness add` accepts (an `acp:` prefix is optional). */
export const validateHarnessId = (id: string): string | undefined => {
  const bare = id.startsWith('acp:') ? id.slice(4) : id;
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(bare)
    ? undefined
    : `invalid harness id "${id}": use lowercase letters, digits and dashes, e.g. my-agent`;
};

export type MountMode = 'ro' | 'rw';

/**
 * `~/code/app:rw` → { path: '~/code/app', mode: 'rw' }; the suffix is optional. A suffix that looks like
 * a mode but is not ro/rw is an error, not part of the path (otherwise `~/app:wr` mounts "~/app:wr").
 */
export const parseMount = (m: string): { path: string; mode?: MountMode } => {
  const match = /^(.+):([^:/\\]*)$/.exec(m);
  if (!match) return { path: m };
  const [, path, suffix] = match as unknown as [string, string, string];
  if (suffix === 'ro' || suffix === 'rw') return { path, mode: suffix };
  if (/^[a-z]*$/i.test(suffix))
    throw new Error(`invalid mount mode "${suffix}" in "${m}": use ${path}:ro or ${path}:rw`);
  return { path: m };
};

const mountKey = (p: string) =>
  (p === '~' || p.startsWith('~/') ? homedir() + p.slice(1) : p).replace(/\/+$/, '') || '/';

/** Repeated `--mount` values → mounts (default read-only); the same folder twice is an error. */
export const parseMounts = (list: string[]): { path: string; mode: MountMode }[] => {
  const seen = new Map<string, string>();
  return list.map((raw) => {
    const { path, mode = 'ro' } = parseMount(raw);
    const key = mountKey(path);
    const prev = seen.get(key);
    if (prev !== undefined)
      throw new Error(`${path} is mounted twice (${prev} and ${raw}); give each folder once`);
    seen.set(key, raw);
    return { path, mode };
  });
};

type Schema = { shape?: Record<string, Schema>; def?: { innerType?: Schema } };

/** Peel optional/default/nullable wrappers to reach the object schema underneath (zod 4). */
const unwrap = (s: Schema): Schema => {
  let cur = s;
  for (let i = 0; i < 10; i++) {
    const inner = cur.def?.innerType;
    if (!inner) break;
    cur = inner;
  }
  return cur;
};

/**
 * Check a dotted `agent set` key against the agent config schema. Returns an error message for a key
 * the daemon would silently drop, or undefined. Below a record or a non-object field it stops checking
 * (record keys are free-form; type errors are the daemon's to report).
 */
export const agentKeyError = (key: string): string | undefined => {
  const parts = key.split('.');
  let schema: Schema = AgentConfig as unknown as Schema;
  for (let i = 0; i < parts.length; i++) {
    const shape = unwrap(schema).shape;
    if (!shape) return undefined;
    const part = parts[i]!;
    if (!Object.hasOwn(shape, part)) {
      const at = parts.slice(0, i).join('.');
      return `unknown agent setting "${key}". Valid ${at ? `keys under ${at}` : 'keys'}: ${Object.keys(shape).join(', ')}`;
    }
    schema = shape[part]!;
  }
  return undefined;
};

/** Show a path under the user's home as `~/…` (shorter, and the same on every machine in docs). */
export const tildify = (p: string): string => {
  const h = homedir();
  return p === h ? '~' : p.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p;
};

const isExecutable = (p: string): boolean => {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * Whether `command` would start: a path must be an executable file, a bare name must be one on PATH.
 * Windows resolves through PATHEXT, which this does not model, so it always answers true there.
 */
export const commandExists = (
  command: string,
  env: Record<string, string | undefined>,
  platform: string = process.platform,
): boolean => {
  if (!command) return false;
  if (platform === 'win32') return true;
  if (command.includes('/'))
    return isExecutable(
      isAbsolute(command)
        ? command
        : resolve(command === '~' || command.startsWith('~/') ? homedir() + command.slice(1) : command),
    );
  return (env.PATH ?? '').split(delimiter).some((dir) => dir && isExecutable(join(dir, command)));
};
