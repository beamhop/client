import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  BeamhopError,
  explicitModel,
  type HarnessEvent,
  type HarnessSession,
  type SandboxHandle,
  type SessionSpec,
  silentLogger,
} from '@beamhop/core';
import {
  AsyncQueue,
  captureStderr,
  readJsonLines,
  resolveInMounts,
  spawnInSandbox,
  terminate,
  truncate,
} from '@beamhop/harness-kit';
import { type CodexOptions, codexPolicy } from './app-server.ts';
import { mcpConfigArgs } from './toml.ts';

/** Build `codex exec --json` args for one turn. Exported for tests. */
export const execArgs = (
  spec: SessionSpec,
  prompt: string,
  threadId: string | undefined,
  images: string[],
  opts: CodexOptions = {},
) => {
  const { sandbox } = codexPolicy(spec.permissionMode);
  const args = [
    ...(opts.extraArgs ?? []),
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--sandbox',
    opts.codexSandbox ?? sandbox,
    '--cd',
    spec.cwd,
    ...mcpConfigArgs(spec.mcpServers),
  ];
  const model = explicitModel(spec.model);
  if (model) args.push('--model', model);
  for (const i of images) args.push(`--image=${i}`); // '=' form: --image is variadic
  if (threadId) args.push('resume', threadId);
  args.push('--', prompt);
  return args;
};

type ExecItem = { id: string; type: string; [k: string]: unknown };

/** Map one `codex exec --json` event. Exported for tests. */
export const mapExecEvent = (ev: Record<string, unknown>): HarnessEvent[] => {
  const item = ev.item as ExecItem | undefined;
  switch (ev.type) {
    case 'item.started':
      if (!item) return [];
      if (item.type === 'command_execution') {
        return [
          {
            type: 'tool_call',
            id: item.id,
            name: 'shell',
            input: { command: item.command },
            title: String(item.command ?? ''),
          },
        ];
      }
      if (item.type === 'mcp_tool_call') {
        return [
          {
            type: 'tool_call',
            id: item.id,
            name: `${item.server}.${item.tool}`,
            input: item.arguments ?? null,
          },
        ];
      }
      return [];
    case 'item.completed':
      if (!item) return [];
      switch (item.type) {
        case 'agent_message':
        case 'assistant_message':
          return item.text ? [{ type: 'text', delta: String(item.text) }] : [];
        case 'reasoning':
          return item.text ? [{ type: 'thinking', delta: String(item.text) }] : [];
        case 'command_execution':
          return [
            {
              type: 'tool_result',
              id: item.id,
              ok: item.status === 'completed' && (item.exit_code === 0 || item.exit_code == null),
              output:
                typeof item.aggregated_output === 'string'
                  ? truncate(item.aggregated_output, 20000)
                  : undefined,
            },
          ];
        case 'file_change': {
          const changes = (item.changes as { path: string; kind: string }[] | undefined) ?? [];
          return [
            {
              type: 'tool_call',
              id: item.id,
              name: 'apply_patch',
              input: { files: changes },
              title: `Edit ${changes.map((c) => c.path).join(', ')}`,
            },
            { type: 'tool_result', id: item.id, ok: item.status === 'completed' },
          ];
        }
        case 'mcp_tool_call':
          return [{ type: 'tool_result', id: item.id, ok: item.status === 'completed' }];
        case 'todo_list': {
          const items = (item.items as { text: string; completed: boolean }[] | undefined) ?? [];
          return [
            {
              type: 'progress',
              message: `Plan:\n${items.map((i) => `- [${i.completed ? 'x' : ' '}] ${i.text}`).join('\n')}`,
            },
          ];
        }
        case 'error':
          return [{ type: 'error', message: String(item.message ?? 'error') }];
        default:
          return [];
      }
    case 'turn.completed': {
      const u = ev.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      return u
        ? [{ type: 'usage', inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0 }]
        : [];
    }
    case 'turn.failed':
      return [
        { type: 'error', message: String((ev.error as { message?: string })?.message ?? 'turn failed') },
      ];
    case 'error':
      return [{ type: 'error', message: String(ev.message ?? 'error') }];
    default:
      return [];
  }
};

