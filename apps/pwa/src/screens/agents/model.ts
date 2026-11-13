/**
 * Pure logic for the Agents screens (no React): cron parsing + human preview + next runs, reach/exposure
 * summary, config diff → plain-language changes (with "widens access" detection), patch + YAML preview,
 * preset tradeoffs, name suggestions, validators. Unit-tested in model.test.ts.
 */
import { type AgentConfig, ALWAYS_DENY_READ, type Mount, type SandboxPolicy } from '@beamhop/core';

// ───────────────────────────── Sections ─────────────────────────────

export const AGENT_SECTIONS = [
  'overview',
  'setup',
  'sandbox',
  'channels',
  'schedules',
  'budgets',
  'identity',
] as const;
export type AgentSection = (typeof AGENT_SECTIONS)[number];
export const isSection = (s: string | undefined): s is AgentSection =>
  !!s && (AGENT_SECTIONS as readonly string[]).includes(s);

// ───────────────────────────── Cron ─────────────────────────────

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7 },
] as const;

const ALIASES: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
};
const NAMES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

export interface Cron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domAny: boolean;
  dowAny: boolean;
  raw: string[];
}

const num = (s: string): number => {
  const n = NAMES[s.toLowerCase()];
  if (n !== undefined) return n;
  return /^\d+$/.test(s) ? Number(s) : Number.NaN;
};

const parseField = (src: string, i: number): Set<number> | string => {
  const f = FIELDS[i]!;
  const out = new Set<number>();
  for (const part of src.split(',')) {
    const [range = '', stepS] = part.split('/');
    const step = stepS === undefined ? 1 : Number(stepS);
    if (!Number.isInteger(step) || step < 1) return `The ${f.name} step “/${stepS}” must be a whole number.`;
    let lo: number;
    let hi: number;
    if (range === '*') {
      lo = f.min;
      hi = f.max;
    } else if (range.includes('-')) {
      const [a = '', b = ''] = range.split('-');
      lo = num(a);
      hi = num(b);
    } else {
      lo = num(range);
      hi = stepS === undefined ? lo : f.max;
    }
    if (Number.isNaN(lo) || Number.isNaN(hi)) return `“${part}” isn't a valid ${f.name}.`;
    if (lo < f.min || hi > f.max || lo > hi) return `The ${f.name} must be ${f.min}–${f.max}.`;
    for (let v = lo; v <= hi; v += step) out.add(i === 4 && v === 7 ? 0 : v);
  }
  return out;
};

/** Parse a 5-field cron expression (or @alias). Returns the parsed form or a human error. */
export const parseCron = (expr: string): Cron | { error: string } => {
  const src = ALIASES[expr.trim().toLowerCase()] ?? expr.trim();
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length !== 5)
    return {
      error: `A cron expression has 5 fields (minute hour day month weekday); this has ${parts.length}.`,
    };
  const sets: Set<number>[] = [];
  for (let i = 0; i < 5; i++) {
    const r = parseField(parts[i]!, i);
    if (typeof r === 'string') return { error: r };
    sets.push(r);
  }
  return {
    minute: sets[0]!,
    hour: sets[1]!,
    dom: sets[2]!,
    month: sets[3]!,
    dow: sets[4]!,
    domAny: parts[2] === '*',
    dowAny: parts[4] === '*',
    raw: parts,
  };
};

const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (n: number) => String(n).padStart(2, '0');
const listJoin = (xs: string[]) =>
  xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;

/** Readable timezone: `Europe/Berlin` → `Berlin time`, `UTC` → `UTC`. */
export const tzLabel = (tz: string): string =>
  tz === 'UTC' || !tz.includes('/') ? tz : `${tz.split('/').pop()!.replace(/_/g, ' ')} time`;

