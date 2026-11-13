import type * as acp from '@agentclientprotocol/sdk';
import type { HarnessEvent, SessionSpec } from '@beamhop/core';

/** Render a minimal unified diff (whole-file replacement hunk) for an ACP `diff` content item. */
export const renderDiff = (file: string, oldText: string | null | undefined, newText: string): string => {
  const oldLines = oldText ? oldText.split('\n') : [];
  const newLines = newText.split('\n');
  const head = oldText == null ? `--- /dev/null\n+++ b/${file}` : `--- a/${file}\n+++ b/${file}`;
  const hunk = `@@ -${oldLines.length ? 1 : 0},${oldLines.length} +${newLines.length ? 1 : 0},${newLines.length} @@`;
  return [head, hunk, ...oldLines.map((l) => `-${l}`), ...newLines.map((l) => `+${l}`)].join('\n');
};

const blockText = (b: acp.ContentBlock): string | undefined => {
  switch (b.type) {
    case 'text':
      return b.text;
    case 'resource_link':
      return `[${b.title ?? b.name}](${b.uri})`;
    case 'resource':
      return 'text' in b.resource ? b.resource.text : `[resource ${b.resource.uri}]`;
    case 'image':
      return '[image]';
    case 'audio':
      return '[audio]';
    default:
      return undefined;
  }
};

const toolOutput = (content: acp.ToolCallContent[] | null | undefined, rawOutput: unknown) => {
  const texts: string[] = [];
  const diffs: string[] = [];
  for (const c of content ?? []) {
    if (c.type === 'content') {
      const t = blockText(c.content);
      if (t) texts.push(t);
    } else if (c.type === 'diff') diffs.push(renderDiff(c.path, c.oldText, c.newText));
    else if (c.type === 'terminal') texts.push(`[terminal ${c.terminalId}]`);
  }
  if (!texts.length && rawOutput !== undefined && rawOutput !== null) {
    texts.push(typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput));
  }
  return {
    output: texts.length ? texts.join('\n') : undefined,
    diff: diffs.length ? diffs.join('\n') : undefined,
  };
};

const planText = (p: acp.Plan): string =>
  `Plan:\n${p.entries
    .map((e) => `- [${e.status === 'completed' ? 'x' : e.status === 'in_progress' ? '~' : ' '}] ${e.content}`)
    .join('\n')}`;

/** Stable beamhop tool names for ACP tool kinds (ACP tool calls usually carry no `name`). */
export const ACP_KIND_TOOL: Record<string, string> = {
  execute: 'bash',
  edit: 'edit',
  delete: 'delete',
  move: 'move',
  fetch: 'web_fetch',
  read: 'read',
  search: 'search',
  think: 'think',
  switch_mode: 'switch_mode',
};

const WRITE_KINDS = new Set(['edit', 'delete', 'move']);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
const field = (input: unknown, ...keys: string[]): string | undefined => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const o = input as Record<string, unknown>;
  for (const k of keys) {
    const v =
      str(o[k]) ??
      (Array.isArray(o[k]) && o[k].every((x) => typeof x === 'string')
        ? (o[k] as string[]).join(' ')
        : undefined);
    if (v) return v;
  }
  return undefined;
};

/** Title verbs → tool names, for `other` / missing kinds. */
const TITLE_RULES: [RegExp, string][] = [
  [/^\s*(\$|run|running|exec|execute|executing|bash|shell|terminal|command)\b/i, 'bash'],
  [/^\s*(delete|deleting|remove|removing|rm)\b/i, 'delete'],
  [/^\s*(move|moving|rename|renaming|mv)\b/i, 'move'],
  [
    /^\s*(write|writing|edit|editing|patch|patching|apply|create|creating|update|updating|replace)\b/i,
    'edit',
  ],
  [/^\s*(fetch|fetching|download|downloading|curl|wget|http|get https?:)/i, 'web_fetch'],
  [/^\s*(search|searching|grep|find|finding|glob|list|listing|ls)\b/i, 'search'],
  [/^\s*(read|reading|view|viewing|cat|open|opening)\b/i, 'read'],
  [/^\s*(think|thinking|plan|planning)\b/i, 'think'],
];

/**
 * Derive a stable tool name for approval checks (`checkTool` deny/approve patterns) from an ACP tool
 * call. ACP has `kind` + `title` + `rawInput` but usually no programmatic name, so every harness
 * would otherwise report `other`. Order:
 *
 * 1. A shell command in `rawInput` (`command`/`cmd`) means `bash` unless the kind is a write
 *    (`edit`/`delete`/`move`, e.g. str_replace-style editors): a call must not dodge a `bash` deny
 *    rule, or read-only mode, by labelling a command `read`/`search`/`fetch`/`think`/`other`.
 * 2. A known `kind` (`execute` → `bash`, `edit` → `edit`, `fetch` → `web_fetch`, …).
 * 3. The agent-supplied `name`, when present.
 * 4. `rawInput` shape (url → `web_fetch`; path + content/edits → `edit`; pattern/query → `search`;
 *    path → `read`), then the title verb.
 * 5. `other`.
 *
 * The title is kept separately for display.
 */
