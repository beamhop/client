/**
 * beamhopd: the integration hub. Wires config + store + secrets + plugins into the router,
 * session runner, approvals, schedules, panic and the API.
 */
import { createHash } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { createConnection, createServer as createNetServer, type Server as NetServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BudgetTracker,
  budgetKey,
  effectiveRoleDef,
  normalizePrincipal,
  type RoleOverride,
} from '@beamhop/authz';
import { applyDlp, createLlmProxy, createSecretStore, type DlpMode, type LlmProxy } from '@beamhop/broker';
import {
  type AgentConfig,
  type AgentView,
  type AuditEvent,
  type BeamhopConfig,
  BeamhopError,
  type Button,
  type ChannelConn,
  createLogger,
  type Logger,
  type OutboundMsgInput,
  paths,
  type RoleDef,
  type SandboxHandle,
  type SandboxPolicy,
  type SecretStore,
  type SentMessage,
  type ServerEvent,
} from '@beamhop/core';
import { createMcpBridge, type McpBridge } from '@beamhop/mcp';
import { createSandbox } from '@beamhop/sandbox';
import { ConfigStore, openStore, type Store } from '@beamhop/store';
import { ApiHandlers } from './api.ts';
import { ApprovalManager } from './approvals.ts';
import { ChannelManager } from './channels.ts';
import {
  acquireLock,
  type DeployEnv,
  ensureApiToken,
  ensureDataKey,
  ensureHomeDirs,
  isInternalSecret,
  readDeployEnv,
} from './home.ts';
import { createMcpHandlers, type McpCtx } from './mcp-handlers.ts';
import { loadNostrMesh, type MeshProvider } from './mesh.ts';
import { loadBuiltinPlugins, PluginRegistry, type PluginRegistryInit } from './registry.ts';
import { Router } from './router.ts';
import { type ApiServer, startApiServer } from './rpc-server.ts';
import { Scheduler } from './schedules.ts';
import { SessionManager } from './sessions.ts';
import { errMsg } from './util.ts';

export const VERSION = '0.1.0';
/** The principal used for the local control plane (CLI, local PWA). Always an owner. */
export const LOCAL_OWNER = 'local:owner';

/** What a sandbox factory must return (a subset of @beamhop/sandbox's BeamhopSandbox). */
export interface DaemonSandbox extends SandboxHandle {
  warnings?: string[];
  onViolation?(
    cb: (v: { kind: 'net.allow' | 'fs.read' | 'fs.write'; value: string; allowed?: boolean }) => void,
  ): () => void;
  close(): Promise<void>;
}

export type SandboxFactory = (
  policy: SandboxPolicy,
  opts: { env: Record<string, string>; brokerPort?: number; localAllow: string[]; log: Logger },
) => Promise<DaemonSandbox>;

export interface DaemonOptions {
  home: string;
  log?: Logger;
  /** Injectable clock (epoch ms). */
  now?: () => number;
  secrets?: SecretStore;
  /** Override the data key (tests). */
  dataKey?: Uint8Array;
  /** Plugins to register. When given, built-ins are not auto-loaded unless `loadBuiltins: true`. */
  plugins?: PluginRegistryInit;
  loadBuiltins?: boolean;
  /** Start the HTTP/WS API. `false` = no server (use `daemon.dispatch` / `directTransport`). */
  api?: false | { port?: number; host?: string; staticDir?: string };
  /** Also listen on the local unix socket (`<home>/beamhop.sock`). Default: true when the API runs. */
  socket?: boolean;
  sandbox?: SandboxFactory;
  /** Start the LLM key proxy (default true). */
  llmProxy?: boolean;
  approvalUndoMs?: number;
  editThrottleMs?: number;
  /** Interval for timers (expiry, schedules, idle, retention). 0 disables; tests call `tick()`. */
  tickMs?: number;
  mesh?: MeshProvider;
  /** Take the single-instance lock (default true). */
  lock?: boolean;
  /** Start the Nostr control plane when the nostr package is available (default false). */
  controlPlane?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface AuditInput {
  type: string;
  severity: AuditEvent['severity'];
  summary: string;
  actor: string;
  agent?: string;
  data?: Record<string, unknown>;
}

const DLP_RANK: Record<DlpMode, number> = { warn: 0, redact: 1, block: 2 };
export const stricterDlp = (a: DlpMode, b: DlpMode): DlpMode => (DLP_RANK[a] >= DLP_RANK[b] ? a : b);

export const defaultStaticDir = (): string =>
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'pwa', 'dist');

