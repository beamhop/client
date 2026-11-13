import { homedir } from 'node:os';
import { isAbsolute, join, normalize, relative, resolve } from 'node:path';
import {
  ALWAYS_DENY_READ,
  type Mount,
  SandboxPolicy,
  type SandboxPolicy as SandboxPolicyT,
  type SandboxProfileName,
} from '@beamhop/core';

/** Hosts every harness needs to reach its model provider (used by all profiles). */
export const LLM_PROVIDER_HOSTS = [
  'api.anthropic.com',
  'api.openai.com',
  'openrouter.ai',
  'generativelanguage.googleapis.com',
  'api.mistral.ai',
  'api.groq.com',
  'api.deepseek.com',
  'api.x.ai',
] as const;

/** Extra hosts the `workspace` profile allows: code hosting and package registries. */
export const WORKSPACE_DEV_HOSTS = [
  'github.com',
  '*.github.com',
  '*.githubusercontent.com',
  'codeload.github.com',
  'gitlab.com',
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'pypi.org',
  'files.pythonhosted.org',
  'crates.io',
  'index.crates.io',
  'static.crates.io',
  'proxy.golang.org',
  'sum.golang.org',
  'jsr.io',
  'npm.jsr.io',
  'deb.nodesource.com',
] as const;

/** Cloud metadata endpoints, always denied by name/literal. */
export const METADATA_HOSTS = [
  '169.254.169.254',
  '169.254.170.2',
  'metadata.google.internal',
  'metadata.goog',
  '100.100.100.200',
  '[fd00:ec2::254]',
] as const;

/** Private/link-local ranges denied as resolution targets when `denyPrivateIps` is on. */
export const PRIVATE_IP_RANGES = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10',
  '169.254.0.0/16',
  'fc00::/7',
  'fe80::/10',
] as const;

/**
 * True for allow entries that would open the *host's* loopback through srt's proxy: the reserved
 * `localhost` names (srt lets them resolve to loopback by design) and loopback / unspecified IP
 * literals. That would expose every local service (daemon API, other sessions' MCP bridges, dev
 * servers). Host-loopback access is only granted per `ip:port` via `localAllow` (e.g. the broker).
 */
export const isLoopbackAllowEntry = (entry: string): boolean => {
  let h = entry.trim().toLowerCase();
  const m = /^\[([^\]]+)\](?::\d+)?$/.exec(h);
  if (m?.[1]) h = m[1];
  else if ((h.match(/:/g) ?? []).length === 1) h = h.replace(/:\d+$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (/^(127|0)\.\d+\.\d+\.\d+(\/\d+)?$/.test(h)) return true;
  return h === '::1' || h === '::' || h.startsWith('::ffff:127.') || h.startsWith('::ffff:0.');
};

export interface PathOptions {
  /** Home directory used to expand `~` (default: os.homedir()). */
  home?: string;
  /** Base for relative paths (default: process.cwd()). */
  cwd?: string;
}

/** Daemon-owned per-session directories carved out of the deny list (compilePolicy only). */
export interface OwnDirs {
  /** The session's own directories: each strictly inside `<beamhopHome>/sessions` or `/worktrees`. */
  dirs: string[];
  /** The beamhop home (denied as a whole; only these per-session dirs are reopened). */
  beamhopHome: string;
}

/** Expand `~` against `home` and make the path absolute + normalized. */
export const expandPath = (p: string, opts: PathOptions = {}): string => {
  const home = opts.home ?? homedir();
  let out = p;
  if (p === '~') out = home;
  else if (p.startsWith('~/') || p.startsWith('~\\')) out = join(home, p.slice(2));
  out = isAbsolute(out) ? out : resolve(opts.cwd ?? process.cwd(), out);
  out = normalize(out);
  // Strip trailing separators (except the root).
  while (out.length > 1 && /[\\/]$/.test(out) && !/^[A-Za-z]:[\\/]$/.test(out)) out = out.slice(0, -1);
  return out;
};

/** True when `child` equals `parent` or lies beneath it. */
export const isWithin = (child: string, parent: string): boolean => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

const uniq = <T>(xs: Iterable<T>): T[] => [...new Set(xs)];

/** Partial policy accepted as overrides (same shape as the core schema input). */
export type PolicyOverrides = {
  fs?: { read?: string[]; write?: string[]; deny?: string[] };
  net?: { allow?: string[]; deny?: string[]; denyPrivateIps?: boolean; mode?: 'restricted' | 'all' };
  secrets?: SandboxPolicyT['secrets'];
  env?: { passthrough?: string[] };
  proc?: { maxSessionMinutes?: number };
  learning?: boolean;
};

/**
 * Compile a beamhop profile + agent mounts + overrides into the effective SandboxPolicy.
 *
 * - `strict`: every mount is read-only regardless of its mode; no extra writes; network
 *   allows only the LLM provider hosts. Overrides may only *restrict* (fs.deny, net.deny),
 *   add read paths, env passthrough, proc limits and learning; fs.write/net.allow overrides
 *   are ignored.
 * - `workspace`: rw mounts are writable; network allows LLM hosts + code hosts + registries,
 *   plus anything in the overrides.
 * - `custom`: the overrides are the policy (validated by the core schema); mounts are added.
 *
 * Always: ALWAYS_DENY_READ is merged into fs.deny (expanded), `denyPrivateIps` is on, and
 * deny wins over allow (read/write entries inside a denied path are dropped; network allow
 * entries that are also denied are dropped). Loopback names/literals are never allow-listed
 * (see `isLoopbackAllowEntry`); use `localAllow` with an explicit `ip:port` instead.
 */
