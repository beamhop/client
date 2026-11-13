/**
 * Pure policy logic for the Policy screens (JOURNEYS §5): folders view of fs rules, profile templates,
 * host/env validation, findings, plain-language diff, YAML rendering + unified diff for the review sheet,
 * learning-mode suggestion classification. No React here — everything is unit-tested in model.test.ts.
 */
import { ALWAYS_DENY_READ, type Mount, type PolicySuggestion, type SandboxPolicy } from '@beamhop/core';
import { parseHostInput } from '../../ui/Chip.tsx';

export type Profile = 'strict' | 'workspace' | 'custom';
export const PROFILES: Profile[] = ['strict', 'workspace', 'custom'];
export const isProfile = (s: string): s is Profile => (PROFILES as string[]).includes(s);

export type Mode = 'ro' | 'rw';
export interface Folder {
  path: string;
  mode: Mode;
}

/** Hosts a `workspace` profile adds so package managers work. */
export const PACKAGE_HOSTS = ['registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org', 'github.com'];

/** Network ranges that are blocked when `denyPrivateIps` is on (the metadata IP is blocked always). */
export const PRIVATE_RANGES = [
  { id: '127.0.0.0/8', note: 'loopback' },
  { id: '10.0.0.0/8', note: 'private' },
  { id: '172.16.0.0/12', note: 'private' },
  { id: '192.168.0.0/16', note: 'home network' },
];
export const METADATA_IP = '169.254.169.254';

export const clone = (p: SandboxPolicy): SandboxPolicy => structuredClone(p);

// ─────────── paths ───────────
const norm = (p: string) => p.replace(/\/+$/, '') || '/';
/** `parent` contains `child` (or is it). */
export const covers = (parent: string, child: string): boolean => {
  const a = norm(parent);
  const b = norm(child);
  return a === b || b.startsWith(`${a}/`) || a === '~' || a === '/';
};
export const isLockedPath = (p: string): boolean => ALWAYS_DENY_READ.some((l) => covers(l, p));
/** Credential files that should come through the secret broker rather than a mount. */
export const isCredentialPath = (p: string): boolean =>
  /(\.npmrc|\.netrc|\.pypirc|credentials|\.git-credentials|token|\.env)$/i.test(p);

/** Locked rows shown to people: a short, recognisable subset first. */
export const LOCKED_HEADLINE = ['~/.ssh', '~/.aws', '~/.config/gh', '~/.gnupg', '~/Library/Keychains'];

// ─────────── folders ───────────
export const foldersOf = (p: SandboxPolicy): Folder[] => {
  const out: Folder[] = [];
  for (const path of p.fs.read) if (!out.some((f) => f.path === path)) out.push({ path, mode: 'ro' });
  for (const path of p.fs.write) {
    const f = out.find((x) => x.path === path);
    if (f) f.mode = 'rw';
    else out.push({ path, mode: 'rw' });
  }
  return out;
};

export const withFolders = (p: SandboxPolicy, folders: Folder[]): SandboxPolicy => ({
  ...p,
  fs: {
    ...p.fs,
    read: folders.map((f) => f.path),
    write: folders.filter((f) => f.mode === 'rw').map((f) => f.path),
  },
});

export const userDenies = (p: SandboxPolicy): string[] =>
  p.fs.deny.filter((d) => !(ALWAYS_DENY_READ as readonly string[]).includes(d));

// ─────────── profiles ───────────
/**
 * What switching to a profile does to the current rules. `strict`: nothing writable, network only to
 * hosts the broker holds a key for (the AI provider). `workspace`: mounts get their configured mode
 * back and package registries are added. `custom`: no automatic change.
 */