/** "Every weekday at 09:00 Berlin time". Falls back to "Custom schedule" (next runs still shown). */
export const describeCron = (expr: string, tz = 'UTC'): string | { error: string } => {
  const c = parseCron(expr);
  if ('error' in c) return c;
  const [m, h, dom, mon, dow] = c.raw as [string, string, string, string, string];
  const zone = ` ${tzLabel(tz)}`;
  const fixedM = /^\d+$/.test(m);
  const fixedH = /^\d+$/.test(h);
  const at = fixedM && fixedH ? `at ${pad(Number(h))}:${pad(Number(m))}` : '';
  const anyDate = dom === '*' && mon === '*';
  if (anyDate && dow === '*') {
    if (m === '*' && h === '*') return 'Every minute';
    const stepM = /^\*\/(\d+)$/.exec(m);
    if (stepM && h === '*') return `Every ${stepM[1]} minutes`;
    if (fixedM && h === '*')
      return Number(m) === 0 ? 'Every hour, on the hour' : `Every hour at :${pad(Number(m))}`;
    const stepH = /^\*\/(\d+)$/.exec(h);
    if (fixedM && stepH) return `Every ${stepH[1]} hours at :${pad(Number(m))}${zone}`;
    if (at) return `Every day ${at}${zone}`;
  }
  if (anyDate && at) {
    const days = [...c.dow].sort();
    const key = days.join(',');
    if (key === '1,2,3,4,5') return `Every weekday ${at}${zone}`;
    if (key === '0,6') return `Every Saturday and Sunday ${at}${zone}`;
    if (days.length === 1) return `Every ${DAY[days[0]!]} ${at}${zone}`;
    return `Every ${listJoin(days.map((d) => DAY_SHORT[d]!))} ${at}${zone}`;
  }
  if (mon === '*' && dow === '*' && /^\d+$/.test(dom) && at)
    return `On day ${dom} of every month ${at}${zone}`;
  return 'Custom schedule';
};

const fmtCache = new Map<string, Intl.DateTimeFormat>();
const partsIn = (t: number, tz: string) => {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    });
    fmtCache.set(tz, f);
  }
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(new Date(t))) o[p.type] = p.value;
  return {
    month: Number(o.month),
    day: Number(o.day),
    hour: Number(o.hour) % 24,
    minute: Number(o.minute),
    dow: DAY_SHORT.indexOf(o.weekday ?? 'Sun'),
  };
};

export const validTimezone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** Next `count` fire times (epoch ms) after `from`, evaluated as wall-clock time in `tz`. */
export const nextRuns = (expr: string, tz = 'UTC', from = Date.now(), count = 3): number[] => {
  const c = parseCron(expr);
  if ('error' in c || !validTimezone(tz)) return [];
  const out: number[] = [];
  let t = Math.floor(from / 60_000) * 60_000 + 60_000;
  const limit = from + 400 * 86_400_000;
  while (out.length < count && t < limit) {
    const p = partsIn(t, tz);
    const dayOk =
      c.domAny || c.dowAny ? c.dom.has(p.day) && c.dow.has(p.dow) : c.dom.has(p.day) || c.dow.has(p.dow);
    if (!c.month.has(p.month) || !dayOk) {
      t += ((23 - p.hour) * 60 + (60 - p.minute)) * 60_000;
      continue;
    }
    if (!c.hour.has(p.hour)) {
      t += (60 - p.minute) * 60_000;
      continue;
    }
    if (c.minute.has(p.minute)) out.push(t);
    t += 60_000;
  }
  return out;
};

/** `Mon 17 Nov 09:00` in the schedule's timezone. */
export const formatRun = (t: number, tz = 'UTC'): string => {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .format(new Date(t))
      .replace(',', '');
  } catch {
    return new Date(t).toISOString();
  }
};

// ───────────────────────────── Schedules ─────────────────────────────

export type ScheduleKind = 'cron' | 'webhook' | 'file-change' | 'nostr-event';

/** Validate a schedule's `spec` for its kind. Returns an error sentence or undefined. */
export const validateSpec = (kind: ScheduleKind, spec: string, mounts: Mount[] = []): string | undefined => {
  const s = spec.trim();
  if (!s) return 'Required.';
  if (kind === 'cron') {
    const c = parseCron(s);
    return 'error' in c ? c.error : undefined;
  }
  if (kind === 'webhook') {
    return /^\/[a-z0-9/_-]+$/i.test(s)
      ? undefined
      : 'Use a path like /hooks/nightly (letters, digits, - and _).';
  }
  if (kind === 'file-change') {
    if (!mounts.length) return 'This agent has no folders. Add one in Setup first.';
    const inside = mounts.some((m) => s === m.path || s.startsWith(`${m.path}/`));
    return inside
      ? undefined
      : `The pattern must be inside a mounted folder: ${mounts.map((m) => m.path).join(', ')}.`;
  }
  try {
    const f = JSON.parse(s) as unknown;
    if (!f || typeof f !== 'object' || Array.isArray(f))
      return 'A Nostr filter is a JSON object, like {"kinds":[1]}.';
    return undefined;
  } catch {
    return 'That isn\'t valid JSON. Example: {"kinds":[1],"#t":["deploy"]}';
  }
};

