import {
  BeamhopError,
  type HarnessEvent,
  type HarnessSession,
  type Logger,
  type SandboxHandle,
  type SessionSpec,
  silentLogger,
} from '@beamhop/core';
import {
  AsyncQueue,
  captureStderr,
  JsonRpcPeer,
  JsonRpcRemoteError,
  PermissionBroker,
  resolveInMounts,
  spawnInSandbox,
  terminate,
  truncate,
} from '@beamhop/harness-kit';
import { mcpConfigArgs } from './toml.ts';

export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type CodexApprovalPolicy = 'untrusted' | 'on-request' | 'never';

export interface CodexOptions {
  command?: string | (() => Promise<string> | string);
  log?: Logger;
  startTimeoutMs?: number;
  /**
   * Codex's own sandbox inside beamhop's. Default is derived from permissionMode. Use
   * 'danger-full-access' when the outer sandbox (srt) does not allow nesting.
   */
  codexSandbox?: CodexSandboxMode;
  /** Extra `codex` CLI args placed before the subcommand args (e.g. `-c key=value`). */
  extraArgs?: string[];
}

/** permissionMode → codex approval policy + sandbox mode. */
export const codexPolicy = (
  mode: SessionSpec['permissionMode'],
): { approvalPolicy: CodexApprovalPolicy; sandbox: CodexSandboxMode } => {
  switch (mode) {
    case 'read-only':
    case 'plan':
      return { approvalPolicy: 'never', sandbox: 'read-only' };
    case 'auto':
      return { approvalPolicy: 'never', sandbox: 'workspace-write' };
    default:
      return { approvalPolicy: 'untrusted', sandbox: 'workspace-write' };
  }
};

type Item = { type: string; id: string; [k: string]: unknown };
type Usage = { inputTokens: number; outputTokens: number };

/** Map a codex ThreadItem (started) to a tool_call, or undefined for non-tool items. */
export const itemToToolCall = (item: Item): HarnessEvent | undefined => {
  switch (item.type) {
    case 'commandExecution':
      return {
        type: 'tool_call',
        id: item.id,
        name: 'shell',
        input: { command: item.command, cwd: item.cwd },
        title: String(item.command ?? ''),
      };
    case 'fileChange': {
      const changes = (item.changes as { path: string; kind: { type: string } }[] | undefined) ?? [];
      return {
        type: 'tool_call',
        id: item.id,
        name: 'apply_patch',
        input: { files: changes.map((c) => ({ path: c.path, kind: c.kind?.type })) },
        title: `Edit ${changes.map((c) => c.path).join(', ')}`,
      };
    }
    case 'mcpToolCall':
      return {
        type: 'tool_call',
        id: item.id,
        name: `${item.server}.${item.tool}`,
        input: item.arguments ?? null,
      };
    case 'dynamicToolCall':
      return { type: 'tool_call', id: item.id, name: String(item.tool), input: item.arguments ?? null };
    case 'webSearch':
      return { type: 'tool_call', id: item.id, name: 'web_search', input: { query: item.query } };
    default:
      return undefined;
  }
};

/** Map a completed codex ThreadItem to a tool_result, or undefined. */
export const itemToToolResult = (item: Item): HarnessEvent | undefined => {
  switch (item.type) {
    case 'commandExecution':
      return {
        type: 'tool_result',
        id: item.id,
        ok: item.status === 'completed' && (item.exitCode === 0 || item.exitCode == null),
        output:
          typeof item.aggregatedOutput === 'string' ? truncate(item.aggregatedOutput, 20000) : undefined,
      };
    case 'fileChange': {
      const changes = (item.changes as { diff?: string }[] | undefined) ?? [];
      const diff = changes
        .map((c) => c.diff ?? '')
        .filter(Boolean)
        .join('\n');
      return { type: 'tool_result', id: item.id, ok: item.status === 'completed', ...(diff ? { diff } : {}) };
    }
    case 'mcpToolCall':
      return {
        type: 'tool_result',
        id: item.id,
        ok: !item.error,
        output:
          item.result != null
            ? truncate(JSON.stringify(item.result), 20000)
            : (item.error as { message?: string })?.message,
      };
    case 'dynamicToolCall':
      return { type: 'tool_result', id: item.id, ok: item.success !== false };
    case 'webSearch':
      return { type: 'tool_result', id: item.id, ok: true };
    default:
      return undefined;
  }
};

const stopFor = (status: string | undefined): string =>
  status === 'completed' ? 'end_turn' : status === 'interrupted' ? 'cancelled' : 'error';

interface Turn {
  queue: AsyncQueue<HarnessEvent>;
  turnId?: string;
  deltas: Set<string>;
  usageStart?: Usage;
  cancelled: boolean;
  lastError?: string;
}