export const applyProfile = (target: Profile, p: SandboxPolicy, mounts: Mount[] = []): SandboxPolicy => {
  const next = clone(p);
  if (target === 'strict') {
    next.fs.write = [];
    const apiHosts = new Set(p.secrets.map((s) => s.host));
    next.net.allow = p.net.allow.filter((h) => apiHosts.has(h));
    next.net.denyPrivateIps = true;
  } else if (target === 'workspace') {
    const folders = foldersOf(next);
    for (const m of mounts) {
      const f = folders.find((x) => x.path === m.path);
      if (f) f.mode = m.mode;
      else folders.push({ path: m.path, mode: m.mode });
    }
    Object.assign(next, withFolders(next, folders));
    for (const h of PACKAGE_HOSTS) if (!next.net.allow.includes(h)) next.net.allow.push(h);
    next.net.denyPrivateIps = true;
  }
  return next;
};

// ─────────── validation ───────────
const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
export const privateKind = (host: string): 'metadata' | 'private' | undefined => {
  if (host === METADATA_IP || host === 'metadata.google.internal') return 'metadata';
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return 'private';
  const m = ipv4.exec(host);
  if (!m) return undefined;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168))
    return 'private';
  if (a === 169 && b === 254) return 'metadata';
  return undefined;
};

export type ParseResult = { value: string; note?: string } | { error: string };

/** Host input for the allowlist: host, `*.domain`, or URL — plus the always-blocked and too-wide checks. */
export const parseAllowHost = (raw: string, denyPrivateIps = true): ParseResult => {
  const s = raw.trim().toLowerCase();
  const local = s === 'localhost' ? { value: s } : parseHostInput(raw);
  if ('error' in local) return local;
  const v = local.value;
  const kind = privateKind(v);
  if (kind === 'metadata')
    return {
      error: `${v} is the cloud metadata address. beamhop always blocks it because it can hand out cloud credentials.`,
    };
  if (kind === 'private' && denyPrivateIps)
    return {
      error: `${v} is on your private network. Turn off “Block private network” first if the agent really needs it.`,
    };
  if (v.startsWith('*.') && v.split('.').length < 3)
    return { error: `${v} would allow every site ending in ${v.slice(1)}. Use a narrower domain.` };
  return local;
};

const SECRETISH = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE)/;
export const parseEnvName = (raw: string): ParseResult => {
  const s = raw.trim();
  if (!s) return { error: 'Type a variable name, like NODE_ENV.' };
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s))
    return { error: `“${s}” isn't a variable name. Use letters, digits and _ (like NODE_ENV).` };
  if (SECRETISH.test(s.toUpperCase()))
    return {
      error: `${s} looks like a secret. Add it as a broker key below so the agent only sees a placeholder.`,
    };
  return { value: s };
};

export const parseFolder = (raw: string): ParseResult => {
  const s = raw.trim().replace(/\/+$/, '');
  if (!s) return { error: 'Choose a folder.' };
  if (!s.startsWith('~') && !s.startsWith('/')) return { error: 'Use a full path, like ~/code/app.' };
  if (s === '~' || s === '/')
    return { error: 'Sharing your whole home folder is too wide. Pick the project folder instead.' };
  if (isLockedPath(s)) return { error: `${s} is always blocked. No profile or role can open it.` };
  return { value: s };
};

// ─────────── findings ───────────
export type Severity = 'caution' | 'stop';
export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  /** Value inside `title` rendered as mono. */
  value?: string;
  /** Fix label + transformation of the draft. */
  fix?: { label: string; apply: (p: SandboxPolicy) => SandboxPolicy };
}

const KNOWN_NARROW: Record<string, string> = {
  '*.githubusercontent.com': 'raw.githubusercontent.com',
  '*.amazonaws.com': 's3.amazonaws.com',
  '*.googleapis.com': 'storage.googleapis.com',
  '*.npmjs.org': 'registry.npmjs.org',
};

export interface FindingContext {
  /** Folders known to be git repos (worktree per session). */
  gitPaths?: Set<string>;
  pendingSuggestions?: number;
}