// ───────────────────────────── Reach / exposure ─────────────────────────────

/** Model API host per harness (the one host every profile must reach). */
export const HARNESS_HOSTS: Record<string, string> = {
  claude: 'api.anthropic.com',
  codex: 'api.openai.com',
  gemini: 'generativelanguage.googleapis.com',
  opencode: 'api.anthropic.com',
  copilot: 'api.githubcopilot.com',
  pi: 'api.anthropic.com',
};

/** Extra hosts a `workspace` profile adds on top of the model API (package installs, git). */
export const WORKSPACE_HOSTS = ['github.com', '*.githubusercontent.com', 'registry.npmjs.org'];

export interface Reach {
  reads: string[];
  writes: string[];
  talksTo: string[];
  never: readonly string[];
  secrets: string[];
}

/**
 * What the agent can read / write / reach. Uses the daemon's effective policy when available; otherwise
 * derives a preview from profile + mounts (new-agent flow, before the daemon compiled anything).
 */
export const reachOf = (
  cfg: Pick<AgentConfig, 'harness' | 'mounts' | 'sandbox'>,
  effective?: SandboxPolicy,
  /** Hosts the harness and its sign-in add at session start (`policy.get` → `required`). */
  required: string[] = [],
): Reach => {
  const uniq = (xs: string[]) => [...new Set(xs)];
  const mountReads = cfg.mounts.map((m) => m.path);
  const mountWrites =
    cfg.sandbox.profile === 'strict' ? [] : cfg.mounts.filter((m) => m.mode === 'rw').map((m) => m.path);
  if (effective) {
    return {
      reads: uniq([...mountReads, ...effective.fs.read]),
      writes: uniq([...mountWrites, ...effective.fs.write]),
      talksTo: uniq([...required, ...effective.net.allow]),
      never: uniq([...ALWAYS_DENY_READ, ...effective.fs.deny]),
      secrets: effective.secrets.map((s) => s.host),
    };
  }
  const api = HARNESS_HOSTS[cfg.harness] ?? 'model API';
  return {
    reads: mountReads,
    writes: mountWrites,
    talksTo: cfg.sandbox.profile === 'strict' ? [api] : [api, ...WORKSPACE_HOSTS],
    never: ALWAYS_DENY_READ,
    secrets: [api],
  };
};

// ───────────────────────────── Diff / patch ─────────────────────────────

export const EDITABLE_KEYS = [
  'displayName',
  'description',
  'harness',
  'model',
  'mounts',
  'sandbox',
  'identity',
  'public',
  'memberships',
  'routes',
  'grants',
  'concurrency',
  'budgets',
  'sessionIdleMinutes',
  'approvalTimeoutMinutes',
  'mesh',
  'retention',
  'harnessAuth',
] as const satisfies readonly (keyof AgentConfig)[];

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Top-level keys that changed, with their new full values (agent.update merges shallowly). */
export const patchOf = (before: AgentConfig, after: AgentConfig): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const k of EDITABLE_KEYS) if (!same(before[k], after[k])) out[k] = after[k];
  return out;
};

export interface Change {
  text: string;
  /** Widening changes need the deliberate `Widen access` confirm (DESIGN §2 asymmetric friction). */
  widens: boolean;
}

const ROLE_RANK: Record<string, number> = { viewer: 1, agent: 1, user: 2, admin: 3, owner: 4 };
const PROFILE_RANK: Record<string, number> = { strict: 0, workspace: 1, custom: 2 };
const money = (n?: number) => (n === undefined ? 'no limit' : `$${n.toFixed(2)}`);
const lim = (n?: number, unit = '') => (n === undefined ? 'no limit' : `${n.toLocaleString('en-US')}${unit}`);