export const compilePolicy = (
  profile: SandboxProfileName,
  agentMounts: Pick<Mount, 'path' | 'mode'>[] = [],
  policyOverrides: PolicyOverrides = {},
  opts: PathOptions & { own?: OwnDirs } = {},
): SandboxPolicyT => {
  const o = policyOverrides;
  const base = SandboxPolicy.parse(profile === 'custom' ? o : {});
  const mounts = agentMounts.map((m) => ({ path: expandPath(m.path, opts), mode: m.mode ?? 'ro' }));

  let read: string[];
  let write: string[];
  let allow: string[];
  switch (profile) {
    case 'strict':
      read = [...mounts.map((m) => m.path), ...(o.fs?.read ?? [])];
      write = [];
      allow = [...LLM_PROVIDER_HOSTS];
      break;
    case 'workspace':
      read = [...mounts.filter((m) => m.mode === 'ro').map((m) => m.path), ...(o.fs?.read ?? [])];
      write = [...mounts.filter((m) => m.mode === 'rw').map((m) => m.path), ...(o.fs?.write ?? [])];
      allow = [...LLM_PROVIDER_HOSTS, ...WORKSPACE_DEV_HOSTS, ...(o.net?.allow ?? [])];
      break;
    case 'custom':
      read = [...mounts.filter((m) => m.mode === 'ro').map((m) => m.path), ...base.fs.read];
      write = [...mounts.filter((m) => m.mode === 'rw').map((m) => m.path), ...base.fs.write];
      allow = [...base.net.allow];
      break;
  }

  const deny = uniq([...ALWAYS_DENY_READ, ...(o.fs?.deny ?? [])].map((p) => expandPath(p, opts)));
  const own = ownCarveOuts(opts.own, deny, opts);
  const isOwn = (p: string) => own.some((d) => isWithin(p, d));
  // Deny wins, except inside this session's own directories.
  const denied = (p: string) => !isOwn(p) && deny.some((d) => isWithin(p, d));
  const writeSet = uniq(write.map((p) => expandPath(p, opts))).filter((p) => !denied(p));
  const readSet = uniq(read.map((p) => expandPath(p, opts)))
    .filter((p) => !denied(p))
    .filter((p) => !writeSet.includes(p));

  const netDeny = uniq((o.net?.deny ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean));
  const netAllow = uniq(allow.map((h) => h.trim().toLowerCase()).filter(Boolean)).filter(
    (h) => !netDeny.includes(h) && !isLoopbackAllowEntry(h),
  );

  return SandboxPolicy.parse({
    // `own` comes only from the daemon's option: an override (or a custom profile) cannot set it.
    fs: { read: readSet, write: writeSet, deny, own },
    net: { allow: netAllow, deny: netDeny, denyPrivateIps: true, mode: o.net?.mode ?? base.net.mode },
    secrets: o.secrets ?? base.secrets,
    env: { passthrough: uniq(o.env?.passthrough ?? base.env.passthrough) },
    proc: { maxSessionMinutes: o.proc?.maxSessionMinutes ?? base.proc.maxSessionMinutes },
    learning: o.learning ?? base.learning,
  });
};

/**
 * Validate the daemon's own-dir carve-outs. Each must lie strictly inside `<beamhopHome>/sessions` or
 * `<beamhopHome>/worktrees` (never a root itself, so sibling sessions stay denied), and the only deny
 * entries covering it may be the beamhop home or its ancestors: a carve-out reopens one session's
 * own dir, never ~/.ssh or a deny the user put inside the home.
 * Throws on violation: a bad carve-out is a daemon bug, and failing closed beats a silent hole.
 */
const ownCarveOuts = (own: OwnDirs | undefined, deny: string[], opts: PathOptions): string[] => {
  if (!own) return [];
  const bh = expandPath(own.beamhopHome, opts);
  // The beamhop home itself may not sit in a credential store (~/.ssh, keychains…): "the home's own
  // deny" must not be a stand-in for one of those.
  const credential = ALWAYS_DENY_READ.filter((p) => !/beamhop/.test(p))
    .map((p) => expandPath(p, opts))
    .find((c) => isWithin(bh, c));
  if (credential) throw new Error(`sandbox: beamhop home ${bh} is inside protected path ${credential}`);
  const roots = [join(bh, 'sessions'), join(bh, 'worktrees')];
  return uniq(own.dirs.map((p) => expandPath(p, opts))).map((p) => {
    if (!roots.some((r) => p !== r && isWithin(p, r)))
      throw new Error(`sandbox: own dir ${p} is not inside ${roots.join(' or ')}`);
    const blocker = deny.find((d) => isWithin(p, d) && !isWithin(bh, d));
    if (blocker) throw new Error(`sandbox: own dir ${p} would reopen denied path ${blocker}`);
    return p;
  });
};

/** Build the scrubbed environment: only `passthrough` names from `source`, plus `extra`. */
export const scrubEnv = (
  passthrough: readonly string[],
  extra: Record<string, string> = {},
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> => {
  const out: Record<string, string> = {};
  const isWin = process.platform === 'win32';
  for (const name of passthrough) {
    if (isWin) {
      // Windows env names are case-insensitive.
      const key = Object.keys(source).find((k) => k.toUpperCase() === name.toUpperCase());
      if (key && source[key] !== undefined) out[name] = source[key] as string;
    } else if (source[name] !== undefined) out[name] = source[name] as string;
  }
  for (const [k, v] of Object.entries(extra)) out[k] = v;
  return out;
};
