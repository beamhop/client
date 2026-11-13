import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as acp from '@agentclientprotocol/sdk';
import {
  BeamhopError,
  type HarnessDetection,
  type HarnessEvent,
  type HarnessPlugin,
  type HarnessSession,
  type Logger,
  type PermissionDecision,
  type SandboxHandle,
  type SessionSpec,
  silentLogger,
} from '@beamhop/core';
import { acpStreamFor, CLIENT_INFO } from '@beamhop/harness-discovery';
import {
  AsyncQueue,
  captureStderr,
  PermissionBroker,
  resolveInMounts,
  spawnInSandbox,
  terminate,
  truncate,
} from '@beamhop/harness-kit';
import { autoDecision, chooseOption, mapSessionUpdate, toAcpMcpServers } from './mapping.ts';

export interface AcpHarnessOptions {
  id: string;
  displayName: string;
  /** Command to spawn (a bare name is resolved via PATH in the session env). */
  command: string | (() => Promise<string> | string);
  args?: string[];
  /** Extra non-secret env for this harness (e.g. disable auto-update). */
  env?: Record<string, string>;
  detect: () => Promise<HarnessDetection | null>;
  log?: Logger;
  /** Timeout for `initialize` and `session/new|load`. Default 60s. */
  startTimeoutMs?: number;
}

type TurnState = { queue: AsyncQueue<HarnessEvent>; cancelled: boolean };

const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> => {
  let t: NodeJS.Timeout | undefined;
  return Promise.race([
    p.finally(() => t && clearTimeout(t)),
    new Promise<never>((_, reject) => {
      t = setTimeout(() => reject(new BeamhopError('timeout', `${what} timed out after ${ms}ms`)), ms);
    }),
  ]);
};

const rpcError = (e: unknown): acp.RequestError =>
  new acp.RequestError(-32603, e instanceof Error ? e.message : String(e));