export const findingsFor = (p: SandboxPolicy, ctx: FindingContext = {}): Finding[] => {
  const out: Finding[] = [];
  for (const h of p.net.allow.filter((x) => x.startsWith('*.'))) {
    const apex = h.slice(2);
    const exact = p.net.allow.filter((x) => !x.startsWith('*.') && x.endsWith(`.${apex}`));
    const target = exact.length ? undefined : KNOWN_NARROW[h];
    out.push({
      id: `wild:${h}`,
      severity: 'caution',
      value: h,
      title: `Wildcard ${h} allows every subdomain of ${apex}, including ones you've never seen.`,
      fix: exact.length
        ? {
            label: `Keep only ${exact.join(', ')}`,
            apply: (q) => ({ ...q, net: { ...q.net, allow: q.net.allow.filter((x) => x !== h) } }),
          }
        : target
          ? {
              label: `Narrow to ${target}`,
              apply: (q) => ({
                ...q,
                net: {
                  ...q.net,
                  allow: [...new Set(q.net.allow.map((x) => (x === h ? target : x)))],
                },
              }),
            }
          : undefined,
    });
  }
  if (ctx.gitPaths)
    for (const f of foldersOf(p).filter((x) => x.mode === 'rw' && !ctx.gitPaths?.has(x.path)))
      out.push({
        id: `lock:${f.path}`,
        severity: 'caution',
        value: f.path,
        title: `${f.path} is read-write and not a git repo, so parallel sessions wait for a lock and edits can't be undone per session.`,
        fix: {
          label: 'Make read-only',
          apply: (q) =>
            withFolders(
              q,
              foldersOf(q).map((x) => (x.path === f.path ? { ...x, mode: 'ro' } : x)),
            ),
        },
      });
  if (!p.net.denyPrivateIps)
    out.push({
      id: 'private',
      severity: 'stop',
      title: 'The agent can reach your private network: router, NAS and other machines at home or work.',
      fix: {
        label: 'Block private network',
        apply: (q) => ({ ...q, net: { ...q.net, denyPrivateIps: true } }),
      },
    });
  for (const s of p.secrets.filter((x) => !hostAllowed(p, x.host)))
    out.push({
      id: `secret:${s.name}`,
      severity: 'caution',
      value: s.name,
      title: `The broker holds ${s.name} for ${s.host}, but ${s.host} isn't in the allowlist, so the key is never used.`,
      fix: {
        label: `Remove ${s.name}`,
        apply: (q) => ({ ...q, secrets: q.secrets.filter((x) => x.name !== s.name) }),
      },
    });
  for (const e of p.env.passthrough.filter((x) => SECRETISH.test(x.toUpperCase())))
    out.push({
      id: `env:${e}`,
      severity: 'stop',
      value: e,
      title: `${e} is passed into the sandbox as plain text. The agent can read and leak it.`,
      fix: {
        label: `Stop passing ${e}`,
        apply: (q) => ({ ...q, env: { passthrough: q.env.passthrough.filter((x) => x !== e) } }),
      },
    });
  if (p.learning && (ctx.pendingSuggestions ?? 0) > 0)
    out.push({
      id: 'learning',
      severity: 'caution',
      title: `Learning mode is on and ${ctx.pendingSuggestions} blocked ${ctx.pendingSuggestions === 1 ? 'request is' : 'requests are'} waiting for your review.`,
    });
  return out;
};

export const hostAllowed = (p: SandboxPolicy, host: string): boolean =>
  p.net.allow.some((a) => a === host || (a.startsWith('*.') && host.endsWith(a.slice(1))));

// ─────────── plain-language diff ───────────
export type ChangeKind = 'widen' | 'tighten' | 'neutral';
export interface Change {
  kind: ChangeKind;
  /** Sentence; `value` (if any) appears verbatim inside it and is rendered as mono. */
  text: string;
  value?: string;
}

const added = <T>(a: T[], b: T[]) => b.filter((x) => !a.includes(x));

