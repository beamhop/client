/**
 * Roles (§6) as a "what can this role do" matrix: rows = actions people understand, cells = Auto | Ask |
 * Deny, derived from RoleDef (permission mode, tool allow/deny, requireApproval, canApprove…).
 */
import type { RoleDef } from '@beamhop/core';

export type Cell = 'auto' | 'ask' | 'deny';

export interface RoleAction {
  id: string;
  label: string;
  /** Tool glob families this action stands for. */
  tools?: string[];
}

export const ROLE_ACTIONS: RoleAction[] = [
  { id: 'prompt', label: 'Talk to the agent' },
  { id: 'read', label: 'Read files in mounted folders' },
  { id: 'edit', label: 'Edit files', tools: ['write', 'edit'] },
  { id: 'delete', label: 'Delete files', tools: ['delete'] },
  { id: 'bash', label: 'Run shell commands', tools: ['bash', 'shell'] },
  { id: 'web', label: 'Fetch web pages', tools: ['web_fetch'] },
  { id: 'approve', label: 'Approve other people’s requests' },
  { id: 'reconfigure', label: 'Switch model or harness' },
];

const matches = (globs: string[], tool: string) =>
  globs.some((g) => {
    const re = new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    return re.test(tool) || re.test(`${tool}_x`);
  });

export const cellFor = (r: RoleDef, a: RoleAction): Cell => {
  if (a.id === 'prompt') return r.canPrompt ? 'auto' : 'deny';
  if (!r.canPrompt) return 'deny';
  if (a.id === 'read') return 'auto';
  if (a.id === 'approve') return r.canApprove ? 'auto' : 'deny';
  if (a.id === 'reconfigure') return r.canReconfigure ? 'auto' : 'deny';
  const tools = a.tools ?? [];
  if (tools.some((t) => matches(r.tools.deny, t))) return 'deny';
  if (r.permissionMode === 'read-only' || r.permissionMode === 'plan') return 'deny';
  if (tools.some((t) => matches(r.requireApproval, t))) return 'ask';
  return r.permissionMode === 'auto' ? 'auto' : 'ask';
};

export const CELL_WORD: Record<Cell, string> = { auto: 'Auto', ask: 'Ask', deny: 'Never' };

export const DLP_WORD: Record<RoleDef['dlp'], string> = {
  block: 'Replies with secrets are blocked',
  redact: 'Secrets in replies are redacted',
  warn: 'Secrets in replies trigger a warning',
};

export const limitsOf = (r: RoleDef): string[] => {
  const out: string[] = [];
  if (r.budget.messagesPerMinute) out.push(`${r.budget.messagesPerMinute} msg/min`);
  if (r.budget.perSessionMinutes) out.push(`${r.budget.perSessionMinutes} min/session`);
  if (r.budget.dailyUsd !== undefined) out.push(`$${r.budget.dailyUsd}/day`);
  if (r.budget.dailyTokens) out.push(`${Math.round(r.budget.dailyTokens / 1000)}k tok/day`);
  return out.length ? out : ['no extra limits'];
};

// ─────────── Editing (role.define / role.delete) ───────────

/** The owner and agent roles are fixed by beamhop; every other role can be edited. */
export const LOCKED_ROLES: readonly string[] = ['owner', 'agent'];
export const isLockedRole = (name: string) => LOCKED_ROLES.includes(name);

export const MODE_WORD: Record<RoleDef['permissionMode'], string> = {
  'read-only': 'Read only',
  plan: 'Plans, never acts',
  ask: 'Asks before acting',
  auto: 'Acts without asking',
};

const yesNo = (b: boolean) => (b ? 'yes' : 'no');
const money = (v?: number) => (v === undefined ? 'no limit' : `$${v}/day`);
const perMin = (v?: number) => (v === undefined ? 'no limit' : `${v} msg/min`);

/**
 * Plain-language list of what changes between two role definitions, in the order people read the
 * role table. Empty when nothing changes.
 */
export const roleDiff = (before: RoleDef, after: RoleDef): string[] => {
  const out: string[] = [];
  const line = (what: string, a: string, b: string) => {
    if (a !== b) out.push(`${what}: ${a} → ${b}`);
  };
  line('Can talk to the agent', yesNo(before.canPrompt), yesNo(after.canPrompt));
  line('Tool use', MODE_WORD[before.permissionMode], MODE_WORD[after.permissionMode]);
  line('Sandbox profile', before.sandboxProfile, after.sandboxProfile);
  line('Can approve other people’s requests', yesNo(before.canApprove), yesNo(after.canApprove));
  line('Can switch model or harness', yesNo(before.canReconfigure), yesNo(after.canReconfigure));
  line('Secrets in replies', DLP_WORD[before.dlp], DLP_WORD[after.dlp]);
  line('Daily spend', money(before.budget.dailyUsd), money(after.budget.dailyUsd));
  line('Message rate', perMin(before.budget.messagesPerMinute), perMin(after.budget.messagesPerMinute));
  if (before.description.trim() !== after.description.trim()) out.push('Description changes');
  return out;
};

/** The `role.define` payload for a definition: every editable field (the daemon validates). */
export const definePayload = (r: RoleDef): Record<string, unknown> => ({
  name: r.name,
  description: r.description.trim(),
  canPrompt: r.canPrompt,
  permissionMode: r.permissionMode,
  sandboxProfile: r.sandboxProfile,
  canApprove: r.canApprove,
  canReconfigure: r.canReconfigure,
  dlp: r.dlp,
  budget: r.budget,
});

/** Enough of an agent's config to see where it uses a role. */
export interface RoleUser {
  config: {
    name: string;
    grants?: Record<string, string>;
    memberships?: { target: string; defaultRole: string }[];
  };
}

/**
 * Everywhere a role is in use, as the daemon checks it before `role.delete` (global grants, an
 * agent's own grants and channel memberships' default role): `fake:bob`, `fake:bob on bot`,
 * `bot on fk:dm`. Empty when the role can be deleted.
 */
export const roleUses = (
  name: string,
  grants: Record<string, string>,
  agents: readonly RoleUser[],
): string[] => {
  const out = Object.entries(grants)
    .filter(([, r]) => r === name)
    .map(([p]) => p);
  for (const a of agents) {
    for (const [p, r] of Object.entries(a.config.grants ?? {}))
      if (r === name) out.push(`${p} on ${a.config.name}`);
    for (const m of a.config.memberships ?? [])
      if (m.defaultRole === name) out.push(`${a.config.name} on ${m.target}`);
  }
  return out;
};