/** Start one ACP-backed HarnessSession. Exported for tests and custom wiring. */
export const startAcpSession = async (
  opts: AcpHarnessOptions,
  spec: SessionSpec,
  sandbox: SandboxHandle,
): Promise<HarnessSession> => {
  const log = (opts.log ?? silentLogger).child({ harness: opts.id, session: spec.sessionId });
  const command = typeof opts.command === 'function' ? await opts.command() : opts.command;
  const child = await spawnInSandbox(
    sandbox,
    { cmd: command, args: opts.args ?? [], env: { ...spec.env, ...opts.env }, cwd: spec.cwd },
    log,
  );
  const stderr = captureStderr(child);
  const broker = new PermissionBroker();
  let turn: TurnState | null = null;
  let acpSessionId: string | undefined;
  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let closing = false;

  const emit = (ev: HarnessEvent) => turn?.queue.push(ev);

  const app = acp
    .client({ name: CLIENT_INFO.name })
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      if (params.sessionId !== acpSessionId || !turn) return; // history replay during session/load etc.
      for (const ev of mapSessionUpdate(params.update)) emit(ev);
    })
    .onRequest(acp.methods.client.session.requestPermission, async ({ params, signal }) => {
      const tc = params.toolCall;
      const kind = tc.kind ?? undefined;
      const key = `${tc.name ?? kind ?? 'tool'}`;
      const cancelled: acp.RequestPermissionResponse = { outcome: { outcome: 'cancelled' } };
      let decision: PermissionDecision | undefined = autoDecision(spec.permissionMode, kind);
      if (!decision && broker.isAlwaysAllowed(key)) decision = { allow: true, always: true };
      if (!decision) {
        if (!turn) return cancelled;
        const id = broker.nextId('acp');
        emit({
          type: 'permission_request',
          id,
          tool: tc.name ?? kind ?? 'tool',
          input: tc.rawInput ?? null,
          title: tc.title ?? `${tc.name ?? kind ?? 'tool'} ${tc.toolCallId}`,
          options: params.options.map((o) => o.name),
        });
        const onAbort = () => {
          try {
            broker.respond(id, { allow: false, reason: 'request cancelled by agent' });
          } catch {
            // already answered
          }
        };
        signal.addEventListener('abort', onAbort, { once: true });
        decision = await broker.ask(id, key);
        signal.removeEventListener('abort', onAbort);
        if (decision.reason === 'cancelled') return cancelled;
      }
      const opt = chooseOption(params.options, decision);
      if (!opt) return cancelled;
      return { outcome: { outcome: 'selected', optionId: opt.optionId } };
    })
    .onRequest(acp.methods.client.fs.readTextFile, async ({ params }) => {
      try {
        const p = resolveInMounts(params.path, spec.mounts, 'read', {
          cwd: spec.cwd,
          deny: sandbox.policy.fs.deny,
        });
        let content = await readFile(p, 'utf8');
        if (params.line || params.limit) {
          const lines = content.split('\n');
          const start = Math.max(0, (params.line ?? 1) - 1);
          content = lines.slice(start, params.limit ? start + params.limit : undefined).join('\n');
        }
        return { content };
      } catch (e) {
        throw rpcError(e);
      }
    })
    .onRequest(acp.methods.client.fs.writeTextFile, async ({ params }) => {
      try {
        if (spec.permissionMode === 'read-only' || spec.permissionMode === 'plan') {
          throw new BeamhopError('forbidden', `writes are disabled in ${spec.permissionMode} mode`);
        }
        const p = resolveInMounts(params.path, spec.mounts, 'write', {
          cwd: spec.cwd,
          deny: sandbox.policy.fs.deny,
        });
        await mkdir(path.dirname(p), { recursive: true });
        await writeFile(p, params.content, 'utf8');
        return {};
      } catch (e) {
        throw rpcError(e);
      }
    });

  const conn = app.connect(acpStreamFor(child));
  const exitPromise = new Promise<void>((resolve) => {
    child.once('exit', (code, signal) => {
      exited = { code, signal };
      broker.denyAll('cancelled');
      if (turn && !closing) {
        const tail = stderr().trim();
        turn.queue.push({
          type: 'error',
          message: `${opts.displayName} exited (code=${code} signal=${signal})${tail ? `: ${truncate(tail, 500)}` : ''}`,
        });
        turn.queue.push({ type: 'done', stopReason: 'error', resume: acpSessionId });
        turn.queue.end();
        turn = null;
      }
      conn.close();
      resolve();
    });
    child.once('error', (e) => {
      log.warn('harness spawn error', { error: e.message });
      exited = { code: null, signal: null };
      resolve();
    });
  });
  const failIfExited = exitPromise.then(() => {
    throw new BeamhopError(
      'unavailable',
      `${opts.displayName} exited during startup${stderr() ? `: ${truncate(stderr().trim(), 500)}` : ''}`,
    );
  });
  failIfExited.catch(() => {});

  const startTimeout = opts.startTimeoutMs ?? 60000;
  let init: acp.InitializeResponse;
  let promptCaps: acp.PromptCapabilities = {};
  try {
    init = await withTimeout(
      Promise.race([
        conn.agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
          clientInfo: CLIENT_INFO,
        }) as Promise<acp.InitializeResponse>,
        failIfExited,
      ]),
      startTimeout,
      'ACP initialize',
    );
    promptCaps = init.agentCapabilities?.promptCapabilities ?? {};
    const mcpServers = toAcpMcpServers(spec.mcpServers);
    const caps = init.agentCapabilities ?? {};
    let configOptions: acp.SessionConfigOption[] | null | undefined;
    let modes: acp.SessionModeState | null | undefined;
    if (spec.resume && caps.loadSession) {
      acpSessionId = spec.resume;
      const r = await withTimeout(
        Promise.race([
          conn.agent.request(acp.methods.agent.session.load, {
            sessionId: spec.resume,
            cwd: spec.cwd,
            mcpServers,
          }),
          failIfExited,
        ]),
        startTimeout,
        'ACP session/load',
      );
      configOptions = r?.configOptions;
      modes = r?.modes;
    } else if (spec.resume && caps.sessionCapabilities?.resume) {
      acpSessionId = spec.resume;
      const r = await withTimeout(
        Promise.race([
          conn.agent.request(acp.methods.agent.session.resume, {
            sessionId: spec.resume,
            cwd: spec.cwd,
            mcpServers,
          }),
          failIfExited,
        ]),
        startTimeout,
        'ACP session/resume',
      );
      configOptions = r.configOptions;
      modes = r.modes;
    } else {
      if (spec.resume) log.info('agent cannot resume sessions; starting a new one');
      const r = await withTimeout(
        Promise.race([
          conn.agent.request(acp.methods.agent.session.new, { cwd: spec.cwd, mcpServers }),
          failIfExited,
        ]),
        startTimeout,
        'ACP session/new',
      );
      acpSessionId = r.sessionId;
      configOptions = r.configOptions;
      modes = r.modes;
    }
    await applySessionSettings(conn, acpSessionId!, spec, configOptions, modes, log);
  } catch (e) {
    closing = true;
    conn.close();
    await terminate(child, 500);
    if (e instanceof BeamhopError) throw e;
    throw new BeamhopError('unavailable', `${opts.displayName} failed to start: ${(e as Error).message}`);
  }

  const buildPrompt = async (text: string, attachments: { path: string; mime: string }[] = []) => {
    const blocks: acp.ContentBlock[] = [{ type: 'text', text }];
    for (const a of attachments) {
      const p = resolveInMounts(a.path, spec.mounts, 'read', { cwd: spec.cwd, deny: sandbox.policy.fs.deny });
      if (a.mime.startsWith('image/') && promptCaps.image) {
        blocks.push({ type: 'image', mimeType: a.mime, data: (await readFile(p)).toString('base64') });
      } else {
        blocks.push({
          type: 'resource_link',
          uri: pathToFileURL(p).href,
          name: path.basename(p),
          mimeType: a.mime,
        });
      }
    }
    return blocks;
  };

  const session: HarnessSession = {
    get id() {
      return acpSessionId!;
    },
    prompt(text, attachments) {
      if (exited || closing || conn.signal.aborted) {
        throw new BeamhopError('unavailable', `${opts.displayName} is not running`);
      }
      if (turn) throw new BeamhopError('conflict', 'a prompt is already running in this session');
      const state: TurnState = { queue: new AsyncQueue<HarnessEvent>(), cancelled: false };
      turn = state;
      const finish = (evs: HarnessEvent[]) => {
        if (turn !== state) return;
        for (const ev of evs) state.queue.push(ev);
        state.queue.end();
        turn = null;
      };
      void (async () => {
        try {
          const prompt = await buildPrompt(text, attachments);
          if (state.cancelled) {
            finish([{ type: 'done', stopReason: 'cancelled', resume: acpSessionId }]);
            return;
          }
          const res = await conn.agent.request(acp.methods.agent.session.prompt, {
            sessionId: acpSessionId!,
            prompt,
          });
          const evs: HarnessEvent[] = [];
          const usage = (res as { usage?: { inputTokens?: number; outputTokens?: number } }).usage;
          if (usage) {
            evs.push({
              type: 'usage',
              inputTokens: usage.inputTokens ?? 0,
              outputTokens: usage.outputTokens ?? 0,
            });
          }
          evs.push({ type: 'done', stopReason: res.stopReason, resume: acpSessionId });
          finish(evs);
        } catch (e) {
          finish([
            { type: 'error', message: e instanceof Error ? e.message : String(e) },
            { type: 'done', stopReason: 'error', resume: acpSessionId },
          ]);
        }
      })();
      return state.queue;
    },
    async respondPermission(requestId, decision) {
      broker.respond(requestId, decision);
    },
    async cancel() {
      if (!acpSessionId || exited) return;
      if (turn) turn.cancelled = true;
      broker.denyAll('cancelled');
      await conn.agent.notify(acp.methods.agent.session.cancel, { sessionId: acpSessionId }).catch(() => {});
    },
    async close() {
      if (closing) return;
      closing = true;
      broker.denyAll('cancelled');
      if (turn) {
        turn.queue.push({ type: 'done', stopReason: 'cancelled', resume: acpSessionId });
        turn.queue.end();
        turn = null;
      }
      conn.close();
      await terminate(child, 1500);
      await exitPromise;
    },
  };
  return session;
};