/**
 * Fallback: one `codex exec --json` process per prompt, resumed by thread id.
 * There is no approval channel in this mode; codex runs with approval policy "never"
 * inside its own sandbox (read-only for read-only/plan, workspace-write otherwise).
 */
export const startCodexExec = async (
  opts: CodexOptions,
  spec: SessionSpec,
  sandbox: SandboxHandle,
): Promise<HarnessSession> => {
  const log = (opts.log ?? silentLogger).child({ harness: 'codex-exec', session: spec.sessionId });
  const command = typeof opts.command === 'function' ? await opts.command() : (opts.command ?? 'codex');
  let threadId = spec.resume;
  let running: { child: ChildProcessWithoutNullStreams; cancelled: boolean } | null = null;
  let closed = false;
  if (spec.permissionMode === 'ask')
    log.warn('codex exec fallback cannot ask for approvals; running with policy "never"');

  return {
    get id() {
      return threadId ?? spec.sessionId;
    },
    prompt(text, attachments = []) {
      if (closed) throw new BeamhopError('unavailable', 'session closed');
      if (running) throw new BeamhopError('conflict', 'a prompt is already running in this session');
      const queue = new AsyncQueue<HarnessEvent>();
      const state = { child: undefined as unknown as ChildProcessWithoutNullStreams, cancelled: false };
      void (async () => {
        try {
          const images: string[] = [];
          let prompt = text;
          for (const a of attachments) {
            const p = resolveInMounts(a.path, spec.mounts, 'read', {
              cwd: spec.cwd,
              deny: sandbox.policy.fs.deny,
            });
            if (a.mime.startsWith('image/')) images.push(p);
            else prompt += `\n\nAttached file: ${p} (${a.mime})`;
          }
          const child = await spawnInSandbox(
            sandbox,
            {
              cmd: command,
              args: execArgs(spec, prompt, threadId, images, opts),
              env: spec.env,
              cwd: spec.cwd,
            },
            log,
          );
          state.child = child;
          running = state;
          child.stdin.end();
          const stderr = captureStderr(child);
          let failed = false;
          readJsonLines(child.stdout, (raw) => {
            const ev = raw as Record<string, unknown>;
            if (ev.type === 'thread.started' && typeof ev.thread_id === 'string') threadId = ev.thread_id;
            for (const e of mapExecEvent(ev)) {
              if (e.type === 'error') failed = true;
              queue.push(e);
            }
          });
          const { code } = await new Promise<{ code: number | null }>((resolve) =>
            child.once('close', (c) => resolve({ code: c })),
          );
          if (state.cancelled) queue.push({ type: 'done', stopReason: 'cancelled', resume: threadId });
          else if (code !== 0 || failed) {
            if (!failed)
              queue.push({
                type: 'error',
                message: `codex exec exited with ${code}: ${truncate(stderr().trim(), 500)}`,
              });
            queue.push({ type: 'done', stopReason: 'error', resume: threadId });
          } else queue.push({ type: 'done', stopReason: 'end_turn', resume: threadId });
        } catch (e) {
          queue.push({ type: 'error', message: (e as Error).message });
          queue.push({ type: 'done', stopReason: 'error', resume: threadId });
        } finally {
          running = null;
          queue.end();
        }
      })();
      return queue;
    },
    async respondPermission() {
      throw new BeamhopError('invalid_input', 'codex exec mode has no permission requests');
    },
    async cancel() {
      const r = running;
      if (!r) return;
      r.cancelled = true;
      r.child.kill('SIGINT');
    },
    async close() {
      closed = true;
      const r = running;
      if (r) {
        r.cancelled = true;
        await terminate(r.child, 1000);
      }
    },
  };
};
