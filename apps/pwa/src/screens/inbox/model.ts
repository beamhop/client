/**
 * Inbox model: pure functions from ApprovalView[] to triage vocabulary (slip groups, swipe mode,
 * quorum state, policy-rule previews, filters, spoken labels). No React here — unit-tested in
 * model.test.ts.
 */
import type { ApprovalView, PolicySuggestion, WhoamiView } from '@beamhop/core';
import { approvalTarget, RISK_LABEL } from '../../api/derive.ts';

export type ApprovalInput = {
  command?: string;
  host?: string;
  url?: string;
  /** `git.push` (session.openPr): where the branch goes (a URL, an scp-like address or a path). */
  remoteUrl?: string;
  path?: string;
  diff?: string;
  why?: string;
  channel?: string;
  thread?: string;
  rule?: string;
  firstTime?: boolean;
  principal?: string;
  message?: string;
};

export const inputOf = (a: ApprovalView): ApprovalInput => (a.input ?? {}) as ApprovalInput;

/** What kind of reach is being asked for — drives the "what" block and the policy rule. */
export type Reach = 'command' | 'network' | 'read' | 'write' | 'access' | 'deploy';

export const reachOf = (a: ApprovalView): Reach => {
  if (a.kind === 'access-request') return 'access';
  if (a.kind === 'deploy') return 'deploy';
  const i = inputOf(a);
  if (i.host || i.url) return 'network';
  if (i.path) return /edit|write/i.test(a.tool) || i.diff ? 'write' : 'read';
  return 'command';
};

/** Slips with identical (agent, action, target) collapse into one: one decision applies to all. */
export interface SlipGroup {
  key: string;
  lead: ApprovalView;
  items: ApprovalView[];
}

export const groupKey = (a: ApprovalView): string => `${a.agent}|${a.kind}|${a.tool}|${approvalTarget(a)}`;

/** Group pending approvals; order follows the first (soonest auto-deny) item of each group. */
export const groupApprovals = (list: ApprovalView[]): SlipGroup[] => {
  const map = new Map<string, SlipGroup>();
  for (const a of list) {
    // Multi-owner requests never collapse: every vote is its own act.
    const k = a.quorum && a.quorum.needed > 1 ? `q|${a.id}` : groupKey(a);
    const g = map.get(k);
    if (g) g.items.push(a);
    else map.set(k, { key: k, lead: a, items: [a] });
  }
  return [...map.values()];
};

/** Soonest auto-deny across a group (the group expires when its first item does). */
export const groupExpiry = (g: SlipGroup): number =>
  Math.min(...g.items.map((a) => new Date(a.expiresAt).getTime()));

/**
 * Risk-scaled swipe (JOURNEYS §2.2–3): only LOW tool requests commit "allow once" on a right swipe.
 * Elevated/high, access requests (widening who can talk) and deploys turn the gesture into intent:
 * the card springs back and a sheet asks how.
 */
export const swipeMode = (g: SlipGroup): 'commit' | 'intent' => {
  const r = reachOf(g.lead);
  if (r === 'access' || r === 'deploy') return 'intent';
  if (g.lead.quorum && g.lead.quorum.needed > 1) return 'intent';
  return g.lead.risk === 'low' ? 'commit' : 'intent';
};

// ─────────── N-of-M ───────────
/**
 * The names "you" go by on this daemon (`system.whoami`): principal, display name and linked person.
 * Votes and `decidedBy` carry the approver's display name or principal, so matching any of them works.
 */
export const meNames = (w?: WhoamiView): ReadonlySet<string> =>
  new Set([w?.principal, w?.displayName, w?.person].filter((x): x is string => !!x));

export const isMe = (me: ReadonlySet<string>, by?: string): boolean => !!by && me.has(by);

/** "you" for your own decisions, else who decided (or `fallback` when the daemon didn't say). */
export const whoDecided = (me: ReadonlySet<string>, by: string | undefined, fallback: string): string =>
  isMe(me, by) ? 'you' : (by ?? fallback);

export interface QuorumState {
  needed: number;
  yes: number;
  /** Named votes (allow only) plus empty seats still to fill. */
  seats: Array<{ name: string; done: boolean; you?: boolean }>;
  youVoted: boolean;
  remaining: number;
}

