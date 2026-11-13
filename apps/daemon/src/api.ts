/** API handlers for every method in `@beamhop/core` api.ts. */
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  allRoleDefs,
  createPairingCode,
  effectiveRoleDef,
  normalizePrincipal,
  type RoleOverride,
} from '@beamhop/authz';
import { keychainAvailable, readKeySource, setKeySource } from '@beamhop/broker';
import {
  AgentConfig,
  type AgentView,
  BeamhopError,
  type ChannelConfig,
  type DoctorCheck,
  expandHome,
  type HarnessJob,
  type HarnessView,
  type MethodName,
  methods,
  newId,
  PRESETS,
  paths,
  type Result,
  type ScheduleConfig,
} from '@beamhop/core';
import {
  type Catalog,
  type CatalogEntry,
  findHarness,
  type LoginMethod,
  loadCatalog,
} from '@beamhop/harness-catalog';
import {
  availableMethods,
  expandPath,
  fileExists,
  installPlan,
  isManagedPath,
  methodLabel,
  noneReason,
  toolWhich,
} from '@beamhop/harness-discovery';
import { compilePolicy, probeSandbox, sandboxActions } from '@beamhop/sandbox';
import { INSTRUCTION_FILES, type MoreMethod, moreHandlers } from './api-more.ts';
import { channelSecretName } from './channels.ts';
import { type Daemon, LOCAL_OWNER, VERSION } from './daemon.ts';
import {
  type DoctorAction,
  defaultFixRunner,
  doctorActionTable,
  elevatedArgv,
  elevatedFailure,
  type FixRunner,
} from './doctor-fix.ts';
import { checkLogin, harnessLogin, harnessModels, loginMethods, resolveMethod } from './harness-auth.ts';
import {
  defaultInstallerDeps,
  homeSignInBody,
  type InstallerDeps,
  installBody,
  isNewer,
  latestVersion,
  loginBody,
  updateMethodFor,
} from './harness-install.ts';
import { type ChildLike, HarnessJobs, type SpawnFn } from './harness-jobs.ts';
import { isInternalSecret } from './home.ts';
import { encodeBlob, exportTransfer, homeEnv, readHome, writeHome } from './home-login.ts';
import { agentKeyRef } from './identity.ts';
import { type CallContext, createDispatcher, type Handler, type Handlers } from './rpc-server.ts';
import { normalizeHostPattern, suggestionValue, withPolicyValue } from './rules.ts';
import { probeHosts, requiredHosts } from './sandbox-hosts.ts';
import { webhookSecretName } from './schedules.ts';
import { stripRecord } from './sessions.ts';
import { errMsg } from './util.ts';

const OK = { ok: true as const };

/** Injection points for harness installs/logins and doctor fixes (tests pass fakes). */
export interface HarnessToolsOptions {
  spawn?: SpawnFn;
  kill?: (child: ChildLike, signal?: NodeJS.Signals) => void;
  installer?: Partial<InstallerDeps>;
  fixRunner?: FixRunner;
  /** Replaces the sandbox's fix table (tests). */
  sandboxActions?: Record<string, DoctorAction>;
}

const UPDATES_TTL_MS = 24 * 60 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 30 * 60 * 1000;

/** Methods that run programs on this computer: only a client on this computer may call them. */
const LOCAL_ONLY_MESSAGE: Record<'install' | 'login' | 'fix', string> = {
  install: 'Installing harnesses works only on the computer running beamhop. Open beamhop there.',
  login: 'Signing in to a harness works only on the computer running beamhop. Open beamhop there.',
  fix: 'Fixing problems works only on the computer running beamhop. Open beamhop there.',
};

/**
 * The doctor's harness line: a short summary (ready / needs login / not installed) and a fix that
 * matches the situation — log in to an installed harness before suggesting a new install.
 */
export const harnessCheck = (hs: HarnessView[], brokerHasKey = false): DoctorCheck => {
  const by = (s: HarnessView['status']) => hs.filter((h) => h.status === s);
  const ready = by('ready');
  const login = by('needs-login');
  const missing = by('not-installed');
  const other = hs.filter((h) => !['ready', 'needs-login', 'not-installed'].includes(h.status));
  const message = hs.length
    ? [
        ready.length ? `ready: ${ready.map((h) => h.id).join(', ')}` : 'none ready',
        login.length ? `needs login: ${login.map((h) => h.id).join(', ')}` : '',
        ...other.map((h) => `${h.id}: ${h.status}`),
        missing.length ? `${missing.length} not installed` : '',
      ]
        .filter(Boolean)
        .join(' · ')
    : 'no harness adapters installed';
  if (ready.length) return { id: 'harness.any', title: 'Harnesses', status: 'ok', message };
  // Installed but not logged in is fine when beamhop's broker holds the provider key.
  if (login.length && brokerHasKey)
    return {
      id: 'harness.any',
      title: 'Harnesses',
      status: 'ok',
      message: `${message} (they use the API key stored in beamhop)`,
    };
  const first = login[0];
  const fix = first
    ? `Log in to ${first.displayName} (${first.message?.startsWith('run ') ? first.message : `run \`${first.command} login\``}) and run \`beamhop harness scan\` — or give beamhop the provider key instead (see the LLM API keys check).`
    : 'Install a harness (e.g. `npm i -g @anthropic-ai/claude-code`) and run `beamhop harness scan`. `beamhop harness ls` lists every supported one.';
  return { id: 'harness.any', title: 'Harnesses', status: 'warn', message, fix };
};

const deepMerge = (a: unknown, b: unknown): unknown => {
  if (Array.isArray(b) || typeof b !== 'object' || b === null) return b === undefined ? a : b;
  if (typeof a !== 'object' || a === null || Array.isArray(a)) return b;
  const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
  for (const [k, v] of Object.entries(b as Record<string, unknown>)) out[k] = deepMerge(out[k], v);
  return out;
};

export class ApiHandlers {
  private dispatcher: ReturnType<typeof createDispatcher> | undefined;
  private customHarnesses = new Map<string, HarnessView>();
  private jobsMgr: HarnessJobs | undefined;
  private installerDeps: InstallerDeps | undefined;
  private catalogCache: Catalog | undefined;

  constructor(private readonly d: Daemon) {}

  /** Refuse anyone but a client on this computer (the API token, or in-process). */
  requireLocal(ctx: CallContext, what: keyof typeof LOCAL_ONLY_MESSAGE): void {
    if (ctx.caller === 'local' || ctx.transport === 'direct') return;
    throw new BeamhopError('forbidden', LOCAL_ONLY_MESSAGE[what]);
  }

  private get tools(): HarnessToolsOptions {
    return this.d.opts.harnessTools ?? {};
  }

  private catalog(): Catalog {
    this.catalogCache ??= loadCatalog();
    return this.catalogCache;
  }

  private catalogEntry(id: string): CatalogEntry {
    const e = findHarness(this.catalog(), id);
    if (!e) throw new BeamhopError('not_found', `${id} is not a harness beamhop knows how to install`);
    return e;
  }

  /** Tools on the daemon's PATH, the environment children get, and where things install. */
  installer(): InstallerDeps {
    if (this.installerDeps) return this.installerDeps;
    const o = this.tools.installer ?? {};
    const env = o.env ?? process.env;
    const platform = o.platform ?? process.platform;
    const which = o.which ?? toolWhich({ platform, env, home: o.home ?? homedir() });
    this.installerDeps = { ...defaultInstallerDeps(this.d.home, env, which), ...o, beamhopHome: this.d.home };
    return this.installerDeps;
  }

  jobs(): HarnessJobs {
    this.jobsMgr ??= new HarnessJobs({
      ...(this.tools.spawn ? { spawn: this.tools.spawn } : {}),
      ...(this.tools.kill ? { kill: this.tools.kill } : {}),
      now: () => this.d.now(),
    });
    return this.jobsMgr;
  }

  /** Cancel running jobs (daemon shutdown). */
  async shutdown(): Promise<void> {
    await this.jobsMgr?.shutdown();
  }

  /** install plan, managed flag and login flow from the catalog (for the views `scan` stores). */
  private decorate(v: HarnessView): HarnessView {
    const entry = findHarness(this.catalog(), v.id);
    if (!entry) return v;
    const deps = this.installer();
    const out: HarnessView = { ...v };
    try {
      out.installPlan = installPlan(entry, deps);
    } catch (e) {
      this.d.log.warn('install plan failed', { harness: v.id, error: errMsg(e) });
    }
    if (isManagedPath(v.path, deps.beamhopHome, deps.platform)) out.managed = true;
    const flow = entry.auth.loginFlow;
    if (flow) out.loginFlow = { kind: flow.kind };
    return out;
  }

  /** Re-scan and return one harness (after an install). */
  private async rescanOne(id: string): Promise<HarnessView | undefined> {
    return (await this.scan()).find((h) => h.id === id);
  }

  /** Store a credential as a harness's vault login (`harness.login`, captured login flows). */
  private async storeHarnessLogin(id: string, method: string | undefined, value: string, ctx: CallContext) {
    const m = resolveMethod(id, method);
    await this.d.secrets.set(m.secret, value.trim());
    this.d.invalidateSecretCache();
    this.d.audit({
      type: 'harness.login',
      severity: 'security',
      summary: `${id} logged in with ${m.label}`,
      actor: this.principal(ctx),
      data: { harness: id, method: m.id, secret: m.secret },
    });
    return m;
  }

