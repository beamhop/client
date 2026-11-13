import { readFile } from 'node:fs/promises';
import {
  type CanUseTool,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import {
  BeamhopError,
  type HarnessDetection,
  type HarnessEvent,
  type HarnessPlugin,
  type HarnessSession,
  type Logger,
  type SandboxHandle,
  type SessionSpec,
  silentLogger,
} from '@beamhop/core';
import { type CatalogEntry, findHarness, loadCatalog, sandboxTraits } from '@beamhop/harness-catalog';
import { detectHarness, type ScanOptions } from '@beamhop/harness-discovery';
import { AsyncQueue, PermissionBroker, resolveInMounts, truncate } from '@beamhop/harness-kit';
import { sandboxedClaudeSpawner } from './spawn.ts';

export { sandboxedClaudeSpawner } from './spawn.ts';

export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => Query;

export interface ClaudeHarnessOptions {
  /** Path to a `claude` executable; default: the SDK's bundled Claude Code binary. */
  pathToClaudeCodeExecutable?: string;
  log?: Logger;
  scan?: Omit<ScanOptions, 'catalog' | 'only'>;
  catalogEntry?: CatalogEntry;
  /** Override for tests. */
  queryFn?: QueryFn;
  /** Extra SDK options (merged last, except callbacks beamhop owns). */
  sdkOptions?: Partial<Options>;
}

const READ_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'NotebookRead',
  'WebSearch',
  'WebFetch',
  'TodoWrite',
]);

/** beamhop permission mode → Claude Code permission mode. */
export const claudePermissionMode = (m: SessionSpec['permissionMode']): PermissionMode =>
  m === 'auto' ? 'bypassPermissions' : m === 'plan' ? 'plan' : 'default';

type Block = { type: string; [k: string]: unknown };

/** Render the SDK's structuredPatch (Edit/Write tool results) as a unified diff. */
export const structuredPatchToDiff = (file: string, hunks: unknown): string | undefined => {
  if (!Array.isArray(hunks) || hunks.length === 0) return undefined;
  const body = hunks.map(
    (h: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }) =>
      [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines].join('\n'),
  );
  return [`--- a/${file}`, `+++ b/${file}`, ...body].join('\n');
};

const contentText = (c: unknown): string | undefined => {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    const t = c.map((b: Block) => (b.type === 'text' ? String(b.text) : '')).filter(Boolean);
    return t.length ? t.join('\n') : undefined;
  }
  return undefined;
};

export interface TurnState {
  streamedText: boolean;
  streamedThinking: boolean;
}

/** Map one SDK message to HarnessEvents. Exported for tests. */
export const mapSdkMessage = (m: SDKMessage, st: TurnState): HarnessEvent[] => {
  switch (m.type) {
    case 'stream_event': {
      const ev = m.event as { type: string; delta?: { type: string; text?: string; thinking?: string } };
      if (m.parent_tool_use_id) return [];
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
        st.streamedText = true;
        return [{ type: 'text', delta: ev.delta.text }];
      }
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'thinking_delta' && ev.delta.thinking) {
        st.streamedThinking = true;
        return [{ type: 'thinking', delta: ev.delta.thinking }];
      }
      return [];
    }
    case 'assistant': {
      if (m.parent_tool_use_id) return [];
      const out: HarnessEvent[] = [];
      for (const b of (m.message.content ?? []) as unknown as Block[]) {
        if (b.type === 'tool_use')
          out.push({ type: 'tool_call', id: String(b.id), name: String(b.name), input: b.input ?? null });
        else if (b.type === 'text' && !st.streamedText && b.text)
          out.push({ type: 'text', delta: String(b.text) });
        else if (b.type === 'thinking' && !st.streamedThinking && b.thinking)
          out.push({ type: 'thinking', delta: String(b.thinking) });
      }
      if (m.error) out.push({ type: 'error', message: `Claude API error: ${m.error}` });
      return out;
    }
    case 'user': {
      if (m.parent_tool_use_id) return [];
      const content = m.message.content;
      if (!Array.isArray(content)) return [];
      const tur = (m.tool_use_result ?? {}) as { filePath?: string; structuredPatch?: unknown };
      return (content as unknown as Block[])
        .filter((b) => b.type === 'tool_result')
        .map((b) => {
          const diff = tur.structuredPatch
            ? structuredPatchToDiff(tur.filePath ?? 'file', tur.structuredPatch)
            : undefined;
          const output = contentText(b.content);
          return {
            type: 'tool_result' as const,
            id: String(b.tool_use_id),
            ok: !b.is_error,
            ...(output ? { output: truncate(output, 20000) } : {}),
            ...(diff ? { diff } : {}),
          };
        });
    }
    case 'result': {
      const out: HarnessEvent[] = [];
      const u = m.usage as {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
      out.push({
        type: 'usage',
        inputTokens:
          (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0),
        outputTokens: u?.output_tokens ?? 0,
        costUsd: m.total_cost_usd,
      });
      if (m.subtype !== 'success') {
        out.push({ type: 'error', message: `Claude Code: ${m.subtype}` });
      } else if (m.is_error) {
        out.push({ type: 'error', message: truncate(String(m.result ?? 'error'), 500) });
      }
      out.push({
        type: 'done',
        stopReason: m.subtype === 'success' && !m.is_error ? 'end_turn' : m.subtype,
        resume: m.session_id,
      });
      return out;
    }
    case 'system':
      if (m.subtype === 'compact_boundary') return [{ type: 'progress', message: 'compacted context' }];
      return [];
    default:
      return [];
  }
};