/** Apply model (via a `model` config option) and plan mode (via session modes) when the agent offers them. */
const applySessionSettings = async (
  conn: acp.ClientConnection,
  sessionId: string,
  spec: SessionSpec,
  configOptions: acp.SessionConfigOption[] | null | undefined,
  modes: acp.SessionModeState | null | undefined,
  log: Logger,
) => {
  if (spec.model) {
    const opt = configOptions?.find((o) => o.category === 'model' && o.type === 'select');
    if (opt && opt.type === 'select') {
      const flat = opt.options.flatMap((o) => ('options' in o ? o.options : [o]));
      const match =
        flat.find((o) => o.value === spec.model) ?? flat.find((o) => o.value.endsWith(`/${spec.model}`));
      if (match && match.value !== opt.currentValue) {
        await conn.agent
          .request(acp.methods.agent.session.setConfigOption, {
            sessionId,
            configId: opt.id,
            value: match.value,
          })
          .catch((e) => log.warn('could not set model', { error: (e as Error).message }));
      } else if (!match) log.warn('model not offered by agent; using its default', { model: spec.model });
    }
  }
  if (spec.permissionMode === 'plan' && modes?.availableModes.some((m) => m.id === 'plan')) {
    await conn.agent
      .request(acp.methods.agent.session.setMode, { sessionId, modeId: 'plan' })
      .catch((e) => log.warn('could not set plan mode', { error: (e as Error).message }));
  }
};

/** Generic ACP harness plugin factory. */
export const createAcpHarness = (opts: AcpHarnessOptions): HarnessPlugin => ({
  id: opts.id,
  displayName: opts.displayName,
  detect: opts.detect,
  start: (spec, sandbox) => startAcpSession(opts, spec, sandbox),
});
