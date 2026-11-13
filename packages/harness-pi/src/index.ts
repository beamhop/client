import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  BeamhopError,
  explicitModel,
  type HarnessDetection,
  type HarnessEvent,
  type HarnessPlugin,
  type HarnessSession,
  type Logger,
  type ModelOption,
  type SandboxHandle,
  type SessionSpec,
  silentLogger,
} from '@beamhop/core';
import { type CatalogEntry, findHarness, loadCatalog, sandboxTraits } from '@beamhop/harness-catalog';
import { detectHarness, type ScanOptions } from '@beamhop/harness-discovery';
import {
  AsyncQueue,
  captureStderr,
  PermissionBroker,
  readJsonLines,
  resolveInMounts,
  spawnInSandbox,
  terminate,
  truncate,
  writeJsonLine,
} from '@beamhop/harness-kit';

/** Path of the approval-gate extension passed to pi with `--extension` in "ask" mode. */
export const PI_GATE_EXTENSION = fileURLToPath(new URL('../extension/beamhop-gate.mjs', import.meta.url));
const GATE_PREFIX = 'beamhop-permission:';
const READ_ONLY_TOOLS = 'read,grep,find,ls';

export interface PiHarnessOptions {
  /** pi binary (default: path from detection, else `pi` via PATH). */
  command?: string | (() => Promise<string> | string);
  /** Extra CLI args (e.g. `--provider openrouter`). */
  extraArgs?: string[];
  log?: Logger;
  scan?: Omit<ScanOptions, 'catalog' | 'only'>;
  startTimeoutMs?: number;
  catalogEntry?: CatalogEntry;
}

/** Build pi CLI args for a session. Exported for tests. */
export const piArgs = (spec: SessionSpec, extra: string[] = [], gatePath = PI_GATE_EXTENSION): string[] => {
  const args = ['--mode', 'rpc'];
  const model = explicitModel(spec.model);
  if (model) args.push('--model', model);
  if (spec.resume) args.push('--session', spec.resume);
  if (spec.permissionMode === 'read-only' || spec.permissionMode === 'plan')
    args.push('--tools', READ_ONLY_TOOLS);
  if (spec.permissionMode === 'ask') args.push('--extension', gatePath);
  return [...args, ...extra];
};

type PiMsg = Record<string, unknown> & { type?: string };

const textOfContent = (content: unknown): string | undefined => {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : undefined;
  const parts = content
    .map((c) =>
      c && typeof c === 'object' && (c as { type?: string }).type === 'text'
        ? (c as { text: string }).text
        : '',
    )
    .filter(Boolean);
  return parts.length ? parts.join('\n') : undefined;
};

interface TurnAcc {
  queue: AsyncQueue<HarnessEvent>;
  input: number;
  output: number;
  cost: number;
  stopReason?: string;
}

/** Map one pi RPC event to HarnessEvents (updates turn accumulators). Exported for tests. */
export const mapPiEvent = (m: PiMsg, acc: Omit<TurnAcc, 'queue'>): HarnessEvent[] => {
  switch (m.type) {
    case 'message_update': {
      const e = m.assistantMessageEvent as { type?: string; delta?: string } | undefined;
      if (e?.type === 'text_delta' && e.delta) return [{ type: 'text', delta: e.delta }];
      if (e?.type === 'thinking_delta' && e.delta) return [{ type: 'thinking', delta: e.delta }];
      return [];
    }
    case 'message_end': {
      const msg = m.message as
        | {
            role?: string;
            stopReason?: string;
            errorMessage?: string;
            usage?: { input?: number; output?: number; cost?: { total?: number } };
          }
        | undefined;
      if (msg?.role !== 'assistant') return [];
      acc.input += msg.usage?.input ?? 0;
      acc.output += msg.usage?.output ?? 0;
      acc.cost += msg.usage?.cost?.total ?? 0;
      acc.stopReason = msg.stopReason;
      if (msg.stopReason === 'error') return [{ type: 'error', message: msg.errorMessage ?? 'model error' }];
      return [];
    }
    case 'tool_execution_start':
      return [
        { type: 'tool_call', id: String(m.toolCallId), name: String(m.toolName), input: m.args ?? null },
      ];
    case 'tool_execution_end': {
      const r = m.result as { content?: unknown; details?: { diff?: unknown } } | undefined;
      const diff = typeof r?.details?.diff === 'string' ? r.details.diff : undefined;
      return [
        {
          type: 'tool_result',
          id: String(m.toolCallId),
          ok: !m.isError,
          output: textOfContent(r?.content),
          ...(diff ? { diff } : {}),
        },
      ];
    }
    case 'auto_retry_start':
      return [
        {
          type: 'progress',
          message: `retrying (${m.attempt}/${m.maxAttempts}): ${truncate(String(m.errorMessage ?? ''), 200)}`,
        },
      ];
    case 'compaction_start':
      return [{ type: 'progress', message: 'compacting context' }];
    case 'extension_error':
      return [{ type: 'progress', message: `pi extension error: ${truncate(String(m.error ?? ''), 300)}` }];
    default:
      return [];
  }
};

