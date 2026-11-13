import { randomBytes } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySecretStore } from '@beamhop/broker';
import { type BeamhopClient, createClient, directTransport } from '@beamhop/client';
import {
  type ButtonPress,
  type ChannelConn,
  type ChannelContext,
  type ChannelHistoryMessage,
  type ChannelHistoryQuery,
  type ChannelPlugin,
  type HarnessEvent,
  type HarnessPlugin,
  type HarnessSession,
  InboundMsg,
  type InboundMsgInput,
  type OutboundMsgInput,
  type PermissionDecision,
  type SentMessage,
  type ServerEvent,
  type SessionSpec,
  silentLogger,
} from '@beamhop/core';
import { createDaemon, type Daemon, type DaemonOptions, type SandboxFactory } from '../src/index.ts';
import { AsyncQueue } from '../src/util.ts';

export const until = async (
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  what = 'condition',
): Promise<void> => {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`until: timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────────── fake channel ─────────────────────────────

export interface SentRecord {
  id: string;
  msg: OutboundMsgInput;
  text: string;
  edits: string[];
}

export class FakeConn implements ChannelConn {
  readonly provider = 'fake';
  readonly self = { principal: 'fake:bot', displayName: 'Beam Bot', handle: 'beambot' };
  readonly sent: SentRecord[] = [];
  readonly typings: string[] = [];
  readonly queue = new AsyncQueue<InboundMsg>();
  closed = false;
  /** The platform's own history (tests set it to enable `fetchHistory`). */
  history: ChannelHistoryMessage[] | undefined;
  readonly historyQueries: ChannelHistoryQuery[] = [];
  fetchHistory = async (q: ChannelHistoryQuery): Promise<ChannelHistoryMessage[]> => {
    this.historyQueries.push(q);
    if (!this.history) throw new Error('no history api');
    const inThread = (m: ChannelHistoryMessage & { threadId?: string }) =>
      q.threadId && q.threadId !== q.conversation.id ? m.threadId === q.threadId : !m.threadId;
    return this.history
      .filter((m) => inThread(m) && (!q.before || m.at < q.before) && (!q.since || m.at >= q.since))
      .slice(-q.limit);
  };
  private n = 0;
  private buttonHandler: ((p: ButtonPress) => void) | undefined;
  private removedHandler: ((c: string) => void) | undefined;
  constructor(
    readonly name: string,
    readonly capabilities: ChannelConn['capabilities'],
  ) {}
  inbound(): AsyncIterable<InboundMsg> {
    return this.queue;
  }
  onButton(h: (p: ButtonPress) => void) {
    this.buttonHandler = h;
  }
  onRemoved(h: (c: string) => void) {
    this.removedHandler = h;
  }
  async send(msg: OutboundMsgInput): Promise<SentMessage> {
    if (this.closed) throw new Error('closed');
    const rec: SentRecord = { id: `out-${++this.n}`, msg, text: msg.markdown, edits: [] };
    this.sent.push(rec);
    return {
      id: rec.id,
      ...(this.capabilities.edit
        ? {
            edit: async (md: string) => {
              rec.edits.push(md);
              rec.text = md;
            },
          }
        : {}),
    };
  }
  async typing(conversationId: string) {
    this.typings.push(conversationId);
  }
  async close() {
    this.closed = true;
    this.queue.close();
  }

  private seq = 0;
  /** Inject an inbound message (defaults: DM from `fake:alice`). */
  inject(m: Partial<InboundMsgInput> & { text: string }): InboundMsg {
    const id = m.id ?? `in-${++this.seq}-${randomBytes(3).toString('hex')}`;
    const conv = m.conversation ?? { kind: 'dm' as const, id: 'alice' };
    const msg = InboundMsg.parse({
      channel: this.name,
      provider: 'fake',
      threadId: m.threadId ?? conv.id,
      from: { principal: 'fake:alice', displayName: 'Alice' },
      receivedAt: new Date().toISOString(),
      ...m,
      id,
      conversation: conv,
    });
    this.queue.push(msg);
    return msg;
  }
  press(p: Omit<ButtonPress, 'messageId'>) {
    this.buttonHandler?.({ messageId: 'x', ...p });
  }
  kick(conversationId: string) {
    this.removedHandler?.(conversationId);
  }
  /** Messages sent to a conversation (final text). */
  textsTo(convId: string): string[] {
    return this.sent.filter((s) => s.msg.conversation.id === convId).map((s) => s.text);
  }
}

export class FakeChannelPlugin implements ChannelPlugin {
  readonly id = 'fake';
  readonly displayName = 'Fake';
  readonly conns = new Map<string, FakeConn>();
  caps: ChannelConn['capabilities'] = { edit: true, buttons: true, typing: true, files: true, threads: true };
  setup = {
    steps: [
      {
        id: 'token',
        title: 'Token',
        body: 'paste',
        fields: [{ kind: 'secret' as const, id: 'token', label: 'Token' }],
      },
    ],
    validate: async (_v: Record<string, unknown>, s: Record<string, string>) =>
      s.token === 'good'
        ? { ok: true, message: 'ok', identity: { name: 'Beam Bot' } }
        : { ok: false, message: 'bad token' },
  };
  lastCtx: ChannelContext | undefined;
  async connect(ctx: ChannelContext): Promise<FakeConn> {
    this.lastCtx = ctx;
    const c = new FakeConn(ctx.name, { ...this.caps });
    this.conns.set(ctx.name, c);
    return c;
  }
  conn(name = 'fk'): FakeConn {
    const c = this.conns.get(name);
    if (!c) throw new Error(`no fake conn ${name}`);
    return c;
  }
}

// ───────────────────────────── fake harness ─────────────────────────────

export class FakeHarnessSession implements HarnessSession {
  readonly prompts: string[] = [];
  readonly decisions = new Map<string, PermissionDecision>();
  private waiters = new Map<string, (d: PermissionDecision) => void>();
  cancelled = 0;
  closed = false;
  private cancelWaiters: (() => void)[] = [];
  constructor(
    readonly id: string,
    readonly spec: SessionSpec,
    private readonly script: Script,
  ) {}
  prompt(text: string): AsyncIterable<HarnessEvent> {
    this.prompts.push(text);
    return this.script(this, text);
  }
  async respondPermission(id: string, d: PermissionDecision) {
    this.decisions.set(id, d);
    this.waiters.get(id)?.(d);
  }
  waitPermission(id: string): Promise<PermissionDecision> {
    const d = this.decisions.get(id);
    if (d) return Promise.resolve(d);
    return new Promise((r) => this.waiters.set(id, r));
  }
  waitCancel(): Promise<void> {
    return new Promise((r) => this.cancelWaiters.push(r));
  }
  async cancel() {
    this.cancelled++;
    for (const w of this.cancelWaiters.splice(0)) w();
    for (const [id, w] of this.waiters) {
      w({ allow: false, reason: 'cancelled' });
      this.waiters.delete(id);
    }
  }
  async close() {
    this.closed = true;
  }
}

export type Script = (s: FakeHarnessSession, prompt: string) => AsyncIterable<HarnessEvent>;

/** Body of the user message, without the replayed history and the beamhop preamble. */
export const body = (prompt: string): string => {
  const p = prompt.replace(/^<conversation-history[\s\S]*?<\/conversation-history>\n\n/, '');
  return p.split('\n\n').slice(1).join('\n\n') || p;
};

export const defaultScript = (secret = 'unset-secret'): Script =>
  async function* (s, prompt) {
    const text = body(prompt);
    if (text.includes('RUN_SHELL')) {
      yield { type: 'tool_call', id: 't1', name: 'bash', input: { command: 'ls' }, title: 'Run ls' };
      yield { type: 'permission_request', id: 'p1', tool: 'bash', input: { command: 'ls' }, title: 'Run ls' };
      const d = await s.waitPermission('p1');
      yield { type: 'tool_result', id: 't1', ok: d.allow, output: d.allow ? 'file.txt' : '' };
      yield { type: 'text', delta: d.allow ? 'shell allowed' : `shell refused: ${d.reason}` };
      yield { type: 'done', stopReason: 'end_turn' };
      return;
    }
    if (text.includes('SLOW')) {
      yield { type: 'progress', message: 'thinking hard…' };
      yield { type: 'text', delta: 'working' };
      await s.waitCancel();
      yield { type: 'done', stopReason: 'cancelled' };
      return;
    }
    if (text.includes('LEAK')) {
      yield { type: 'text', delta: `here is the key: ${secret} done` };
      yield { type: 'done', stopReason: 'end_turn' };
      return;
    }
    if (text.includes('SPEND')) {
      yield { type: 'usage', inputTokens: 1000, outputTokens: 500, costUsd: 1.5 };
    }
    yield { type: 'text', delta: 'reply: ' };
    yield { type: 'text', delta: text.slice(0, 200) };
    yield { type: 'done', stopReason: 'end_turn', resume: `resume-${s.id}` };
  };

export class FakeHarnessPlugin implements HarnessPlugin {
  readonly displayName = 'Fake Harness';
  readonly sessions: FakeHarnessSession[] = [];
  constructor(
    public script: Script = defaultScript(),
    readonly id = 'fake',
  ) {}
  async detect() {
    return {
      id: this.id,
      displayName: this.displayName,
      command: 'fake',
      status: 'ready' as const,
      protocol: 'acp' as const,
    };
  }
  async start(spec: SessionSpec): Promise<FakeHarnessSession> {
    const s = new FakeHarnessSession(spec.sessionId, spec, (sess, p) => this.script(sess, p));
    this.sessions.push(s);
    return s;
  }
  latest(): FakeHarnessSession {
    const s = this.sessions.at(-1);
    if (!s) throw new Error('no harness session');
    return s;
  }
}

export const fakeSandbox: SandboxFactory = async (policy, o) => ({
  policy,
  backend: 'none',
  wrap: async (cmd, args) => ({ cmd, args, env: { ...o.env } }),
  close: async () => {},
});

// ───────────────────────────── harness ─────────────────────────────

export interface TestEnv {
  d: Daemon;
  home: string;
  channel: FakeChannelPlugin;
  harness: FakeHarnessPlugin;
  secrets: MemorySecretStore;
  clock: { t: number };
  events: ServerEvent[];
  client: BeamhopClient;
  conn: () => FakeConn;
  close(): Promise<void>;
}

export const tmpHome = (): string => realpathSync(mkdtempSync(join(tmpdir(), 'bh-daemon-')));

export const makeEnv = async (
  opts: Partial<DaemonOptions> & {
    harness?: FakeHarnessPlugin;
    channel?: FakeChannelPlugin;
    home?: string;
  } = {},
): Promise<TestEnv> => {
  const home = opts.home ?? tmpHome();
  const channel = opts.channel ?? new FakeChannelPlugin();
  const harness = opts.harness ?? new FakeHarnessPlugin();
  const secrets = (opts.secrets as MemorySecretStore | undefined) ?? new MemorySecretStore();
  const clock = { t: Date.parse('2026-11-13T10:00:00Z') };
  const d = await createDaemon({
    home,
    log: silentLogger,
    now: () => clock.t,
    secrets,
    dataKey: opts.dataKey ?? Buffer.alloc(32, 7),
    plugins: { channels: [channel], harnesses: [harness] },
    api: false,
    llmProxy: false,
    sandbox: fakeSandbox,
    tickMs: 0,
    approvalUndoMs: 40,
    editThrottleMs: 5,
    ...opts,
  });
  const events: ServerEvent[] = [];
  d.subscribe((e) => events.push(e));
  const client = createClient(
    directTransport((method, params) => d.call(method, params), { subscribe: (fn) => d.subscribe(fn) }),
  );
  return {
    d,
    home,
    channel,
    harness,
    secrets,
    clock,
    events,
    client,
    conn: () => channel.conn('fk'),
    close: async () => {
      await d.stop();
      if (!opts.home) rmSync(home, { recursive: true, force: true });
    },
  };
};

/** Add the fake channel `fk` and an agent `bot` joined to `fk:dm` (and optionally a group). */
export const setupBot = async (env: TestEnv, agent: Record<string, unknown> = {}) => {
  await env.client.call('channel.add', {
    name: 'fk',
    provider: 'fake',
    values: {},
    secrets: { token: 'good' },
  });
  await env.client.call('agent.create', {
    config: {
      name: 'bot',
      harness: 'fake',
      memberships: [
        { target: 'fk:dm', defaultRole: 'viewer', triggers: ['dm', 'mention', 'reply'] },
        { target: 'fk:group/g1', defaultRole: 'user', triggers: ['mention', 'reply'] },
      ],
      budgets: { dailyUsd: 5 },
      ...agent,
    },
  });
  await until(() => env.channel.conns.has('fk'), 2000, 'channel connect');
  return env.conn();
};

/** Make `fake:alice` the owner. */
export const ownerAlice = async (env: TestEnv) => env.client.call('owner.add', { principal: 'fake:alice' });