  /** Sign in to a subscription login (`home` method) in a fresh directory; the files go to the vault. */
  private async homeSignIn(entry: CatalogEntry, m: LoginMethod, openBrowser: boolean, ctx: CallContext) {
    const d = this.d;
    if (m.kind !== 'home' || !m.home || !m.signIn)
      throw new BeamhopError(
        'invalid_input',
        `${m.label} is not a sign-in; use beamhop harness login ${entry.id}`,
      );
    if (!this.scanFresh()) await this.scan();
    const v = this.harnessViews().find((h) => h.id === entry.id);
    if (!v?.path || v.status === 'not-installed')
      throw new BeamhopError('invalid_input', `${entry.displayName} is not installed`);
    const home = m.home;
    const dir = join(paths(d.home).sessions, `signin-${entry.id}-${randomBytes(4).toString('hex')}`);
    writeHome(dir, home);
    const actor = this.principal(ctx);
    const cleanup = () => rmSync(dir, { recursive: true, force: true });
    return this.jobs().start(
      {
        harness: entry.id,
        displayName: entry.displayName,
        kind: 'login',
        method: 'flow',
        timeoutMs: (m.signIn.timeoutSec ?? 300) * 1000,
        onEnd: (job) => {
          cleanup();
          this.auditJob(job, actor);
        },
      },
      homeSignInBody(
        entry,
        m,
        this.installer(),
        {
          binary: v.path,
          dir,
          read: (final) =>
            home.transfer ? (final ? exportTransfer(v.path!, home, dir) : undefined) : readHome(dir, home),
          store: async (files) => {
            await this.storeHarnessLogin(entry.id, m.id, encodeBlob(files), ctx);
            await checkLogin(d, entry.id).catch(() => undefined);
          },
        },
        homeEnv(dir, home),
        openBrowser,
      ),
    );
  }

  /** Audit the end of a job (never its output: a login's may hold a token). */
  private auditJob(job: HarnessJob, actor: string): void {
    const name = job.displayName ?? job.harness;
    const verb = job.kind === 'install' ? 'Install' : job.kind === 'update' ? 'Update' : 'Sign-in';
    const data = {
      harness: job.harness,
      kind: job.kind,
      ...(job.method ? { method: job.method } : {}),
      jobId: job.id,
    };
    if (job.step === 'done')
      this.d.audit({
        type:
          job.kind === 'login'
            ? 'harness.loginFlow'
            : job.kind === 'install'
              ? 'harness.installed'
              : 'harness.updated',
        severity: 'security',
        summary: job.kind === 'login' ? `Logged in ${name}` : (job.message ?? `${verb} of ${name} finished`),
        actor,
        data,
      });
    else
      this.d.audit({
        type: `harness.${job.kind}.${job.step}`,
        severity: job.step === 'failed' ? 'warn' : 'info',
        summary: `${verb} of ${name} ${job.step === 'failed' ? `failed: ${job.message ?? 'unknown error'}` : 'cancelled'}`,
        actor,
        data,
      });
  }

  private startInstall(
    entry: CatalogEntry,
    method: ReturnType<typeof availableMethods>[number],
    update: boolean,
    ctx: CallContext,
  ) {
    const actor = this.principal(ctx);
    return this.jobs().start(
      {
        harness: entry.id,
        displayName: entry.displayName,
        kind: update ? 'update' : 'install',
        method,
        timeoutMs: INSTALL_TIMEOUT_MS,
        onEnd: (job) => this.auditJob(job, actor),
      },
      installBody(entry, method, update, this.installer(), () => this.rescanOne(entry.id)),
    );
  }

  /** Doctor checks (`system.doctor`, and again after `system.doctorFix`). */
  private async doctorChecks(): Promise<DoctorCheck[]> {
    const d = this.d;
    const checks: DoctorCheck[] = [];
    try {
      checks.push(...(await probeSandbox()));
    } catch (e) {
      checks.push({ id: 'sandbox', title: 'Sandbox', status: 'fail', message: errMsg(e) });
    }
    // With beamhop's own sign-in state, as the Harnesses screen shows it: a harness the user is logged in
    // to on this computer still needs a login for its agents (theirs is not usable inside the sandbox).
    const hs = await this.withLogins(await this.scan());
    // Agents with `harnessAuth: api-key` (the default) reach their LLM only through the broker,
    // which needs the provider key in beamhop's secret store.
    const llmKeys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY'];
    const haveKeys = (await d.secrets.list().catch(() => []))
      .map((s) => s.name)
      .filter((n) => llmKeys.includes(n));
    const keyAgents = d.config.agents.list().filter((a) => a.harnessAuth === 'api-key');
    checks.push(harnessCheck(hs, haveKeys.length > 0));
    // Agents on a harness with no working login (your own login is not usable inside the sandbox).
    const seen = new Set<string>();
    for (const a of d.config.agents.list()) {
      if (seen.has(a.harness)) continue;
      seen.add(a.harness);
      const login = await harnessLogin(d, a.harness);
      if (login.status !== 'logged-out' && login.status !== 'invalid') continue;
      const users = d.config.agents
        .list()
        .filter((x) => x.harness === a.harness)
        .map((x) => x.name);
      checks.push({
        id: `harness.${a.harness}.login`,
        title: `${d.registry.harness(a.harness)?.displayName ?? a.harness} login (${users.join(', ')})`,
        status: 'fail',
        message: login.status === 'invalid' ? `login rejected: ${login.message}` : 'not logged in',
        fix: `beamhop harness login ${a.harness}`,
      });
    }
    for (const c of d.config.channels.list()) {
      const v = d.channels.view(c);
      checks.push({
        id: `channel.${c.name}`,
        title: `Channel ${c.name} (${c.provider})`,
        status:
          v.status === 'connected' ? 'ok' : v.status === 'disabled' ? 'skip' : d.isPanic() ? 'warn' : 'fail',
        message: v.error ?? v.status,
      });
    }
    const secretsBackend = d.secrets.backend;
    const keyWhere = {
      file: `key in ${join(d.home, 'vault.key')}`,
      keychain: 'key in the system keychain',
      passphrase: 'locked with BEAMHOP_VAULT_PASSPHRASE',
    } as const;
    checks.push({
      id: 'secrets.backend',
      title: 'Secret storage',
      status: secretsBackend === 'memory' ? 'warn' : 'ok',
      message:
        secretsBackend === 'file'
          ? `encrypted vault, ${keyWhere[readKeySource({ home: d.home })]}`
          : 'in memory only: secrets are lost on restart',
    });
    checks.push({
      id: 'llm.keys',
      title: 'LLM API keys',
      status: haveKeys.length ? 'ok' : keyAgents.length ? 'warn' : 'skip',
      message: haveKeys.length
        ? `set: ${haveKeys.join(', ')}`
        : keyAgents.length
          ? `none set; ${keyAgents.map((a) => a.name).join(', ')} cannot reach a model`
          : 'none set (no agent needs one yet)',
      ...(haveKeys.length
        ? {}
        : {
            fix: 'beamhop secret set ANTHROPIC_API_KEY --from-env ANTHROPIC_API_KEY (or OPENAI_API_KEY / OPENROUTER_API_KEY for other harnesses)',
          }),
    });
    if (d.isPanic())
      checks.push({
        id: 'panic',
        title: 'Panic',
        status: 'warn',
        message: 'panic mode is active',
        fix: 'beamhop resume',
        action: doctorActionTable({})['system.resume'],
      });
    return checks;
  }

  dispatch(raw: unknown, ctx: CallContext) {
    this.dispatcher ??= createDispatcher(this.handlers(), this.d.log);
    return this.dispatcher(raw, ctx);
  }

  /** Principal acting for an API call: local clients and paired devices act as the local owner. */
  principal(ctx: CallContext): string {
    if (ctx.caller === 'local' || ctx.transport === 'direct') return LOCAL_OWNER;
    if (ctx.caller.startsWith('nostr:')) {
      const npub = ctx.caller.slice(6);
      const owners = this.d.ownerPrincipals();
      if (owners.includes(normalizePrincipal(ctx.caller))) return ctx.caller;
      if (this.d.pairing.activeDevices().some((dev) => dev.pubkey === npub)) return LOCAL_OWNER;
    }
    return ctx.caller;
  }

  /**
   * A paired device may only manage its own push settings; local clients and owners may manage any
   * device. `browser` (the locally served PWA) is local-only.
   */
  private assertOwnDevice(id: string, ctx: CallContext): void {
    if (
      ctx.caller === 'local' ||
      ctx.transport === 'direct' ||
      ctx.transport === 'http' ||
      ctx.transport === 'ws'
    )
      return;
    if (ctx.caller.startsWith('nostr:')) {
      const npub = ctx.caller.slice(6);
      const dev = this.d.pairing.activeDevices().find((x) => x.pubkey === npub);
      if (dev && dev.id === id) return;
      if (!dev && this.d.ownerPrincipals().includes(normalizePrincipal(ctx.caller)) && id !== 'browser')
        return;
    }
    throw new BeamhopError('forbidden', 'a device can only change its own push settings');
  }