export class Daemon {
  readonly home: string;
  readonly log: Logger;
  readonly now: () => number;
  readonly opts: DaemonOptions;
  readonly startedAt: number;
  readonly deployEnv: DeployEnv;
  config!: ConfigStore;
  store!: Store;
  secrets!: SecretStore;
  readonly registry: PluginRegistry;
  readonly budgets: BudgetTracker;
  readonly channels: ChannelManager;
  readonly sessions: SessionManager;
  readonly approvals: ApprovalManager;
  readonly router: Router;
  readonly scheduler: Scheduler;
  readonly apiHandlers: ApiHandlers;
  api: ApiServer | undefined;
  llmProxy: LlmProxy | undefined;
  mcpBridge!: McpBridge<McpCtx>;
  mesh: MeshProvider | undefined;
  apiToken = '';
  private readonly listeners = new Set<(e: ServerEvent) => void>();
  private releaseLock: (() => void) | undefined;
  private timer: NodeJS.Timeout | undefined;
  private socketServer: NetServer | undefined;
  private secretCache: { at: number; values: string[] } | undefined;
  private lastRetention = 0;
  private started = false;
  private stopping: Promise<void> | undefined;
  /** Agents stopped via agent.stop (persisted in kv). */
  readonly sandboxFactory: SandboxFactory;
  control:
    | { setAllowlist(p: string[]): void; notify(e: ServerEvent): Promise<void>; close(): void }
    | undefined;