export const deriveToolName = (tc: {
  name?: string | null;
  kind?: string | null;
  title?: string | null;
  rawInput?: unknown;
}): string => {
  const input = tc.rawInput;
  const kind = tc.kind ?? undefined;
  if (field(input, 'command', 'cmd') && !WRITE_KINDS.has(kind ?? '')) return 'bash';
  if (kind && ACP_KIND_TOOL[kind]) return ACP_KIND_TOOL[kind] as string;
  const name = str(tc.name);
  if (name) return name.trim();
  if (field(input, 'url', 'uri')) return 'web_fetch';
  const path = field(input, 'path', 'file_path', 'filePath', 'file', 'filename');
  if (path && field(input, 'content', 'new_string', 'newText', 'new_text', 'patch', 'diff', 'edits'))
    return 'edit';
  if (field(input, 'pattern', 'query', 'glob', 'regex')) return 'search';
  for (const [re, tool] of TITLE_RULES) if (re.test(tc.title ?? '')) return tool;
  if (path) return 'read';
  return 'other';
};

/** Map one ACP `session/update` to zero or more HarnessEvents. */
export const mapSessionUpdate = (u: acp.SessionUpdate): HarnessEvent[] => {
  switch (u.sessionUpdate) {
    case 'agent_message_chunk': {
      const t = blockText(u.content);
      return t ? [{ type: 'text', delta: t }] : [];
    }
    case 'agent_thought_chunk': {
      const t = blockText(u.content);
      return t ? [{ type: 'thinking', delta: t }] : [];
    }
    case 'tool_call': {
      const ev: HarnessEvent[] = [
        {
          type: 'tool_call',
          id: u.toolCallId,
          name: deriveToolName(u),
          input: u.rawInput ?? null,
          title: u.title,
        },
      ];
      if (u.status === 'completed' || u.status === 'failed') {
        ev.push({
          type: 'tool_result',
          id: u.toolCallId,
          ok: u.status === 'completed',
          ...toolOutput(u.content, u.rawOutput),
        });
      }
      return ev;
    }
    case 'tool_call_update':
      if (u.status === 'completed' || u.status === 'failed') {
        return [
          {
            type: 'tool_result',
            id: u.toolCallId,
            ok: u.status === 'completed',
            ...toolOutput(u.content, u.rawOutput),
          },
        ];
      }
      return [];
    case 'plan':
      return [{ type: 'progress', message: planText(u) }];
    case 'notice':
      return [{ type: 'progress', message: u.description ? `${u.title}: ${u.description}` : u.title }];
    default:
      return [];
  }
};

/** SessionSpec MCP servers → ACP stdio server descriptors. */
export const toAcpMcpServers = (servers: SessionSpec['mcpServers']): acp.McpServer[] =>
  servers.map((s) => ({
    name: s.name,
    command: s.command,
    args: [...s.args],
    env: Object.entries(s.env ?? {}).map(([name, value]) => ({ name, value })),
  }));

/** Pick the ACP permission option that matches a beamhop decision. */
export const chooseOption = (
  options: acp.PermissionOption[],
  decision: { allow: boolean; always?: boolean },
): acp.PermissionOption | undefined => {
  const order: acp.PermissionOptionKind[] = decision.allow
    ? decision.always
      ? ['allow_always', 'allow_once']
      : ['allow_once', 'allow_always']
    : decision.always
      ? ['reject_always', 'reject_once']
      : ['reject_once', 'reject_always'];
  for (const k of order) {
    const o = options.find((x) => x.kind === k);
    if (o) return o;
  }
  return undefined;
};

const READ_TOOLS = new Set<string>(['read', 'search', 'think', 'web_fetch']);

/**
 * Auto-decision by permission mode; `undefined` means "ask the owner". `tool` is the derived tool
 * name (`deriveToolName`), so a call whose input carries a shell command is never auto-allowed in
 * read-only/plan mode even if its kind claims `read`.
 */
export const autoDecision = (
  mode: SessionSpec['permissionMode'],
  tool: string | null | undefined,
): { allow: boolean; reason?: string } | undefined => {
  if (mode === 'auto') return { allow: true };
  if (mode === 'read-only' || mode === 'plan') {
    return tool && READ_TOOLS.has(tool) ? { allow: true } : { allow: false, reason: `denied: ${mode} mode` };
  }
  return undefined;
};
