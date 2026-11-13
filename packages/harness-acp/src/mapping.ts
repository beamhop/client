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
          name: u.name ?? u.kind ?? 'tool',
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

const READ_KINDS = new Set<string>(['read', 'search', 'think', 'fetch']);

/** Auto-decision by permission mode; `undefined` means "ask the owner". */
export const autoDecision = (
  mode: SessionSpec['permissionMode'],
  kind: string | null | undefined,
): { allow: boolean; reason?: string } | undefined => {
  if (mode === 'auto') return { allow: true };
  if (mode === 'read-only' || mode === 'plan') {
    return kind && READ_KINDS.has(kind) ? { allow: true } : { allow: false, reason: `denied: ${mode} mode` };
  }
  return undefined;
};