/** Start a Claude Code session through the Agent SDK. */
export const startClaudeSession = async (
  opts: ClaudeHarnessOptions,
  spec: SessionSpec,
  sandbox: SandboxHandle,
): Promise<HarnessSession> => {
  const log = (opts.log ?? silentLogger).child({ harness: 'claude', session: spec.sessionId });
  const input = new AsyncQueue<SDKUserMessage>();
  const broker = new PermissionBroker();
  const abort = new AbortController();
  type ActiveTurn = { queue: AsyncQueue<HarnessEvent>; st: TurnState };
  let turn = null as ActiveTurn | null;
  let sessionId = spec.resume ?? '';
  let closed = false;
  let failed: Error | undefined;

  const canUseTool: CanUseTool = async (toolName, toolInput, o): Promise<PermissionResult> => {
    if (spec.permissionMode === 'read-only' && !READ_TOOLS.has(toolName)) {
      return { behavior: 'deny', message: 'denied: read-only session' };
    }
    if (spec.permissionMode === 'auto' || (spec.permissionMode === 'read-only' && READ_TOOLS.has(toolName))) {
      return { behavior: 'allow', updatedInput: toolInput };
    }
    if (broker.isAlwaysAllowed(toolName)) return { behavior: 'allow', updatedInput: toolInput };
    const t = turn;
    if (!t) return { behavior: 'deny', message: 'no active turn' };
    const id = broker.nextId('claude');
    t.queue.push({
      type: 'permission_request',
      id,
      tool: toolName,
      input: toolInput,
      title: o.title ?? `${o.displayName ?? toolName}`,
      options: ['Allow', 'Always allow', 'Deny'],
    });
    const onAbort = () => {
      try {
        broker.respond(id, { allow: false, reason: 'aborted' });
      } catch {
        // already answered
      }
    };
    o.signal.addEventListener('abort', onAbort, { once: true });
    const d = await broker.ask(id, toolName);
    o.signal.removeEventListener('abort', onAbort);
    if (!d.allow)
      return { behavior: 'deny', message: d.reason ? `denied: ${d.reason}` : 'denied by the owner' };
    return {
      behavior: 'allow',
      updatedInput: toolInput,
      ...(d.always && o.suggestions ? { updatedPermissions: o.suggestions } : {}),
    };
  };

  const mcpServers: Options['mcpServers'] = Object.fromEntries(
    spec.mcpServers.map((s) => [
      s.name,
      { type: 'stdio' as const, command: s.command, args: s.args, env: s.env ?? {} },
    ]),
  );
  const options: Options = {
    cwd: spec.cwd,
    env: { ...spec.env },
    ...(spec.model ? { model: spec.model } : {}),
    ...(spec.resume ? { resume: spec.resume } : {}),
    permissionMode: claudePermissionMode(spec.permissionMode),
    ...(spec.permissionMode === 'auto' ? { allowDangerouslySkipPermissions: true } : {}),
    mcpServers,
    includePartialMessages: true,
    settingSources: ['user', 'project', 'local'],
    additionalDirectories: spec.mounts.map((m) => m.path).filter((p) => p !== spec.cwd),
    abortController: abort,
    stderr: (d) => log.debug('claude stderr', { line: truncate(d, 500) }),
    ...opts.sdkOptions,
    canUseTool,
    spawnClaudeCodeProcess: sandboxedClaudeSpawner(sandbox, log),
    ...(opts.pathToClaudeCodeExecutable
      ? { pathToClaudeCodeExecutable: opts.pathToClaudeCodeExecutable }
      : {}),
  } as Options;

  const q = (opts.queryFn ?? (sdkQuery as QueryFn))({ prompt: input, options });

  // Pump SDK messages into the active turn.
  void (async () => {
    try {
      for await (const m of q) {
        if ('session_id' in m && typeof m.session_id === 'string' && m.session_id) sessionId = m.session_id;
        const t = turn;
        if (!t) continue;
        for (const ev of mapSdkMessage(m, t.st)) t.queue.push(ev);
        if (m.type === 'result') {
          turn = null;
          t.queue.end();
        }
      }
      failed = new BeamhopError('unavailable', 'Claude Code session ended');
    } catch (e) {
      failed = e instanceof Error ? e : new Error(String(e));
      log.warn('claude query failed', { error: failed.message });
    }
    broker.denyAll('cancelled');
    const t = turn;
    turn = null;
    if (t && !closed) {
      t.queue.push({ type: 'error', message: failed?.message ?? 'Claude Code exited' });
      t.queue.push({ type: 'done', stopReason: 'error', resume: sessionId || undefined });
      t.queue.end();
    }
  })();

  return {
    get id() {
      return sessionId || spec.sessionId;
    },
    prompt(text, attachments = []) {
      if (closed || failed)
        throw new BeamhopError(
          'unavailable',
          `Claude Code is not running${failed ? `: ${failed.message}` : ''}`,
        );
      if (turn) throw new BeamhopError('conflict', 'a prompt is already running in this session');
      const t: ActiveTurn = {
        queue: new AsyncQueue<HarnessEvent>(),
        st: { streamedText: false, streamedThinking: false },
      };
      turn = t;
      void (async () => {
        try {
          const content: Block[] = [{ type: 'text', text }];
          for (const a of attachments) {
            const p = resolveInMounts(a.path, spec.mounts, 'read', {
              cwd: spec.cwd,
              deny: sandbox.policy.fs.deny,
            });
            if (a.mime.startsWith('image/')) {
              content.push({
                type: 'image',
                source: { type: 'base64', media_type: a.mime, data: (await readFile(p)).toString('base64') },
              });
            } else content.push({ type: 'text', text: `Attached file: ${p} (${a.mime})` });
          }
          input.push({
            type: 'user',
            message: { role: 'user', content },
            parent_tool_use_id: null,
          } as unknown as SDKUserMessage);
        } catch (e) {
          if (turn === t) {
            turn = null;
            t.queue.push({ type: 'error', message: (e as Error).message });
            t.queue.push({ type: 'done', stopReason: 'error', resume: sessionId || undefined });
            t.queue.end();
          }
        }
      })();
      return t.queue;
    },
    async respondPermission(id, decision) {
      broker.respond(id, decision);
    },
    async cancel() {
      if (!turn) return;
      broker.denyAll('cancelled');
      await q.interrupt().catch((e) => log.debug('interrupt failed', { error: (e as Error).message }));
    },
    async close() {
      if (closed) return;
      closed = true;
      broker.denyAll('cancelled');
      const t = turn;
      turn = null;
      if (t) {
        t.queue.push({ type: 'done', stopReason: 'cancelled', resume: sessionId || undefined });
        t.queue.end();
      }
      input.end();
      q.close();
    },
  };
};

/** Claude Code harness plugin (Agent SDK). */
export const claudeHarness = (opts: ClaudeHarnessOptions = {}): HarnessPlugin => {
  const entry = opts.catalogEntry ?? findHarness(loadCatalog(), 'claude')!;
  return {
    id: 'claude',
    displayName: entry.displayName,
    ...sandboxTraits(entry),
    async detect(): Promise<HarnessDetection | null> {
      const d = await detectHarness(entry, opts.scan);
      return d.status === 'not-installed' ? null : d;
    },
    start: (spec, sandbox) => startClaudeSession(opts, spec, sandbox),
  };
};