export const describeChanges = (
  agent: string,
  base: { profile: string; policy: SandboxPolicy },
  draft: { profile: string; policy: SandboxPolicy },
): Change[] => {
  const out: Change[] = [];
  const a = base.policy;
  const b = draft.policy;
  if (base.profile !== draft.profile)
    out.push({
      kind: 'neutral',
      text: `Profile changes from ${base.profile} to ${draft.profile}.`,
      value: draft.profile,
    });
  const fa = foldersOf(a);
  const fb = foldersOf(b);
  for (const f of fb) {
    const was = fa.find((x) => x.path === f.path);
    if (!was)
      out.push({
        kind: 'widen',
        text:
          f.mode === 'rw'
            ? `${agent} will be able to read and change files in ${f.path}.`
            : `${agent} will be able to read ${f.path}.`,
        value: f.path,
      });
    else if (was.mode !== f.mode)
      out.push(
        f.mode === 'rw'
          ? { kind: 'widen', text: `${agent} will be able to change files in ${f.path}.`, value: f.path }
          : {
              kind: 'tighten',
              text: `${f.path} becomes read-only: ${agent} can look but not change.`,
              value: f.path,
            },
      );
  }
  for (const f of fa.filter((x) => !fb.some((y) => y.path === x.path)))
    out.push({ kind: 'tighten', text: `${agent} will no longer see ${f.path}.`, value: f.path });
  for (const d of added(a.fs.deny, b.fs.deny))
    out.push({ kind: 'tighten', text: `${d} will always be blocked.`, value: d });
  for (const d of added(b.fs.deny, a.fs.deny))
    out.push({ kind: 'widen', text: `${d} is no longer on the block list.`, value: d });
  for (const h of added(a.net.allow, b.net.allow))
    out.push({
      kind: 'widen',
      text: h.startsWith('*.')
        ? `${agent} will also be able to reach ${h} (every subdomain).`
        : `${agent} will also be able to reach ${h}.`,
      value: h,
    });
  for (const h of added(b.net.allow, a.net.allow))
    out.push({ kind: 'tighten', text: `${agent} will no longer reach ${h}.`, value: h });
  if (a.net.denyPrivateIps !== b.net.denyPrivateIps)
    out.push(
      b.net.denyPrivateIps
        ? { kind: 'tighten', text: `${agent} will be blocked from your private network.` }
        : { kind: 'widen', text: `${agent} will be able to reach your private network.` },
    );
  for (const s of b.secrets.filter((x) => !a.secrets.some((y) => y.name === x.name && y.host === x.host)))
    out.push({
      kind: 'widen',
      text: `The broker will add ${s.name} to requests to ${s.host}.`,
      value: s.name,
    });
  for (const s of a.secrets.filter((x) => !b.secrets.some((y) => y.name === x.name && y.host === x.host)))
    out.push({ kind: 'tighten', text: `The broker stops adding ${s.name} for ${s.host}.`, value: s.name });
  for (const e of added(a.env.passthrough, b.env.passthrough))
    out.push({ kind: 'widen', text: `${agent} will see the environment variable ${e}.`, value: e });
  for (const e of added(b.env.passthrough, a.env.passthrough))
    out.push({ kind: 'tighten', text: `${agent} will no longer see ${e}.`, value: e });
  if (a.proc.maxSessionMinutes !== b.proc.maxSessionMinutes)
    out.push({
      kind: b.proc.maxSessionMinutes > a.proc.maxSessionMinutes ? 'widen' : 'tighten',
      text: `Sessions stop after ${b.proc.maxSessionMinutes} min (was ${a.proc.maxSessionMinutes}).`,
    });
  if (a.learning !== b.learning)
    out.push(
      b.learning
        ? {
            kind: 'widen',
            text: 'Learning mode: requests outside the rules are let through and logged so you can review them.',
          }
        : { kind: 'tighten', text: 'Learning mode off: requests outside the rules fail again.' },
    );
  return out;
};