  private agentView(name: string): AgentView {
    return this.d.agentView(this.d.agent(name));
  }

  /** What refers to a secret by name: agent identity keys, secretEnv and broker bindings, channels, webhooks. */
  private secretUsers(name: string): string[] {
    const d = this.d;
    const out: string[] = [];
    for (const a of d.config.agents.list()) {
      if (a.identity.nostrKeyRef === name) out.push(`agent ${a.name} (identity key)`);
      if (a.secretEnv.some((e) => (e.split('=')[1] ?? e) === name)) out.push(`agent ${a.name} (secretEnv)`);
      if (a.sandbox.policy?.secrets?.some((b) => b.name === name))
        out.push(`agent ${a.name} (sandbox secret binding)`);
    }
    for (const c of d.config.channels.list())
      if (c.secretRefs.includes(name) || name.startsWith(`channel.${c.name}.`)) out.push(`channel ${c.name}`);
    for (const s of d.config.schedules.list())
      if (webhookSecretName(s.id) === name) out.push(`schedule ${s.id} (webhook secret)`);
    return out;
  }

  private saveAgent(input: unknown): AgentView {
    const a = this.d.config.agents.save(input);
    this.d.emitAgent(a.name);
    return this.d.agentView(a);
  }

  /**
   * Attach login status. For harnesses beamhop logs in, "ready" also means agents can authenticate:
   * installed but logged out (or rejected) is `needs-login`, whatever the harness's own login says,
   * since that one is not usable inside the sandbox.
   */
  private async withLogins(views: HarnessView[]): Promise<HarnessView[]> {
    return Promise.all(
      views.map(async (h) => {
        const login = await harnessLogin(this.d, h.id);
        if (login.status === 'unmanaged' || (h.status !== 'ready' && h.status !== 'needs-login'))
          return { ...h, login };
        const ok = login.status === 'logged-in' || login.status === 'unchecked';
        const message = ok
          ? h.status === 'needs-login'
            ? undefined
            : h.message
          : login.status === 'invalid'
            ? `Login rejected: ${login.message}. Run: beamhop harness login ${h.id}`
            : login.message;
        const { message: _old, ...rest } = h;
        return { ...rest, status: ok ? 'ready' : 'needs-login', ...(message ? { message } : {}), login };
      }),
    );
  }

  private async harnessView(id: string): Promise<HarnessView> {
    const v = (await this.withLogins(this.harnessViews())).find((h) => h.id === id);
    if (!v) throw new BeamhopError('not_found', `no harness ${id}`);
    return v;
  }

  private harnessViews(): HarnessView[] {
    const list = this.d.store.kv.get<HarnessView[]>('harness', 'scan') ?? [];
    const ids = new Set(list.map((h) => h.id));
    for (const h of this.customHarnesses.values()) if (!ids.has(h.id)) list.push(h);
    for (const id of this.d.registry.harnesses.keys())
      if (!list.some((h) => h.id === id))
        list.push({
          id,
          displayName: this.d.registry.harness(id)?.displayName ?? id,
          command: id,
          status: 'ready',
          protocol: 'acp',
        });
    return list;
  }

  async scan(): Promise<HarnessView[]> {
    const d = this.d;
    const out: HarnessView[] = [];
    const add = (h: {
      id: string;
      displayName: string;
      command: string;
      status: HarnessView['status'];
      protocol: string;
      version?: string;
      path?: string;
      message?: string;
      install?: HarnessView['install'];
    }) => {
      if (out.some((x) => x.id === h.id)) return;
      const v: HarnessView = {
        id: h.id,
        displayName: h.displayName,
        command: h.command,
        status: h.status,
        protocol: h.protocol,
      };
      if (h.version) v.version = h.version;
      if (h.path) v.path = h.path;
      if (h.message) v.message = h.message;
      if (h.install) v.install = h.install;
      out.push(v);
    };
    if (d.registry.discovery) {
      try {
        for (const h of await d.registry.discovery.scan()) add(h);
      } catch (e) {
        d.log.warn('harness discovery failed', { error: errMsg(e) });
      }
    }
    for (const p of d.registry.harnesses.values()) {
      try {
        const det = await p.detect();
        if (det) add(det);
        else
          add({
            id: p.id,
            displayName: p.displayName,
            command: p.id,
            status: 'not-installed',
            protocol: 'acp',
          });
      } catch (e) {
        add({
          id: p.id,
          displayName: p.displayName,
          command: p.id,
          status: 'error',
          protocol: 'acp',
          message: errMsg(e),
        });
      }
    }
    for (const h of this.customHarnesses.values()) add(h);
    const views = out.map((v) => this.decorate(v));
    d.store.kv.set('harness', 'scan', views);
    d.store.kv.set('harness', 'scanCatalog', this.catalog().revision);
    return views;
  }

  /** A stored scan exists and was made with this catalog (an updated app or catalog rescans). */
  private scanFresh(): boolean {
    const d = this.d;
    return (
      !!d.store.kv.get('harness', 'scan') &&
      d.store.kv.get<string>('harness', 'scanCatalog') === this.catalog().revision
    );
  }

  private channelProviders() {
    return [...this.d.registry.channels.values()].map((p) => ({
      provider: p.id,
      displayName: p.displayName,
      steps: p.setup.steps as unknown[],
    }));
  }

  private requireDeployer(id: string) {
    const dep = this.d.registry.deployers.get(id);
    if (!dep)
      throw new BeamhopError(
        'unavailable',
        this.d.registry.deployers.size
          ? `unknown deploy provider "${id}" (available: ${[...this.d.registry.deployers.keys()].join(', ')})`
          : 'cloud deploy is not available: the @beamhop/deploy package is not installed',
      );
    return dep;
  }

  private async effectivePolicy(name: string) {
    const a = this.d.agent(name);
    const required = await requiredHosts(this.d, a.harness);
    return {
      profile: a.sandbox.profile,
      effective: compilePolicy(a.sandbox.profile, a.mounts, (a.sandbox.policy ?? {}) as never),
      required,
      userAllow: a.sandbox.policy?.net?.allow ?? [],
    };
  }

