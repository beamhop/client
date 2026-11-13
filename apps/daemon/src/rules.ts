/**
 * "Always allow" rules from approval cards and widened policy suggestions. Everything here is
 * strict on purpose: a rule may only ever cover the request it was created from (or a narrow,
 * explicit widening of it), never an always-denied path, never a bare wildcard and never a shell
 * interpreter prefix.
 */
import { homedir } from 'node:os';
import { isAbsolute, normalize, resolve, sep } from 'node:path';
import { classifyTool, toolNameVariants } from '@beamhop/authz';
import {
  type AgentConfig,
  ALWAYS_DENY_READ,
  type ApprovalRule,
  BeamhopError,
  expandHome,
} from '@beamhop/core';

const bad = (msg: string): never => {
  throw new BeamhopError('invalid_input', msg);
};

/** Shell control characters: a prefix rule never matches a command containing any of them. */
const SHELL_META = /[;&|`$<>\n\r\\]|\$\(/;
/** First words that would turn a prefix into "run anything". */
const INTERPRETERS = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'dash',
  'ksh',
  'pwsh',
  'powershell',
  'cmd',
  'cmd.exe',
  'env',
  'sudo',
  'doas',
  'su',
  'xargs',
  'eval',
  'exec',
  'nohup',
  'time',
  'timeout',
  'nice',
  'command',
  'builtin',
  'python',
  'python3',
  'node',
  'perl',
  'ruby',
  'deno',
  'bun',
  'php',
  'lua',
  'osascript',
]);

const HOST_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export interface RequestTarget {
  command?: string;
  host?: string;
  path?: string;
}

/** What a tool request touches: its shell command, network host or file path. */
export const targetOf = (input: unknown): RequestTarget => {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const out: RequestTarget = {};
  if (typeof i.command === 'string') out.command = i.command.trim();
  else if (Array.isArray(i.command) && i.command.every((x) => typeof x === 'string'))
    out.command = (i.command as string[]).join(' ').trim();
  const url = typeof i.url === 'string' ? i.url : undefined;
  if (typeof i.host === 'string') out.host = i.host.toLowerCase();
  else if (url) {
    try {
      out.host = new URL(url).hostname.toLowerCase();
    } catch {
      /* not a URL */
    }
  }
  for (const k of ['file_path', 'path', 'filePath', 'notebook_path']) {
    const v = i[k];
    if (typeof v === 'string' && v) {
      out.path = v;
      break;
    }
  }
  return out;
};

const words = (s: string): string[] => s.trim().split(/\s+/).filter(Boolean);
const caseFold = (p: string) =>
  process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p;
export const within = (p: string, root: string): boolean => {
  const a = caseFold(p);
  const r = caseFold(root);
  return a === r || a.startsWith(r.endsWith(sep) ? r : r + sep);
};

/** Absolute, normalized form of a `~`/absolute path (relative paths are refused). */
export const absPath = (p: string): string => {
  if (!p || p.includes('\0')) return bad('invalid path');
  const x = p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? expandHome(p) : p;
  if (!isAbsolute(x)) return bad('paths must be absolute or start with ~/');
  const n = normalize(resolve(x));
  return n.length > 1 && n.endsWith(sep) && !/^[A-Za-z]:\\$/.test(n) ? n.slice(0, -1) : n;
};

/** ALWAYS_DENY_READ, expanded. */
export const alwaysDenied = (): string[] => ALWAYS_DENY_READ.map((d) => normalize(expandHome(d)));

/** True when `p` is an always-denied path or inside one. */
export const isDenied = (p: string): boolean => alwaysDenied().some((d) => within(p, d));

/** True when `p` is an always-denied path, inside one, or contains one. */
export const touchesDenied = (p: string): boolean => alwaysDenied().some((d) => within(p, d) || within(d, p));

/** A path rule/suggestion may never be the filesystem root or the whole home directory. */
const assertSafeDir = (p: string) => {
  const home = normalize(homedir());
  if (p === normalize(resolve(sep)) || /^[A-Za-z]:\\?$/.test(p) || caseFold(p) === caseFold(home))
    bad('that path is too broad');
  if (touchesDenied(p)) bad('that path is always denied (credentials, keys, browser profiles)');
};

/** Normalize a host pattern; refuses bare `*`, `*.tld`, IPs with wildcards and localhost. */
export const normalizeHostPattern = (raw: string): string => {
  const h = raw.trim().toLowerCase().replace(/\.$/, '');
  if (!HOST_RE.test(h)) return bad(`"${raw}" is not a host name or *.domain`);
  if (h.startsWith('*.') && h.slice(2).split('.').length < 2) bad('a wildcard needs at least two labels');
  if (h === 'localhost' || h.endsWith('.localhost')) bad('loopback hosts cannot be allowed');
  return h;
};

export const hostMatches = (pattern: string, host: string): boolean => {
  const h = host.toLowerCase();
  if (pattern.startsWith('*.')) {
    const base = pattern.slice(2);
    return h === base || h.endsWith(`.${base}`);
  }
  return h === pattern;
};

/** Validate a command prefix (or exact command) against the request it comes from. */
const commandRule = (value: string, request: string | undefined, exact: boolean): string => {
  const v = value.trim().replace(/\s+/g, ' ');
  if (!v) return bad('empty command rule');
  if (request === undefined) return bad('this request has no command');
  const req = request.trim().replace(/\s+/g, ' ');
  if (exact) {
    if (v !== req) bad('an exact command rule must equal the requested command');
    return v;
  }
  if (SHELL_META.test(v)) bad('a command prefix cannot contain shell control characters');
  const vw = words(v);
  const rw = words(req);
  if (vw.length > rw.length || vw.some((w, i) => w !== rw[i]))
    bad('the command prefix must be a prefix of the requested command');
  const first = (vw[0] ?? '').replace(/^.*[/\\]/, '');
  if (INTERPRETERS.has(first)) bad(`"${first}" runs arbitrary code; allow the exact command instead`);
  return v;
};

export interface RuleRequest {
  tool: string;
  input: unknown;
  role?: string;
}

/**
 * Build the rule for an "always" decision. `raw` is the client's choice (`bash:<prefix>`, a host or
 * `*.domain`, a file or `dir/`), or undefined for the exact request.
 */
export const buildRule = (
  req: RuleRequest,
  raw: string | undefined,
  meta: { at: string; by?: string },
): ApprovalRule => {
  const t = targetOf(req.input);
  const base = {
    tool: req.tool,
    createdAt: meta.at,
    ...(meta.by ? { createdBy: meta.by } : {}),
    ...(req.role ? { role: req.role } : {}),
  };
  const category = classifyTool(req.tool);
  if (raw === undefined) {
    if (t.command !== undefined) return { ...base, kind: 'command', value: t.command, exact: true };
    if (t.host) return { ...base, kind: 'host', value: normalizeHostPattern(t.host) };
    if (t.path) {
      const p = absPath(t.path);
      if (touchesDenied(p)) bad('that path is always denied (credentials, keys, browser profiles)');
      return { ...base, kind: 'path', value: p, exact: true };
    }
    if (category === 'shell' || category === 'network')
      return bad('this tool can only be allowed per command or host');
    return { ...base, kind: 'tool', value: req.tool };
  }
  const r = raw.trim();
  if (r.length > 500) return bad('rule too long');
  const cmd = /^(bash|sh|shell|cmd):(.*)$/s.exec(r);
  if (cmd) {
    const v = cmd[2]!.trim();
    const exact = t.command !== undefined && v.replace(/\s+/g, ' ') === t.command.replace(/\s+/g, ' ');
    return { ...base, kind: 'command', value: commandRule(v, t.command, exact), ...(exact ? { exact } : {}) };
  }
  if (r.startsWith('~') || isAbsolute(r)) {
    if (!t.path) return bad('this request has no file path');
    const dir = r.endsWith('/') || r.endsWith('\\');
    const p = absPath(r);
    const req = absPath(t.path);
    if (dir) {
      assertSafeDir(p);
      if (!within(req, p)) bad('the directory must contain the requested path');
      return { ...base, kind: 'path', value: p };
    }
    if (p !== req) bad('a file rule must name the requested file');
    if (touchesDenied(p)) bad('that path is always denied (credentials, keys, browser profiles)');
    return { ...base, kind: 'path', value: p, exact: true };
  }
  if (r === req.tool) {
    if (category === 'shell' || category === 'network')
      return bad('this tool can only be allowed per command or host');
    return { ...base, kind: 'tool', value: req.tool };
  }
  const host = normalizeHostPattern(r);
  if (!t.host) return bad('this request has no network host');
  if (!hostMatches(host, t.host)) bad('the host rule must cover the requested host');
  return { ...base, kind: 'host', value: host };
};

/** Does a persisted rule cover this tool request? */
export const ruleMatches = (rule: ApprovalRule, req: RuleRequest): boolean => {
  if (rule.role && req.role !== rule.role) return false;
  const variants = new Set(toolNameVariants(req.tool).map((v) => v.toLowerCase()));
  if (!toolNameVariants(rule.tool).some((v) => variants.has(v.toLowerCase()))) return false;
  const t = targetOf(req.input);
  switch (rule.kind) {
    case 'tool':
      return true;
    case 'command': {
      if (t.command === undefined) return false;
      const c = t.command.replace(/\s+/g, ' ');
      if (rule.exact) return c === rule.value;
      if (SHELL_META.test(c)) return false;
      const rw = words(rule.value);
      const cw = words(c);
      return rw.length > 0 && rw.length <= cw.length && rw.every((w, i) => w === cw[i]);
    }
    case 'host':
      return !!t.host && hostMatches(rule.value, t.host);
    case 'path': {
      if (!t.path) return false;
      let p: string;
      try {
        p = absPath(t.path);
      } catch {
        return false;
      }
      if (touchesDenied(p)) return false;
      return rule.exact ? p === rule.value : within(p, rule.value);
    }
  }
};

/**
 * Validate a client-chosen value for a sandbox policy suggestion (`policy.applySuggestion` with
 * `value`): a host may widen to `*.domain` of the suggested host; a path may widen to a parent dir.
 */
export const suggestionValue = (
  kind: 'net.allow' | 'fs.read' | 'fs.write',
  suggested: string,
  raw: string,
) => {
  if (kind === 'net.allow') {
    const v = normalizeHostPattern(raw);
    const host = suggested.toLowerCase().replace(/^\*\./, '');
    if (!hostMatches(v, host) && v !== suggested.toLowerCase())
      bad('the value must cover the suggested host');
    return v;
  }
  const v = absPath(raw);
  const s = absPath(suggested);
  if (!within(s, v)) bad('the value must be the suggested path or a parent directory');
  if (v !== s) assertSafeDir(v);
  if (touchesDenied(v)) bad('that path is always denied (credentials, keys, browser profiles)');
  return v;
};

/** Add one value to an agent's sandbox policy list (`net.allow`, `fs.read`, `fs.write`). */
export const withPolicyValue = (
  a: AgentConfig,
  kind: 'net.allow' | 'fs.read' | 'fs.write',
  value: string,
): AgentConfig => {
  const pol = (a.sandbox.policy ?? {}) as Record<string, Record<string, unknown>>;
  const [sect, key] =
    kind === 'net.allow' ? ['net', 'allow'] : kind === 'fs.read' ? ['fs', 'read'] : ['fs', 'write'];
  const cur = pol[sect] ?? {};
  const list = [...new Set([...((cur[key] as string[] | undefined) ?? []), value])];
  return { ...a, sandbox: { ...a.sandbox, policy: { ...pol, [sect]: { ...cur, [key]: list } } as never } };
};

const sameRule = (x: ApprovalRule, y: ApprovalRule) =>
  x.kind === y.kind &&
  x.tool === y.tool &&
  x.value === y.value &&
  x.role === y.role &&
  !!x.exact === !!y.exact;

/** Persist a rule (deduplicated); host rules also join the sandbox net allowlist. */
export const withRule = (a: AgentConfig, rule: ApprovalRule): AgentConfig => {
  const next = { ...a, approvalRules: [...(a.approvalRules ?? []).filter((r) => !sameRule(r, rule)), rule] };
  return rule.kind === 'host' ? withPolicyValue(next, 'net.allow', rule.value) : next;
};

/** Clean a free-text reason from a client: no control characters, bounded. */
export const cleanReason = (r: string | undefined): string | undefined => {
  if (r === undefined) return undefined;
  const v = Array.from(r, (ch) => {
    const c = ch.codePointAt(0) ?? 0;
    return (c < 0x20 && c !== 0x0a) || c === 0x7f ? ' ' : ch;
  })
    .join('')
    .trim()
    .slice(0, 500);
  return v || undefined;
};