/** Quorum progress from the server's `quorum` / `votes`; `me` comes from `meNames(whoami)`. */
export const quorumOf = (a: ApprovalView, me: ReadonlySet<string>, you = 'you'): QuorumState | null => {
  if (!a.quorum || a.quorum.needed <= 1) return null;
  const yesVotes = (a.votes ?? []).filter((v) => v.allow);
  const youVoted = yesVotes.some((v) => isMe(me, v.by));
  const named = yesVotes.map((v) =>
    isMe(me, v.by) ? { name: you, done: true, you: true } : { name: v.by, done: true },
  );
  const empties = Math.max(0, a.quorum.needed - named.length);
  const seats = [
    ...named,
    ...Array.from({ length: empties }, (_, i) => ({
      name: i === 0 && !youVoted ? you : 'another owner',
      done: false,
      you: i === 0 && !youVoted,
    })),
  ];
  return {
    needed: a.quorum.needed,
    yes: yesVotes.length,
    seats,
    youVoted,
    remaining: empties,
  };
};

/** After you approved, an N-of-M slip moves to "Waiting on others". */
export const waitingOnOthers = (a: ApprovalView, me: ReadonlySet<string>): boolean =>
  a.status === 'pending' && !!quorumOf(a, me)?.youVoted;

// ─────────── Policy rule preview (scope sheet "Always allow") ───────────
/** `registry.npmjs.org` → `*.npmjs.org`; two-label hosts have no wider scope. */
export const wildcardFor = (host: string): string | null => {
  const labels = host.split('.').filter(Boolean);
  if (labels.length < 3) return null;
  return `*.${labels.slice(1).join('.')}`;
};

const dirOf = (path: string): string => {
  const i = path.lastIndexOf('/');
  return i > 0 ? path.slice(0, i) : path;
};

const commandPrefix = (cmd: string): string => cmd.trim().split(/\s+/).slice(0, 2).join(' ');
/** The daemon refuses prefix rules for interpreters / shell metacharacters (they run anything). */
const INTERPRETER =
  /^(.*\/)?(sh|bash|zsh|fish|dash|env|sudo|doas|su|xargs|eval|exec|python3?|node|perl|ruby|deno|bun)$/;