  handlers(): Handlers {
    const d = this.d;
    const h: { [M in Exclude<MethodName, MoreMethod>]: Handler<M> } = {
      // ── system ──
      'system.status': async () => {
        const g = d.global();
        return {
          version: VERSION,
          uptimeSec: Math.round((d.now() - d.startedAt) / 1000),
          panic: g.panic.active,
          agents: d.config.agents.list().length,
          channels: d.config.channels.list().length,
          pendingApprovals: d.store.approvals.countPending(),
          owner: g.nostr.ownerNpub ? { npub: g.nostr.ownerNpub } : {},
          home: d.home,
          remotes: d.remotes.views(),
        };
      },
      'system.doctor': async () => ({ checks: await this.doctorChecks() }),
      'system.doctorFix': async ({ id, elevate }, ctx) => {
        this.requireLocal(ctx, 'fix');
        const action = doctorActionTable(this.tools.sandboxActions ?? sandboxActions())[id];
        if (!action) throw new BeamhopError('not_found', `no fix ${id} on this computer`);
        const actor = this.principal(ctx);
        let output = '';
        if (id === 'system.resume') {
          await d.resume(actor);
          output = 'Resumed.';
        } else {
          if (!action.admin) throw new BeamhopError('internal', `fix ${id} has no runner`);
          if (elevate === 'none')
            throw new BeamhopError(
              'forbidden',
              `"${action.label}" needs administrator rights. Run \`beamhop doctor --fix\` in a terminal to use sudo.`,
            );
          const deps = this.installer();
          const { cmd, args } = elevatedArgv(deps.platform, action.command, deps.which);
          const r = await (this.tools.fixRunner ?? defaultFixRunner(deps.env))(cmd, args);
          output = r.output;
          d.audit({
            type: r.code === 0 ? 'doctor.fixed' : 'doctor.fix.failed',
            severity: r.code === 0 ? 'security' : 'warn',
            summary: r.code === 0 ? `Ran fix ${id}` : `Fix ${id} failed (exit ${r.code})`,
            actor,
            data: { id, command: action.command },
          });
          if (r.code !== 0)
            throw new BeamhopError('unavailable', elevatedFailure(deps.platform, r), {
              output: r.output.slice(-4000),
            });
        }
        return { checks: await this.doctorChecks(), output };
      },
      'system.panic': async (p, ctx) => {
        await d.panic(p.reason, this.principal(ctx));
        return OK;
      },
      'system.resume': async (_p, ctx) => {
        await d.resume(this.principal(ctx));
        return OK;
      },

      // ── agents ──
      'agent.list': async () => ({ agents: d.config.agents.list().map((a) => d.agentView(a)) }),
      'agent.get': async ({ name }) => this.agentView(name),
      'agent.create': async ({ config, preset }, ctx) => {
        let base: Record<string, unknown> = {};
        if (preset) {
          const pr = PRESETS.find((x) => x.id === preset);
          if (!pr) throw new BeamhopError('invalid_input', `unknown preset ${preset}`);
          base = { ...(pr.config as Record<string, unknown>), preset };
        }
        const merged = deepMerge(base, config) as Record<string, unknown>;
        const parsed = AgentConfig.safeParse(merged);
        if (!parsed.success)
          throw new BeamhopError(
            'invalid_input',
            parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          );
        if (d.config.agents.has(parsed.data.name))
          throw new BeamhopError('conflict', `agent ${parsed.data.name} exists`);
        // §4: each agent gets its own Nostr key (kept in the secret store).
        const withKey = await d.identity.ensureAgentKey(parsed.data);
        this.saveAgent(withKey);
        d.audit({
          type: 'agent.created',
          severity: 'info',
          summary: `Agent ${parsed.data.name} created${preset ? ` from ${preset}` : ''}${withKey.identity.npub ? ` (${withKey.identity.npub})` : ''}`,
          actor: this.principal(ctx),
          agent: parsed.data.name,
        });
        await d.identity
          .onAgentCreated(withKey.name)
          .catch((e) => d.log.warn('agent identity setup failed', { agent: withKey.name, error: errMsg(e) }));
        return this.agentView(withKey.name);
      },
      'agent.update': async ({ name, patch }, ctx) => {
        const cur = d.agent(name);
        if (patch.name !== undefined && patch.name !== name)
          throw new BeamhopError('invalid_input', 'use agent.clone to rename');
        // The identity key ref may only stay as it is or name the agent's own key: pointing it at any
        // other secret would let the agent sign (and publish) with, e.g., another agent's key.
        const id = patch.identity as { nostrKeyRef?: unknown } | undefined;
        if (id && typeof id === 'object' && 'nostrKeyRef' in id) {
          const ref = id.nostrKeyRef;
          if (ref !== cur.identity.nostrKeyRef && ref !== agentKeyRef(name))
            throw new BeamhopError(
              'forbidden',
              `identity.nostrKeyRef can only be ${agentKeyRef(name)} (this agent's own key)`,
            );
        }
        const next = deepMerge(cur, patch);
        const v = this.saveAgent(next);
        const sensitive = [
          'sandbox',
          'grants',
          'mounts',
          'routes',
          'public',
          'memberships',
          'mesh',
          'secretEnv',
          'identity',
          'approvalRules',
          'harnessAuth',
        ].filter((k) => k in patch);
        d.audit({
          type: 'agent.updated',
          severity: sensitive.length ? 'security' : 'info',
          summary: `Agent ${name} updated (${Object.keys(patch).join(', ')})`,
          actor: this.principal(ctx),
          agent: name,
          data: { fields: Object.keys(patch) },
        });
        return v;
      },
      'agent.delete': async ({ name }, ctx) => {
        const cfg = d.agent(name);
        for (const s of d.sessions.all())
          if (s.agent === name) await d.sessions.end(s, 'agent deleted', { hard: true });
        d.config.agents.delete(name);
        await d.channels.syncAgent(name);
        await d.identity.deleteAgentKey(cfg);
        for (const sc of d.config.schedules.list().filter((s) => s.agent === name)) {
          d.scheduler.disarm(sc.id);
          d.config.schedules.delete(sc.id);
        }
        d.audit({
          type: 'agent.deleted',
          severity: 'warn',
          summary: `Agent ${name} deleted`,
          actor: this.principal(ctx),
          agent: name,
        });
        return OK;
      },
      'agent.start': async ({ name }, ctx) => {
        d.assertNotPanic();
        d.agent(name);
        d.store.kv.delete('agent-stopped', name);
        d.audit({
          type: 'agent.start',
          severity: 'info',
          summary: `Agent ${name} started`,
          actor: this.principal(ctx),
          agent: name,
        });
        d.emitAgent(name);
        return this.agentView(name);
      },
      'agent.stop': async ({ name, hard }, ctx) => {
        d.agent(name);
        d.store.kv.set('agent-stopped', name, true);
        for (const s of d.sessions.all())
          if (s.agent === name)
            await d.sessions.end(s, hard ? 'agent hard-stopped' : 'agent stopped', { hard });
        d.audit({
          type: 'agent.stop',
          severity: hard ? 'security' : 'info',
          summary: `Agent ${name} stopped${hard ? ' (hard)' : ''}`,
          actor: this.principal(ctx),
          agent: name,
        });
        d.emitAgent(name);
        return this.agentView(name);
      },
      'agent.clone': async ({ name, newName }, ctx) => {
        const cur = d.agent(name);
        if (d.config.agents.has(newName)) throw new BeamhopError('conflict', `agent ${newName} exists`);
        // A clone gets its own identity and no memberships (it must be joined explicitly).
        const cloned = await d.identity.ensureAgentKey(
          AgentConfig.parse({
            ...cur,
            name: newName,
            identity: {},
            memberships: [],
            displayName: cur.displayName ? `${cur.displayName} (copy)` : undefined,
          }),
        );
        this.saveAgent(cloned);
        await d.identity
          .onAgentCreated(newName)
          .catch((e) => d.log.warn('agent identity setup failed', { agent: newName, error: errMsg(e) }));
        const v = this.agentView(newName);
        d.audit({
          type: 'agent.cloned',
          severity: 'info',
          summary: `Agent ${name} cloned to ${newName}`,
          actor: this.principal(ctx),
          agent: newName,
        });
        return v;
      },
      'agent.presets': async () => ({
        presets: PRESETS.map((p) => ({
          id: p.id,
          title: p.title,
          description: p.description,
          config: p.config as Record<string, unknown>,
        })),
      }),
      'agent.instructions': async ({ name }) => {
        const a = d.agent(name);
        const files: { path: string; harness: string; content: string }[] = [];
        for (const m of a.mounts) {
          const root = expandHome(m.path);
          for (const f of INSTRUCTION_FILES) {
            const p = join(root, f.file);
            try {
              // lstat: a symlinked instruction file (a cloned repo can carry one) could point anywhere,
              // e.g. at the vault key; it is not read, as instructionsWrite already refuses it.
              const st = existsSync(p) ? lstatSync(p) : undefined;
              if (st?.isFile() && st.size < 256 * 1024)
                files.push({ path: p, harness: f.harness, content: readFileSync(p, 'utf8') });
            } catch {
              /* unreadable */
            }
          }
        }
        return { files };
      },

      // ── harnesses ──
      'harness.scan': async () => ({ harnesses: await this.withLogins(await this.scan()) }),
      'harness.models': async ({ id, refresh }) => harnessModels(d, id, refresh),
      'harness.list': async () => {
        if (!this.scanFresh()) await this.scan();
        return { harnesses: await this.withLogins(this.harnessViews()) };
      },
      'harness.login': async ({ id, method, value }, ctx) => {
        if (resolveMethod(id, method).kind === 'home')
          throw new BeamhopError(
            'invalid_input',
            `${resolveMethod(id, method).label} is a sign-in, not a key: run beamhop harness login ${id} --browser --method ${resolveMethod(id, method).id}`,
          );
        await this.storeHarnessLogin(id, method, value, ctx);
        // Verify right away; a failed check is shown in the returned status, not thrown.
        const login = await checkLogin(d, id).catch(() => undefined);
        const v = await this.harnessView(id);
        return login ? { ...v, login: { ...v.login!, ...login } } : v;
      },
      'harness.logout': async ({ id, method }, ctx) => {
        const methods = method ? [resolveMethod(id, method)] : loginMethods(id);
        for (const m of methods) await d.secrets.delete(m.secret);
        d.invalidateSecretCache();
        d.store.kv.delete('harness-login', id);
        d.audit({
          type: 'harness.logout',
          severity: 'security',
          summary: `${id} logged out (${methods.map((m) => m.secret).join(', ')})`,
          actor: this.principal(ctx),
          data: { harness: id, secrets: methods.map((m) => m.secret) },
        });
        return this.harnessView(id);
      },
      'harness.checkLogin': async ({ id }) => {
        if (!loginMethods(id).length) resolveMethod(id);
        const login = await checkLogin(d, id);
        const v = await this.harnessView(id);
        // Keep the check's own message (e.g. why it could not run), not just the stored state.
        return { ...v, login };
      },
      'harness.install': async ({ id, method }, ctx) => {
        this.requireLocal(ctx, 'install');
        const entry = this.catalogEntry(id);
        const deps = this.installer();
        const avail = availableMethods(entry, deps);
        const m = method ?? avail[0];
        if (!m) throw new BeamhopError('unavailable', noneReason(entry, deps));
        if (!avail.includes(m))
          throw new BeamhopError(
            'unavailable',
            `${methodLabel(entry, m)} can't install ${entry.displayName} on this computer.`,
          );
        return this.startInstall(entry, m, false, ctx);
      },
      'harness.update': async ({ id }, ctx) => {
        this.requireLocal(ctx, 'install');
        const entry = this.catalogEntry(id);
        const v = this.harnessViews().find((h) => h.id === id);
        if (!v || v.status === 'not-installed' || !v.path)
          throw new BeamhopError('invalid_input', `${entry.displayName} is not installed`);
        const m = updateMethodFor(v, entry, this.installer());
        if (!m)
          throw new BeamhopError(
            'unavailable',
            `${entry.displayName} wasn't installed by beamhop or Homebrew, so beamhop can't update it. Update it the way you installed it.`,
          );
        return this.startInstall(entry, m, true, ctx);
      },
      'harness.updates': async ({ refresh }) => {
        type Updates = Result<'harness.updates'>['updates'];
        const cached = d.store.kv.get<{ at: number; updates: Updates }>('harness', 'updates');
        if (!refresh && cached && d.now() - cached.at < UPDATES_TTL_MS) return { updates: cached.updates };
        if (!this.scanFresh()) await this.scan();
        const deps = this.installer();
        const installed = this.harnessViews().filter((h) => h.status !== 'not-installed' && h.path);
        const updates = (
          await Promise.all(
            installed.map(async (v) => {
              const entry = findHarness(this.catalog(), v.id);
              if (!entry) return undefined;
              const m = updateMethodFor(v, entry, deps);
              const latest = await latestVersion(entry, m, deps).catch(() => undefined);
              return {
                id: v.id,
                ...(v.version ? { current: v.version } : {}),
                ...(latest ? { latest } : {}),
                available: !!m && isNewer(latest, v.version),
                required: v.status === 'unsupported-version',
              };
            }),
          )
        ).filter((u) => u !== undefined);
        d.store.kv.set('harness', 'updates', { at: d.now(), updates });
        return { updates };
      },
      'harness.loginFlow': async ({ id, openBrowser, method }, ctx) => {
        this.requireLocal(ctx, 'login');
        const entry = this.catalogEntry(id);
        const homeMethod = method
          ? resolveMethod(id, method)
          : entry.auth.loginFlow
            ? undefined
            : entry.auth.methods.find((m) => m.kind === 'home');
        if (homeMethod) return this.homeSignIn(entry, homeMethod, openBrowser, ctx);
        const flow = entry.auth.loginFlow;
        if (!flow)
          throw new BeamhopError(
            'unavailable',
            entry.auth.methods.length
              ? `${entry.displayName} can't be signed in from the app this way; use one of its login methods instead.`
              : `${entry.displayName} can't be signed in from the app yet.`,
          );
        if (!this.scanFresh()) await this.scan();
        const v = this.harnessViews().find((h) => h.id === id);
        if (!v?.path || v.status === 'not-installed')
          throw new BeamhopError('invalid_input', `${entry.displayName} is not installed`);
        const deps = this.installer();
        const host = { platform: deps.platform, env: deps.env, home: deps.home };
        const actor = this.principal(ctx);
        return this.jobs().start(
          {
            harness: id,
            displayName: entry.displayName,
            kind: 'login',
            method: 'flow',
            timeoutMs: (flow.timeoutSec ?? 300) * 1000,
            onEnd: (job) => this.auditJob(job, actor),
          },
          loginBody(
            entry,
            flow,
            deps,
            {
              binary: v.path,
              storeLogin: async (method, value) => {
                await this.storeHarnessLogin(id, method, value, ctx);
                await checkLogin(d, id).catch(() => undefined);
              },
              loggedIn: () =>
                !entry.auth.files.length ||
                entry.auth.files.some((f) => {
                  const p = expandPath(f, host);
                  return !!p && fileExists(p);
                }),
            },
            openBrowser,
          ),
        );
      },
      'harness.job.get': async ({ jobId, since }) => this.jobs().get(jobId, since),
      'harness.job.list': async () => ({ jobs: this.jobs().list() }),
      'harness.job.cancel': async ({ jobId }, ctx) => {
        this.requireLocal(ctx, 'install');
        return this.jobs().cancel(jobId);
      },
      'harness.add': async ({ id, command, args }, ctx) => {
        const hid = id.startsWith('acp:') ? id : `acp:${id}`;
        const factory = d.registry.acpFactory;
        let view: HarnessView = {
          id: hid,
          displayName: id,
          command: [command, ...args].join(' '),
          status: 'error',
          protocol: 'acp',
          message: 'ACP adapter (@beamhop/harness-acp) is not installed',
        };
        if (factory) {
          const plugin = factory({ id: hid, command, args });
          d.registry.addHarness(plugin);
          try {
            const det = await plugin.detect();
            view = det
              ? {
                  id: hid,
                  displayName: det.displayName,
                  command: det.command,
                  status: det.status,
                  protocol: det.protocol,
                  ...(det.version ? { version: det.version } : {}),
                  ...(det.message ? { message: det.message } : {}),
                }
              : { ...view, status: 'error', message: 'ACP initialize handshake failed' };
          } catch (e) {
            view = { ...view, message: errMsg(e) };
          }
        }
        this.customHarnesses.set(hid, view);
        d.store.kv.set('harness', 'custom', [...this.customHarnesses.values()]);
        d.store.kv.set('harness-defs', hid, { command, args });
        d.audit({
          type: 'harness.added',
          severity: 'security',
          summary: `Custom ACP harness ${hid} added (${command})`,
          actor: this.principal(ctx),
        });
        return view;
      },

      'harness.remove': async ({ id }, ctx) => {
        const hid = id.startsWith('acp:') ? id : `acp:${id}`;
        if (!this.customHarnesses.has(hid))
          throw new BeamhopError(
            'not_found',
            `${id} is not a custom harness (only ones added with beamhop harness add can be removed)`,
          );
        const users = d.config.agents.list().filter((a) => a.harness === hid);
        if (users.length)
          throw new BeamhopError(
            'conflict',
            `${hid} is used by ${users.map((a) => a.name).join(', ')}; move them to another harness first`,
          );
        this.customHarnesses.delete(hid);
        d.registry.removeHarness(hid);
        d.store.kv.set('harness', 'custom', [...this.customHarnesses.values()]);
        d.store.kv.delete('harness-defs', hid);
        d.audit({
          type: 'harness.removed',
          severity: 'security',
          summary: `Custom ACP harness ${hid} removed`,
          actor: this.principal(ctx),
        });
        return OK;
      },

      // ── channels ──
      'channel.providers': async () => ({ providers: this.channelProviders() }),
      'channel.list': async () => ({ channels: d.config.channels.list().map((c) => d.channels.view(c)) }),
      'channel.validate': async ({ provider, values, secrets }) => {
        const p = d.registry.channel(provider);
        if (!p) throw new BeamhopError('not_found', `unknown channel provider ${provider}`);
        try {
          return await p.setup.validate(values, secrets);
        } catch (e) {
          return { ok: false, message: errMsg(e) };
        }
      },
      'channel.add': async ({ name, provider, values, secrets }, ctx) => {
        const p = d.registry.channel(provider);
        if (!p) throw new BeamhopError('not_found', `unknown channel provider ${provider}`);
        if (d.config.channels.has(name)) throw new BeamhopError('conflict', `channel ${name} exists`);
        const refs: string[] = [];
        for (const [field, value] of Object.entries(secrets)) {
          if (!/^[A-Za-z0-9_-]{1,64}$/.test(field))
            throw new BeamhopError('invalid_input', `invalid secret field ${field}`);
          const ref = channelSecretName(name, field);
          await d.secrets.set(ref, value);
          refs.push(ref);
        }
        d.invalidateSecretCache();
        const cfg: ChannelConfig = d.config.channels.save({
          name,
          provider,
          settings: values,
          secretRefs: refs,
          enabled: true,
          createdAt: new Date(d.now()).toISOString(),
        });
        d.audit({
          type: 'channel.added',
          severity: 'security',
          summary: `Channel ${name} (${provider}) added`,
          actor: this.principal(ctx),
        });
        if (!d.isPanic()) await d.channels.connect(cfg).catch(() => {});
        return d.channels.view(cfg);
      },
      'channel.remove': async ({ name }, ctx) => {
        const cfg = d.config.channels.require(name);
        await d.channels.disconnect(name);
        for (const ref of cfg.secretRefs) await d.secrets.delete(ref);
        d.invalidateSecretCache();
        d.config.channels.delete(name);
        d.audit({
          type: 'channel.removed',
          severity: 'security',
          summary: `Channel ${name} removed`,
          actor: this.principal(ctx),
        });
        return OK;
      },
      'channel.pair': async ({ name }, ctx) => {
        const cfg = d.config.channels.require(name);
        const code = createPairingCode({ now: d.now() });
        d.store.pairingCodes.put({
          code: code.code,
          purpose: 'channel-pair',
          expiresAt: code.expiresAt,
          data: { channel: name },
        });
        d.audit({
          type: 'pairing.started',
          severity: 'security',
          summary: `Pairing code issued for channel ${name}`,
          actor: this.principal(ctx),
        });
        const conn = d.channels.get(name);
        const bot = conn?.self.handle ?? conn?.self.displayName ?? `the ${cfg.provider} bot`;
        return {
          code: code.code,
          expiresAt: code.expiresAt,
          instructions: `Send \`/pair ${code.code}\` to ${bot} in a direct message within 10 minutes. This links your ${cfg.provider} account to this beamhop as an owner.`,
        };
      },

      // ── memberships ──
      'membership.join': async ({ agent, membership }, ctx) => {
        const a = d.agent(agent);
        const { revokedAt: _r, ...m } = membership;
        if (!effectiveRoleDef(m.defaultRole, d.global().roles as RoleOverride[]))
          throw new BeamhopError(
            'invalid_input',
            `unknown role ${m.defaultRole}; one of: ${allRoleDefs(d.global().roles as RoleOverride[])
              .map((r) => r.name)
              .join(', ')}`,
          );
        const memberships = [...a.memberships.filter((x) => x.target !== m.target), m];
        const v = this.saveAgent({ ...a, memberships });
        d.audit({
          type: 'membership.join',
          severity: 'security',
          summary: `${agent} joined ${m.target} (default role ${m.defaultRole})`,
          actor: this.principal(ctx),
          agent,
          data: { target: m.target },
        });
        return v;
      },
      'membership.leave': async ({ agent, target }, ctx) => {
        const a = d.agent(agent);
        if (!a.memberships.some((x) => x.target === target))
          throw new BeamhopError(
            'not_found',
            `${agent} is not a member of ${target}${a.memberships.length ? `; it is in ${a.memberships.map((x) => x.target).join(', ')}` : ''}`,
          );
        const v = this.saveAgent({ ...a, memberships: a.memberships.filter((x) => x.target !== target) });
        d.audit({
          type: 'membership.leave',
          severity: 'info',
          summary: `${agent} left ${target}`,
          actor: this.principal(ctx),
          agent,
        });
        return v;
      },

      // ── sessions ──
      'session.list': async ({ agent }) => ({
        sessions: d.store.sessions.list(agent ? { agent } : {}).map(stripRecord),
      }),
      'session.events': async ({ id, afterSeq }) => {
        d.store.sessions.require(id);
        return { events: d.store.sessions.events(id, { afterSeq }) };
      },
      'session.send': async ({ id, text }, ctx) => {
        d.assertNotPanic();
        const rec = d.store.sessions.require(id);
        const agent = d.agent(rec.agent);
        if (rec.status === 'ended') d.store.sessions.update(id, { status: 'idle' });
        const owner = d.roleDef('owner');
        const live = d.sessions.live(id);
        await d.sessions.submit({
          agent,
          channel: rec.channel,
          conversation: { kind: live?.conversationKind ?? 'dm', id: rec.conversationId },
          threadId: rec.threadId,
          ...(live?.membership ? { membership: live.membership } : {}),
          turn: {
            text,
            promptFor: () =>
              `[beamhop] from=local owner via=${ctx.transport} (role=owner) time=${new Date(d.now()).toISOString()}\n\n${text}`,
            from: { principal: this.principal(ctx), displayName: 'owner', role: 'owner' },
            role: owner,
            attachments: [],
            hops: 0,
            source: 'api',
          },
        });
        return OK;
      },
      'session.start': async ({ agent: name, text, title }, ctx) => {
        d.assertNotPanic();
        const agent = d.agent(name);
        if (d.isAgentStopped(name)) throw new BeamhopError('unavailable', `agent ${name} is stopped`);
        const owner = d.roleDef('owner');
        const live = await d.sessions.submit({
          agent,
          channel: 'local',
          conversation: { kind: 'dm', id: 'owner' },
          threadId: newId('thr'),
          fresh: true,
          ...(title ? { title } : {}),
          turn: {
            text,
            promptFor: () =>
              `[beamhop] from=local owner via=${ctx.transport} (role=owner) time=${new Date(d.now()).toISOString()}\n\n${text}`,
            from: { principal: this.principal(ctx), displayName: 'owner', role: 'owner' },
            role: owner,
            attachments: [],
            hops: 0,
            source: 'api',
          },
        });
        return stripRecord(live.record());
      },
      'session.stop': async ({ id }, ctx) => {
        d.store.sessions.require(id);
        const live = d.sessions.live(id);
        if (live) await d.sessions.end(live, `stopped by ${this.principal(ctx)}`);
        else d.store.sessions.update(id, { status: 'ended' });
        return OK;
      },

      // ── approvals ──
      'approval.list': async ({ status }) => ({
        approvals: d.store.approvals.listStates({ status }).map((s) => d.approvals.view(s)),
      }),
      'approval.decide': async ({ id, allow, always, grantRole, session, rule, reason }, ctx) =>
        d.approvals.decide(id, this.principal(ctx), allow, {
          always,
          ...(session ? { session } : {}),
          ...(rule !== undefined ? { rule } : {}),
          ...(reason !== undefined ? { reason } : {}),
          ...(grantRole ? { grantRole } : {}),
        }),
      'approval.undo': async ({ id }, ctx) => d.approvals.undo(id, this.principal(ctx)),

      // ── roles & owners ──
      'role.list': async () => {
        const g = d.global();
        return { roles: allRoleDefs(g.roles as RoleOverride[]), grants: g.grants };
      },
      'role.grant': async ({ principal, role, agent }, ctx) => {
        if (!effectiveRoleDef(role, d.global().roles as RoleOverride[]))
          throw new BeamhopError('invalid_input', `unknown role ${role}`);
        if (role === 'owner') throw new BeamhopError('invalid_input', 'use owner.add to add owners');
        if (agent)
          d.config.agents.update(agent, (a) => ({ ...a, grants: { ...a.grants, [principal]: role } }));
        else d.updateGlobal((c) => ({ ...c, grants: { ...c.grants, [principal]: role } }));
        d.audit({
          type: 'role.grant',
          severity: 'security',
          summary: `Granted ${role} to ${principal}${agent ? ` on ${agent}` : ' globally'}`,
          actor: this.principal(ctx),
          ...(agent ? { agent } : {}),
          data: { principal, role },
        });
        if (agent) d.emitAgent(agent);
        return OK;
      },
      'role.revoke': async ({ principal, agent }, ctx) => {
        const n = normalizePrincipal(principal);
        const strip = (g: Record<string, string>) =>
          Object.fromEntries(
            Object.entries(g).filter(([k]) => normalizePrincipal(k) !== n && k !== principal),
          );
        if (agent) d.config.agents.update(agent, (a) => ({ ...a, grants: strip(a.grants) }));
        else d.updateGlobal((c) => ({ ...c, grants: strip(c.grants) }));
        d.audit({
          type: 'role.revoke',
          severity: 'security',
          summary: `Revoked role of ${principal}${agent ? ` on ${agent}` : ' globally'}`,
          actor: this.principal(ctx),
          ...(agent ? { agent } : {}),
          data: { principal },
        });
        return OK;
      },
      'principal.link': async ({ person, principal }, ctx) => {
        d.updateGlobal((c) => {
          const list = c.people[person] ?? [];
          if (list.some((p) => normalizePrincipal(p) === normalizePrincipal(principal))) return c;
          return { ...c, people: { ...c.people, [person]: [...list, principal] } };
        });
        d.audit({
          type: 'principal.link',
          severity: 'security',
          summary: `Linked ${principal} to ${person}`,
          actor: this.principal(ctx),
          data: { person, principal },
        });
        return OK;
      },
      'owner.add': async ({ principal }, ctx) => {
        d.ensureOwner(principal);
        if (principal.startsWith('nostr:') && !d.global().nostr.ownerNpub)
          d.updateGlobal((c) => ({ ...c, nostr: { ...c.nostr, ownerNpub: principal.slice(6) } }));
        d.refreshControlAllowlist();
        d.audit({
          type: 'owner.add',
          severity: 'security',
          summary: `Added owner ${principal}`,
          actor: this.principal(ctx),
          data: { principal },
        });
        return OK;
      },
      'owner.remove': async ({ principal }, ctx) => {
        const g = d.global();
        const n = normalizePrincipal(principal);
        const rest = g.owners.filter((o) => normalizePrincipal(o) !== n);
        if (rest.length === g.owners.length)
          throw new BeamhopError('not_found', `${principal} is not an owner`);
        if (rest.length === 0) throw new BeamhopError('conflict', 'at least one owner must remain');
        d.updateGlobal((c) => ({
          ...c,
          owners: rest,
          people: Object.fromEntries(
            Object.entries(c.people).map(([k, v]) => [
              k,
              k === 'owner' ? v.filter((p) => normalizePrincipal(p) !== n) : v,
            ]),
          ),
          nostr:
            c.nostr.ownerNpub && n === normalizePrincipal(`nostr:${c.nostr.ownerNpub}`)
              ? { ...c.nostr, ownerNpub: undefined }
              : c.nostr,
        }));
        d.refreshControlAllowlist();
        d.channels.forgetPairings((p) => normalizePrincipal(p) === n);
        d.audit({
          type: 'owner.remove',
          severity: 'security',
          summary: `Removed owner ${principal}`,
          actor: this.principal(ctx),
          data: { principal },
        });
        return OK;
      },

      // ── policy ──
      'policy.get': async ({ name }) => this.effectivePolicy(name),
      'sandbox.test': async ({ name }) => {
        const a = d.agent(name);
        const results = await probeHosts(d, a, await requiredHosts(d, a.harness));
        return {
          results: results.map(({ host, source, status, detail }) => ({
            host,
            source,
            status,
            ...(detail ? { detail } : {}),
          })),
        };
      },
      'policy.set': async ({ name, profile, policy }, ctx) => {
        const prof = profile as 'strict' | 'workspace' | 'custom';
        if (!['strict', 'workspace', 'custom'].includes(prof))
          throw new BeamhopError('invalid_input', `unknown profile ${profile}`);
        // Hosts are checked here, not when a session starts: a bad entry ("*", a URL, "") would
        // otherwise only fail later, as a raw schema error from the sandbox.
        const checked = policy && {
          ...policy,
          net: { ...policy.net, allow: [...new Set(policy.net.allow.map(normalizeHostPattern))] },
        };
        d.config.agents.update(name, (a) => ({
          ...a,
          sandbox: {
            profile: prof,
            ...(checked ? { policy: checked } : a.sandbox.policy ? { policy: a.sandbox.policy } : {}),
          },
        }));
        d.audit({
          type: 'policy.set',
          severity: 'security',
          summary: `Sandbox policy of ${name} set to ${profile}`,
          actor: this.principal(ctx),
          agent: name,
        });
        d.emitAgent(name);
        return OK;
      },
      'policy.suggestions': async ({ name }) => ({
        suggestions: d.store.policySuggestions.list(name ? { agent: name } : {}),
      }),
      'policy.applySuggestion': async ({ id, accept, value }, ctx) => {
        const s = d.store.policySuggestions.get(id);
        if (!s) throw new BeamhopError('not_found', `suggestion ${id} not found`);
        if (value !== undefined && !accept)
          throw new BeamhopError('invalid_input', '`value` only applies when accepting');
        // Validated before anything changes: widened hosts/dirs must cover the suggestion, never
        // an always-denied path. Paths are validated even without `value`.
        const v = accept
          ? value !== undefined
            ? suggestionValue(s.kind, s.value, value)
            : s.kind === 'net.allow'
              ? s.value
              : suggestionValue(s.kind, s.value, s.value)
          : s.value;
        d.store.policySuggestions.resolve(id, accept);
        if (accept) {
          d.config.agents.update(s.agent, (a) => withPolicyValue(a, s.kind, v));
          d.emitAgent(s.agent);
        }
        d.audit({
          type: 'policy.suggestion',
          severity: 'security',
          summary: `${accept ? 'Accepted' : 'Rejected'} sandbox suggestion ${s.kind} ${v}${v !== s.value ? ` (suggested ${s.value})` : ''} for ${s.agent}`,
          actor: this.principal(ctx),
          agent: s.agent,
          data: { kind: s.kind, value: v, suggested: s.value },
        });
        return OK;
      },

      // ── secrets (names only) ──
      'secret.list': async () => ({
        secrets: (await d.secrets.list()).filter((s) => !isInternalSecret(s.name)),
        backend: d.secrets.backend,
        ...(d.secrets.backend === 'file'
          ? { keySource: readKeySource({ home: d.home }), keychainAvailable: await keychainAvailable() }
          : {}),
      }),
      'secret.setKeySource': async ({ keySource }, ctx) => {
        if (d.secrets.backend !== 'file')
          throw new BeamhopError('unavailable', 'this daemon does not keep secrets in the encrypted vault');
        const from = readKeySource({ home: d.home });
        // The open vault keeps working: only where its key is stored changes.
        await setKeySource({ home: d.home }, keySource);
        if (from !== keySource)
          d.audit({
            type: 'secret.keySource',
            severity: 'security',
            summary: `Vault key moved from ${from} to ${keySource}`,
            actor: this.principal(ctx),
            data: { from, to: keySource },
          });
        return { keySource: readKeySource({ home: d.home }) };
      },
      'secret.set': async ({ name, value }, ctx) => {
        if (isInternalSecret(name)) throw new BeamhopError('forbidden', 'reserved secret name');
        await d.secrets.set(name, value);
        d.invalidateSecretCache();
        await d.channels.onSecretSet(name);
        d.audit({
          type: 'secret.set',
          severity: 'security',
          summary: `Secret ${name} set`,
          actor: this.principal(ctx),
          data: { name },
        });
        return OK;
      },
      'secret.delete': async ({ name }, ctx) => {
        if (isInternalSecret(name)) throw new BeamhopError('forbidden', 'reserved secret name');
        if ((await d.secrets.get(name)) === undefined)
          throw new BeamhopError('not_found', `no secret named ${name}`);
        // Deleting a secret something still uses breaks it silently (an agent loses its identity, a
        // channel its credentials): name the users so they can be changed first.
        const users = this.secretUsers(name);
        if (users.length)
          throw new BeamhopError(
            'conflict',
            `secret ${name} is in use by ${users.join(', ')}; change or remove ${users.length > 1 ? 'those' : 'that'} first`,
          );
        await d.secrets.delete(name);
        d.invalidateSecretCache();
        d.audit({
          type: 'secret.delete',
          severity: 'security',
          summary: `Secret ${name} deleted`,
          actor: this.principal(ctx),
          data: { name },
        });
        return OK;
      },

      // ── schedules ──
      'schedule.list': async ({ agent }) => ({
        schedules: d.config.schedules.list().filter((s) => !agent || s.agent === agent),
      }),
      'schedule.add': async (p, ctx) => {
        d.agent(p.agent);
        const id = newId('sch');
        const input = { ...p, id };
        d.scheduler.validate(input);
        const s = d.config.schedules.save(input);
        let webhook: { url: string; secret: string } | undefined;
        if (s.kind === 'webhook') {
          const secret = await d.scheduler.createWebhookSecret(id);
          webhook = { url: `${d.api?.url ?? `http://127.0.0.1:${d.global().api.port}`}/hooks/${id}`, secret };
        }
        d.scheduler.rearm(id);
        d.audit({
          type: 'schedule.added',
          severity: 'info',
          summary: `Schedule ${id} (${s.kind}) added for ${s.agent}`,
          actor: this.principal(ctx),
          agent: s.agent,
        });
        return { ...s, ...(webhook ? { webhook } : {}) };
      },
      'schedule.update': async ({ id, patch }, ctx) => {
        const cur = d.config.schedules.require(id);
        const next = { ...cur, ...patch, id } as ScheduleConfig;
        // A schedule pointed at a missing agent could never run (and blocked later updates).
        if ('agent' in patch) {
          if (typeof next.agent !== 'string') throw new BeamhopError('invalid_input', 'agent must be a name');
          d.agent(next.agent);
        }
        d.scheduler.validate(next);
        const s = d.config.schedules.save(next);
        d.scheduler.rearm(id);
        d.audit({
          type: 'schedule.updated',
          severity: 'info',
          summary: `Schedule ${id} updated`,
          actor: this.principal(ctx),
          agent: s.agent,
        });
        return s;
      },
      'schedule.remove': async ({ id }, ctx) => {
        const s = d.config.schedules.require(id);
        d.scheduler.disarm(id);
        d.config.schedules.delete(id);
        await d.secrets.delete(webhookSecretName(id));
        d.audit({
          type: 'schedule.removed',
          severity: 'info',
          summary: `Schedule ${id} removed`,
          actor: this.principal(ctx),
          agent: s.agent,
        });
        return OK;
      },
      'schedule.run': async ({ id }) => {
        d.assertNotPanic();
        d.config.schedules.require(id);
        // Checks (agent exists, not stopped, owner's role, postTo) fail the call; the turn runs on.
        const go = d.scheduler.prepare(id);
        void go()
          .then((r) => {
            if (!r.ok) d.log.warn('schedule run failed', { id, error: r.error ?? 'unknown error' });
          })
          .catch((e) => d.log.warn('schedule run failed', { id, error: errMsg(e) }));
        return OK;
      },

      // ── deploy ──
      'deploy.providers': async () => {
        const out = [];
        for (const dep of d.registry.deployers.values())
          out.push({
            id: dep.id,
            displayName: dep.displayName,
            kind: dep.kind,
            configured: (await d.secrets.get(`deploy.${dep.id}.token`)) !== undefined,
          });
        return { providers: out };
      },
      'deploy.options': async ({ provider }) => {
        const dep = this.requireDeployer(provider);
        return { sizes: await dep.sizes(), regions: await dep.regions() };
      },
      'deploy.plan': async (p) => {
        const dep = this.requireDeployer(p.provider);
        const a = d.agent(p.agent);
        return dep.plan(this.deploySpec(p, a));
      },
      'deploy.apply': async (p, ctx) => {
        d.assertNotPanic();
        const dep = this.requireDeployer(p.provider);
        const a = d.agent(p.agent);
        // The one-time provisioning key must exist before the host is created (its pubkey goes into
        // the host's environment); without the nostr package the deployer reports the gap itself.
        await d.remotes.provisioningKey(a.name).catch(() => undefined);
        const spec = this.deploySpec(p, a);
        const res = await dep.apply(spec);
        const plan = await dep.plan(spec).catch(() => undefined);
        const rec = d.store.deployments.upsert({
          id: res.id,
          provider: res.provider,
          agent: res.agent,
          status: res.status,
          createdAt: res.createdAt,
          ...(res.region ? { region: res.region } : {}),
          ...(res.size ? { size: res.size } : {}),
          ...(plan ? { monthlyCostUsd: plan.monthlyCostUsd } : {}),
          ...(res.address ? { address: res.address } : {}),
        });
        d.audit({
          type: 'deploy.apply',
          severity: 'security',
          summary: `Deployed ${p.agent} to ${p.provider} (${p.mode})`,
          actor: this.principal(ctx),
          agent: p.agent,
          data: { id: res.id },
        });
        // Wait for the host's hello, then send its config and secrets over the control plane.
        await d.remotes
          .afterApply(rec)
          .catch((e) => d.log.warn('provisioning could not start', { id: rec.id, error: errMsg(e) }));
        const { address: _a, data: _d, ...view } = rec;
        return view;
      },
      'deploy.list': async () => {
        const out = [];
        for (const r of d.store.deployments.list()) {
          let status = r.status;
          const dep = d.registry.deployers.get(r.provider);
          if (dep) {
            try {
              status = (await dep.status(r.id)).status;
              if (status !== r.status) d.store.deployments.setStatus(r.id, status);
            } catch {
              /* offline: keep last known */
            }
          }
          const { address: _a, data: _d, ...view } = r;
          out.push({ ...view, status });
        }
        return { deployments: out };
      },
      'deploy.destroy': async ({ id }, ctx) => {
        const r = d.store.deployments.get(id);
        if (!r) throw new BeamhopError('not_found', `deployment ${id} not found`);
        await this.requireDeployer(r.provider).destroy(id);
        d.store.deployments.setStatus(id, 'destroyed');
        await d.remotes.forget(id);
        d.audit({
          type: 'deploy.destroy',
          severity: 'security',
          summary: `Destroyed deployment ${id}`,
          actor: this.principal(ctx),
          agent: r.agent,
        });
        return OK;
      },

      // ── audit & usage ──
      'audit.query': async ({ agent, severity, limit, before }) => ({
        events: d.store.audit.query({
          ...(agent ? { agent } : {}),
          ...(severity ? { severity } : {}),
          limit,
          ...(before ? { before } : {}),
        }),
      }),
      'usage.query': async ({ days, agent }) => ({
        rows: d.store.usage.query({ days, ...(agent ? { agent } : {}) }),
      }),

      // ── devices ──
      'device.list': async () => ({ devices: d.store.devices.list() }),
      'device.pairStart': async ({ name, requireConfirm }, ctx) =>
        d.pairing.start(name, requireConfirm, { actor: this.principal(ctx) }),
      'device.pairComplete': async (p, ctx) => d.pairing.complete(p, ctx),
      'device.pairStatus': async ({ pairingId }) => d.pairing.status(pairingId),
      'device.pairConfirm': async ({ pairingId, accept }, ctx) =>
        d.pairing.confirm(pairingId, accept, this.principal(ctx)),
      'device.remove': async ({ id }, ctx) => {
        if (!d.pairing.remove(id)) throw new BeamhopError('not_found', `device ${id} not found`);
        d.push.forgetDevice(id);
        d.audit({
          type: 'device.removed',
          severity: 'security',
          summary: `Removed device ${id}`,
          actor: this.principal(ctx),
          data: { device: id },
        });
        return OK;
      },
      'device.pushSubscribe': async ({ id, subscription }, ctx) => {
        this.assertOwnDevice(id, ctx);
        d.push.subscribe(id, subscription ?? null);
        return OK;
      },
      'device.pushKey': async () => ({ publicKey: await d.push.publicKey() }),
      'device.pushPrefs': async ({ id, prefs }, ctx) => {
        this.assertOwnDevice(id, ctx);
        return { id, prefs: prefs ? d.push.setPrefs(id, prefs) : d.push.prefs(id) };
      },

      // ── identity ──
      'identity.get': async () => {
        const g = d.global();
        const daemonNpub = d.control?.npub ?? (await d.controlKey().catch(() => undefined))?.npub;
        return {
          ...(g.nostr.ownerNpub ? { npub: g.nostr.ownerNpub } : {}),
          ownerKeyHeld: await d.identity.ownerKeyHeld(),
          ...(daemonNpub ? { daemonNpub } : {}),
          agents: d.config.agents.list().map((a) => ({
            name: a.name,
            ...(a.identity.npub ? { npub: a.identity.npub } : {}),
            ...(a.identity.nip05 ? { nip05: a.identity.nip05 } : {}),
            attested: d.identity.attested(a.name),
          })),
        };
      },
      'identity.ownerCreate': async ({ replace }, ctx) => {
        const npub = await d.identity.createOwner(replace);
        d.audit({
          type: 'owner.created',
          severity: 'security',
          summary: `Created owner key ${npub}`,
          actor: this.principal(ctx),
          data: { npub },
        });
        return { npub };
      },
      'identity.ownerImport': async ({ npub, replace }, ctx) => {
        const n = await d.identity.importOwner(npub, replace);
        d.audit({
          type: 'owner.imported',
          severity: 'security',
          summary: `Owner set to ${n} (key held on the owner's device)`,
          actor: this.principal(ctx),
          data: { npub: n },
        });
        return { npub: n };
      },
      'identity.ownerExport': async (_p, ctx) => {
        // Never over the Nostr control plane: only a client on this computer can see the key.
        // Allowlist, not denylist (review wave C OWN-1): any future transport stays refused.
        if (ctx.caller !== 'local' || !['direct', 'http', 'ws'].includes(ctx.transport))
          throw new BeamhopError('forbidden', 'the owner key can only be exported on this computer');
        const nsec = await d.identity.exportOwner();
        d.audit({
          type: 'owner.exported',
          severity: 'security',
          summary: 'Owner secret key exported (shown once)',
          actor: this.principal(ctx),
        });
        return { nsec };
      },
      'identity.attestationTemplate': async ({ name }) => d.identity.attestationTemplate(name),
      'identity.attest': async ({ name, event }, ctx) => {
        await d.identity.attest(name, event);
        d.audit({
          type: 'identity.attested',
          severity: 'security',
          summary: `Owner attestation published for ${name}`,
          actor: this.principal(ctx),
          agent: name,
        });
        return OK;
      },
      'identity.publish': async ({ name }) => d.identity.publish(name),
      'onboarding.hello': async ({ agent, text }) => d.identity.hello(agent, text),
      'onboarding.helloStatus': async ({ agent }) => d.identity.helloStatus(agent),
      'identity.nip05': async ({ domain, names }) => {
        let mod: {
          buildNip05Json: (
            domain: string,
            names: Record<string, string>,
          ) => { body: string; snippets: Record<string, string> };
        };
        try {
          mod = (await import(/* @vite-ignore */ '@beamhop/channel-nostr')) as never;
        } catch {
          throw new BeamhopError('unavailable', 'NIP-05 needs the @beamhop/channel-nostr package');
        }
        const map: Record<string, string> = names ?? {};
        if (!names)
          for (const a of d.config.agents.list()) if (a.identity.npub) map[a.name] = a.identity.npub;
        if (!Object.keys(map).length)
          throw new BeamhopError('invalid_input', 'no agents with an npub; pass names');
        try {
          const b = mod.buildNip05Json(domain, map);
          return { json: b.body, snippets: b.snippets };
        } catch (e) {
          throw new BeamhopError('invalid_input', errMsg(e));
        }
      },

      // ── data ──
      'data.export': async ({ agent }, ctx) => {
        const path = d.store.exportData(agent);
        d.audit({
          type: 'data.export',
          severity: 'security',
          summary: `Data exported${agent ? ` for ${agent}` : ''}`,
          actor: this.principal(ctx),
          ...(agent ? { agent } : {}),
        });
        return { path };
      },
      'data.purge': async ({ agent, before, includeAudit }, ctx) => {
        const r = d.store.purge({
          ...(agent ? { agent } : {}),
          ...(before ? { before } : {}),
          ...(includeAudit ? { includeAudit: true } : {}),
        });
        d.audit({
          type: 'data.purge',
          severity: 'security',
          summary: `Purged ${r.deleted} records${includeAudit ? ' (with audit)' : ''}${agent ? ` for ${agent}` : ''}${before ? ` before ${before}` : ''}`,
          actor: this.principal(ctx),
          ...(agent ? { agent } : {}),
        });
        return { deleted: r.deleted };
      },
    };
    const more = moreHandlers(d, { principal: (ctx) => this.principal(ctx) });
    return { ...h, ...more.handlers } as Handlers;
  }

  /** DeploySpec from deploy.plan/apply params: mount choices must name the agent's own mounts. */
  private deploySpec(
    p: import('@beamhop/core').ParsedParams<'deploy.plan'>,
    a: import('@beamhop/core').AgentConfig,
  ): import('@beamhop/core').DeploySpec {
    const { mounts, harnessAuth, ...rest } = p;
    if (mounts) {
      const known = new Set(a.mounts.flatMap((m) => [m.path, expandHome(m.path)]));
      for (const m of mounts)
        if (!known.has(m.path) && !known.has(expandHome(m.path)))
          throw new BeamhopError('invalid_input', `${m.path} is not a mount of ${a.name}`);
      const seen = new Set<string>();
      for (const m of mounts) {
        const k = expandHome(m.path);
        if (seen.has(k)) throw new BeamhopError('invalid_input', `${m.path} is listed twice`);
        seen.add(k);
      }
    }
    return {
      ...rest,
      harnesses: [a.harness],
      ...(mounts ? { mounts } : {}),
      harnessAuth: harnessAuth ?? a.harnessAuth,
    };
  }
}

/** Every method name of the API contract (to assert coverage in tests). */
export const ALL_METHODS = Object.keys(methods) as MethodName[];
export type { Result };
