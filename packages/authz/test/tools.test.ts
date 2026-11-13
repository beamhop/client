import { DEFAULT_ROLES, type RoleDef } from '@beamhop/core';
import { describe, expect, it } from 'vitest';
import {
  checkTool,
  checkToolDetailed,
  classifyRisk,
  classifyTool,
  globMatch,
  stricterMode,
  toolNameVariants,
} from '../src/index.ts';

const role = (name: string): RoleDef => DEFAULT_ROLES.find((r) => r.name === name)!;
const custom = (over: Partial<RoleDef>): RoleDef => ({ ...role('owner'), permissionMode: 'auto', ...over });

describe('globMatch', () => {
  it('supports * and ? and is case-insensitive by default', () => {
    expect(globMatch('bash*', 'Bash')).toBe(true);
    expect(globMatch('ba?h', 'bash')).toBe(true);
    expect(globMatch('ba?h', 'baash')).toBe(false);
    expect(globMatch('*', '')).toBe(true);
    expect(globMatch('Bash', 'bash', { caseInsensitive: false })).toBe(false);
    expect(globMatch('bash*', 'bash\nfoo')).toBe(true);
  });
  it('treats regex metacharacters literally', () => {
    expect(globMatch('a.b', 'axb')).toBe(false);
    expect(globMatch('mcp__x__(y)', 'mcp__x__(y)')).toBe(true);
    expect(globMatch('a+', 'aa')).toBe(false);
  });
  it('handles unicode', () => {
    expect(globMatch('wörk*', 'WÖRK_tool')).toBe(true);
    expect(globMatch('café', 'café')).toBe(true);
  });
});

describe('toolNameVariants / classifyTool', () => {
  it('produces snake_case and MCP-stripped variants', () => {
    expect(toolNameVariants('WebFetch')).toContain('web_fetch');
    expect(toolNameVariants('mcp__github__create_pr')).toContain('create_pr');
    expect(toolNameVariants('mcp__my_server__do_x')).toContain('do_x');
  });
  it.each([
    ['Bash', 'shell'],
    ['shell', 'shell'],
    ['local_shell', 'shell'],
    ['Write', 'write'],
    ['Edit', 'write'],
    ['MultiEdit', 'write'],
    ['apply_patch', 'write'],
    ['NotebookEdit', 'write'],
    ['delete_file', 'delete'],
    ['WebFetch', 'network'],
    ['Read', 'read'],
    ['Grep', 'read'],
    ['Glob', 'read'],
    ['WebSearch', 'read'],
    ['channel.history', 'read'],
    ['TodoWrite', 'meta'],
    ['mcp__github__create_pr', 'write'],
    ['frobnicate', 'unknown'],
  ])('%s → %s', (tool, cat) => {
    expect(classifyTool(tool)).toBe(cat);
  });
  it('prefers the ACP kind hint', () => {
    expect(classifyTool('frobnicate', 'execute')).toBe('shell');
    expect(classifyTool('Bash', 'read')).toBe('read');
    expect(classifyTool('Bash', 'other')).toBe('shell');
  });
});

describe('classifyRisk', () => {
  it('shell, deletes, network and git push are high', () => {
    expect(classifyRisk('Bash', { command: 'ls' })).toBe('high');
    expect(classifyRisk('rm')).toBe('high');
    expect(classifyRisk('WebFetch')).toBe('high');
    expect(classifyRisk('git_push')).toBe('high');
    expect(classifyRisk('mcp__git__push')).toBe('high');
  });
  it('writes and unknown are medium, reads low', () => {
    expect(classifyRisk('Write', { path: 'a' })).toBe('medium');
    expect(classifyRisk('frobnicate')).toBe('medium');
    expect(classifyRisk('Read')).toBe('low');
  });
  it('escalates unknown tools carrying dangerous commands', () => {
    expect(classifyRisk('frobnicate', { command: 'rm -rf /' })).toBe('high');
    expect(classifyRisk('frobnicate', { command: 'git push origin main' })).toBe('high');
    expect(classifyRisk('Write', { content: 'rm is a word' })).toBe('medium');
  });
  it('survives unserializable input', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(classifyRisk('frobnicate', cyclic)).toBe('medium');
  });
});

describe('checkTool', () => {
  it('owner: reads allowed, high-risk tools need approval in ask mode', () => {
    expect(checkTool({ role: role('owner'), tool: 'Read' })).toBe('allow');
    expect(checkTool({ role: role('owner'), tool: 'Write' })).toBe('allow');
    expect(checkTool({ role: role('owner'), tool: 'Bash' })).toBe('approve');
  });
  it('auto mode allows high risk unless requireApproval matches', () => {
    expect(checkTool({ role: custom({}), tool: 'Bash' })).toBe('allow');
    expect(checkTool({ role: custom({ requireApproval: ['bash'] }), tool: 'Bash' })).toBe('approve');
  });
  it('admin/user: requireApproval patterns match camelCase via snake_case', () => {
    expect(checkTool({ role: role('admin'), tool: 'WebFetch' })).toBe('approve');
    expect(checkTool({ role: role('user'), tool: 'Edit' })).toBe('approve');
    expect(checkTool({ role: role('user'), tool: 'Grep' })).toBe('allow');
  });
  it('viewer: read-only denies write/shell even without a deny pattern', () => {
    const v = { ...role('viewer'), tools: { allow: [], deny: [] } };
    expect(checkToolDetailed({ role: v, tool: 'apply_patch' }).decision).toBe('deny');
    expect(checkTool({ role: v, tool: 'frobnicate', kind: 'execute' })).toBe('deny');
    expect(checkTool({ role: v, tool: 'Read' })).toBe('allow');
  });
  it('viewer and agent deny via patterns', () => {
    expect(checkToolDetailed({ role: role('viewer'), tool: 'Bash' }).reason).toMatch(/pattern/);
    expect(checkTool({ role: role('agent'), tool: 'write_file' })).toBe('deny');
  });
  it('deny wins over allow and requireApproval', () => {
    const r = custom({ tools: { allow: ['*'], deny: ['bash'] }, requireApproval: ['bash'] });
    expect(checkTool({ role: r, tool: 'BASH' })).toBe('deny');
  });
  it('a non-empty allowlist denies everything else', () => {
    const r = custom({ tools: { allow: ['read', 'grep'], deny: [] } });
    expect(checkTool({ role: r, tool: 'Read' })).toBe('allow');
    expect(checkToolDetailed({ role: r, tool: 'Glob' }).reason).toBe('not in tool allowlist');
  });
  it('MCP tools match on the bare name', () => {
    const r = custom({ tools: { allow: [], deny: ['create_*'] } });
    expect(checkTool({ role: r, tool: 'mcp__github__create_issue' })).toBe('deny');
  });
  it('session /mode can tighten but never loosen', () => {
    expect(checkTool({ role: custom({}), tool: 'Bash', mode: 'read-only' })).toBe('deny');
    expect(checkTool({ role: custom({}), tool: 'Write', mode: 'plan' })).toBe('deny');
    expect(checkTool({ role: role('viewer'), tool: 'Write', mode: 'auto' })).toBe('deny');
    expect(stricterMode('auto', 'plan')).toBe('plan');
    expect(stricterMode('read-only', 'auto')).toBe('read-only');
    expect(stricterMode('ask', undefined)).toBe('ask');
  });
});