const piStop = (s: string | undefined): string => {
  switch (s) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'aborted':
      return 'cancelled';
    default:
      return s ?? 'end_turn';
  }
};

export const startPiSession = async (
  opts: PiHarnessOptions,
  spec: SessionSpec,
  sandbox: SandboxHandle,
): Promise<HarnessSession> => {
  const log = (opts.log ?? silentLogger).child({ harness: 'pi', session: spec.sessionId });
  if (spec.mcpServers.length)
    log.warn('pi does not support MCP servers; beamhop tools are unavailable in this session');
  const command = typeof opts.command === 'function' ? await opts.command() : (opts.command ?? 'pi');
  const child = await spawnInSandbox(
    sandbox,
    { cmd: command, args: piArgs(spec, opts.extraArgs), env: spec.env, cwd: spec.cwd },
    log,
  );
  const stderr = captureStderr(child);
  const broker = new PermissionBroker();
  const pending = new Map<string, { resolve: (m: PiMsg) => void; reject: (e: Error) => void }>();
  let seq = 0;
  let turn: TurnAcc | null = null;
  let exited = false;
  let closing = false;
  let state: { sessionId?: string; sessionFile?: string } = {};

  const send = (cmd: PiMsg) => writeJsonLine(child.stdin, cmd);
  const call = (cmd: PiMsg, timeoutMs?: number): Promise<PiMsg> => {
    const id = `bh-${++seq}`;
    return new Promise<PiMsg>((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            pending.delete(id);
            reject(new BeamhopError('timeout', `pi ${cmd.type} timed out after ${timeoutMs}ms`));
          }, timeoutMs)
        : undefined;
      pending.set(id, {
        resolve: (m) => {
          if (timer) clearTimeout(timer);
          resolve(m);
        },
        reject: (e) => {
          if (timer) clearTimeout(timer);
          reject(e);
        },
      });
      send({ ...cmd, id }).catch((e) => {
        pending.delete(id);
        reject(e);
      });
    });
  };
  const resumeToken = () => state.sessionFile ?? state.sessionId;
  const finishTurn = (extra: HarnessEvent[]) => {
    const t = turn;
    if (!t) return;
    turn = null;
    for (const e of extra) t.queue.push(e);
    t.queue.end();
  };

  const onUiRequest = async (m: PiMsg) => {
    const id = String(m.id);
    const method = String(m.method);
    if (method === 'confirm' && typeof m.title === 'string' && m.title.startsWith(GATE_PREFIX)) {
      let req: { toolCallId?: string; tool?: string; input?: unknown } = {};
      try {
        req = JSON.parse(m.title.slice(GATE_PREFIX.length));
      } catch {
        // malformed: deny below
      }
      const key = req.tool;
      let allow = false;
      if (broker.isAlwaysAllowed(key)) allow = true;
      else if (turn && req.tool) {
        const pid = broker.nextId('pi');
        turn.queue.push({
          type: 'permission_request',
          id: pid,
          tool: req.tool,
          input: req.input ?? null,
          title: `${req.tool}: ${truncate(JSON.stringify(req.input ?? {}), 160)}`,
          options: ['Allow', 'Always allow', 'Deny'],
        });
        allow = (await broker.ask(pid, key)).allow;
      }
      await send({ type: 'extension_ui_response', id, confirmed: allow }).catch(() => {});
    } else if (['select', 'confirm', 'input', 'editor'].includes(method)) {
      await send({ type: 'extension_ui_response', id, cancelled: true }).catch(() => {});
    } else if (method === 'notify' && turn) {
      turn.queue.push({ type: 'progress', message: String(m.message ?? '') });
    }
  };

  readJsonLines(
    child.stdout,
    (raw) => {
      const m = raw as PiMsg;
      if (m.type === 'response') {
        const p = typeof m.id === 'string' ? pending.get(m.id) : undefined;
        if (p) {
          pending.delete(m.id as string);
          p.resolve(m);
        }
        return;
      }
      if (m.type === 'extension_ui_request') {
        void onUiRequest(m);
        return;
      }
      if (!turn) return;
      for (const ev of mapPiEvent(m, turn)) turn.queue.push(ev);
      if (m.type === 'agent_end') {
        const t = turn;
        const evs: HarnessEvent[] = [];
        if (t.input || t.output || t.cost) {
          evs.push({
            type: 'usage',
            inputTokens: t.input,
            outputTokens: t.output,
            ...(t.cost ? { costUsd: t.cost } : {}),
          });
        }
        evs.push({ type: 'done', stopReason: piStop(t.stopReason), resume: resumeToken() });
        finishTurn(evs);
      }
    },
    { onBadLine: (l) => log.debug('pi non-JSON output', { line: truncate(l, 200) }) },
  );

  const exitP = new Promise<void>((resolve) => {
    child.once('exit', (code, signal) => {
      exited = true;
      broker.denyAll('cancelled');
      const err = new BeamhopError(
        'unavailable',
        `pi exited (code=${code} signal=${signal}): ${truncate(stderr().trim(), 500)}`,
      );
      for (const p of pending.values()) p.reject(err);
      pending.clear();
      if (!closing)
        finishTurn([
          { type: 'error', message: err.message },
          { type: 'done', stopReason: 'error', resume: resumeToken() },
        ]);
      resolve();
    });
    child.once('error', () => {
      exited = true;
      resolve();
    });
  });

  try {
    const r = await call({ type: 'get_state' }, opts.startTimeoutMs ?? 60000);
    if (!r.success) throw new BeamhopError('unavailable', `pi get_state failed: ${r.error}`);
    state = (r.data as typeof state) ?? {};
  } catch (e) {
    closing = true;
    await terminate(child, 500);
    if (e instanceof BeamhopError) throw e;
    throw new BeamhopError('unavailable', `pi failed to start: ${(e as Error).message}`);
  }

  return {
    get id() {
      return state.sessionId ?? spec.sessionId;
    },
    async models(): Promise<ModelOption[]> {
      if (exited || closing) throw new BeamhopError('unavailable', 'pi is not running');
      const r = await call({ type: 'get_available_models' }, opts.startTimeoutMs ?? 60000);
      if (!r.success) throw new BeamhopError('unavailable', `pi get_available_models failed: ${r.error}`);
      return piModelOptions(r.data);
    },
    prompt(text, attachments = []) {
      if (exited || closing) throw new BeamhopError('unavailable', 'pi is not running');
      if (turn) throw new BeamhopError('conflict', 'a prompt is already running in this session');
      const t: TurnAcc = { queue: new AsyncQueue<HarnessEvent>(), input: 0, output: 0, cost: 0 };
      turn = t;
      void (async () => {
        try {
          const images: { type: 'image'; data: string; mimeType: string }[] = [];
          let message = text;
          for (const a of attachments) {
            const p = resolveInMounts(a.path, spec.mounts, 'read', {
              cwd: spec.cwd,
              deny: sandbox.policy.fs.deny,
            });
            if (a.mime.startsWith('image/')) {
              images.push({ type: 'image', data: (await readFile(p)).toString('base64'), mimeType: a.mime });
            } else message += `\n\nAttached file: ${p} (${a.mime})`;
          }
          const r = await call({ type: 'prompt', message, ...(images.length ? { images } : {}) });
          if (!r.success && turn === t) {
            finishTurn([
              { type: 'error', message: `pi rejected the prompt: ${String(r.error ?? 'unknown error')}` },
              { type: 'done', stopReason: 'error', resume: resumeToken() },
            ]);
          }
        } catch (e) {
          if (turn === t) {
            finishTurn([
              { type: 'error', message: (e as Error).message },
              { type: 'done', stopReason: 'error', resume: resumeToken() },
            ]);
          }
        }
      })();
      return t.queue;
    },
    async respondPermission(requestId, decision) {
      broker.respond(requestId, decision);
    },
    async cancel() {
      if (exited) return;
      broker.denyAll('cancelled');
      await call({ type: 'abort' }, 10000).catch(() => {});
    },
    async close() {
      if (closing) return;
      closing = true;
      broker.denyAll('cancelled');
      finishTurn([{ type: 'done', stopReason: 'cancelled', resume: resumeToken() }]);
      await terminate(child, 1500);
      await exitP;
    },
  };
};

