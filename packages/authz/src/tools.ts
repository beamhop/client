import type { PermissionMode, RoleDef } from '@beamhop/core';
import { anyGlobMatch } from './glob.ts';

export type ToolCategory = 'shell' | 'write' | 'delete' | 'network' | 'read' | 'meta' | 'unknown';
export type Risk = 'low' | 'medium' | 'high';
export type ToolDecision = 'allow' | 'deny' | 'approve';

/** ACP-style tool kinds a harness may report alongside the name. */
export type ToolKindHint =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other';

/**
 * Name variants used for glob matching: raw lower-case, snake_case of camelCase ("WebFetch" → "web_fetch"),
 * and the bare tool name with an MCP prefix stripped ("mcp__github__create_pr" → "create_pr").
 */
export const toolNameVariants = (tool: string): string[] => {
  const raw = tool.trim().normalize('NFC');
  const out = new Set<string>([raw.toLowerCase()]);
  const snake = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s.-]+/g, '_')
    .toLowerCase();
  out.add(snake);
  for (const v of [...out]) {
    const m = /^mcp__[^_]+(?:_[^_]+)*?__(.+)$/.exec(v);
    if (m?.[1]) out.add(m[1]);
  }
  return [...out];
};

const CATEGORY_RULES: [ToolCategory, RegExp][] = [
  ['meta', /^(todo_?(write|read)|think|task|exit_plan_mode|switch_mode)$/],
  ['shell', /(^|_)(bash|shell|sh|exec|execute|terminal|run_command|command|powershell|cmd|process|kill_shell)($|_)/],
  ['delete', /(^|_)(delete|remove|rm|unlink|rmdir|trash)($|_)/],
  ['network', /(^|_)(web_?fetch|fetch|http|curl|wget|download|upload|request|browse|navigate)($|_)/],
  [
    'write',
    /(^|_)(write|edit|multi_?edit|notebook_?edit|apply_?patch|patch|create|move|rename|mkdir|str_replace|replace|insert|update|commit|push|merge)($|_)/,
  ],
  ['read', /(^|_)(read|grep|glob|ls|list|search|view|cat|find|get|stat|history|members|web_search|status)($|_)/],
];

const KIND_CATEGORY: Record<ToolKindHint, ToolCategory> = {
  read: 'read',
  search: 'read',
  edit: 'write',
  move: 'write',
  delete: 'delete',
  execute: 'shell',
  fetch: 'network',
  think: 'meta',
  switch_mode: 'meta',
  other: 'unknown',
};

/** Classify a tool by name (and optional ACP kind hint). */
export const classifyTool = (tool: string, kind?: ToolKindHint): ToolCategory => {
  if (kind && kind !== 'other') return KIND_CATEGORY[kind];
  const variants = toolNameVariants(tool);
  for (const [cat, re] of CATEGORY_RULES) if (variants.some((v) => re.test(v))) return cat;
  return 'unknown';
};

const DANGEROUS_SHELL =
  /\b(rm|rmdir|dd|mkfs|shred|chmod|chown|sudo|su|curl|wget|nc|ncat|netcat|ssh|scp|rsync|ftp|telnet)\b|git\s+(push|reset\s+--hard|clean)|>\s*\/dev\//;

const inputText = (input: unknown): string => {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input);
  } catch {
    return '';
  }
};

/**
 * Risk of a tool call (§7A approvals): high for shell, deletes, network and git push;
 * medium for writes and unknown tools; low for reads.
 */
export const classifyRisk = (tool: string, input?: unknown, kind?: ToolKindHint): Risk => {
  const cat = classifyTool(tool, kind);
  if (cat === 'shell' || cat === 'delete' || cat === 'network') return 'high';
  const text = inputText(input);
  if (DANGEROUS_SHELL.test(text) && /\b(command|cmd|script)\b/i.test(text)) return 'high';
  if (toolNameVariants(tool).some((v) => /(^|_)push($|_)/.test(v))) return 'high';
  if (cat === 'write' || cat === 'unknown') return 'medium';
  return 'low';
};

/** Tool categories each permission mode refuses outright. */
const MODE_DENIES: Record<PermissionMode, ToolCategory[]> = {
  'read-only': ['shell', 'write', 'delete'],
  plan: ['shell', 'write', 'delete'],
  ask: [],
  auto: [],
};

export interface CheckToolInput {
  role: Pick<RoleDef, 'tools' | 'requireApproval' | 'permissionMode'>;
  tool: string;
  input?: unknown;
  kind?: ToolKindHint;
  /** Session override from `/mode`; can only tighten the role's mode, never loosen it. */
  mode?: PermissionMode;
}

export interface ToolCheck {
  decision: ToolDecision;
  reason: string;
  risk: Risk;
  category: ToolCategory;
}

const MODE_RANK: Record<PermissionMode, number> = { 'read-only': 0, plan: 1, ask: 2, auto: 3 };

/** The stricter of two permission modes. */
export const stricterMode = (a: PermissionMode, b: PermissionMode | undefined): PermissionMode =>
  b === undefined ? a : MODE_RANK[b] < MODE_RANK[a] ? b : a;

export const modeRank = (m: PermissionMode): number => MODE_RANK[m];

/**
 * Decide whether a role may use a tool.
 * Order: deny patterns (deny wins) → allowlist → mode restrictions → requireApproval → `ask` mode on high risk.
 */
export const checkToolDetailed = ({ role, tool, input, kind, mode }: CheckToolInput): ToolCheck => {
  const variants = toolNameVariants(tool);
  const category = classifyTool(tool, kind);
  const risk = classifyRisk(tool, input, kind);
  const base = { risk, category };
  const deny = anyGlobMatch(role.tools.deny, variants);
  if (deny) return { ...base, decision: 'deny', reason: `denied by pattern "${deny}"` };
  if (role.tools.allow.length > 0 && !anyGlobMatch(role.tools.allow, variants))
    return { ...base, decision: 'deny', reason: 'not in tool allowlist' };
  const effective = stricterMode(role.permissionMode, mode);
  if (MODE_DENIES[effective].includes(category))
    return { ...base, decision: 'deny', reason: `${category} tools are not allowed in ${effective} mode` };
  const appr = anyGlobMatch(role.requireApproval, variants);
  if (appr) return { ...base, decision: 'approve', reason: `requires approval ("${appr}")` };
  if (effective === 'ask' && risk === 'high')
    return { ...base, decision: 'approve', reason: 'high-risk tool in ask mode' };
  return { ...base, decision: 'allow', reason: 'allowed' };
};

export const checkTool = (input: CheckToolInput): ToolDecision => checkToolDetailed(input).decision;