/** Plain-language list of changes ("reviewer will also be able to write ~/notes"). */
export const describeChanges = (before: AgentConfig, after: AgentConfig): Change[] => {
  const n = after.name;
  const out: Change[] = [];
  const add = (text: string, widens = false) => out.push({ text, widens });

  if (before.harness !== after.harness)
    add(`${n} will run on ${after.harness} instead of ${before.harness}.`);
  if (before.model !== after.model) add(`Model: ${before.model} → ${after.model}.`);
  if (before.harnessAuth !== after.harnessAuth)
    add(`Harness login: ${before.harnessAuth} → ${after.harnessAuth}.`, after.harnessAuth === 'subscription');
  if (before.displayName !== after.displayName) add(`Display name → ${after.displayName ?? n}.`);
  if (before.description !== after.description) add('Profile description updated.');

  // mounts
  const bm = new Map(before.mounts.map((m) => [m.path, m]));
  const am = new Map(after.mounts.map((m) => [m.path, m]));
  for (const [p, m] of am) {
    const o = bm.get(p);
    if (!o) add(`${n} will be able to ${m.mode === 'rw' ? 'read and write' : 'read'} ${p}.`, true);
    else {
      if (o.mode !== m.mode)
        add(
          m.mode === 'rw' ? `${n} will be able to write ${p}.` : `${p} becomes read-only.`,
          m.mode === 'rw',
        );
      if (o.parallelUnsafe !== m.parallelUnsafe)
        add(
          m.parallelUnsafe
            ? `Parallel sessions may write ${p} at the same time (no lock).`
            : `Sessions take a write lock on ${p} again.`,
          m.parallelUnsafe,
        );
    }
  }
  for (const p of bm.keys()) if (!am.has(p)) add(`${n} will no longer see ${p}.`);
  if (
    !same(
      before.mounts.map((m) => m.path),
      after.mounts.map((m) => m.path),
    ) &&
    out.length === 0
  )
    add('Folder order changed.');

  if (before.sandbox.profile !== after.sandbox.profile)
    add(
      `Sandbox profile: ${before.sandbox.profile} → ${after.sandbox.profile}.`,
      (PROFILE_RANK[after.sandbox.profile] ?? 0) > (PROFILE_RANK[before.sandbox.profile] ?? 0),
    );

  if (before.public !== after.public)
    add(
      after.public ? `Anyone can talk to ${n} as viewer.` : `Only allowlisted people can talk to ${n}.`,
      after.public,
    );

  // memberships
  const bms = new Map(before.memberships.map((m) => [m.target, m]));
  const ams = new Map(after.memberships.map((m) => [m.target, m]));
  for (const [t, m] of ams) {
    const o = bms.get(t);
    if (!o) add(`${n} joins ${t} (default role ${m.defaultRole}).`, true);
    else {
      if (o.defaultRole !== m.defaultRole)
        add(
          `Default role in ${t}: ${o.defaultRole} → ${m.defaultRole}.`,
          (ROLE_RANK[m.defaultRole] ?? 0) > (ROLE_RANK[o.defaultRole] ?? 0),
        );
      if (!same([...o.triggers].sort(), [...m.triggers].sort())) {
        const added = m.triggers.filter((x) => !o.triggers.includes(x));
        add(`Triggers in ${t}: ${m.triggers.join(', ') || 'none'}.`, added.length > 0);
      }
    }
  }
  for (const t of bms.keys()) if (!ams.has(t)) add(`${n} leaves ${t}.`);

  // routes
  const key = (r: { from: string; to: string }) => `${r.from} → ${r.to}`;
  const br = new Set(before.routes.map(key));
  const ar = new Set(after.routes.map(key));
  for (const r of ar) if (!br.has(r)) add(`${n} may post across: ${r}.`, true);
  for (const r of br) if (!ar.has(r)) add(`Route removed: ${r}.`);

  // grants
  for (const [p, r] of Object.entries(after.grants)) {
    const o = before.grants[p];
    if (o === undefined) add(`${p} gets the ${r} role on ${n}.`, true);
    else if (o !== r) add(`${p}: ${o} → ${r}.`, (ROLE_RANK[r] ?? 0) > (ROLE_RANK[o] ?? 0));
  }
  for (const p of Object.keys(before.grants)) if (!(p in after.grants)) add(`${p} loses their role on ${n}.`);

  // limits
  const up = (a?: number, b?: number) => (a === undefined ? false : b === undefined || b > a);
  const bb = before.budgets;
  const ab = after.budgets;
  if (bb.dailyUsd !== ab.dailyUsd)
    add(`Daily budget: ${money(bb.dailyUsd)} → ${money(ab.dailyUsd)}.`, up(bb.dailyUsd, ab.dailyUsd));
  if (bb.dailyTokens !== ab.dailyTokens)
    add(
      `Tokens per day: ${lim(bb.dailyTokens)} → ${lim(ab.dailyTokens)}.`,
      up(bb.dailyTokens, ab.dailyTokens),
    );
  if (bb.perSessionMinutes !== ab.perSessionMinutes)
    add(
      `Session length: ${lim(bb.perSessionMinutes, ' min')} → ${lim(ab.perSessionMinutes, ' min')}.`,
      up(bb.perSessionMinutes, ab.perSessionMinutes),
    );
  if (bb.messagesPerMinute !== ab.messagesPerMinute)
    add(
      `Messages per minute: ${lim(bb.messagesPerMinute)} → ${lim(ab.messagesPerMinute)}.`,
      up(bb.messagesPerMinute, ab.messagesPerMinute),
    );
  if (before.concurrency.maxSessions !== after.concurrency.maxSessions)
    add(`Parallel sessions: ${before.concurrency.maxSessions} → ${after.concurrency.maxSessions}.`);
  if (before.sessionIdleMinutes !== after.sessionIdleMinutes)
    add(`Idle sessions end after ${after.sessionIdleMinutes} min.`);
  if (before.approvalTimeoutMinutes !== after.approvalTimeoutMinutes)
    add(`Approvals auto-deny after ${after.approvalTimeoutMinutes} min.`);

  // mesh
  const bmsh = before.mesh;
  const amsh = after.mesh;
  for (const p of amsh.allow) if (!bmsh.allow.includes(p)) add(`Peer agent ${p} is trusted.`, true);
  for (const p of bmsh.allow) if (!amsh.allow.includes(p)) add(`Peer agent ${p} is no longer trusted.`);
  for (const p of amsh.block) if (!bmsh.block.includes(p)) add(`Peer agent ${p} is blocked.`);
  for (const p of bmsh.block) if (!amsh.block.includes(p)) add(`Peer agent ${p} is unblocked.`, true);
  if (bmsh.maxTurnsPerThread !== amsh.maxTurnsPerThread)
    add(
      `Agent-to-agent turns per thread: ${bmsh.maxTurnsPerThread} → ${amsh.maxTurnsPerThread}.`,
      amsh.maxTurnsPerThread > bmsh.maxTurnsPerThread,
    );
  if (bmsh.maxHops !== amsh.maxHops)
    add(`Hop limit: ${bmsh.maxHops} → ${amsh.maxHops}.`, amsh.maxHops > bmsh.maxHops);
  if (bmsh.perPeerBudget.dailyTokens !== amsh.perPeerBudget.dailyTokens)
    add(
      `Per-peer tokens/day: ${lim(bmsh.perPeerBudget.dailyTokens)} → ${lim(amsh.perPeerBudget.dailyTokens)}.`,
      up(bmsh.perPeerBudget.dailyTokens, amsh.perPeerBudget.dailyTokens),
    );

  // retention & identity
  if (before.retention.transcriptDays !== after.retention.transcriptDays)
    add(`Transcripts kept ${after.retention.transcriptDays} days.`);
  if (before.retention.auditDays !== after.retention.auditDays)
    add(`Audit log kept ${after.retention.auditDays} days.`);
  if (before.identity.nip05 !== after.identity.nip05)
    add(`NIP-05 handle → ${after.identity.nip05 || 'none'}.`);

  return out;
};

