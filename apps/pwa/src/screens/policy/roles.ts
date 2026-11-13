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