/** Start a session on `codex app-server` (JSON-RPC over stdio, v2 thread/turn API). */
export const startCodexAppServer = async (
  opts: CodexOptions,
  spec: SessionSpec,
  sandbox: SandboxHandle,
): Promise<HarnessSession> => {
  const log = (opts.log ?? silentLogger).child({ harness: 'codex', session: spec.sessionId });
  const command = typeof opts.command === 'function' ? await opts.command() : (opts.command ?? 'codex');
  const args = [...(opts.extraArgs ?? []), 'app-server', ...mcpConfigArgs(spec.mcpServers)];
  const child = await spawnInSandbox(sandbox, { cmd: command, args, env: spec.env, cwd: spec.cwd }, log);
  const stderr = captureStderr(child);
  const broker = new PermissionBroker();
  let threadId: string | undefined;
  let turn: Turn | null = null;
  let totalUsage: Usage = { inputTokens: 0, outputTokens: 0 };
  let exited = false;
  let closing = false;
  const policy = codexPolicy(spec.permissionMode);
  const sandboxMode = opts.codexSandbox ?? policy.sandbox;

  const finish = (evs: HarnessEvent[]) => {
    const t = turn;
    if (!t) return;
    turn = null;
    for (const e of evs) t.queue.push(e);
    t.queue.end();
  };

  const askOwner = async (tool: string, input: unknown, title: string, key: string) => {
    if (broker.isAlwaysAllowed(key)) return { allow: true, always: true };
    if (!turn) return { allow: false, reason: 'cancelled' };
    const id = broker.nextId('codex');
    turn.queue.push({
      type: 'permission_request',
      id,
      tool,
      input,
      title,
      options: ['Allow', 'Allow for session', 'Deny'],
    });
    return broker.ask(id, key);
  };

  const onRequest = async (method: string, params: unknown) => {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const cmd = String(p.command ?? '');
        const d = await askOwner(
          'shell',
          { command: cmd, cwd: p.cwd, reason: p.reason },
          cmd || 'run a command',
          `shell`,
        );
        if (d.reason === 'cancelled') return { decision: 'cancel' };
        return { decision: d.allow ? (d.always ? 'acceptForSession' : 'accept') : 'decline' };
      }
      case 'item/fileChange/requestApproval': {
        const d = await askOwner(
          'apply_patch',
          { itemId: p.itemId, reason: p.reason, grantRoot: p.grantRoot },
          `Apply file changes${p.reason ? `: ${p.reason}` : ''}`,
          'apply_patch',
        );
        if (d.reason === 'cancelled') return { decision: 'cancel' };
        return { decision: d.allow ? (d.always ? 'acceptForSession' : 'accept') : 'decline' };
      }
      case 'execCommandApproval':
      case 'applyPatchApproval': {
        const tool = method === 'execCommandApproval' ? 'shell' : 'apply_patch';
        const d = await askOwner(tool, p, tool, tool);
        return { decision: d.allow ? (d.always ? 'approved_for_session' : 'approved') : 'denied' };
      }
      default:
        throw new JsonRpcRemoteError({ code: -32601, message: `beamhop does not support ${method}` });
    }
  };

  const onNotification = (method: string, params: unknown) => {
    const p = (params ?? {}) as Record<string, unknown>;
    if (p.threadId && p.threadId !== threadId) return;
    if (method === 'thread/tokenUsage/updated') {
      const total = (p.tokenUsage as { total?: { inputTokens?: number; outputTokens?: number } })?.total;
      totalUsage = { inputTokens: total?.inputTokens ?? 0, outputTokens: total?.outputTokens ?? 0 };
      return;
    }
    const t = turn;
    if (!t) return;
    const push = (e: HarnessEvent | undefined) => e && t.queue.push(e);
    switch (method) {
      case 'item/agentMessage/delta':
        t.deltas.add(String(p.itemId));
        push({ type: 'text', delta: String(p.delta ?? '') });
        break;
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta':
        push({ type: 'thinking', delta: String(p.delta ?? '') });
        break;
      case 'item/started':
        push(itemToToolCall(p.item as Item));
        break;
      case 'item/completed': {
        const item = p.item as Item;
        if (item.type === 'agentMessage' && !t.deltas.has(item.id) && item.text) {
          push({ type: 'text', delta: String(item.text) });
        }
        push(itemToToolResult(item));
        break;
      }
      case 'turn/plan/updated': {
        const plan = (p.plan as { step: string; status: string }[] | undefined) ?? [];
        push({
          type: 'progress',
          message: `Plan:\n${plan.map((s) => `- [${s.status === 'completed' ? 'x' : s.status === 'inProgress' ? '~' : ' '}] ${s.step}`).join('\n')}`,
        });
        break;
      }
      case 'error': {
        const err = p.error as { message?: string } | undefined;
        if (!p.willRetry) t.lastError = err?.message ?? 'codex error';
        push(
          p.willRetry
            ? { type: 'progress', message: `retrying: ${err?.message ?? 'error'}` }
            : { type: 'error', message: err?.message ?? 'codex error' },
        );
        break;
      }
      case 'turn/completed': {
        const tr = p.turn as { id?: string; status?: string; error?: { message?: string } | null };
        if (t.turnId && tr.id && tr.id !== t.turnId) return;
        const evs: HarnessEvent[] = [];
        if (tr.status === 'failed' && tr.error?.message && tr.error.message !== t.lastError)
          evs.push({ type: 'error', message: tr.error.message });
        const start = t.usageStart ?? { inputTokens: 0, outputTokens: 0 };
        const inputTokens = totalUsage.inputTokens - start.inputTokens;
        const outputTokens = totalUsage.outputTokens - start.outputTokens;
        if (inputTokens > 0 || outputTokens > 0) evs.push({ type: 'usage', inputTokens, outputTokens });
        evs.push({ type: 'done', stopReason: stopFor(tr.status), resume: threadId });
        finish(evs);
        break;
      }
    }
  };

  const rpc = new JsonRpcPeer(child.stdout, child.stdin, {
    omitVersion: true,
    onRequest,
    onNotification,
    onBadLine: (l) => log.debug('codex non-JSON output', { line: truncate(l, 200) }),
  });

  const exitP = new Promise<void>((resolve) => {
    child.once('exit', (code, signal) => {
      exited = true;
      broker.denyAll('cancelled');
      const msg = `codex exited (code=${code} signal=${signal})${stderr().trim() ? `: ${truncate(stderr().trim(), 500)}` : ''}`;
      rpc.close(new BeamhopError('unavailable', msg));
      if (!closing)
        finish([
          { type: 'error', message: msg },
          { type: 'done', stopReason: 'error', resume: threadId },
        ]);
      resolve();
    });
    child.once('error', () => {
      exited = true;
      resolve();
    });
  });

  const timeout = opts.startTimeoutMs ?? 60000;
  try {
    await rpc.request(
      'initialize',
      {
        clientInfo: { name: 'beamhop', title: 'beamhop', version: '0.1.0' },
        capabilities: { experimentalApi: false, requestAttestation: false },
      },
      timeout,
    );
    await rpc.notify('initialized');
    const common = { cwd: spec.cwd, approvalPolicy: policy.approvalPolicy, sandbox: sandboxMode };
    const model = spec.model ? { model: spec.model } : {};
    const res = spec.resume
      ? await rpc.request<{ thread: { id: string } }>(
          'thread/resume',
          { threadId: spec.resume, ...common, ...model, excludeTurns: true },
          timeout,
        )
      : await rpc.request<{ thread: { id: string } }>('thread/start', { ...common, ...model }, timeout);
    threadId = res.thread.id;
  } catch (e) {
    closing = true;
    await terminate(child, 500);
    const tail = stderr().trim();
    throw new BeamhopError(
      e instanceof BeamhopError ? e.code : 'unavailable',
      `codex app-server failed to start: ${(e as Error).message}${tail ? ` (${truncate(tail, 500)})` : ''}`,
    );
  }

  return {
    get id() {
      return threadId!;
    },
    prompt(text, attachments = []) {
      if (exited || closing) throw new BeamhopError('unavailable', 'codex is not running');
      if (turn) throw new BeamhopError('conflict', 'a prompt is already running in this session');
      const t: Turn = {
        queue: new AsyncQueue<HarnessEvent>(),
        deltas: new Set(),
        usageStart: { ...totalUsage },
        cancelled: false,
      };
      turn = t;
      void (async () => {
        try {
          const input: unknown[] = [{ type: 'text', text, text_elements: [] }];
          for (const a of attachments) {
            const p = resolveInMounts(a.path, spec.mounts, 'read', {
              cwd: spec.cwd,
              deny: sandbox.policy.fs.deny,
            });
            if (a.mime.startsWith('image/')) input.push({ type: 'localImage', path: p });
            else input.push({ type: 'mention', name: p.split(/[\\/]/).pop(), path: p });
          }
          const r = await rpc.request<{ turn: { id: string } }>('turn/start', { threadId, input });
          t.turnId = r.turn.id;
          if (t.cancelled)
            await rpc.request('turn/interrupt', { threadId, turnId: t.turnId }).catch(() => {});
        } catch (e) {
          if (turn === t)
            finish([
              { type: 'error', message: (e as Error).message },
              { type: 'done', stopReason: 'error', resume: threadId },
            ]);
        }
      })();
      return t.queue;
    },
    async respondPermission(id, decision) {
      broker.respond(id, decision);
    },
    async cancel() {
      const t = turn;
      if (!t || exited) return;
      t.cancelled = true;
      broker.denyAll('cancelled');
      if (t.turnId)
        await rpc.request('turn/interrupt', { threadId, turnId: t.turnId }, 10000).catch(() => {});
    },
    async close() {
      if (closing) return;
      closing = true;
      broker.denyAll('cancelled');
      finish([{ type: 'done', stopReason: 'cancelled', resume: threadId }]);
      rpc.close();
      await terminate(child, 1500);
      await exitP;
    },
  };
};