/** Minimal YAML rendering of a patch for the review sheet (mirrors ~/.beamhop/agents/<name>.yaml). */
export const toYaml = (v: unknown, indent = 0): string => {
  const sp = '  '.repeat(indent);
  const scalar = (x: unknown) =>
    typeof x === 'string'
      ? /^[\w./~@*:-]+$/.test(x) && !/^(true|false|null|\d+)$/.test(x)
        ? x
        : JSON.stringify(x)
      : String(x);
  if (Array.isArray(v)) {
    if (!v.length) return `${sp}[]`;
    return v
      .map((x) => {
        if (x && typeof x === 'object') {
          const body = toYaml(x, indent + 1).trimStart();
          return `${sp}- ${body}`;
        }
        return `${sp}- ${scalar(x)}`;
      })
      .join('\n');
  }
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
    if (!entries.length) return `${sp}{}`;
    return entries
      .map(([k, x]) => {
        const kk = /^[\w-]+$/.test(k) ? k : JSON.stringify(k);
        if (x && typeof x === 'object' && (Array.isArray(x) ? x.length : Object.keys(x).length))
          return `${sp}${kk}:\n${toYaml(x, indent + 1)}`;
        return `${sp}${kk}: ${x && typeof x === 'object' ? (Array.isArray(x) ? '[]' : '{}') : scalar(x)}`;
      })
      .join('\n');
  }
  return `${sp}${scalar(v)}`;
};