export const isWidening = (changes: Change[]) => changes.some((c) => c.kind === 'widen');

// ─────────── YAML + unified diff ───────────
const q = (s: string) => (/^[\w./~-]+$/.test(s) && !/^[*~]$/.test(s) && !s.startsWith('*') ? s : JSON.stringify(s));
const list = (indent: string, key: string, xs: string[]) =>
  xs.length ? [`${indent}${key}:`, ...xs.map((x) => `${indent}  - ${q(x)}`)] : [`${indent}${key}: []`];

/** The `sandbox:` block of ~/.beamhop/agents/<name>.yaml (§6A.1). */
export const toYaml = (profile: string, p: SandboxPolicy): string =>
  [
    'sandbox:',
    `  profile: ${profile}`,
    '  policy:',
    '    fs:',
    ...list('      ', 'read', p.fs.read),
    ...list('      ', 'write', p.fs.write),
    ...list('      ', 'deny', p.fs.deny),
    '    net:',
    ...list('      ', 'allow', p.net.allow),
    ...list('      ', 'deny', p.net.deny),
    `      denyPrivateIps: ${p.net.denyPrivateIps}`,
    ...(p.secrets.length
      ? [
          '    secrets:',
          ...p.secrets.flatMap((s) => [
            `      - name: ${s.name}`,
            `        host: ${s.host}`,
            `        header: ${s.header}`,
            ...(s.prefix ? [`        prefix: ${s.prefix}`] : []),
          ]),
        ]
      : ['    secrets: []']),
    '    env:',
    ...list('      ', 'passthrough', p.env.passthrough),
    '    proc:',
    `      maxSessionMinutes: ${p.proc.maxSessionMinutes}`,
    `    learning: ${p.learning}`,
  ].join('\n');

/** Line diff (LCS) rendered as a single-hunk unified diff with full context. */
export const unifiedDiff = (path: string, before: string, after: string): string => {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      lines.push(` ${a[i]}`);
      i++;
      j++;
    } else if (j < m && (i >= n || dp[i]![j + 1]! >= dp[i + 1]![j]!)) {
      lines.push(`+${b[j]}`);
      j++;
    } else {
      lines.push(`-${a[i]}`);
      i++;
    }
  }
  return [`diff --git a/${path} b/${path}`, `@@ -1,${n} +1,${m} @@`, ...lines].join('\n');
};

// ─────────── learning-mode suggestions ───────────
export type SuggestionClass = 'host' | 'path' | 'credential' | 'locked';
export const classify = (s: PolicySuggestion): SuggestionClass =>
  s.kind === 'net.allow'
    ? 'host'
    : isLockedPath(s.value)
      ? 'locked'
      : isCredentialPath(s.value)
        ? 'credential'
        : 'path';

/** Scope choices for a host suggestion: exact host, or its parent wildcard (explicit choice only). */
export const hostScopes = (host: string): string[] => {
  const parts = host.split('.');
  if (parts.length < 3 || privateKind(host)) return [host];
  return [host, `*.${parts.slice(1).join('.')}`];
};

/** Add an accepted suggestion to the draft. */
export const acceptSuggestion = (p: SandboxPolicy, s: PolicySuggestion, value = s.value): SandboxPolicy => {
  const next = clone(p);
  if (s.kind === 'net.allow') {
    if (!next.net.allow.includes(value)) next.net.allow.push(value);
  } else {
    const folders = foldersOf(next);
    if (!folders.some((f) => f.path === value))
      folders.push({ path: value, mode: s.kind === 'fs.write' ? 'rw' : 'ro' });
    Object.assign(next, withFolders(next, folders));
  }
  return next;
};

export const samePolicy = (a: SandboxPolicy, b: SandboxPolicy) => JSON.stringify(a) === JSON.stringify(b);