  constructor(opts: DaemonOptions) {
    this.opts = opts;
    this.home = opts.home;
    this.log = opts.log ?? createLogger();
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
    this.deployEnv = readDeployEnv(opts.env ?? process.env);
    this.registry = new PluginRegistry(opts.plugins);
    this.budgets = new BudgetTracker({ now: this.now });
    this.channels = new ChannelManager(this);
    this.sessions = new SessionManager(this);
    this.approvals = new ApprovalManager(this);
    this.router = new Router(this);
    this.scheduler = new Scheduler(this);
    this.apiHandlers = new ApiHandlers(this);
    this.mesh = opts.mesh;
    this.sandboxFactory =
      opts.sandbox ??
      ((policy, o) =>
        createSandbox(policy, {
          env: o.env,
          ...(o.brokerPort ? { brokerPort: o.brokerPort } : {}),
          localAllow: o.localAllow,
          log: o.log,
          ...(this.deployEnv.sandboxFs === 'container' ? { backend: 'none' as const } : {}),
        }));
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  async start(): Promise<this> {
    if (this.started) return this;
    this.started = true;
    ensureHomeDirs(this.home);
    if (this.opts.lock !== false) this.releaseLock = acquireLock(this.home);
    try {
      this.config = new ConfigStore({ home: this.home, logger: this.log });
      this.config.ensureDirs();
      if (!existsSync(this.config.configFile)) this.config.saveGlobal({});
      if (this.deployEnv.ownerNpub) this.ensureOwner(`nostr:${this.deployEnv.ownerNpub}`);
      this.secrets =
        this.opts.secrets ??
        (await createSecretStore({ log: this.log, vaultPath: join(this.home, 'vault.enc.json') }));
      const key = this.opts.dataKey ?? (await ensureDataKey(this.home, this.secrets, this.log));
      this.store = openStore({ key, home: this.home, logger: this.log, now: () => new Date(this.now()) });
      this.apiToken = ensureApiToken(this.home);

      if (!this.opts.plugins || this.opts.loadBuiltins) {
        const loaded = await loadBuiltinPlugins({
          registry: this.registry,
          secrets: this.secrets,
          log: this.log,
          provisioning: async () => this.provisioningInfo(),
        });
        this.log.info('plugins loaded', { loaded });
      }

      if (!this.mesh) this.mesh = await loadNostrMesh(this);
      this.seedBudgets();
      if (this.opts.llmProxy !== false) {
        this.llmProxy = await createLlmProxy({
          secrets: this.secrets,
          log: this.log.child({ component: 'broker' }),
          onUsage: (u) => this.sessions.onBrokerUsage(u.session, u),
          checkBudget: (token) => this.sessions.brokerBudgetOk(token),
        });
      }
      this.mcpBridge = await createMcpBridge<McpCtx>({ handlers: createMcpHandlers(this), log: this.log });

      if (this.opts.api !== false) {
        const a = this.opts.api ?? {};
        const g = this.global();
        const staticDir = a.staticDir ?? defaultStaticDir();
        this.api = await startApiServer({
          handlers: this.apiHandlers.handlers(),
          token: this.apiToken,
          log: this.log,
          host: a.host ?? g.api.host,
          port: a.port ?? g.api.port,
          ...(existsSync(staticDir) ? { staticDir } : {}),
          routes: (req, res, url) => this.scheduler.handleHttp(req, res, url),
        });
        this.listeners.add((e) => this.api?.broadcast(e));
        if (this.opts.socket !== false) await this.startSocket();
      }
      if (this.opts.controlPlane)
        await this.startControlPlane().catch((e) =>
          this.log.warn('control plane failed', { error: errMsg(e) }),
        );

      const panic = this.global().panic;
      if (panic.active) {
        this.log.warn('daemon starting in PANIC state; run `beamhop resume` to recover', { since: panic.at });
      } else {
        await this.channels.startAll();
        this.scheduler.start();
      }
      const tickMs = this.opts.tickMs ?? 5000;
      if (tickMs > 0) {
        this.timer = setInterval(
          () => void this.tick().catch((e) => this.log.error('tick failed', { error: errMsg(e) })),
          tickMs,
        );
        this.timer.unref?.();
      }
      return this;
    } catch (e) {
      await this.stop().catch(() => {});
      throw e;
    }
  }

  /** Graceful shutdown. */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      if (this.timer) clearInterval(this.timer);
      this.scheduler.stop();
      await this.sessions.closeAll({ hard: false }).catch(() => {});
      await this.channels.stopAll().catch(() => {});
      this.approvals.dispose();
      this.control?.close();
      await this.api?.close().catch(() => {});
      if (this.socketServer) {
        await new Promise<void>((r) => this.socketServer?.close(() => r()));
        if (process.platform !== 'win32') rmSync(paths(this.home).socket, { force: true });
      }
      await this.mcpBridge?.close().catch(() => {});
      await this.llmProxy?.close().catch(() => {});
      try {
        this.store?.close();
      } catch {
        /* closed */
      }
      this.releaseLock?.();
    })();
    return this.stopping;
  }

  /** Periodic housekeeping; tests call it directly with an advanced clock. */
  async tick(): Promise<void> {
    await this.approvals.tick();
    await this.sessions.tick();
    await this.scheduler.tick();
    if (this.now() - this.lastRetention >= 3_600_000) {
      this.lastRetention = this.now();
      this.applyRetention();
    }
  }

  applyRetention() {
    const policies: Record<string, { transcriptDays: number; auditDays: number }> = {};
    for (const a of this.config.agents.list()) policies[a.name] = a.retention;
    const r = this.store.applyRetention(new Date(this.now()), policies);
    if (r.transcripts || r.audit) this.log.info('retention applied', r);
    return r;
  }

  private async startSocket(): Promise<void> {
    if (process.platform === 'win32' || !this.api) return;
    const sock = paths(this.home).socket;
    rmSync(sock, { force: true });
    const port = Number(new URL(this.api.url).port);
    const host = new URL(this.api.url).hostname;
    this.socketServer = createNetServer((c) => {
      const up = createConnection({ port, host });
      c.pipe(up).pipe(c);
      up.on('error', () => c.destroy());
      c.on('error', () => up.destroy());
    });
    await new Promise<void>((res, rej) => {
      this.socketServer?.once('error', rej);
      this.socketServer?.listen(sock, () => res());
    });
    try {
      (await import('node:fs')).chmodSync(sock, 0o600);
    } catch {
      /* best effort */
    }
  }

  private async startControlPlane(): Promise<void> {
    let mod: Record<string, unknown>;
    try {
      mod = (await import(/* @vite-ignore */ '@beamhop/channel-nostr')) as Record<string, unknown>;
    } catch {
      return;
    }
    const createControlServer = mod.createControlServer as (o: unknown) => NonNullable<Daemon['control']>;
    const generateAgentKey = mod.generateAgentKey as () => { nsec: string };
    const ref = this.deployEnv.daemonNsecRef ?? 'beamhop.control.nsec';
    let nsec = await this.secrets.get(ref);
    if (!nsec) {
      nsec = generateAgentKey().nsec;
      await this.secrets.set(ref, nsec);
    }
    const { proxyWebSocket } = await import('./net.ts');
    this.control = createControlServer({
      key: nsec,
      allowlist: this.controlAllowlist(),
      relays: this.global().nostr.relays,
      log: this.log.child({ component: 'control' }),
      ...(proxyWebSocket() ? { WebSocket: proxyWebSocket() } : {}),
      handle: (req: unknown, ctx: { senderNpub: string }) =>
        this.dispatch(req, { caller: `nostr:${ctx.senderNpub}`, transport: 'nostr' }),
    });
    this.listeners.add((e) => void this.control?.notify(e).catch(() => {}));
  }

  /** Owner npubs + paired device pubkeys allowed on the Nostr control plane. */
  controlAllowlist(): string[] {
    const g = this.global();
    const owners = g.owners.filter((p) => p.startsWith('nostr:')).map((p) => p.slice(6));
    if (g.nostr.ownerNpub) owners.push(g.nostr.ownerNpub);
    const devices = this.store.devices.list().map((d) => d.pubkey);
    return [...new Set([...owners, ...devices])];
  }

  refreshControlAllowlist(): void {
    this.control?.setAllowlist(this.controlAllowlist());
  }

  /** JSON-RPC dispatch independent of transport (also used by tests through directTransport). */
  dispatch(raw: unknown, ctx: { caller: string; transport: 'http' | 'ws' | 'nostr' | 'direct' }) {
    return this.apiHandlers.dispatch(raw, ctx);
  }

  /** Call one API method in-process (validated like a remote call). Throws BeamhopError-like errors. */
  async call(method: string, params: unknown = {}): Promise<unknown> {
    const res = await this.dispatch(
      { jsonrpc: '2.0', id: 1, method, params },
      { caller: 'local', transport: 'direct' },
    );
    if ('error' in res) {
      const data = res.error.data as { code?: string } | undefined;
      throw new BeamhopError((data?.code as never) ?? 'internal', res.error.message, res.error.data);
    }
    return res.result;
  }

  private provisioningInfo() {
    const g = this.global();
    return {
      ownerNpub: g.nostr.ownerNpub ?? this.deployEnv.ownerNpub ?? '',
      provisioningPubkey: this.deployEnv.provisioningPubkey ?? '',
      beamhopVersion: VERSION,
    };
  }

  // ───────────────────────────── config helpers ─────────────────────────────

  global(): BeamhopConfig {
    return this.config.loadGlobal();
  }

  updateGlobal(fn: (c: BeamhopConfig) => BeamhopConfig): BeamhopConfig {
    return this.config.updateGlobal((c) => fn(c));
  }

  ensureOwner(principal: string): void {
    const g = this.global();
    if (!g.owners.some((o) => normalizePrincipal(o) === normalizePrincipal(principal)))
      this.updateGlobal((c) => ({ ...c, owners: [...c.owners, principal] }));
  }

  /** Owners including the implicit local owner. */
  owners(): string[] {
    return [...this.global().owners, LOCAL_OWNER];
  }

  /** Global config with the local owner added (input for resolveRole). */
  authzGlobal(): Pick<BeamhopConfig, 'owners' | 'grants' | 'people'> {
    const g = this.global();
    return { owners: [...g.owners, LOCAL_OWNER], grants: g.grants, people: g.people };
  }

  roleDef(name: string): RoleDef {
    return (
      effectiveRoleDef(name, this.global().roles as RoleOverride[]) ?? (effectiveRoleDef('viewer') as RoleDef)
    );
  }

  agent(name: string): AgentConfig {
    return this.config.agents.require(name);
  }

  isAgentStopped(name: string): boolean {
    return this.store.kv.get<boolean>('agent-stopped', name) === true;
  }

  isPanic(): boolean {
    return this.global().panic.active;
  }

  assertNotPanic(): void {
    if (this.isPanic())
      throw new BeamhopError('unavailable', 'panic mode is active; run `beamhop resume` first');
  }

  private seedBudgets(): void {
    for (const a of this.config.agents.list()) {
      const t = this.store.usage.totals({ agent: a.name });
      this.budgets.load(budgetKey.agent(a.name), { tokens: t.tokens, usd: t.usd, minutes: t.minutes });
    }
  }

  // ───────────────────────────── events & audit ─────────────────────────────

  subscribe(fn: (e: ServerEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(e: ServerEvent): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(e);
      } catch (err) {
        this.log.warn('event listener failed', { error: errMsg(err) });
      }
    }
  }

  audit(input: AuditInput): AuditEvent {
    const ev = this.store.audit.append({
      type: input.type,
      severity: input.severity,
      summary: input.summary,
      actor: input.actor,
      ...(input.agent ? { agent: input.agent } : {}),
      data: input.data ?? {},
    });
    this.emit({ type: 'audit', event: ev });
    return ev;
  }

  emitAgent(name: string): void {
    try {
      this.emit({ type: 'agent.updated', agent: this.agentView(this.agent(name)) });
    } catch {
      /* deleted */
    }
  }

  agentView(a: AgentConfig): AgentView {
    const t = this.store.usage.totals({ agent: a.name });
    const active = this.sessions.activeCount(a.name);
    const busy = this.sessions.isBusy(a.name);
    const status: AgentView['status'] = this.isPanic()
      ? 'paused'
      : this.isAgentStopped(a.name)
        ? 'stopped'
        : busy
          ? 'busy'
          : this.sessions.agentError(a.name)
            ? 'error'
            : 'idle';
    const view: AgentView = {
      config: a,
      status,
      activeSessions: active,
      usageToday: { usd: t.usd, tokens: t.tokens, minutes: t.minutes },
      location: { kind: 'local' },
    };
    const err = this.sessions.agentError(a.name);
    if (err) view.error = err;
    const last = this.store.sessions.list({ agent: a.name, limit: 1 })[0];
    if (last) view.lastActivityAt = last.lastActivityAt;
    return view;
  }

  // ───────────────────────────── secrets & DLP ─────────────────────────────

  invalidateSecretCache(): void {
    this.secretCache = undefined;
  }

  /** Exact values of every secret in the vault (for DLP). Cached for 60 s. */
  async knownSecrets(): Promise<string[]> {
    if (this.secretCache && this.now() - this.secretCache.at < 60_000) return this.secretCache.values;
    const values: string[] = [];
    for (const { name } of await this.secrets.list()) {
      const v = await this.secrets.get(name);
      if (v && v.length >= 8 && !isInternalSecret(name)) values.push(v);
    }
    if (this.apiToken) values.push(this.apiToken);
    this.secretCache = { at: this.now(), values };
    return values;
  }

  /**
   * Send a message through a channel with DLP applied (§7A). `dlp` is the effective mode for the
   * recipients; owners get `warn`. Blocked messages are replaced by a notice. Edits are re-checked.
   */
  async sendOutbound(
    conn: ChannelConn,
    msg: OutboundMsgInput,
    ctx: { agent: string; dlp: DlpMode; recipient: string },
  ): Promise<SentMessage | undefined> {
    const check = async (text: string): Promise<string | undefined> => {
      const res = applyDlp(ctx.dlp, text, await this.knownSecrets());
      if (res.findings.length) {
        const types = [...new Set(res.findings.map((f) => f.type))];
        this.audit({
          type: 'dlp.hit',
          severity: res.action === 'warned' ? 'warn' : 'security',
          summary: `DLP ${res.action} outbound message to ${ctx.recipient} (${types.join(', ')})`,
          actor: `agent:${ctx.agent}`,
          agent: ctx.agent,
          data: { action: res.action, types, channel: conn.name, recipient: ctx.recipient },
        });
        if (res.action !== 'warned')
          void this.notifyOwners(
            `⚠️ DLP ${res.action} a message from *${ctx.agent}* to ${ctx.recipient} (${types.join(', ')}).`,
            { exceptChannelConv: `${conn.name}|${msg.conversation.id}` },
          );
      }
      if (!res.ok) return '⚠️ This message was withheld because it looked like it contained a secret.';
      return res.text;
    };
    const text = await check(msg.markdown);
    if (text === undefined) return undefined;
    const sent = await conn.send({ ...msg, markdown: text });
    this.router.recordHistory(conn.name, msg.conversation.id, {
      id: sent.id,
      threadId: msg.threadId ?? msg.conversation.id,
      principal: conn.self.principal,
      name: conn.self.displayName,
      text,
      at: new Date(this.now()).toISOString(),
      role: 'agent-self',
    });
    if (!sent.edit) return sent;
    const edit = sent.edit.bind(sent);
    return {
      id: sent.id,
      edit: async (md: string) => {
        const t = await check(md);
        if (t !== undefined) await edit(t);
      },
    };
  }

  /** Effective DLP mode for a conversation (§7A): DMs use the recipient's role, groups never just warn. */
  dlpFor(kind: string, recipientRole: string, membershipDefault?: string): DlpMode {
    const r = this.roleDef(recipientRole);
    if (kind === 'dm') return recipientRole === 'owner' ? 'warn' : r.dlp;
    let mode: DlpMode = stricterDlp(r.dlp, 'redact');
    if (membershipDefault) mode = stricterDlp(mode, this.roleDef(membershipDefault).dlp);
    return mode;
  }

  /** Remember the DM conversation of a principal so owners can be notified there. */
  rememberDm(principal: string, channel: string, conversationId: string): void {
    this.store.kv.set('dm', normalizePrincipal(principal), { channel, conversationId });
  }

  /** All principals that belong to owners (owners + linked identities). */
  ownerPrincipals(): string[] {
    const g = this.global();
    const owners = new Set(g.owners.map(normalizePrincipal));
    const out = new Set<string>(owners);
    for (const ps of Object.values(g.people)) {
      if (ps.some((p) => owners.has(normalizePrincipal(p))))
        for (const p of ps) out.add(normalizePrincipal(p));
    }
    return [...out];
  }

  /** DM every owner on every channel where we know their DM conversation. Returns deliveries. */
  async notifyOwners(
    markdown: string,
    opts: { buttons?: Button[]; exceptChannelConv?: string; principals?: string[] } = {},
  ): Promise<number> {
    let n = 0;
    const seen = new Set<string>();
    for (const p of opts.principals ?? this.ownerPrincipals()) {
      const dm = this.store.kv.get<{ channel: string; conversationId: string }>('dm', normalizePrincipal(p));
      if (!dm) continue;
      const key = `${dm.channel}|${dm.conversationId}`;
      if (seen.has(key) || key === opts.exceptChannelConv) continue;
      seen.add(key);
      const conn = this.channels.get(dm.channel);
      if (!conn) continue;
      try {
        const buttons = conn.capabilities.buttons ? (opts.buttons ?? []) : [];
        await conn.send({ conversation: { kind: 'dm', id: dm.conversationId }, markdown, buttons });
        n++;
      } catch (e) {
        this.log.warn('owner notification failed', { channel: dm.channel, error: errMsg(e) });
      }
    }
    return n;
  }

  // ───────────────────────────── panic (§7A) ─────────────────────────────

  async panic(reason: string | undefined, actor: string): Promise<void> {
    this.updateGlobal((c) => ({ ...c, panic: { active: true, at: new Date(this.now()).toISOString() } }));
    this.scheduler.pauseAll();
    await this.sessions.closeAll({ hard: true });
    this.approvals.denyAll('denied: emergency stop');
    await this.channels.stopAll();
    this.audit({
      type: 'panic',
      severity: 'security',
      summary: `PANIC: all sessions killed, schedules paused, channels disconnected${reason ? ` (${reason})` : ''}`,
      actor,
      data: reason ? { reason } : {},
    });
    this.emit({ type: 'panic', active: true });
    for (const a of this.config.agents.list()) this.emitAgent(a.name);
  }

  async resume(actor: string): Promise<void> {
    if (!this.isPanic()) return;
    this.updateGlobal((c) => ({ ...c, panic: { active: false } }));
    this.budgets.reset();
    this.seedBudgets();
    await this.channels.startAll();
    this.scheduler.start();
    this.audit({ type: 'panic.resume', severity: 'security', summary: 'Resumed after panic', actor });
    this.emit({ type: 'panic', active: false });
    for (const a of this.config.agents.list()) this.emitAgent(a.name);
  }
}

/** Short stable hash (for throttling keys etc.). */
export const shortHash = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);

/** Create (and start) a daemon. Tests inject plugins/clock/secrets and disable the network API. */
export const createDaemon = async (opts: DaemonOptions): Promise<Daemon> => new Daemon(opts).start();

export type { DlpMode };
