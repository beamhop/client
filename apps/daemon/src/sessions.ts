/**
 * Session runner (§6A.5, §6A.8, §7): one live session per thread, sandbox + broker + MCP bridge +
 * git worktrees, harness start/resume, streaming output, usage and budgets.
 */
import { mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { baseChannelName, budgetKey, modeRank, normalizePrincipal, stricterMode } from '@beamhop/authz';
import { envForHarness } from '@beamhop/broker';
import {
  type AgentConfig,
  type Attachment,
  BeamhopError,
  type ChannelConn,
  type HarnessEvent,
  type HarnessSession,
  type InboundMsg,
  type Membership,
  type Mount,
  newId,
  type PermissionMode,
  paths,
  type RoleDef,
  type SandboxProfileName,
  type SessionEventView,
} from '@beamhop/core';
import { mcpReadPaths } from '@beamhop/mcp';
import { compilePolicy, LLM_PROVIDER_HOSTS } from '@beamhop/sandbox';
import type { NewSessionEvent, SessionRecord } from '@beamhop/store';
import type { Daemon, DaemonSandbox } from './daemon.ts';
import { sandboxGitWritePaths } from './git-ops.ts';
import { sessionCredentials } from './harness-auth.ts';
import { ReplyStreamer } from './output.ts';
import { killSessionTree, SESSION_ENV_MARKER } from './proctree.ts';
import { errMsg, Mutex, personBudgetKey, Semaphore, slugify, withTimeout } from './util.ts';
import { addWorktree, gitTopLevel, type Worktree } from './worktree.ts';

const CONV_KIND_NS = 'conv-kind';
const CONV_KINDS = ['dm', 'group', 'channel', 'public'] as const;

export interface Turn {
  text: string;
  /** Build the harness prompt (channel preamble) once attachments have local paths. */
  promptFor: (msg?: InboundMsg) => string;
  msg?: InboundMsg;
  from: { principal: string; displayName?: string; role: string };
  role: RoleDef;
  attachments: Attachment[];
  replyToId?: string;
  /** `hops` tag for outgoing replies (mesh). */
  hops: number;
  peer?: string;
  source: 'channel' | 'api' | 'schedule';
  /** Resolves when the turn finished (tests, schedule.run). */
  done?: (r: { ok: boolean; text: string; error?: string }) => void;
}

export interface ThreadKey {
  agent: string;
  channel: string;
  conversationId: string;
  threadId: string;
}

export interface Overrides {
  model?: string;
  harness?: string;
  mode?: PermissionMode;
}

interface Runtime {
  harness: HarnessSession;
  sandbox: DaemonSandbox;
  harnessId: string;
  model: string;
  profile: SandboxProfileName;
  mode: PermissionMode;
  proxyToken?: string;
  mcpToken: string;
  worktrees: Worktree[];
  /** Effective mounts (worktree-mapped). */
  mounts: { path: string; mode: 'ro' | 'rw'; lockKey?: string }[];
  deny: string[];
  /** The session's own dirs carved out of `deny` (session dir, worktrees). */
  own: string[];
  offViolation?: () => void;
}

export interface ToolLogEntry {
  id: string;
  name: string;
  title?: string;
  input?: unknown;
  ok?: boolean;
  output?: string;
  at: string;
}

const PROFILE_RANK: Record<SandboxProfileName, number> = { strict: 0, workspace: 1, custom: 2 };
/** The stricter of agent and role sandbox profile: strict wins, else the agent's own profile. */
export const stricterProfile = (agent: SandboxProfileName, role: SandboxProfileName): SandboxProfileName =>
  agent === 'strict' || role === 'strict' ? 'strict' : agent;

const ATTACHMENT_LIMIT: Record<string, number> = {
  owner: 50 * 1024 * 1024,
  admin: 50 * 1024 * 1024,
  user: 20 * 1024 * 1024,
};
const attachmentLimit = (role: string) => ATTACHMENT_LIMIT[role] ?? 5 * 1024 * 1024;

const threadKeyStr = (k: ThreadKey) => JSON.stringify([k.agent, k.channel, k.conversationId, k.threadId]);

export class LiveSession {
  readonly queue: Turn[] = [];
  running = false;
  runtime: Runtime | undefined;
  overrides: Overrides = {};
  readonly alwaysAllow = new Set<string>();
  readonly toolLog: ToolLogEntry[] = [];
  current: { abort: AbortController; turn: Turn; startedAt: number } | undefined;
  brokerSeen = false;
  ended = false;
  lastTurnRole: RoleDef | undefined;
  lastTurn: Turn | undefined;
  readonly dir: string;
  readonly inbox: string;
  readonly target: string;

  constructor(
    private readonly d: Daemon,
    readonly id: string,
    readonly key: ThreadKey,
    readonly conversationKind: 'dm' | 'group' | 'channel' | 'public',
    public membership: Membership | undefined,
  ) {
    this.dir = join(paths(d.home).sessions, id);
    this.inbox = join(this.dir, 'inbox');
    mkdirSync(this.inbox, { recursive: true, mode: 0o700 });
    this.target = `${key.channel}:${conversationKind}/${key.conversationId}`;
  }

  get agent(): string {
    return this.key.agent;
  }

  record(): SessionRecord {
    return this.d.store.sessions.require(this.id);
  }

  conn(): ChannelConn | undefined {
    return this.d.channels.get(this.key.channel);
  }
}

export interface SubmitInput {
  agent: AgentConfig;
  channel: string;
  conversation: { kind: 'dm' | 'group' | 'channel' | 'public'; id: string };
  threadId: string;
  membership?: Membership;
  turn: Turn;
  title?: string;
  /** Force a brand-new session (session.start). */
  fresh?: boolean;
}

export class SessionManager {
  private readonly lives = new Map<string, LiveSession>();
  private readonly byThread = new Map<string, string>();
  private readonly semaphores = new Map<string, Semaphore>();
  private readonly mountLocks = new Map<string, Mutex>();
  private readonly tokenToSession = new Map<string, string>();
  private readonly errors = new Map<string, string>();
  private readonly reservations = new Map<string, { usd: number; at: number }[]>();

  constructor(private readonly d: Daemon) {}

  live(id: string): LiveSession | undefined {
    return this.lives.get(id);
  }

  all(): LiveSession[] {
    return [...this.lives.values()];
  }

  activeCount(agent: string): number {
    return this.d.store.sessions.list({ agent, status: ['running', 'idle', 'queued'] }).length;
  }

  isBusy(agent: string): boolean {
    return this.all().some((s) => s.agent === agent && s.running);
  }

  agentError(agent: string): string | undefined {
    return this.errors.get(agent);
  }

  private semaphore(agent: AgentConfig): Semaphore {
    let s = this.semaphores.get(agent.name);
    if (!s) {
      s = new Semaphore(agent.concurrency.maxSessions);
      this.semaphores.set(agent.name, s);
    }
    s.limit = agent.concurrency.maxSessions;
    return s;
  }

  private emitSession(id: string): void {
    const s = this.d.store.sessions.get(id);
    if (s) this.d.emit({ type: 'session.updated', session: stripRecord(s) });
  }

  private setStatus(live: LiveSession, status: SessionRecord['status']): void {
    this.d.store.sessions.update(live.id, { status });
    this.emitSession(live.id);
    this.d.emitAgent(live.agent);
  }

  event(sessionId: string, ev: NewSessionEvent): SessionEventView {
    const out = this.d.store.sessions.appendEvent(sessionId, ev);
    this.d.emit({ type: 'session.event', sessionId, event: out });
    return out;
  }

  /** Replace an event's text (same seq) and push it again; used for streaming assistant text. */
  updateEvent(sessionId: string, seq: number, text: string): void {
    try {
      const out = this.d.store.sessions.updateEventText(sessionId, seq, text);
      if (out) this.d.emit({ type: 'session.event', sessionId, event: out });
    } catch (e) {
      this.d.log.warn('transcript update failed', { error: errMsg(e) });
    }
  }

  findForThread(key: ThreadKey): LiveSession | undefined {
    const id = this.byThread.get(threadKeyStr(key));
    const live = id ? this.lives.get(id) : undefined;
    return live && !live.ended ? live : undefined;
  }

  private attach(live: LiveSession): void {
    this.lives.set(live.id, live);
    this.byThread.set(threadKeyStr(live.key), live.id);
  }

  /** Get or create the session for a thread (idle timeout → new session). */
  private sessionFor(input: SubmitInput): LiveSession {
    const d = this.d;
    const key: ThreadKey = {
      agent: input.agent.name,
      channel: input.channel,
      conversationId: input.conversation.id,
      threadId: input.threadId,
    };
    let live = input.fresh ? undefined : this.findForThread(key);
    const idleCut = d.now() - input.agent.sessionIdleMinutes * 60_000;
    if (
      live &&
      !live.running &&
      live.queue.length === 0 &&
      Date.parse(live.record().lastActivityAt) < idleCut
    ) {
      void this.end(live, 'idle timeout');
      live = undefined;
    }
    if (!live && !input.fresh) {
      // Re-attach a stored active session (e.g. after a daemon restart), unless idle.
      const rec = d.store.sessions.findActive(key.agent, key.channel, key.conversationId, key.threadId);
      if (rec && Date.parse(rec.lastActivityAt) >= idleCut) {
        live = new LiveSession(d, rec.id, key, input.conversation.kind, input.membership);
        this.attach(live);
      } else if (rec) d.store.sessions.update(rec.id, { status: 'ended' });
    }
    if (!live) {
      const rec = d.store.sessions.create({
        agent: key.agent,
        channel: key.channel,
        conversationId: key.conversationId,
        threadId: key.threadId,
        title: input.title ?? input.turn.text.slice(0, 80),
        status: 'idle',
        principal: input.turn.from.principal,
        harness: input.agent.harness,
      });
      live = new LiveSession(d, rec.id, key, input.conversation.kind, input.membership);
      this.attach(live);
      this.emitSession(rec.id);
    }
    if (input.membership) live.membership = input.membership;
    this.rememberKind(key, input.conversation.kind);
    return live;
  }

  /** Queue a turn for the thread's session. Returns the session. */
  async submit(input: SubmitInput): Promise<LiveSession> {
    const live = this.sessionFor(input);
    live.queue.push(input.turn);
    if (!live.running) void this.drain(live, input.agent.name);
    return live;
  }

  private async drain(live: LiveSession, agentName: string): Promise<void> {
    if (live.running) return;
    live.running = true;
    try {
      while (live.queue.length && !live.ended) {
        const turn = live.queue.shift()!;
        let agent: AgentConfig;
        try {
          agent = this.d.agent(agentName);
        } catch {
          turn.done?.({ ok: false, text: '', error: 'agent deleted' });
          continue;
        }
        await this.runTurn(live, agent, turn).catch((e) => {
          this.d.log.error('turn failed', { session: live.id, error: errMsg(e) });
          turn.done?.({ ok: false, text: '', error: errMsg(e) });
        });
      }
    } finally {
      live.running = false;
      if (!live.ended && this.d.store.sessions.get(live.id)?.status !== 'ended') this.setStatus(live, 'idle');
    }
  }

  // ───────────────────────────── runtime ─────────────────────────────

  private effectiveMode(role: RoleDef, override?: PermissionMode): PermissionMode {
    if (!override) return role.permissionMode;
    return role.name === 'owner' ? override : stricterMode(role.permissionMode, override);
  }

  /** Role used for tool checks this turn: owner `/mode` overrides replace, others only tighten. */
  checkRole(live: LiveSession, role: RoleDef): { role: RoleDef; mode?: PermissionMode } {
    const o = live.overrides.mode;
    if (!o) return { role };
    if (role.name === 'owner') return { role: { ...role, permissionMode: o } };
    return { role, mode: o };
  }

  private async ensureRuntime(live: LiveSession, agent: AgentConfig, role: RoleDef): Promise<Runtime> {
    const harnessId = live.overrides.harness ?? agent.harness;
    const model = live.overrides.model ?? agent.model;
    const profile = stricterProfile(agent.sandbox.profile, role.sandboxProfile);
    const mode = this.effectiveMode(role, live.overrides.mode);
    const rt = live.runtime;
    if (
      rt &&
      rt.harnessId === harnessId &&
      rt.model === model &&
      PROFILE_RANK[rt.profile] <= PROFILE_RANK[profile] &&
      modeRank(rt.mode) <= modeRank(mode)
    )
      return rt;
    if (rt) await this.closeRuntime(live, { hard: false });
    return this.createRuntime(live, agent, harnessId, model, profile, mode);
  }

  private async prepareMounts(
    live: LiveSession,
    agent: AgentConfig,
  ): Promise<{ mounts: Runtime['mounts']; worktrees: Worktree[] }> {
    const d = this.d;
    const mounts: Runtime['mounts'] = [];
    const worktrees: Worktree[] = [];
    const rec = live.record();
    let gitIndex = 0;
    for (const m of agent.mounts as Mount[]) {
      const path = expand(m.path);
      if (m.mode !== 'rw') {
        mounts.push({ path, mode: 'ro' });
        continue;
      }
      const top = await gitTopLevel(path);
      if (top) {
        const dir = join(paths(d.home).worktrees, gitIndex === 0 ? live.id : `${live.id}-${gitIndex}`);
        gitIndex++;
        const wt = await addWorktree({ mount: path, repo: top, dir, thread: live.key.threadId });
        worktrees.push(wt);
        mounts.push({ path: wt.mountPath, mode: 'rw' });
        if (worktrees.length === 1 && !rec.worktree)
          d.store.sessions.update(live.id, { worktree: { path: wt.path, branch: wt.branch } });
        continue;
      }
      mounts.push({ path, mode: 'rw', ...(m.parallelUnsafe ? {} : { lockKey: path }) });
    }
    return { mounts, worktrees };
  }

  private async createRuntime(
    live: LiveSession,
    agent: AgentConfig,
    harnessId: string,
    model: string,
    profile: SandboxProfileName,
    mode: PermissionMode,
  ): Promise<Runtime> {
    const d = this.d;
    const plugin = d.registry.harness(harnessId);
    if (!plugin) throw new BeamhopError('unavailable', `harness "${harnessId}" is not installed`);
    const { mounts, worktrees } = await this.prepareMounts(live, agent);
    const o = (agent.sandbox.policy ?? {}) as NonNullable<Parameters<typeof compilePolicy>[2]>;
    // Only objects, beamhop/* refs and the worktree's own admin dir: never the repo's config or
    // hooks, which unsandboxed git (the owner's, or the daemon's merge/PR) would run (wave C GIT-1).
    const gitWrite = (await Promise.all(worktrees.map((w) => sandboxGitWritePaths(w.path, w.repo)))).flat();
    const extraWrite = profile === 'strict' ? [] : [live.dir, ...gitWrite];
    const home = paths(d.home);
    const policy = compilePolicy(
      profile,
      mounts.map((m) => ({ path: m.path, mode: m.mode })),
      {
        ...o,
        fs: {
          ...(o.fs ?? {}),
          // The injected beamhop-mcp stdio server (package, deps, node) must be readable inside.
          read: [...(o.fs?.read ?? []), live.dir, ...MCP_READ_PATHS()],
          write: [...(o.fs?.write ?? []), ...extraWrite],
          // The actual beamhop home (token, data key, other sessions), also when BEAMHOP_HOME is not
          // ~/.beamhop, which ALWAYS_DENY_READ covers.
          deny: [...(o.fs?.deny ?? []), d.home],
        },
      },
      // The session dir and its worktrees live in the beamhop home: carve exactly those back out,
      // or a harness started in them cannot read its own cwd (and dies before answering).
      { own: { dirs: [live.dir, ...worktrees.map((w) => w.path)], beamhopHome: home.home } },
    );
    // With the broker in place the sandbox never talks to LLM providers directly (no own-key exfiltration).
    if (d.llmProxy) {
      const llm = new Set<string>(LLM_PROVIDER_HOSTS);
      policy.net.allow = policy.net.allow.filter((h) => !llm.has(h));
    }
    // The harness's own service (catalog `network`, e.g. GitHub Copilot's API), unless the agent denies it.
    for (const h of plugin.network ?? [])
      if (!policy.net.deny.includes(h) && !policy.net.allow.includes(h)) policy.net.allow.push(h);
    const env: Record<string, string> = { [SESSION_ENV_MARKER]: live.id, BEAMHOP_SESSION_DIR: live.dir };
    // The harness keeps its config/state in the session dir (writable), not in the user's own ~/.copilot & co.
    if (plugin.homeEnv) {
      const harnessHome = join(live.dir, 'harness-home');
      mkdirSync(harnessHome, { recursive: true, mode: 0o700 });
      env[plugin.homeEnv] = harnessHome;
    }
    // Env-kind harness login (Copilot's token) or the agent's own secretEnv override. The harness can
    // read these values (DLP still redacts them from messages); broker-kind logins never reach it.
    const credentials = await sessionCredentials(d.secrets, agent, harnessId, plugin.displayName);
    let proxyToken: string | undefined;
    if (d.llmProxy) {
      proxyToken = d.llmProxy.createSession(live.id);
      this.tokenToSession.set(proxyToken, live.id);
      Object.assign(env, envForHarness(harnessId, d.llmProxy.url, proxyToken));
    }
    Object.assign(env, credentials);
    const mcpToken = d.mcpBridge.addSession({ sessionId: live.id });
    const mcp = d.mcpBridge.spec(mcpToken);
    let sandbox: DaemonSandbox | undefined;
    try {
      sandbox = await d.sandboxFactory(policy, {
        env,
        ...(d.llmProxy ? { brokerPort: d.llmProxy.port } : {}),
        localAllow: [`127.0.0.1:${d.mcpBridge.port}`],
        ...(plugin.macosTrustd ? { macosTrustd: true } : {}),
        log: d.log.child({ session: live.id }),
      });
      for (const w of sandbox.warnings ?? []) this.event(live.id, { kind: 'system', text: w });
      const seen = new Set<string>();
      const offViolation = sandbox.onViolation?.((v) => {
        const k = `${v.kind}|${v.value}`;
        if (policy.learning) d.store.policySuggestions.record(agent.name, v.kind, v.value);
        if (seen.has(k)) return;
        seen.add(k);
        d.audit({
          type: 'sandbox.violation',
          severity: 'security',
          summary: `Sandbox ${v.allowed ? 'logged' : 'blocked'} ${v.kind === 'net.allow' ? 'network access to' : v.kind === 'fs.write' ? 'a write to' : 'a read of'} ${v.value}`,
          actor: `agent:${agent.name}`,
          agent: agent.name,
          data: { kind: v.kind, value: v.value, session: live.id, learning: policy.learning },
        });
      });
      const cwd = mounts.find((m) => m.mode === 'rw')?.path ?? mounts[0]?.path ?? live.dir;
      const resume = d.store.sessions.resumeToken(live.id);
      const harness = await plugin.start(
        {
          sessionId: live.id,
          agent: agent.name,
          model,
          cwd,
          mounts: mounts.map((m) => ({ path: m.path, mode: m.mode })),
          permissionMode: mode,
          env: { ...env },
          mcpServers: [mcp],
          ...(resume ? { resume } : {}),
        },
        sandbox,
      );
      const rt: Runtime = {
        harness,
        sandbox,
        harnessId,
        model,
        profile,
        mode,
        mcpToken,
        worktrees,
        mounts,
        deny: policy.fs.deny,
        own: policy.fs.own,
        ...(proxyToken ? { proxyToken } : {}),
        ...(offViolation ? { offViolation } : {}),
      };
      live.runtime = rt;
      d.store.sessions.update(live.id, { harness: harnessId });
      this.errors.delete(agent.name);
      return rt;
    } catch (e) {
      d.mcpBridge.removeSession(mcpToken);
      if (proxyToken) {
        d.llmProxy?.revokeSession(proxyToken);
        this.tokenToSession.delete(proxyToken);
      }
      await sandbox?.close().catch(() => {});
      this.errors.set(agent.name, errMsg(e));
      throw e;
    }
  }

  private async closeRuntime(live: LiveSession, opts: { hard: boolean }): Promise<void> {
    const rt = live.runtime;
    if (!rt) return;
    live.runtime = undefined;
    const d = this.d;
    if (opts.hard) {
      void rt.harness.cancel().catch(() => {});
      killSessionTree(live.id);
      void rt.harness.close().catch(() => {});
    } else {
      await withTimeout(
        rt.harness.close().catch(() => {}),
        5000,
      );
      killSessionTree(live.id);
    }
    rt.offViolation?.();
    d.mcpBridge.removeSession(rt.mcpToken);
    if (rt.proxyToken) {
      d.llmProxy?.revokeSession(rt.proxyToken);
      this.tokenToSession.delete(rt.proxyToken);
    }
    await rt.sandbox.close().catch(() => {});
  }

  // ───────────────────────────── turns ─────────────────────────────

  private dlpFor(live: LiveSession, turn: Turn) {
    return this.d.dlpFor(live.conversationKind, turn.role.name, live.membership?.defaultRole);
  }

  private async download(
    live: LiveSession,
    conn: ChannelConn | undefined,
    turn: Turn,
  ): Promise<Attachment[]> {
    const out: Attachment[] = [];
    const limit = attachmentLimit(turn.role.name);
    let i = 0;
    for (const a of turn.attachments) {
      i++;
      const dest = join(
        live.inbox,
        `${Date.now().toString(36)}-${i}-${slugify(basename(a.name || 'file'), 80)}`,
      );
      try {
        if (a.size !== undefined && a.size > limit)
          throw new Error(`file exceeds ${limit} bytes for role ${turn.role.name}`);
        const dl = (
          conn as unknown as {
            downloadFile?: (ref: string, dest: string, o: { maxBytes: number }) => Promise<unknown>;
          }
        )?.downloadFile;
        const isHttp = !!a.url && /^https?:\/\//i.test(a.url);
        // Channel file references (e.g. `telegram-file:<id>`) go through the channel's own API;
        // plain URLs (Nostr, Discord CDN, …) only through the SSRF-safe fetch, never a bare fetch.
        if (a.url && !isHttp && typeof dl === 'function')
          await dl.call(conn, a.url, dest, { maxBytes: limit });
        else if (a.url && isHttp) await this.d.fetcher.download(a.url, dest, { maxBytes: limit });
        else continue;
        out.push({ ...a, localPath: dest });
      } catch (e) {
        this.event(live.id, { kind: 'error', text: `attachment ${a.name} not downloaded: ${errMsg(e)}` });
      }
    }
    return out;
  }

  private async runTurn(live: LiveSession, agent: AgentConfig, turn: Turn): Promise<void> {
    const d = this.d;
    const conn = live.conn();
    const say = async (markdown: string) => {
      if (!conn) return;
      await d.sendOutbound(
        conn,
        {
          conversation: { kind: live.conversationKind, id: live.key.conversationId },
          threadId: live.key.threadId,
          ...(turn.replyToId ? { replyToId: turn.replyToId } : {}),
          markdown,
          ...(turn.hops ? { hops: turn.hops } : {}),
        },
        { agent: agent.name, dlp: this.dlpFor(live, turn), recipient: turn.from.principal },
      );
    };

    // Session-minute budget (role and agent).
    const rec = live.record();
    const minutes = minDefined(turn.role.budget.perSessionMinutes, agent.budgets.perSessionMinutes);
    const sessCheck = d.budgets.checkSession(Date.parse(rec.startedAt), { perSessionMinutes: minutes });
    if (!sessCheck.ok) {
      await say(`⏳ ${sessCheck.message}. Send /new to start a new session.`);
      this.event(live.id, { kind: 'system', text: sessCheck.message });
      turn.done?.({ ok: false, text: '', error: sessCheck.message });
      return;
    }
    const daily = d.budgets.checkDaily(budgetKey.agent(agent.name), agent.budgets);
    if (!daily.ok) {
      await say(`⏳ ${daily.message}`);
      turn.done?.({ ok: false, text: '', error: daily.message });
      return;
    }

    const abort = new AbortController();
    let release: (() => void) | undefined;
    try {
      release = await this.semaphore(agent).acquire({
        signal: abort.signal,
        onQueued: () => this.setStatus(live, 'queued'),
      });
    } catch {
      return;
    }
    if (live.ended || d.isPanic()) {
      release();
      turn.done?.({ ok: false, text: '', error: 'session ended' });
      return;
    }
    live.current = { abort, turn, startedAt: d.now() };
    live.lastTurnRole = turn.role;
    live.lastTurn = turn;
    this.setStatus(live, 'running');
    const locks: (() => void)[] = [];
    const streamer = conn
      ? new ReplyStreamer(
          {
            canEdit: conn.capabilities.edit,
            send: (md) =>
              d.sendOutbound(
                conn,
                {
                  conversation: { kind: live.conversationKind, id: live.key.conversationId },
                  threadId: live.key.threadId,
                  ...(turn.replyToId ? { replyToId: turn.replyToId } : {}),
                  markdown: md,
                  ...(turn.hops ? { hops: turn.hops } : {}),
                },
                { agent: agent.name, dlp: this.dlpFor(live, turn), recipient: turn.from.principal },
              ),
            ...(conn.capabilities.typing && conn.typing
              ? { typing: () => conn.typing!(live.key.conversationId) }
              : {}),
          },
          { throttleMs: d.opts.editThrottleMs ?? 1000, now: d.now },
        )
      : undefined;
    let text = '';
    let error: string | undefined;
    let watchdog: NodeJS.Timeout | undefined;
    const pendingPerms: Promise<void>[] = [];
    const transcript = new AssistantStream(this, live.id);
    try {
      const rt = await this.ensureRuntime(live, agent, turn.role);
      for (const m of rt.mounts) {
        if (!m.lockKey) continue;
        let mu = this.mountLocks.get(m.lockKey);
        if (!mu) {
          mu = new Mutex();
          this.mountLocks.set(m.lockKey, mu);
        }
        if (mu.locked) streamer?.onProgress('waiting for another session to finish writing…');
        locks.push(await mu.acquire());
      }
      const files = await this.download(live, conn, turn);
      const prompt = turn.msg ? turn.promptFor({ ...turn.msg, attachments: files }) : turn.promptFor();
      this.event(live.id, { kind: 'user', from: turn.from, text: turn.text });
      streamer?.start();
      if (minutes) {
        const left = Date.parse(rec.startedAt) + minutes * 60_000 - d.now();
        watchdog = setTimeout(
          () => {
            error = `session limit of ${minutes} minutes reached`;
            abort.abort();
            void rt.harness.cancel().catch(() => {});
          },
          Math.max(1000, left),
        );
        watchdog.unref?.();
      }
      const it = rt.harness.prompt(
        prompt,
        files.filter((f) => f.localPath).map((f) => ({ path: f.localPath!, mime: f.mime })),
      );
      for await (const ev of it as AsyncIterable<HarnessEvent>) {
        if (abort.signal.aborted && ev.type !== 'done') continue;
        switch (ev.type) {
          case 'text':
            text += ev.delta;
            streamer?.onText(ev.delta);
            transcript.add(ev.delta);
            break;
          case 'thinking':
            break;
          case 'progress':
            streamer?.onProgress(ev.message);
            this.event(live.id, { kind: 'progress', text: ev.message });
            break;
          case 'tool_call': {
            transcript.close();
            const entry: ToolLogEntry = {
              id: ev.id,
              name: ev.name,
              input: ev.input,
              at: new Date(d.now()).toISOString(),
            };
            if (ev.title) entry.title = ev.title;
            live.toolLog.push(entry);
            if (live.toolLog.length > 200) live.toolLog.shift();
            this.event(live.id, {
              kind: 'tool_call',
              tool: { id: ev.id, name: ev.name, input: ev.input, ...(ev.title ? { title: ev.title } : {}) },
            });
            if (ev.title) streamer?.onProgress(ev.title);
            break;
          }
          case 'tool_result': {
            transcript.close();
            const entry = live.toolLog.find((t) => t.id === ev.id);
            if (entry) {
              entry.ok = ev.ok;
              if (ev.output !== undefined) entry.output = ev.output.slice(0, 2000);
            }
            this.event(live.id, {
              kind: 'tool_result',
              tool: {
                id: ev.id,
                name: entry?.name ?? 'tool',
                ok: ev.ok,
                ...(ev.output !== undefined ? { output: ev.output.slice(0, 20_000) } : {}),
                ...(ev.diff !== undefined ? { diff: ev.diff.slice(0, 50_000) } : {}),
              },
            });
            break;
          }
          case 'permission_request': {
            transcript.close();
            const p = d.approvals
              .requestTool(live, agent, turn, ev)
              .then((decision) => rt.harness.respondPermission(ev.id, decision))
              .catch((e) => d.log.warn('permission response failed', { error: errMsg(e) }));
            pendingPerms.push(p);
            break;
          }
          case 'usage':
            this.usage(
              live,
              agent,
              turn,
              { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, usd: ev.costUsd ?? 0 },
              'harness',
            );
            this.event(live.id, {
              kind: 'usage',
              text: `${ev.inputTokens} in / ${ev.outputTokens} out${ev.costUsd !== undefined ? ` / $${ev.costUsd.toFixed(4)}` : ''}`,
            });
            break;
          case 'error':
            transcript.close();
            error = ev.message;
            this.event(live.id, { kind: 'error', text: ev.message });
            break;
          case 'done':
            if (ev.resume) d.store.sessions.update(live.id, { resume: ev.resume });
            break;
        }
      }
    } catch (e) {
      transcript.close();
      error = errMsg(e);
      this.event(live.id, { kind: 'error', text: error });
    } finally {
      if (watchdog) clearTimeout(watchdog);
      for (const l of locks) l();
      const stopped = abort.signal.aborted;
      const elapsedMin = (d.now() - (live.current?.startedAt ?? d.now())) / 60_000;
      live.current = undefined;
      release();
      transcript.close();
      // A turn that failed on its own (not stopped, not the session watchdog) is an agent crash (§9B).
      if (error && !stopped)
        d.audit({
          type: 'agent.crash',
          severity: 'warn',
          summary: `${agent.name} failed: ${error.slice(0, 200)}`,
          actor: `agent:${agent.name}`,
          agent: agent.name,
          data: { session: live.id },
        });
      this.usage(live, agent, turn, { minutes: elapsedMin }, 'clock');
      if (streamer) {
        const fallback = error ? `⚠️ ${error}` : stopped ? '⏹ Stopped.' : undefined;
        if (error && text.trim()) streamer.onText(`\n\n⚠️ ${error}`);
        await streamer.finish(fallback).catch(() => {});
      }
      void Promise.allSettled(pendingPerms);
      turn.done?.({ ok: !error, text, ...(error ? { error } : {}) });
    }
  }

  // ───────────────────────────── usage & budgets ─────────────────────────────

  private usage(
    live: LiveSession,
    agent: AgentConfig,
    turn: Turn | undefined,
    u: { inputTokens?: number; outputTokens?: number; usd?: number; minutes?: number },
    source: 'harness' | 'broker' | 'clock',
  ): void {
    const d = this.d;
    if (source === 'broker') live.brokerSeen = true;
    // The broker counts tokens itself; harness-reported usage is only used when no broker data exists.
    if (source === 'harness' && live.brokerSeen) return;
    const tokens = (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
    const usd = u.usd ?? 0;
    const minutes = u.minutes ?? 0;
    if (tokens || usd)
      d.store.sessions.addUsage(live.id, {
        inputTokens: u.inputTokens ?? 0,
        outputTokens: u.outputTokens ?? 0,
        usd,
      });
    d.store.usage.add({
      agent: agent.name,
      channel: live.key.channel,
      ...(turn?.peer ? { peer: turn.peer } : {}),
      inputTokens: u.inputTokens ?? 0,
      outputTokens: u.outputTokens ?? 0,
      usd,
      minutes,
    });
    const delta = { tokens, usd, minutes };
    const agentKey = budgetKey.agent(agent.name);
    const before = d.budgets.usage(agentKey);
    d.budgets.record(agentKey, delta, agent.budgets);
    const rules = d.alerts.rules();
    const crossings = budgetCrossings(before, d.budgets.usage(agentKey), agent.budgets, [
      rules.budgetWarn / 100,
      rules.budgetAlert / 100,
    ]);
    if (turn) {
      d.budgets.record(
        budgetKey.principal(agent.name, normalizePrincipal(turn.from.principal)),
        delta,
        turn.role.budget,
      );
      const personKey = personBudgetKey(agent.name, d.global().people, turn.from.principal);
      if (personKey) d.budgets.record(personKey, delta, turn.role.budget);
      if (turn.peer)
        d.budgets.record(
          budgetKey.peer(agent.name, normalizePrincipal(turn.peer)),
          delta,
          agent.mesh.perPeerBudget,
        );
    }
    for (const c of crossings) {
      const pct = Math.round(c.threshold * 100);
      const what =
        c.metric === 'usd' ? `$${c.used.toFixed(2)} of $${c.limit}` : `${c.used} of ${c.limit} tokens`;
      d.audit({
        type: 'budget.alert',
        severity: c.threshold >= 1 ? 'security' : 'warn',
        summary: `${agent.name} used ${pct}% of its daily budget (${what})`,
        actor: 'system:budget',
        agent: agent.name,
        data: { metric: c.metric, threshold: c.threshold, used: c.used, limit: c.limit },
      });
      d.alerts.dmOwners(`💸 *${agent.name}* has used ${pct}% of its daily budget (${what}).`);
    }
    if (tokens || usd) this.emitSession(live.id);
  }

  onBrokerUsage(token: string, u: { inputTokens: number; outputTokens: number; costUsd?: number }): void {
    const id = this.tokenToSession.get(token);
    const live = id ? this.lives.get(id) : undefined;
    if (!live) return;
    this.settleReservation(live.id);
    try {
      this.usage(
        live,
        this.d.agent(live.agent),
        live.current?.turn ?? live.lastTurn,
        {
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          usd: u.costUsd ?? 0,
        },
        'broker',
      );
    } catch {
      /* agent deleted */
    }
  }

  private settleReservation(sessionId: string): void {
    const list = this.reservations.get(sessionId);
    if (list?.length) list.shift();
  }

  /**
   * Broker budget gate. Reserves an estimate per in-flight request so parallel requests cannot all
   * pass a nearly exhausted budget (reservations expire after 10 minutes if no usage arrives).
   */
  brokerBudgetOk(token: string): boolean {
    const id = this.tokenToSession.get(token);
    const live = id ? this.lives.get(id) : undefined;
    if (!live || live.ended) return false;
    const d = this.d;
    let agent: AgentConfig;
    try {
      agent = d.agent(live.agent);
    } catch {
      return false;
    }
    if (d.isPanic() || d.isAgentStopped(agent.name)) return false;
    const now = d.now();
    const list = (this.reservations.get(live.id) ?? []).filter((r) => now - r.at < 600_000);
    const limit = agent.budgets.dailyUsd;
    const used = d.budgets.usage(budgetKey.agent(agent.name));
    if (agent.budgets.dailyTokens !== undefined && used.tokens >= agent.budgets.dailyTokens) return false;
    if (limit !== undefined) {
      const estimate = Math.max(0.01, limit * 0.02);
      const reserved = [...this.reservations.values()]
        .flat()
        .filter((r) => now - r.at < 600_000)
        .reduce((s, r) => s + r.usd, 0);
      if (used.usd + reserved + estimate > limit + 1e-9) return false;
      list.push({ usd: estimate, at: now });
    }
    if (list.length > 4) return false; // at most a few concurrent LLM requests per session
    this.reservations.set(live.id, list);
    return true;
  }

  // ───────────────────────────── controls ─────────────────────────────

  /** /stop: cancel the running turn (pending approvals are denied). */
  async stopThread(key: ThreadKey): Promise<boolean> {
    const live = this.findForThread(key);
    return live ? this.stop(live) : false;
  }

  async stop(live: LiveSession): Promise<boolean> {
    const queued = live.queue.splice(0);
    for (const t of queued) t.done?.({ ok: false, text: '', error: 'stopped' });
    if (!live.current) return queued.length > 0;
    live.current.abort.abort();
    this.d.approvals.cancelSession(live.id, 'denied: stopped by user');
    await live.runtime?.harness.cancel().catch(() => {});
    return true;
  }

  async end(live: LiveSession, reason: string, opts: { hard?: boolean } = {}): Promise<void> {
    if (live.ended) return;
    live.ended = true;
    await this.stop(live);
    await this.closeRuntime(live, { hard: !!opts.hard });
    this.byThread.delete(threadKeyStr(live.key));
    this.lives.delete(live.id);
    this.tokenToSessionCleanup(live.id);
    this.reservations.delete(live.id);
    try {
      this.d.store.sessions.update(live.id, { status: 'ended' });
      this.event(live.id, { kind: 'system', text: `session ended: ${reason}` });
      this.emitSession(live.id);
      this.d.emitAgent(live.agent);
    } catch {
      /* purged */
    }
  }

  private tokenToSessionCleanup(id: string) {
    for (const [t, s] of this.tokenToSession) if (s === id) this.tokenToSession.delete(t);
  }

  async endThread(key: ThreadKey, reason: string): Promise<void> {
    const live = this.findForThread(key);
    if (live) await this.end(live, reason);
    const rec = this.d.store.sessions.findActive(key.agent, key.channel, key.conversationId, key.threadId);
    if (rec) this.d.store.sessions.update(rec.id, { status: 'ended' });
  }

  async endConversation(agent: string, channel: string, conversationId: string): Promise<void> {
    for (const s of this.all())
      if (s.agent === agent && s.key.channel === channel && s.key.conversationId === conversationId)
        await this.end(s, 'membership revoked', { hard: true });
  }

  /** /resume: reactivate the latest ended session of the thread (its harness resume token is reused). */
  resumeThread(key: ThreadKey): string | undefined {
    if (this.findForThread(key)) return this.findForThread(key)?.id;
    const rec = this.d.store.sessions.findLatest(key.agent, key.channel, key.conversationId, key.threadId);
    if (!rec) return undefined;
    this.d.store.sessions.update(rec.id, { status: 'idle' });
    const kind = rec.channel === 'local' ? 'dm' : this.kindOf(key);
    const live = new LiveSession(this.d, rec.id, key, kind, undefined);
    this.attach(live);
    this.emitSession(rec.id);
    return rec.id;
  }

  /** Remember the real conversation kind (resumed sessions must not guess it from names). */
  private rememberKind(key: ThreadKey, kind: LiveSession['conversationKind']): void {
    const k = `${key.channel}|${key.conversationId}`;
    if (this.d.store.kv.get<string>(CONV_KIND_NS, k) !== kind) this.d.store.kv.set(CONV_KIND_NS, k, kind);
  }

  /**
   * Conversation kind for a thread without a live inbound message (/resume, overrides): the kind
   * recorded when the session was created, else a membership on the base channel (`nostr@rev` →
   * `nostr`), else `dm`.
   */
  kindOf(key: ThreadKey): LiveSession['conversationKind'] {
    const stored = this.d.store.kv.get<string>(CONV_KIND_NS, `${key.channel}|${key.conversationId}`);
    if (stored && (CONV_KINDS as readonly string[]).includes(stored))
      return stored as LiveSession['conversationKind'];
    const base = baseChannelName(key.channel);
    const a = this.d.config.agents.get(key.agent);
    const m = a?.memberships.find(
      (x) => x.target.startsWith(`${base}:`) && x.target.endsWith(`/${key.conversationId}`),
    );
    const kind = m ? m.target.slice(m.target.indexOf(':') + 1).split('/')[0]! : 'dm';
    return (
      (CONV_KINDS as readonly string[]).includes(kind) ? kind : 'dm'
    ) as LiveSession['conversationKind'];
  }

  setOverride(key: ThreadKey, patch: Overrides, agent: AgentConfig): void {
    let live = this.findForThread(key);
    if (!live) {
      const rec = this.d.store.sessions.create({
        agent: agent.name,
        channel: key.channel,
        conversationId: key.conversationId,
        threadId: key.threadId,
        status: 'idle',
        harness: agent.harness,
      });
      live = new LiveSession(this.d, rec.id, key, this.kindOf(key), undefined);
      this.attach(live);
    }
    live.overrides = { ...live.overrides, ...patch };
  }

  detailsText(id: string): string {
    const live = this.lives.get(id);
    const tools = live?.toolLog ?? [];
    if (!tools.length) return 'No tool calls in this session yet.';
    return [
      `Tool calls in session \`${id}\` (latest ${Math.min(10, tools.length)}):`,
      ...tools.slice(-10).map((t) => {
        const status = t.ok === undefined ? '…' : t.ok ? '✓' : '✗';
        const input = t.input === undefined ? '' : ` \`${JSON.stringify(t.input).slice(0, 120)}\``;
        return `${status} **${t.title ?? t.name}**${input}`;
      }),
    ].join('\n');
  }

  async closeAll(opts: { hard: boolean }): Promise<void> {
    await Promise.all(
      this.all().map((s) => this.end(s, opts.hard ? 'emergency stop' : 'daemon shutdown', opts)),
    );
  }

  /** Housekeeping: end idle sessions. */
  async tick(): Promise<void> {
    const now = this.d.now();
    for (const s of this.all()) {
      if (s.running || s.queue.length) continue;
      let idle = 120;
      try {
        idle = this.d.agent(s.agent).sessionIdleMinutes;
      } catch {
        await this.end(s, 'agent deleted');
        continue;
      }
      if (Date.parse(s.record().lastActivityAt) < now - idle * 60_000) await this.end(s, 'idle timeout');
    }
    for (const a of this.d.config.agents.list())
      this.d.store.sessions
        .endIdle(a.name, new Date(now - a.sessionIdleMinutes * 60_000).toISOString())
        .forEach((id) => {
          if (!this.lives.has(id)) this.emitSession(id);
        });
  }

  /** Effective roots for channel_send_file and deny list. */
  fileRoots(live: LiveSession): { roots: string[]; deny: string[]; own: string[] } {
    const rt = live.runtime;
    return {
      roots: [live.dir, ...(rt?.mounts.map((m) => m.path) ?? [])],
      deny: rt?.deny ?? [],
      own: rt?.own ?? [],
    };
  }
}

let mcpRead: string[] | undefined;
const MCP_READ_PATHS = (): string[] => (mcpRead ??= mcpReadPaths());

const minDefined = (...xs: (number | undefined)[]): number | undefined => {
  const v = xs.filter((x): x is number => x !== undefined);
  return v.length ? Math.min(...v) : undefined;
};

const expand = (p: string): string => {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(home, p.slice(2));
  return p;
};

/** Alert thresholds (fractions of the daily limit) crossed between two usage snapshots. */
export const budgetCrossings = (
  before: { tokens: number; usd: number },
  after: { tokens: number; usd: number },
  budget: { dailyUsd?: number; dailyTokens?: number },
  thresholds: number[],
): { metric: 'usd' | 'tokens'; threshold: number; used: number; limit: number }[] => {
  const out: { metric: 'usd' | 'tokens'; threshold: number; used: number; limit: number }[] = [];
  const ts = [...new Set(thresholds)].sort((a, b) => a - b);
  for (const [metric, limit] of [
    ['usd', budget.dailyUsd],
    ['tokens', budget.dailyTokens],
  ] as const) {
    if (!limit) continue;
    for (const t of ts)
      if (before[metric] < limit * t && after[metric] >= limit * t)
        out.push({ metric, threshold: t, used: after[metric], limit });
  }
  return out;
};

export const stripRecord = (s: SessionRecord) => {
  const { principal: _p, harness: _h, endedAt: _e, ...view } = s;
  return view;
};

export { newId };

/**
 * Streams assistant text into the transcript: the first non-blank delta of a segment appends an
 * `assistant` event, later deltas update that same event (same `seq`, PWA replaces it) at most every
 * `throttleMs`. A tool call, permission request or error closes the segment, so text before and
 * after a tool lands in transcript order.
 */
export class AssistantStream {
  private seq: number | undefined;
  private buf = '';
  private sent = '';
  private timer: NodeJS.Timeout | undefined;
  constructor(
    private readonly sessions: Pick<SessionManager, 'event' | 'updateEvent'>,
    private readonly sessionId: string,
    private readonly throttleMs = 120,
  ) {}
  add(delta: string): void {
    this.buf += delta;
    if (this.seq === undefined) {
      if (!this.buf.trim()) return;
      this.seq = this.sessions.event(this.sessionId, { kind: 'assistant', text: this.buf }).seq;
      this.sent = this.buf;
      return;
    }
    this.timer ??= setTimeout(() => this.flush(), this.throttleMs);
  }
  private flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.seq === undefined || this.buf === this.sent) return;
    this.sent = this.buf;
    this.sessions.updateEvent(this.sessionId, this.seq, this.buf);
  }
  close(): void {
    this.flush();
    this.seq = undefined;
    this.buf = '';
    this.sent = '';
  }
}