/** pi coding agent harness (RPC mode). */
export const piHarness = (opts: PiHarnessOptions = {}): HarnessPlugin => {
  const entry = opts.catalogEntry ?? findHarness(loadCatalog(), 'pi')!;
  let lastPath: string | undefined;
  return {
    id: 'pi',
    displayName: entry.displayName,
    ...sandboxTraits(entry),
    async detect(): Promise<HarnessDetection | null> {
      const d = await detectHarness(entry, opts.scan);
      if (d.path) lastPath = d.path;
      return d.status === 'not-installed' ? null : d;
    },
    start: (spec, sandbox) =>
      startPiSession({ ...opts, command: opts.command ?? (() => lastPath ?? 'pi') }, spec, sandbox),
  };
};

/**
 * pi's `get_available_models` rows as model options. pi's `--model` takes `<provider>/<id>`, so that is
 * the option id. Exported for tests.
 */
export const piModelOptions = (data: unknown): ModelOption[] => {
  const rows = (data as { models?: { id?: unknown; provider?: unknown; name?: unknown }[] } | undefined)
    ?.models;
  const out: ModelOption[] = [];
  for (const m of Array.isArray(rows) ? rows : []) {
    if (typeof m?.id !== 'string' || typeof m.provider !== 'string') continue;
    out.push({ id: `${m.provider}/${m.id}`, ...(typeof m.name === 'string' ? { label: m.name } : {}) });
  }
  return out;
};