// ───────────────────────────── Names, principals, presets ─────────────────────────────

export const SLUG = /^[a-z0-9][a-z0-9-]*$/;

export const validateName = (name: string, taken: string[]): string | undefined => {
  if (!name) return 'Give the agent a name.';
  if (name.length > 48) return 'Use at most 48 characters.';
  if (!SLUG.test(name)) return 'Use lowercase letters, digits and dashes, starting with a letter or digit.';
  if (taken.includes(name)) return `${name} already exists. Try ${suggestName(name, taken)}.`;
  return undefined;
};

/** `reviewer` → `reviewer-2` (first free). */
export const suggestName = (base: string, taken: string[]): string => {
  if (!taken.includes(base)) return base;
  for (let i = 2; i < 100; i++) if (!taken.includes(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now().toString(36)}`;
};

export const PRINCIPAL = /^[a-z][a-z0-9_-]*:.+$/;
export const validatePrincipal = (p: string): string | undefined =>
  PRINCIPAL.test(p.trim()) ? undefined : 'Use provider:id, like telegram:5551234 or nostr:npub1….';

export const validateNip05 = (v: string): string | undefined =>
  !v || /^[a-z0-9._-]+@([a-z0-9-]+\.)+[a-z]{2,}$/i.test(v)
    ? undefined
    : 'Use name@domain, like reviewer@example.com.';

export const validateMountPath = (p: string, existing: Mount[]): string | undefined => {
  const s = p.trim().replace(/\/+$/, '');
  if (!s) return 'Choose a folder.';
  if (!(s === '~' || s.startsWith('~/') || s.startsWith('/'))) return 'Use a path like ~/code/app.';
  if (s === '~') return 'Mounting your whole home folder would expose everything. Pick a project folder.';
  const locked = ALWAYS_DENY_READ.find((d) => s === d || s.startsWith(`${d}/`));
  if (locked) return `${locked} is always blocked. No agent can mount it.`;
  if (existing.some((m) => m.path === s)) return `${s} is already mounted.`;
  return undefined;
};

export interface PresetMeta {
  /** Default agent name. */
  name: string;
  /** Who can talk to it. */
  who: string;
  /** What it can change. */
  writes: string;
  /** The deliberate trade-off, in one line. */
  tradeoff: string;
  /** Mount mode forced by the preset (code-reviewer never writes). */
  lockMode?: 'ro';
}

export const PRESET_META: Record<string, PresetMeta> = {
  'personal-assistant': {
    name: 'assistant',
    who: 'Only you, over Nostr DMs',
    writes: 'Folders you mount read-write',
    tradeoff: 'Most reach, smallest audience.',
  },
  'code-reviewer': {
    name: 'reviewer',
    who: 'You and teammates who mention it',
    writes: 'Nothing — read-only',
    tradeoff: 'Safest for a shared repo; it can only comment.',
    lockMode: 'ro',
  },
  'team-dev-bot': {
    name: 'devbot',
    who: 'Teammates in your channels',
    writes: 'A git worktree per thread',
    tradeoff: 'Real changes; you approve shell and writes.',
  },
  'public-qa': {
    name: 'qa',
    who: 'Anyone, as viewer',
    writes: 'Nothing — strict sandbox',
    tradeoff: 'Widest audience, least reach, tight rate limits.',
    lockMode: 'ro',
  },
};

/**
 * The "start from scratch" choice in the New agent flow. Not a daemon preset: the agent is created with
 * no preset, so it gets the AgentConfig defaults (no channels, $5/day) plus the sandbox picked here.
 */
export const SCRATCH = 'scratch';
export const SCRATCH_NAME = 'agent';

/** CLI equivalent for creating an agent. */
export const createCli = (o: {
  name: string;
  preset?: string;
  harness?: string;
  model?: string;
  mounts: Mount[];
  /** Only for agents without a preset; a preset already sets the profile. */
  profile?: string;
}): string =>
  [
    // An invalid name would make a broken (or, with shell characters, a different) command, so the
    // preview keeps the placeholder until the name passes validation.
    `beamhop agent add ${o.name && o.name.length <= 48 && SLUG.test(o.name) ? o.name : '<name>'}`,
    o.preset && `--preset ${o.preset}`,
    o.profile && `--profile ${o.profile}`,
    `--harness ${o.harness || '<harness>'}`,
    o.model && o.model !== 'default' && `--model ${o.model}`,
    ...o.mounts.map((m) => `--mount ${m.path}:${m.mode}`),
  ]
    .filter(Boolean)
    .join(' ');

// ───────────────────────────── Instruction files ─────────────────────────────

const normPath = (p: string): string => {
  const out: string[] = [];
  for (const seg of p.replace(/\/+$/, '').split('/')) {
    if (seg === '..') out.pop();
    else if (seg !== '.' && seg !== '') out.push(seg);
  }
  return (p.startsWith('/') ? '/' : '') + out.join('/');
};
const within = (p: string, root: string) => p === root || p.startsWith(`${root}/`);

/** The read-write mount holding `path`, if any: instruction files are only writable there. */
export const writableMount = (mounts: Mount[], path: string): Mount | undefined => {
  const p = normPath(path);
  return mounts.find((m) => m.mode === 'rw' && within(p, normPath(m.path)));
};

/**
 * A git-style unified diff of one file (3 lines of context), for the preview before a write.
 * Empty when nothing changed.
 */
export const unifiedDiff = (path: string, before: string, after: string, context = 3): string => {
  if (before === after) return '';
  const a = before.split('\n');
  const b = after.split('\n');
  // Trim the common head and tail, then LCS the middle (instruction files are small).
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  const am = a.slice(head, a.length - tail);
  const bm = b.slice(head, b.length - tail);
  const ops: Array<{ k: ' ' | '-' | '+'; t: string }> = a.slice(0, head).map((t) => ({ k: ' ', t }));
  if (am.length * bm.length > 4_000_000) {
    for (const t of am) ops.push({ k: '-', t });
    for (const t of bm) ops.push({ k: '+', t });
  } else {
    const L = Array.from({ length: am.length + 1 }, () => new Uint32Array(bm.length + 1));
    for (let i = am.length - 1; i >= 0; i--)
      for (let j = bm.length - 1; j >= 0; j--)
        L[i]![j] = am[i] === bm[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
    let i = 0;
    let j = 0;
    while (i < am.length || j < bm.length) {
      if (i < am.length && j < bm.length && am[i] === bm[j]) {
        ops.push({ k: ' ', t: am[i]! });
        i++;
        j++;
      } else if (j < bm.length && (i === am.length || L[i]![j + 1]! >= L[i + 1]![j]!)) {
        ops.push({ k: '+', t: bm[j]! });
        j++;
      } else {
        ops.push({ k: '-', t: am[i]! });
        i++;
      }
    }
  }
  for (const t of a.slice(a.length - tail)) ops.push({ k: ' ', t });

  // Group into hunks with `context` lines around each change.
  const changed = ops.map((o, i) => (o.k === ' ' ? -1 : i)).filter((i) => i >= 0);
  const out = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`];
  let k = 0;
  while (k < changed.length) {
    const start = Math.max(0, changed[k]! - context);
    let end = Math.min(ops.length - 1, changed[k]! + context);
    while (k + 1 < changed.length && changed[k + 1]! - context <= end + 1) {
      k++;
      end = Math.min(ops.length - 1, changed[k]! + context);
    }
    k++;
    let oldStart = 1;
    let newStart = 1;
    for (let x = 0; x < start; x++) {
      if (ops[x]!.k !== '+') oldStart++;
      if (ops[x]!.k !== '-') newStart++;
    }
    const slice = ops.slice(start, end + 1);
    const oldLen = slice.filter((o) => o.k !== '+').length;
    const newLen = slice.filter((o) => o.k !== '-').length;
    out.push(`@@ -${oldStart},${oldLen} +${newStart},${newLen} @@`);
    for (const o of slice) out.push(`${o.k}${o.t}`);
  }
  return out.join('\n');
};