const prefixable = (cmd: string): boolean =>
  !/[;&|`$<>\n\r\\]/.test(cmd) && !INTERPRETER.test(cmd.trim().split(/\s+/)[0] ?? '');
/** Path rules must be absolute or under ~ (the daemon reads anything else as a host name). */
const absolute = (p: string): boolean => p.startsWith('~/') || p.startsWith('/');

export interface RuleChoice {
  id: 'exact' | 'wide';
  label: string;
  value: string;
}

/** Host of a URL, or undefined when it doesn't parse (approval input is untrusted data). */
export const hostOf = (url: string): string | undefined => {
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
};

/**
 * Requests for an action the daemon itself runs once approved (session.openPr's push): the daemon
 * refuses "for the session" and "always" for them, so only "once" is offered.
 */
export const DAEMON_ACTION_TOOLS: readonly string[] = ['git.push'];

/** The scopes an "always" rule can take for this request (Little Snitch: host vs domain). */
export const ruleChoices = (a: ApprovalView): RuleChoice[] => {
  const i = inputOf(a);
  switch (reachOf(a)) {
    case 'network': {
      const host = i.host ?? (i.url ? hostOf(i.url) : undefined) ?? approvalTarget(a);
      const wide = wildcardFor(host);
      return [
        { id: 'exact', label: host, value: host },
        ...(wide ? [{ id: 'wide' as const, label: wide, value: wide }] : []),
      ];
    }
    case 'read':
    case 'write': {
      const p = i.path ?? approvalTarget(a);
      const d = dirOf(p);
      return [
        { id: 'exact', label: 'this file', value: p },
        ...(d !== p && absolute(p) && d !== '~'
          ? [{ id: 'wide' as const, label: `${d}/`, value: `${d}/` }]
          : []),
      ];
    }
    case 'command': {
      const cmd = i.command ?? approvalTarget(a);
      const pre = commandPrefix(cmd);
      return [
        { id: 'exact', label: 'this command', value: `bash:${cmd}` },
        ...(pre !== cmd.trim() && prefixable(cmd)
          ? [{ id: 'wide' as const, label: `${pre} …`, value: `bash:${pre}` }]
          : []),
      ];
    }
    default:
      return [];
  }
};

/** The exact policy line the "always" option adds, shown as a diff before you commit. */
export const ruleLine = (a: ApprovalView, value: string): string => {
  switch (reachOf(a)) {
    case 'network':
      return `+ network.allow: ${value}`;
    case 'read':
      return `+ fs.read: ${value}`;
    case 'write':
      return `+ fs.write: ${value}`;
    case 'command':
      return `+ approvals.auto: ${value}`;
    default:
      return '';
  }
};

/** Scope sheet offers session/always only where they mean something. */
export const scopeOptions = (a: ApprovalView): Array<'once' | 'session' | 'always'> => {
  const r = reachOf(a);
  if (r === 'deploy' || r === 'access') return ['once'];
  if (a.quorum && a.quorum.needed > 1) return ['once'];
  if (DAEMON_ACTION_TOOLS.includes(a.tool)) return ['once'];
  return ['once', 'session', 'always'];
};

// ─────────── Filters ───────────
export type InboxFilter = 'all' | 'high' | `agent:${string}`;

export const filterGroups = (groups: SlipGroup[], f: InboxFilter): SlipGroup[] => {
  if (f === 'all') return groups;
  if (f === 'high') return groups.filter((g) => g.lead.risk === 'high');
  const agent = f.slice('agent:'.length);
  return groups.filter((g) => g.lead.agent === agent);
};

export const filterOptions = (
  groups: SlipGroup[],
): Array<{ id: InboxFilter; label: string; count: number }> => {
  const byAgent = new Map<string, number>();
  for (const g of groups) byAgent.set(g.lead.agent, (byAgent.get(g.lead.agent) ?? 0) + 1);
  const high = groups.filter((g) => g.lead.risk === 'high').length;
  return [
    { id: 'all', label: 'All', count: groups.length },
    ...[...byAgent.entries()].map(([name, count]) => ({
      id: `agent:${name}` as InboxFilter,
      label: name,
      count,
    })),
    ...(high > 0 ? [{ id: 'high' as InboxFilter, label: 'High risk', count: high }] : []),
  ];
};

/** Burst (>20 pending from one agent): offer stopping the agent instead of triaging. */
export const BURST_AT = 20;
export const burstAgents = (pending: ApprovalView[]): Array<{ agent: string; count: number }> => {
  const m = new Map<string, number>();
  for (const a of pending) m.set(a.agent, (m.get(a.agent) ?? 0) + 1);
  return [...m.entries()].filter(([, n]) => n > BURST_AT).map(([agent, count]) => ({ agent, count }));
};

// ─────────── Keyboard navigation ───────────
/** Next/previous key in an ordered list (j/k); clamps at the ends. */
export const step = (keys: string[], current: string | undefined, dir: 1 | -1): string | undefined => {
  if (keys.length === 0) return undefined;
  const i = current ? keys.indexOf(current) : -1;
  if (i === -1) return keys[0];
  return keys[Math.max(0, Math.min(keys.length - 1, i + dir))];
};

/** Where focus goes after a decision removes `current`: the next one, else the previous one. */
export const afterRemoval = (keys: string[], current: string): string | undefined => {
  const i = keys.indexOf(current);
  if (i === -1) return keys[0];
  return keys[i + 1] ?? keys[i - 1];
};

// ─────────── Speech ───────────
const minutesWord = (ms: number): string => {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (ms < 60_000) return 'less than a minute';
  return `${m} ${m === 1 ? 'minute' : 'minutes'}`;
};

/** "Approval from reviewer: Run a shell command, git push origin beamhop/842, high risk, auto-denies in 12 minutes". */
export const spokenLabel = (g: SlipGroup, now: number): string => {
  const a = g.lead;
  const risk = RISK_LABEL[a.risk].toLowerCase();
  const left = new Date(a.expiresAt).getTime() - now;
  const times = g.items.length > 1 ? `, ${g.items.length} identical requests` : '';
  const kind = a.kind === 'access-request' ? 'Access request for' : 'Approval from';
  return `${kind} ${a.agent}: ${a.title}, ${approvalTarget(a)}, ${risk} risk${times}, auto-denies in ${minutesWord(left)}`;
};

// ─────────── Learning-mode suggestions ───────────
/** Never offer to unlock locked paths (JOURNEYS §5 Learning 4). */
export const isLockedPath = (v: string): boolean =>
  /^~\/\.(ssh|aws|gnupg|kube|docker)(\/|$)|^~\/Library\/Keychains|^\/etc\/shadow/.test(v);

/** Credential files are better provided through the secret broker than mounted. */
export const isCredentialFile = (v: string): boolean =>
  /(^|\/)\.(npmrc|pypirc|netrc|git-credentials)$|(^|\/)\.env(\.|$)|credentials(\.json)?$/.test(v);

export const suggestionVerb = (s: PolicySuggestion): string =>
  s.kind === 'net.allow' ? 'reach' : s.kind === 'fs.read' ? 'read' : 'write';

export const suggestionChoices = (s: PolicySuggestion): RuleChoice[] => {
  if (s.kind === 'net.allow') {
    const wide = wildcardFor(s.value);
    return [
      { id: 'exact', label: s.value, value: s.value },
      ...(wide ? [{ id: 'wide' as const, label: wide, value: wide }] : []),
    ];
  }
  return [{ id: 'exact', label: s.value, value: s.value }];
};
