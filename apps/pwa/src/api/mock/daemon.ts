/**
 * The fake daemon: implements EVERY method in `@beamhop/core` `methods` against in-memory state
 * (seed.ts) and pushes `ServerEvent`s like the real daemon would. Params are validated with the
 * real zod schemas, so a screen that works against the mock sends valid requests to beamhopd.
 */
import { RpcError } from '@beamhop/client';
import {
  AgentConfig,
  type AgentView,
  type ApprovalRule,
  type ApprovalView,
  type AuditEvent,
  BUILTIN_ROLES,
  ChannelConfig,
  type ChannelView,
  DEFAULT_ALERT_RULES,
  DEFAULT_ROLES,
  type DeploymentView,
  isMethod,
  type MethodName,
  methods,
  type ParsedParams,
  PRESETS,
  type PushCategory,
  type Result,
  RoleDef,
  RoleName,
  SandboxPolicy,
  ScheduleConfig,
  type ServerEvent,
  type SessionEventView,
  type SessionView,
  type WhoamiView,
} from '@beamhop/core';
import { MockJobs } from './jobs.ts';
import { MockPairing } from './pairing.ts';
import { ago, ahead, type MockState, NPUBS, OWNER, seed } from './seed.ts';

type Handler<M extends MethodName> = (p: ParsedParams<M>) => Result<M> | Promise<Result<M>>;
type Handlers = { [M in MethodName]: Handler<M> };

const ERR = {
  not_found: -32004,
  invalid_input: -32602,
  forbidden: -32003,
  conflict: -32009,
  unavailable: -32010,
  sandbox_violation: -32012,
} as const;

export const fail = (code: keyof typeof ERR, message: string): never => {
  throw new RpcError(ERR[code], message, { code });
};

const OK = { ok: true as const };
const LOCAL = 'local:owner';

/** Harness instruction files (relative to a mount), like the daemon's INSTRUCTION_FILES. */
const INSTRUCTION_FILES: { file: string; harness: string }[] = [
  { file: 'CLAUDE.md', harness: 'claude' },
  { file: '.claude/CLAUDE.md', harness: 'claude' },
  { file: 'AGENTS.md', harness: 'codex' },
  { file: 'GEMINI.md', harness: 'gemini' },
  { file: '.codex/config.toml', harness: 'codex' },
  { file: '.pi/SYSTEM.md', harness: 'pi' },
  { file: 'opencode.json', harness: 'opencode' },
];

/** The demo home directory for `fs.list` (hidden and always-denied entries are never listed). */
const MOCK_FS: Record<string, { name: string; git?: boolean }[]> = {
  '~': [{ name: 'Downloads' }, { name: 'Library' }, { name: 'code' }, { name: 'docs' }, { name: 'notes' }],
  '~/code': [{ name: 'app', git: true }, { name: 'scratch' }, { name: 'site', git: true }],
  '~/code/app': [{ name: 'src' }, { name: 'test' }],
  '~/code/site': [{ name: 'pages' }],
  '~/docs': [{ name: 'private' }, { name: 'public' }],
  '~/notes': [{ name: 'meetings' }],
  '~/Library': [{ name: 'Fonts' }],
};
/** ALWAYS_DENY_READ (home-relative), mirrored for the mock's path checks. */
const DENIED = [
  '~/.ssh',
  '~/.aws',
  '~/.gnupg',
  '~/.config/gh',
  '~/.config/gcloud',
  '~/.azure',
  '~/.kube',
  '~/.docker/config.json',
  '~/.netrc',
  '~/.npmrc',
  '~/.beamhop',
  '~/.config/beamhop',
  '~/Library/Keychains',
  '~/Library/Application Support/Google/Chrome',
  '~/Library/Application Support/Firefox',
  '~/.mozilla',
  '~/.config/google-chrome',
  '~/.config/chromium',
];
const normPath = (p: string) => {
  const out: string[] = [];
  for (const seg of p.replace(/\/+$/, '').split('/')) {
    if (seg === '..') out.pop();
    else if (seg !== '.' && seg !== '') out.push(seg);
  }
  return (p.startsWith('/') ? '/' : '') + out.join('/');
};
const inside = (p: string, root: string) => p === root || p.startsWith(`${root}/`);
const deniedPath = (p: string) => DENIED.some((d) => inside(p, d) || inside(d, p));
const HOST_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const SHELL_META = /[;&|`$<>\n\r\\]/;
const INTERPRETERS = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'dash',
  'env',
  'sudo',
  'doas',
  'su',
  'xargs',
  'eval',
  'exec',
  'python',
  'python3',
  'node',
  'perl',
  'ruby',
  'deno',
  'bun',
]);
const hostCovers = (pattern: string, host: string) =>
  pattern.startsWith('*.') ? host === pattern.slice(2) || host.endsWith(pattern.slice(1)) : host === pattern;
const checkHost = (raw: string): string => {
  const h = raw.trim().toLowerCase();
  if (!HOST_RE.test(h) || (h.startsWith('*.') && h.slice(2).split('.').length < 2) || h === 'localhost')
    return fail('invalid_input', `"${raw}" is not a host name or *.domain`);
  return h;
};

/**
 * The daemon's "always" rule validation (apps/daemon/src/rules.ts), for the demo: a rule only ever
 * covers the request it came from (or a narrow widening of it); never denied paths or interpreters.
 */
const mockRule = (a: ApprovalView, raw: string | undefined, by: string): ApprovalRule => {
  const i = (a.input ?? {}) as {
    command?: string;
    host?: string;
    url?: string;
    path?: string;
    file_path?: string;
  };
  const host = i.host ?? (i.url ? new URL(i.url).hostname : undefined);
  const path = i.path ?? i.file_path;
  const base = { tool: a.tool, role: a.requestedBy.role, createdAt: new Date().toISOString(), createdBy: by };
  if (raw === undefined) {
    if (i.command !== undefined) return { ...base, kind: 'command', value: i.command, exact: true };
    if (host) return { ...base, kind: 'host', value: checkHost(host) };
    if (path) {
      if (deniedPath(normPath(path))) return fail('invalid_input', 'that path is always denied');
      return { ...base, kind: 'path', value: normPath(path), exact: true };
    }
    return { ...base, kind: 'tool', value: a.tool };
  }
  const cmd = /^(bash|sh|shell|cmd):(.*)$/s.exec(raw.trim());
  if (cmd) {
    const v = cmd[2]!.trim().replace(/\s+/g, ' ');
    const req = (i.command ?? '').trim().replace(/\s+/g, ' ');
    if (!i.command || !v) return fail('invalid_input', 'this request has no command');
    if (v === req) return { ...base, kind: 'command', value: v, exact: true };
    const vw = v.split(' ');
    const rw = req.split(' ');
    if (SHELL_META.test(v) || vw.length > rw.length || vw.some((w, k) => w !== rw[k]))
      return fail('invalid_input', 'the command prefix must be a prefix of the requested command');
    if (INTERPRETERS.has((vw[0] ?? '').replace(/^.*\//, '')))
      return fail('invalid_input', `"${vw[0]}" runs arbitrary code; allow the exact command instead`);
    return { ...base, kind: 'command', value: v };
  }
  if (raw.startsWith('~') || raw.startsWith('/')) {
    if (!path) return fail('invalid_input', 'this request has no file path');
    const p = normPath(raw);
    const req = normPath(path);
    if (raw.endsWith('/')) {
      if (p === '~' || p === '/' || deniedPath(p) || !inside(req, p))
        return fail('invalid_input', 'the directory must contain the requested path');
      return { ...base, kind: 'path', value: p };
    }
    if (p !== req || deniedPath(p)) return fail('invalid_input', 'a file rule must name the requested file');
    return { ...base, kind: 'path', value: p, exact: true };
  }
  const h = checkHost(raw);
  if (!host || !hostCovers(h, host.toLowerCase()))
    return fail('invalid_input', 'the host rule must cover the requested host');
  return { ...base, kind: 'host', value: h };
};
const UNDO_WINDOW_MS = 5000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Binaries the mock pretends are on PATH for `harness.add` probes. */
const MOCK_PATH_BINARIES = new Set([
  'my-agent',
  'goose',
  'kiro-cli',
  'npx',
  'node',
  'uvx',
  'bunx',
  'docker',
  'auggie',
]);
/** Who answers a pairing code per provider in the demo. */
const MOCK_PAIRERS: Record<string, { principal: string; displayName: string; handle?: string }> = {
  telegram: { principal: 'telegram:5551', displayName: 'Alice', handle: '@alice' },
  slack: { principal: 'slack:T01ACME/U01ALICE', displayName: 'Alice', handle: 'alice · acme.slack.com' },
  discord: { principal: 'discord:220719', displayName: 'alice', handle: '@alice' },
};

/** Demo model lists for the mock daemon's model picker. */
const MOCK_MODELS: Record<
  string,
  { id: string; label?: string; description?: string; isDefault?: boolean }[]
> = {
  claude: [
    { id: 'default', label: 'Default (recommended)', isDefault: true },
    { id: 'opus', label: 'Opus', description: 'Most capable for complex work' },
    { id: 'sonnet', label: 'Sonnet', description: 'Best for everyday tasks' },
    { id: 'haiku', label: 'Haiku', description: 'Fastest for quick answers' },
  ],
  codex: [
    { id: 'gpt-6-luna', label: 'GPT-6-Luna', description: 'Fast and affordable', isDefault: true },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', description: 'Older balanced model' },
  ],
};

export class MockDaemon {
  state: MockState;
  private listeners = new Set<(e: ServerEvent) => void>();
  /** Decisions inside their 5 s commit window (JOURNEYS §2.6). */
  private commitTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pushPrefs = new Map<string, Record<PushCategory, boolean>>();
  /** Daemon actions (session.openPr pushes) held until their approval is released. */
  private actions = new Map<string, () => void>();
  /** Instruction files written through agent.instructionsWrite (path → content). */
  private instructionFiles = new Map<string, string>();
  /** Hook for the simulator: called when an approval's decision is released to the agent. */
  onDecisionReleased?: (a: ApprovalView) => void;
  /** Hook for the simulator: called after a user message so the agent can answer. */
  onUserMessage?: (sessionId: string, text: string) => void;

  /** Pairing + onboarding hello simulation (mock/pairing.ts). */
  pairing: MockPairing;
  /** Harness install / update / login jobs (mock/jobs.ts). */
  jobs: MockJobs;

  constructor(now = Date.now()) {
    this.state = seed(now);
    this.jobs = new MockJobs(() => this.state.harnesses, this.state.harnessUpdates, fail);
    this.pairing = new MockPairing({
      addDevice: (d) => {
        this.state.devices = [...this.state.devices.filter((x) => x.pubkey !== d.pubkey), d];
      },
      audit: (type, summary, severity) => this.audit({ actor: 'alice', type, severity, summary }),
    });
  }

  /** Run a pairing call, mapping its errors to RPC errors. */
  private pair<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      const code = (e as { code?: string }).code === 'not_found' ? 'not_found' : 'conflict';
      return fail(code, (e as Error).message);
    }
  }

  // ─────────── events ───────────
  subscribe(fn: (e: ServerEvent) => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  emit(e: ServerEvent) {
    for (const fn of this.listeners) fn(e);
  }
  audit(e: Omit<AuditEvent, 'id' | 'at' | 'data'> & { data?: AuditEvent['data'] }) {
    const ev: AuditEvent = {
      id: `aud_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      at: new Date().toISOString(),
      data: {},
      ...e,
    };
    this.state.audit.unshift(ev);
    this.emit({ type: 'audit', event: ev });
    return ev;
  }

  // ─────────── helpers used by handlers and the simulator ───────────
  agent(name: string): AgentView {
    return this.state.agents.get(name) ?? fail('not_found', `No agent named ${name}`);
  }
  putAgent(a: AgentView) {
    this.state.agents.set(a.config.name, a);
    this.emit({ type: 'agent.updated', agent: a });
    return a;
  }
  patchAgent(name: string, patch: Partial<AgentView>) {
    return this.putAgent({ ...this.agent(name), ...patch });
  }
  session(id: string): SessionView {
    return this.state.sessions.get(id) ?? fail('not_found', `No session ${id}`);
  }
  putSession(s: SessionView) {
    this.state.sessions.set(s.id, s);
    this.emit({ type: 'session.updated', session: s });
    return s;
  }
  /** Append (or, with an existing seq, replace — used for streaming text) a session event. */
  pushEvent(sessionId: string, ev: Omit<SessionEventView, 'seq' | 'at'> & { seq?: number; at?: string }) {
    const list = this.state.events.get(sessionId) ?? [];
    const seq = ev.seq ?? (list.at(-1)?.seq ?? 0) + 1;
    const full: SessionEventView = { ...ev, seq, at: ev.at ?? new Date().toISOString() };
    const i = list.findIndex((x) => x.seq === seq);
    if (i === -1) list.push(full);
    else list[i] = full;
    this.state.events.set(sessionId, list);
    this.emit({ type: 'session.event', sessionId, event: full });
    const s = this.state.sessions.get(sessionId);
    if (s) this.putSession({ ...s, lastActivityAt: full.at });
    return full;
  }
  nextSeq(sessionId: string) {
    return (this.state.events.get(sessionId)?.at(-1)?.seq ?? 0) + 1;
  }
  putApproval(a: ApprovalView, created = false) {
    this.state.approvals.set(a.id, a);
    this.emit({ type: created ? 'approval.created' : 'approval.updated', approval: a });
    return a;
  }
  putChannel(c: ChannelView) {
    this.state.channels.set(c.config.name, c);
    this.emit({ type: 'channel.updated', channel: c });
    return c;
  }
  pending() {
    return [...this.state.approvals.values()].filter((a) => a.status === 'pending');
  }
  /** Person a principal is linked to (config `people`). */
  personOf(principal: string): string | undefined {
    return Object.entries(this.state.people).find(([, ps]) => ps.includes(principal))?.[0];
  }
  /** Approver pool: owners (one per person), the local owner and roles with canApprove. */
  approverPool(): number {
    const ids = new Set<string>();
    const add = (p: string) => ids.add(this.personOf(p) ?? p);
    for (const o of [...this.state.owners, LOCAL]) add(o);
    for (const [p, r] of Object.entries(this.state.grants))
      if (this.state.roles.find((x) => x.name === r)?.canApprove) add(p);
    return ids.size;
  }
  /** The demo's instruction files for an agent (before edits through agent.instructionsWrite). */
  private instructionsBase(name: string): { files: { path: string; harness: string; content: string }[] } {
    const a = this.agent(name);
    if (a.config.harness !== 'claude' && a.config.harness !== 'codex') return { files: [] };
    return {
      files: [
        {
          path: '~/code/app/CLAUDE.md',
          harness: 'claude',
          content:
            '# acme/app\n\n- Run `npm test` before pushing.\n- Never push to main; use beamhop/* branches.\n- Keep diffs small and explain them in the thread.\n',
        },
        {
          path: '~/code/app/AGENTS.md',
          harness: 'codex',
          content: '# Agents\n\nUse pnpm. Tests: `pnpm test`. Lint: `pnpm lint`.\n',
        },
      ],
    };
  }

  /** deploy.plan/apply: mount sync choices must name the agent's own mounts, once each. */
  private checkDeployMounts(agent: string, mounts?: { path: string }[]) {
    if (!mounts?.length) return; // a new cloud agent has no mounts yet
    const known = new Set(this.agent(agent).config.mounts.map((m) => m.path));
    const seen = new Set<string>();
    for (const m of mounts ?? []) {
      if (!known.has(m.path)) fail('invalid_input', `${m.path} is not a mount of ${agent}`);
      if (seen.has(m.path)) fail('invalid_input', `${m.path} is listed twice`);
      seen.add(m.path);
    }
  }

  alertRules() {
    return { ...DEFAULT_ALERT_RULES, ...this.state.alerts };
  }
  /** Expire overdue approvals (called by the simulator every few seconds). */
  expireDue(now = Date.now()) {
    for (const a of this.pending()) {
      if (new Date(a.expiresAt).getTime() <= now) {
        this.putApproval({ ...a, status: 'expired', decidedAt: new Date(now).toISOString() });
        this.audit({
          agent: a.agent,
          actor: 'beamhopd',
          type: 'approval.expired',
          severity: 'warn',
          summary: `Auto-denied ${a.title.toLowerCase()} for ${a.agent} — the agent was told`,
          data: { approvalId: a.id },
        });
      }
    }
  }

  // ─────────── dispatch ───────────
  /**
   * Pairing (JOURNEYS §4 step 5): ~5 s after a code is issued, the owner "sends /start" from the
   * provider. Recorded on the channel as `settings.pairings` (non-secret) and as an owner grant.
   */
  private pairTimers = new Map<string, ReturnType<typeof setTimeout>>();
  simulatePairing(name: string, delayMs = 5000) {
    clearTimeout(this.pairTimers.get(name));
    this.pairTimers.set(
      name,
      setTimeout(() => {
        const c = this.state.channels.get(name);
        const who = c ? MOCK_PAIRERS[c.config.provider] : undefined;
        if (!c || !who) return;
        const prev = (c.config.settings.pairings as Array<{ principal: string }> | undefined) ?? [];
        const pairing = { ...who, role: 'owner', pairedAt: new Date().toISOString() };
        this.putChannel({
          ...c,
          config: {
            ...c.config,
            settings: {
              ...c.config.settings,
              pairings: [...prev.filter((x) => x.principal !== who.principal), pairing],
            },
          },
        });
        if (!this.state.owners.includes(who.principal)) this.state.owners.push(who.principal);
        this.state.grants[who.principal] = 'owner';
        this.audit({
          actor: who.principal,
          type: 'channel.paired',
          severity: 'security',
          summary: `${who.handle ?? who.displayName} paired with ${name} as owner`,
          data: { channel: name, principal: who.principal },
        });
      }, delayMs),
    );
  }

  /** Last identity `channel.validate` reported per provider, reused by `channel.add` as the channel's `self`. */
  private lastIdentity: Record<string, { name: string; handle?: string }> = {};
  private async validateChannel(p: ParsedParams<'channel.validate'>): Promise<Result<'channel.validate'>> {
    await sleep(450);
    const token = String(Object.values(p.secrets)[0] ?? '');
    if (p.provider === 'telegram') {
      if (!/^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(token))
        return {
          ok: false,
          message: "Telegram didn't accept this token. In @BotFather, send /token to get a new one.",
        };
      return {
        ok: true,
        message: 'Valid',
        identity: { name: 'reviewer (beamhop)', handle: '@reviewer_alice_bot' },
      };
    }
    if (p.provider === 'slack' && ('appToken' in p.secrets || 'botToken' in p.secrets)) {
      const app = p.secrets.appToken ?? '';
      const bot = p.secrets.botToken ?? '';
      if (!bot.startsWith('xoxb-'))
        return {
          ok: false,
          message: 'Slack rejected the bot token (invalid_auth). Copy it again from Install App.',
        };
      if (!app.startsWith('xapp-'))
        return {
          ok: false,
          message:
            'Slack refused the app-level token (apps.connections.open). It needs the connections:write scope.',
        };
      return {
        ok: true,
        message: 'Valid · acme workspace',
        identity: { name: 'beamhop', handle: '@beamhop' },
      };
    }
    if (p.provider === 'discord' && 'botToken' in p.secrets) {
      if (token.split('.').length !== 3)
        return {
          ok: false,
          message: 'Discord returned 401 Unauthorized for this token. Reset it in the Bot tab.',
        };
      return {
        ok: true,
        message: p.values.intentChecked
          ? 'Valid'
          : 'Message Content intent is off. The agent will only see slash commands and mentions without text.',
        identity: { name: 'beamhop-helper', handle: 'beamhop-helper#0' },
      };
    }
    if (p.provider === 'nostr') {
      const relay = String(p.values.relay ?? '');
      const host = relay.replace('wss://', '');
      if (!/^wss:\/\/[^\s/]+/.test(relay))
        return { ok: false, message: 'That relay address should start with wss://.' };
      if (relay.includes('offline'))
        return { ok: false, message: `Couldn't reach ${host} (timeout after 5 s).` };
      if (p.values.group === undefined)
        return {
          ok: true,
          message: 'NIP-11 ✓ · supports NIP-29 groups',
          identity: { name: host, handle: 'NIP-29' },
        };
      const group = String(p.values.group ?? '');
      if (!/^[a-z0-9_-]{2,}$/.test(group))
        return { ok: false, message: 'Group ids use lowercase letters, digits, - and _.' };
      return {
        ok: true,
        message: 'Valid',
        identity: { name: String(p.values.title || group), handle: `${host}'${group}` },
      };
    }
    if (!token) return { ok: false, message: 'The token is empty.' };
    return { ok: true, message: 'Valid', identity: { name: 'beamhop', handle: '@beamhop' } };
  }

  async handle(method: string, params: unknown): Promise<unknown> {
    if (!isMethod(method)) throw new RpcError(-32601, `Unknown method ${method}`);
    const schema = methods[method].params;
    const parsed = schema.safeParse(params ?? {});
    if (!parsed.success) {
      throw new RpcError(-32602, `Invalid params for ${method}: ${parsed.error.issues[0]?.message ?? ''}`, {
        code: 'invalid_input',
        details: parsed.error.issues,
      });
    }
    const h = this.handlers[method] as Handler<MethodName>;
    return h(parsed.data as never);
  }

  private handlers: Handlers = {
    // ── system
    'system.status': () => ({
      version: '0.1.0',
      uptimeSec: Math.round((Date.now() - this.state.startedAt) / 1000),
      panic: this.state.panic.active,
      agents: this.state.agents.size,
      channels: this.state.channels.size,
      pendingApprovals: this.pending().length,
      owner: { npub: OWNER.npub },
      home: '~/.beamhop',
    }),
    'system.doctor': () => ({ checks: this.state.doctor }),
    // Fixes come from a fixed table (the check's `action`); admin ones go through the OS prompt.
    'system.doctorFix': async (p) => {
      const c = this.state.doctor.find((x) => x.action?.id === p.id) ?? fail('not_found', `No fix ${p.id}`);
      if (c.action?.admin && p.elevate === 'none')
        fail('forbidden', `${c.action.label} needs administrator rights.`);
      await sleep(800);
      const output = `$ ${c.action?.command.join(' ') ?? ''}\nok`;
      this.state.doctor = this.state.doctor.map((x) =>
        x.id === c.id
          ? { id: x.id, title: x.title, status: 'ok', message: `Fixed: ${c.action?.label ?? ''}` }
          : x,
      );
      return { checks: this.state.doctor, output };
    },
    // The browser is a local client: the local owner, linked to alice in the demo.
    'system.whoami': (): WhoamiView => {
      const person = this.personOf(LOCAL);
      return { principal: LOCAL, role: 'owner', via: 'local', ...(person ? { person } : {}) };
    },
    'system.panic': (p) => {
      const st = this.state;
      if (st.panic.active) return OK;
      const at = new Date().toISOString();
      st.panic = {
        active: true,
        at,
        snapshot: {
          agents: [...st.agents.values()].filter((a) => a.status !== 'stopped').map((a) => a.config.name),
          schedules: st.schedules.filter((s) => s.enabled && !s.paused).map((s) => s.id),
        },
      };
      for (const s of st.sessions.values()) {
        if (s.status === 'running' || s.status === 'queued' || s.status === 'idle') {
          this.pushEvent(s.id, { kind: 'system', text: 'Stopped by panic.' });
          this.putSession({ ...this.session(s.id), status: 'ended' });
        }
      }
      for (const a of st.agents.values()) this.putAgent({ ...a, status: 'stopped', activeSessions: 0 });
      for (const a of this.pending())
        this.putApproval({ ...a, status: 'denied', decidedBy: 'panic', decidedAt: at });
      st.schedules = st.schedules.map((s) => ({ ...s, paused: true }));
      for (const c of st.channels.values())
        if (c.status !== 'error') this.putChannel({ ...c, status: 'disconnected' });
      st.deployments = st.deployments.map((d) => (d.status === 'running' ? { ...d, status: 'stopped' } : d));
      this.audit({
        actor: 'alice',
        type: 'panic',
        severity: 'security',
        summary: `alice stopped everything${p.reason ? `: ${p.reason}` : ''}`,
      });
      this.emit({ type: 'panic', active: true });
      return OK;
    },
    'system.resume': () => {
      const st = this.state;
      if (!st.panic.active) return OK;
      st.panic = { active: false, snapshot: st.panic.snapshot };
      // Channels reconnect; agents and schedules stay stopped until resumed one by one (§7A).
      for (const c of st.channels.values())
        if (c.status === 'disconnected') this.putChannel({ ...c, status: 'connected' });
      this.audit({ actor: 'alice', type: 'resume', severity: 'info', summary: 'alice resumed after review' });
      this.emit({ type: 'panic', active: false });
      return OK;
    },

    // ── agents
    'agent.list': () => ({ agents: [...this.state.agents.values()] }),
    'agent.get': (p) => this.agent(p.name),
    'agent.create': (p) => {
      const preset = PRESETS.find((x) => x.id === p.preset);
      const parsed = AgentConfig.safeParse({ ...(preset?.config ?? {}), ...p.config, preset: p.preset });
      if (!parsed.success) return fail('invalid_input', parsed.error.issues[0]?.message ?? 'invalid config');
      if (this.state.agents.has(parsed.data.name))
        return fail('conflict', `${parsed.data.name} already exists`);
      const a: AgentView = {
        config: {
          ...parsed.data,
          identity: {
            ...parsed.data.identity,
            npub: `npub1${parsed.data.name}${'q'.repeat(20)}x9`.slice(0, 63),
          },
        },
        status: 'idle',
        activeSessions: 0,
        usageToday: { usd: 0, tokens: 0, minutes: 0 },
        location: { kind: 'local' },
      };
      this.audit({
        agent: a.config.name,
        actor: 'alice',
        type: 'agent.created',
        severity: 'info',
        summary: `alice created ${a.config.name}`,
      });
      return this.putAgent(a);
    },
    'agent.update': (p) => {
      const a = this.agent(p.name);
      const parsed = AgentConfig.safeParse({ ...a.config, ...p.patch, name: a.config.name });
      if (!parsed.success) return fail('invalid_input', parsed.error.issues[0]?.message ?? 'invalid config');
      this.audit({
        agent: p.name,
        actor: 'alice',
        type: 'config.changed',
        severity: 'info',
        summary: `alice edited ${p.name}`,
        data: { keys: Object.keys(p.patch) },
      });
      return this.putAgent({ ...a, config: parsed.data });
    },
    'agent.delete': (p) => {
      this.agent(p.name);
      this.state.agents.delete(p.name);
      this.audit({
        agent: p.name,
        actor: 'alice',
        type: 'agent.deleted',
        severity: 'warn',
        summary: `alice deleted ${p.name}`,
      });
      return OK;
    },
    'agent.start': (p) => {
      if (this.state.panic.active) return fail('conflict', 'Everything is stopped. Resume first.');
      this.audit({
        agent: p.name,
        actor: 'alice',
        type: 'agent.started',
        severity: 'info',
        summary: `alice started ${p.name}`,
      });
      return this.patchAgent(p.name, { status: 'idle', error: undefined });
    },
    'agent.stop': (p) => {
      const a = this.agent(p.name);
      for (const s of this.state.sessions.values()) {
        if (
          s.agent === a.config.name &&
          (s.status === 'running' || s.status === 'queued' || (p.hard && s.status === 'idle'))
        ) {
          this.pushEvent(s.id, {
            kind: 'system',
            text: p.hard ? 'Stopped hard by alice.' : 'Stopped by alice.',
          });
          this.putSession({ ...this.session(s.id), status: 'ended' });
        }
      }
      this.audit({
        agent: p.name,
        actor: 'alice',
        type: 'agent.stopped',
        severity: 'info',
        summary: `alice stopped ${p.name}${p.hard ? ' (hard)' : ''}`,
      });
      return this.patchAgent(p.name, { status: 'stopped', activeSessions: 0 });
    },
    'agent.clone': (p) => {
      const a = this.agent(p.name);
      if (this.state.agents.has(p.newName)) return fail('conflict', `${p.newName} already exists`);
      const cfg = AgentConfig.parse({ ...a.config, name: p.newName, identity: {}, memberships: [] });
      return this.putAgent({
        ...a,
        config: cfg,
        status: 'stopped',
        activeSessions: 0,
        usageToday: { usd: 0, tokens: 0, minutes: 0 },
      });
    },
    'agent.presets': () => ({
      presets: PRESETS.map((p) => ({ ...p, config: p.config as Record<string, unknown> })),
    }),
    'agent.instructionsWrite': (p) => {
      const a = this.agent(p.name);
      const rw = a.config.mounts.filter((m) => m.mode === 'rw').map((m) => normPath(m.path));
      const target = normPath(
        p.path.startsWith('~') || p.path.startsWith('/') ? p.path : `${rw[0] ?? ''}/${p.path}`,
      );
      if (!rw[0]) return fail('forbidden', 'the agent has no read-write mount');
      const mount = rw.find((m) => inside(target, m));
      if (!mount) {
        const ro = a.config.mounts.some((m) => inside(target, normPath(m.path)));
        return fail(
          'forbidden',
          ro
            ? 'that mount is read-only; make it read-write to edit instructions'
            : 'instruction files can only be written inside the agent’s mounts',
        );
      }
      const kind = INSTRUCTION_FILES.find((f) => `${mount}/${f.file}` === target);
      if (!kind) return fail('forbidden', 'only harness instruction files can be written');
      this.instructionFiles.set(target, p.content);
      this.audit({
        agent: p.name,
        actor: 'alice',
        type: 'agent.instructions',
        severity: 'security',
        summary: `alice edited ${target}`,
      });
      return { path: target, harness: kind.harness, bytes: new TextEncoder().encode(p.content).length };
    },
    'agent.instructions': (p) => {
      const written = [...this.instructionFiles.entries()]
        .filter(([path]) => this.agent(p.name).config.mounts.some((m) => inside(path, normPath(m.path))))
        .map(([path, content]) => ({
          path,
          content,
          harness: INSTRUCTION_FILES.find((f) => path.endsWith(`/${f.file}`))?.harness ?? 'claude',
        }));
      const base = this.instructionsBase(p.name);
      return {
        files: [...base.files.filter((f) => !this.instructionFiles.has(f.path)), ...written],
      };
    },
    'channel.connect': (p) => {
      const c = this.state.channels.get(p.name) ?? fail('not_found', `No channel ${p.name}`);
      if (this.state.panic.active) return fail('unavailable', 'Everything is stopped. Resume first.');
      const next = {
        ...c,
        config: { ...c.config, enabled: true },
        status: 'connecting' as const,
        error: undefined,
      };
      this.putChannel(next);
      setTimeout(() => this.putChannel({ ...next, status: 'connected' }), 900);
      this.audit({
        actor: 'alice',
        type: 'channel.connect',
        severity: 'info',
        summary: `alice connected ${p.name}`,
      });
      return next;
    },
    'channel.disconnect': (p) => {
      const c = this.state.channels.get(p.name) ?? fail('not_found', `No channel ${p.name}`);
      const next = this.putChannel({ ...c, config: { ...c.config, enabled: false }, status: 'disabled' });
      this.audit({
        actor: 'alice',
        type: 'channel.disconnect',
        severity: 'security',
        summary: `alice disconnected ${p.name}`,
      });
      return next;
    },
    'fs.list': (p) => {
      const raw = (p.path ?? '~').trim() || '~';
      if (!raw.startsWith('~') && !raw.startsWith('/'))
        return fail('invalid_input', 'paths must be absolute or start with ~/');
      const path = normPath(raw);
      if (!inside(path, '~'))
        return fail('forbidden', 'only directories under your home folder can be listed');
      if (DENIED.some((d) => inside(path, d))) return fail('forbidden', 'that directory is always denied');
      const list = MOCK_FS[path];
      if (!list) return fail('not_found', 'directory not found');
      const parent = path === '~' ? undefined : path.slice(0, path.lastIndexOf('/'));
      return {
        path,
        ...(parent ? { parent } : {}),
        roots: ['~'],
        entries: list
          .filter((e) => !e.name.startsWith('.') && !DENIED.some((d) => inside(`${path}/${e.name}`, d)))
          .map((e) => ({ name: e.name, path: `${path}/${e.name}`, git: !!e.git })),
      };
    },
    'alerts.get': () => this.alertRules(),
    'alerts.set': (p) => {
      const clean = Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined));
      const next = { ...this.alertRules(), ...clean };
      if (next.budgetWarn > next.budgetAlert)
        return fail('invalid_input', 'the budget warning must not be above the budget alert');
      this.state.alerts = { ...this.state.alerts, ...clean };
      this.audit({
        actor: 'alice',
        type: 'alerts.set',
        severity: 'info',
        summary: 'alice changed alert rules',
      });
      return this.alertRules();
    },
    'updates.get': () => ({ ...this.state.updates }),
    'updates.set': (p) => {
      this.state.updates = {
        catalogAuto: p.catalogAuto ?? this.state.updates.catalogAuto,
        appPrompt: p.appPrompt ?? this.state.updates.appPrompt,
      };
      return { ...this.state.updates };
    },
    'approval.quorumGet': () => ({ quorum: this.state.quorum, approvers: this.approverPool() }),
    'approval.quorumSet': (p) => {
      this.state.quorum = p.quorum;
      this.audit({
        actor: 'alice',
        type: 'approval.quorum',
        severity: 'security',
        summary: `alice set the approval quorum to ${p.quorum}`,
      });
      return { quorum: this.state.quorum, approvers: this.approverPool() };
    },
    'session.merge': (p) => {
      const s = this.session(p.id);
      if (!s.worktree) return fail('invalid_input', 'this session has no git worktree');
      if (s.status === 'running') return fail('conflict', 'the session is running; wait or stop it first');
      const base = p.base ?? 'main';
      if (base.startsWith('-') || /\s/.test(base)) return fail('invalid_input', 'invalid branch name');
      const commit = Array.from(
        { length: 40 },
        () => '0123456789abcdef'[Math.floor(Math.random() * 16)],
      ).join('');
      this.pushEvent(p.id, {
        kind: 'system',
        text: `Merged ${s.worktree.branch} into ${base} (${commit.slice(0, 10)}).`,
      });
      this.audit({
        agent: s.agent,
        actor: 'alice',
        type: 'session.merged',
        severity: 'security',
        summary: `Merged ${s.worktree.branch} into ${base} for session ${s.id}`,
      });
      return { branch: s.worktree.branch, base, commit, fastForward: false };
    },
    'session.openPr': (p) => {
      const s = this.session(p.id);
      if (!s.worktree) return fail('invalid_input', 'this session has no git worktree');
      if (s.status === 'running') return fail('conflict', 'the session is running; wait or stop it first');
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(p.remote) || p.remote.startsWith('-'))
        return fail('invalid_input', 'invalid remote name');
      if (p.remote !== 'origin') return fail('not_found', `no git remote named ${p.remote}`);
      const branch = s.worktree.branch;
      const base = p.base ?? 'main';
      const url = 'git@github.com:acme/app.git';
      const compareUrl = `https://github.com/acme/app/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}?expand=1`;
      const now = Date.now();
      const approval = this.putApproval(
        {
          id: `apr_${now.toString(36)}`,
          agent: s.agent,
          sessionId: s.id,
          requestedBy: { principal: LOCAL, displayName: 'owner', role: 'owner' },
          tool: 'git.push',
          title: `Push ${branch} to ${p.remote}`,
          input: {
            command: `git push ${p.remote} ${branch}`,
            remote: p.remote,
            remoteUrl: url,
            branch,
            base,
            compareUrl,
          },
          risk: 'medium',
          createdAt: new Date(now).toISOString(),
          expiresAt: ahead(now, 15),
          status: 'pending',
          kind: 'tool',
        },
        true,
      );
      this.actions.set(approval.id, () => {
        this.pushEvent(s.id, {
          kind: 'system',
          text: `Pushed ${branch} to ${p.remote}. Open a pull request: ${compareUrl}`,
        });
        this.audit({
          agent: s.agent,
          actor: 'alice',
          type: 'session.pushed',
          severity: 'security',
          summary: `Pushed ${branch} to ${p.remote}`,
        });
      });
      return { branch, base, remote: p.remote, compareUrl, approval };
    },

    // ── harnesses
    // Scans take a moment on a real daemon (it runs `--version` on every catalog entry).
    'harness.scan': async () => {
      await sleep(900);
      return { harnesses: this.state.harnesses };
    },
    'harness.list': () => ({ harnesses: this.state.harnesses }),
    'harness.models': (p) => ({ models: MOCK_MODELS[p.id] ?? [] }),
    // Install / update / login run as jobs (mock/jobs.ts); the browser is the local client, so allowed.
    'harness.install': (p) => this.jobs.install(p.id, p.method),
    'harness.update': (p) => this.jobs.update(p.id),
    'harness.updates': () => ({ updates: this.state.harnessUpdates.map((u) => ({ ...u })) }),
    'harness.loginFlow': (p) => this.jobs.login(p.id, p.method),
    'harness.job.get': (p) => this.jobs.get(p.jobId, p.since),
    'harness.job.list': () => this.jobs.list(),
    'harness.job.cancel': (p) => this.jobs.cancel(p.jobId),
    // Logins: `bad…` values are rejected like a real check would; anything else is accepted.
    'harness.login': async (p) => {
      await sleep(600);
      const h = this.state.harnesses.find((x) => x.id === p.id) ?? fail('not_found', `No harness ${p.id}`);
      const login = h.login ?? fail('unavailable', `beamhop does not manage ${p.id}'s login`);
      const method =
        login.methods.find((x) => x.id === (p.method ?? login.methods[0]?.id)) ??
        fail('invalid_input', `unknown login method ${p.method}`);
      method.set = true;
      const ok = !p.value.startsWith('bad');
      h.login = {
        ...login,
        status: ok ? 'logged-in' : 'invalid',
        method: method.id,
        checkedAt: new Date().toISOString(),
        message: ok ? `${method.label} accepted` : `${method.label} rejected (HTTP 401)`,
      };
      if (h.status === 'ready' || h.status === 'needs-login') h.status = ok ? 'ready' : 'needs-login';
      if (ok) delete h.message;
      return h;
    },
    'harness.logout': (p) => {
      const h = this.state.harnesses.find((x) => x.id === p.id) ?? fail('not_found', `No harness ${p.id}`);
      const login = h.login ?? fail('unavailable', `beamhop does not manage ${p.id}'s login`);
      for (const x of login.methods) if (!p.method || x.id === p.method) x.set = false;
      const any = login.methods.find((x) => x.set);
      h.login = any
        ? { methods: login.methods, status: 'unchecked', method: any.id }
        : {
            methods: login.methods,
            status: 'logged-out',
            message: `Not logged in. Run: beamhop harness login ${h.id}`,
          };
      if (!any && h.status === 'ready') h.status = 'needs-login';
      return h;
    },
    'harness.checkLogin': async (p) => {
      await sleep(500);
      const h = this.state.harnesses.find((x) => x.id === p.id) ?? fail('not_found', `No harness ${p.id}`);
      const login = h.login ?? fail('unavailable', `beamhop does not manage ${p.id}'s login`);
      if (login.status === 'unchecked')
        h.login = { ...login, status: 'logged-in', checkedAt: new Date().toISOString(), message: 'accepted' };
      return h;
    },
    // Probes the command with an ACP `initialize` handshake. Unknown binaries fail like a real spawn would.
    'harness.add': async (p) => {
      await sleep(700);
      const bin = p.command.trim().split(/\s+/)[0] ?? '';
      const base = bin.split('/').pop() ?? bin;
      const onPath = MOCK_PATH_BINARIES.has(base) || /^(\/|\.\/|~\/)/.test(bin);
      const h = {
        id: `acp:${p.id}`,
        displayName: p.id,
        command: [p.command, ...p.args].join(' '),
        status: onPath ? ('ready' as const) : ('error' as const),
        protocol: 'acp',
        path: onPath ? (bin.includes('/') ? bin : `/usr/local/bin/${bin}`) : undefined,
        version: onPath ? '0.3.1' : undefined,
        message: onPath
          ? 'ACP handshake ok · protocol v1 · 118 ms'
          : `spawn ${bin}: command not found on PATH`,
      };
      if (onPath) this.state.harnesses = [...this.state.harnesses.filter((x) => x.id !== h.id), h];
      return h;
    },

    // ── channels
    'channel.providers': () => ({
      providers: [
        {
          provider: 'telegram',
          displayName: 'Telegram',
          steps: ['create', 'credentials', 'validate', 'connect', 'pair', 'join'],
        },
        {
          provider: 'slack',
          displayName: 'Slack',
          steps: ['create', 'credentials', 'validate', 'connect', 'pair', 'join'],
        },
        {
          provider: 'discord',
          displayName: 'Discord',
          steps: ['create', 'credentials', 'validate', 'connect', 'join', 'pair'],
        },
        { provider: 'nostr', displayName: 'Nostr group (NIP-29)', steps: ['relay', 'group', 'join'] },
      ],
    }),
    'channel.list': () => ({ channels: [...this.state.channels.values()] }),
    'channel.validate': async (p) => {
      const r = await this.validateChannel(p);
      if (r.ok && r.identity) this.lastIdentity[p.provider] = r.identity;
      return r;
    },
    'channel.add': (p) => {
      if (this.state.channels.has(p.name)) return fail('conflict', `A channel named ${p.name} exists`);
      const c: ChannelView = {
        config: ChannelConfig.parse({
          name: p.name,
          provider: p.provider,
          settings: p.values,
          // Same vault naming as the daemon (`channel.<name>.<field>`, apps/daemon channels.ts).
          secretRefs: Object.keys(p.secrets).map((k) => `channel.${p.name}.${k}`),
          createdAt: new Date().toISOString(),
        }),
        status: 'connecting',
        // The bot identity the provider reported during validation (getMe / auth.test / users/@me).
        ...(this.lastIdentity[p.provider]
          ? {
              self: {
                principal: `${p.provider}:${p.name}`,
                displayName: this.lastIdentity[p.provider]!.name,
                handle: this.lastIdentity[p.provider]!.handle,
              },
            }
          : {}),
      };
      this.putChannel(c);
      setTimeout(() => this.putChannel({ ...c, status: 'connected' }), 900);
      this.audit({
        actor: 'alice',
        type: 'channel.added',
        severity: 'info',
        summary: `alice added ${p.provider} channel ${p.name}`,
      });
      return c;
    },
    'channel.remove': (p) => {
      if (!this.state.channels.delete(p.name)) return fail('not_found', `No channel ${p.name}`);
      this.audit({
        actor: 'alice',
        type: 'channel.removed',
        severity: 'warn',
        summary: `alice removed channel ${p.name}`,
      });
      return OK;
    },
    'channel.pair': (p) => {
      if (!this.state.channels.has(p.name)) return fail('not_found', `No channel ${p.name}`);
      this.simulatePairing(p.name);
      return {
        code: '7KQ2-9XHD',
        expiresAt: ahead(Date.now(), 10),
        instructions: 'Send /pair 7KQ2-9XHD to the bot.',
      };
    },

    // ── memberships
    'membership.join': (p) => {
      const a = this.agent(p.agent);
      const memberships = [
        ...a.config.memberships.filter((m) => m.target !== p.membership.target),
        p.membership,
      ];
      return this.putAgent({ ...a, config: { ...a.config, memberships } });
    },
    'membership.leave': (p) => {
      const a = this.agent(p.agent);
      return this.putAgent({
        ...a,
        config: { ...a.config, memberships: a.config.memberships.filter((m) => m.target !== p.target) },
      });
    },

    // ── sessions
    'session.list': (p) => ({
      sessions: [...this.state.sessions.values()]
        .filter((s) => !p.agent || s.agent === p.agent)
        .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)),
    }),
    'session.events': (p) => {
      this.session(p.id);
      return { events: (this.state.events.get(p.id) ?? []).filter((e) => e.seq > p.afterSeq) };
    },
    'session.send': (p) => {
      const s = this.session(p.id);
      if (this.state.panic.active) return fail('conflict', 'Everything is stopped. Resume first.');
      this.pushEvent(p.id, {
        kind: 'user',
        from: { principal: OWNER.principal, displayName: 'alice', role: 'owner' },
        text: p.text,
      });
      this.putSession({ ...this.session(s.id), status: 'running' });
      this.onUserMessage?.(p.id, p.text);
      return OK;
    },
    'session.start': (p) => {
      this.agent(p.agent);
      if (this.state.panic.active) return fail('conflict', 'Everything is stopped. Resume first.');
      const id = `ses_${Date.now().toString(36)}`;
      const now = new Date().toISOString();
      const s: SessionView = {
        id,
        agent: p.agent,
        channel: 'pwa',
        conversationId: 'dm',
        threadId: id.slice(4),
        title: p.title ?? p.text.slice(0, 80),
        status: 'running',
        startedAt: now,
        lastActivityAt: now,
        usage: { inputTokens: 0, outputTokens: 0, usd: 0 },
      };
      this.putSession(s);
      this.pushEvent(id, {
        kind: 'user',
        from: { principal: OWNER.principal, displayName: 'alice', role: 'owner' },
        text: p.text,
      });
      this.onUserMessage?.(id, p.text);
      return s;
    },
    'session.stop': (p) => {
      const s = this.session(p.id);
      this.pushEvent(p.id, { kind: 'system', text: 'Stopped by alice.' });
      this.putSession({ ...this.session(s.id), status: 'ended' });
      return OK;
    },

    // ── approvals
    'approval.list': (p) => ({
      approvals: [...this.state.approvals.values()]
        .filter((a) => p.status === 'all' || a.status === 'pending')
        .sort((a, b) =>
          p.status === 'all'
            ? b.createdAt.localeCompare(a.createdAt)
            : a.expiresAt.localeCompare(b.expiresAt),
        ),
    }),
    'approval.decide': (p) => {
      const a = this.state.approvals.get(p.id) ?? fail('not_found', `No approval ${p.id}`);
      if (a.status !== 'pending')
        return fail('conflict', `Already ${a.status}${a.decidedBy ? ` by ${a.decidedBy}` : ''}`);
      if (p.rule !== undefined && !p.always) return fail('invalid_input', '`rule` needs `always: true`');
      const plainTool = a.kind === 'tool' && !this.actions.has(a.id);
      if (p.allow && (p.always || p.session) && !plainTool)
        return fail('invalid_input', 'only tool requests can be allowed always or for the session');
      const rule = p.allow && p.always ? mockRule(a, p.rule, 'alice') : undefined;
      const at = new Date().toISOString();
      const how = p.allow
        ? p.always
          ? `always allowed${p.rule ? ` (${p.rule})` : ''}`
          : p.session
            ? 'allowed for the session'
            : p.grantRole
              ? `allowed as ${p.grantRole}`
              : 'allowed'
        : `denied${p.reason ? ` ("${p.reason}")` : ''}`;
      // N-of-M: an allow vote that doesn't reach the quorum keeps the request pending.
      let votes = a.votes;
      if (a.quorum && a.quorum.needed > 1) {
        votes = [...(a.votes ?? []).filter((v) => v.by !== 'alice'), { by: 'alice', allow: p.allow, at }];
        const yes = votes.filter((v) => v.allow).length;
        if (p.allow && yes < a.quorum.needed) {
          const next = this.putApproval({ ...a, votes });
          this.commitTimers.set(
            a.id,
            setTimeout(() => {
              this.commitTimers.delete(a.id);
              this.audit({
                agent: a.agent,
                actor: 'alice',
                type: 'approval.voted',
                severity: 'info',
                summary: `alice approved ${describeApproval(a)} (${yes} of ${a.quorum?.needed})`,
                data: { approvalId: a.id },
              });
            }, UNDO_WINDOW_MS),
          );
          return next;
        }
      }
      const next = this.putApproval({
        ...a,
        ...(votes ? { votes } : {}),
        status: p.allow ? 'approved' : 'denied',
        decidedBy: 'alice',
        decidedAt: at,
      });
      this.commitTimers.set(
        a.id,
        setTimeout(() => {
          this.commitTimers.delete(a.id);
          const action = this.actions.get(a.id);
          this.actions.delete(a.id);
          if (action && p.allow) action();
          if (rule) {
            const ag = this.state.agents.get(a.agent);
            if (ag)
              this.putAgent({
                ...ag,
                config: { ...ag.config, approvalRules: [...(ag.config.approvalRules ?? []), rule] },
              });
            const pol = this.state.policies.get(a.agent);
            if (pol && rule.kind === 'host' && !pol.effective.net.allow.includes(rule.value))
              pol.effective.net.allow.push(rule.value);
          }
          this.audit({
            agent: a.agent,
            actor: 'alice',
            type: 'approval.decided',
            severity: 'info',
            summary: `alice ${how} ${describeApproval(a)}`,
            data: {
              approvalId: a.id,
              always: p.always,
              session: p.session,
              rule: p.rule,
              reason: p.reason,
              grantRole: p.grantRole,
            },
          });
          this.onDecisionReleased?.(next);
        }, UNDO_WINDOW_MS),
      );
      return next;
    },
    'approval.undo': (p) => {
      const a = this.state.approvals.get(p.id) ?? fail('not_found', `No approval ${p.id}`);
      const t = this.commitTimers.get(p.id);
      if (!t) return fail('conflict', 'The undo window has passed. The decision is in Audit.');
      clearTimeout(t);
      this.commitTimers.delete(p.id);
      return this.putApproval({
        ...a,
        status: 'pending',
        decidedBy: undefined,
        decidedAt: undefined,
        ...(a.votes ? { votes: a.votes.filter((v) => v.by !== 'alice') } : {}),
      });
    },

    // ── roles
    'role.list': () => ({ roles: this.state.roles, grants: this.state.grants }),
    'role.grant': (p) => {
      this.state.grants[p.principal] = p.role;
      this.audit({
        agent: p.agent,
        actor: 'alice',
        type: 'role.granted',
        severity: 'info',
        summary: `alice granted ${p.role} to ${p.principal}`,
      });
      return OK;
    },
    'role.revoke': (p) => {
      delete this.state.grants[p.principal];
      this.audit({
        agent: p.agent,
        actor: 'alice',
        type: 'role.revoked',
        severity: 'warn',
        summary: `alice revoked ${p.principal}`,
      });
      return OK;
    },
    'principal.link': (p) => {
      const list = this.state.people[p.person] ?? [];
      if (!list.includes(p.principal)) this.state.people[p.person] = [...list, p.principal];
      return OK;
    },
    'principal.unlink': (p) => {
      const list = this.state.people[p.person] ?? [];
      if (!list.includes(p.principal))
        return fail('not_found', `${p.principal} is not linked to ${p.person}`);
      const rest = list.filter((x) => x !== p.principal);
      if (rest.length) this.state.people[p.person] = rest;
      else delete this.state.people[p.person];
      return OK;
    },
    'principal.list': () => ({ people: { ...this.state.people } }),
    'owner.list': () => ({
      owners: this.state.owners.map((principal) => {
        const person = this.personOf(principal);
        const linked = person ? (this.state.people[person] ?? []).filter((x) => x !== principal) : [];
        return { principal, ...(person ? { person } : {}), linked };
      }),
    }),
    'role.define': (p) => {
      const name = RoleName.safeParse(p.role.name);
      if (!name.success) return fail('invalid_input', 'role name: lowercase letters, digits and -');
      if (name.data === 'owner' || name.data === 'agent')
        return fail('forbidden', 'the owner and agent roles cannot be changed');
      const shape = RoleDef.shape as Record<
        string,
        { safeParse(v: unknown): { success: boolean; data?: unknown } }
      >;
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(p.role)) {
        if (k === 'name' || v === undefined) continue;
        if (!shape[k]) return fail('invalid_input', `unknown role field ${k}`);
        const r = shape[k]!.safeParse(v);
        if (!r.success) return fail('invalid_input', `invalid role field ${k}`);
        patch[k] = k === 'tools' || k === 'budget' ? v : r.data;
      }
      const cur = this.state.roles.find((r) => r.name === name.data);
      const viewer = DEFAULT_ROLES.find((r) => r.name === 'viewer')!;
      const baseRole = cur ?? { ...viewer, description: '' };
      const def = RoleDef.parse({
        ...baseRole,
        ...patch,
        name: name.data,
        tools: { ...baseRole.tools, ...((patch.tools as object) ?? {}) },
        budget: { ...baseRole.budget, ...((patch.budget as object) ?? {}) },
      });
      this.state.roles = [...this.state.roles.filter((r) => r.name !== def.name), def];
      this.audit({
        actor: 'alice',
        type: 'role.define',
        severity: 'security',
        summary: `alice defined role ${def.name}`,
      });
      return def;
    },
    'role.delete': (p) => {
      if (p.name === 'owner' || p.name === 'agent')
        return fail('forbidden', 'the owner and agent roles cannot be changed');
      const builtin = (BUILTIN_ROLES as readonly string[]).includes(p.name);
      const cur = this.state.roles.find((r) => r.name === p.name);
      if (!cur) return fail('not_found', `no role ${p.name}`);
      if (builtin) {
        const def = DEFAULT_ROLES.find((r) => r.name === p.name)!;
        if (JSON.stringify(def) === JSON.stringify(cur))
          return fail('invalid_input', 'built-in roles cannot be deleted');
        this.state.roles = this.state.roles.map((r) => (r.name === p.name ? def : r));
        return OK;
      }
      const used = Object.entries(this.state.grants).find(([, r]) => r === p.name);
      if (used) return fail('conflict', `role ${p.name} is still in use (${used[0]})`);
      this.state.roles = this.state.roles.filter((r) => r.name !== p.name);
      this.audit({
        actor: 'alice',
        type: 'role.delete',
        severity: 'security',
        summary: `alice deleted role ${p.name}`,
      });
      return OK;
    },
    'owner.add': (p) => {
      if (!this.state.owners.includes(p.principal)) this.state.owners.push(p.principal);
      return OK;
    },
    'owner.remove': (p) => {
      if (this.state.owners.length <= 1) return fail('conflict', 'At least one owner must remain.');
      this.state.owners = this.state.owners.filter((o) => o !== p.principal);
      return OK;
    },

    // ── policy
    'policy.get': (p) => {
      this.agent(p.name);
      return (
        this.state.policies.get(p.name) ?? {
          profile: 'workspace',
          effective: SandboxPolicy.parse({}),
          required: [],
          userAllow: [],
        }
      );
    },
    'sandbox.test': (p) => {
      this.agent(p.name);
      return { results: [] };
    },
    'policy.set': (p) => {
      const a = this.agent(p.name);
      const prev = this.state.policies.get(p.name);
      this.state.policies.set(p.name, {
        profile: p.profile,
        effective: p.policy ?? prev?.effective ?? SandboxPolicy.parse({}),
      });
      this.putAgent({
        ...a,
        config: {
          ...a.config,
          sandbox: { profile: p.profile as 'strict' | 'workspace' | 'custom', policy: p.policy },
        },
      });
      this.audit({
        agent: p.name,
        actor: 'alice',
        type: 'config.changed',
        severity: 'info',
        summary: `alice changed ${p.name}'s sandbox (${p.profile})`,
      });
      return OK;
    },
    'policy.suggestions': (p) => ({
      suggestions: this.state.suggestions.filter((s) => !p.name || s.agent === p.name),
    }),
    'policy.applySuggestion': (p) => {
      const s =
        this.state.suggestions.find((x) => x.id === p.id) ?? fail('not_found', `No suggestion ${p.id}`);
      if (p.value !== undefined && !p.accept)
        return fail('invalid_input', '`value` only applies when accepting');
      // The daemon's checks: a host may widen to a covering *.domain, a path to a parent dir.
      if (p.accept && p.value !== undefined) {
        if (s.kind === 'net.allow') {
          const v = checkHost(p.value);
          if (!hostCovers(v, s.value.toLowerCase()))
            return fail('invalid_input', 'the value must cover the suggested host');
        } else {
          const v = normPath(p.value);
          if (!inside(normPath(s.value), v) || v === '~' || v === '/' || deniedPath(v))
            return fail('invalid_input', 'the value must be the suggested path or a parent directory');
        }
      }
      if (p.accept && s.kind !== 'net.allow' && deniedPath(normPath(s.value)))
        return fail('invalid_input', 'that path is always denied');
      this.state.suggestions = this.state.suggestions.filter((x) => x.id !== p.id);
      if (p.accept) {
        const pol = this.state.policies.get(s.agent);
        const value = p.value ?? s.value;
        if (pol && s.kind === 'net.allow') pol.effective.net.allow.push(value);
        if (pol && s.kind === 'fs.read') pol.effective.fs.read.push(value);
      }
      this.audit({
        agent: s.agent,
        actor: 'alice',
        type: 'policy.suggestion',
        severity: 'info',
        summary: `alice ${p.accept ? 'allowed' : 'kept blocked'} ${p.accept ? (p.value ?? s.value) : s.value} for ${s.agent}`,
      });
      return OK;
    },

    // ── secrets (names only, never values)
    'secret.list': () => ({
      secrets: this.state.secrets,
      backend: 'file',
      keySource: this.state.vaultKeySource,
      keychainAvailable: true,
    }),
    'secret.setKeySource': (p: { keySource: 'file' | 'keychain' }) => {
      this.state.vaultKeySource = p.keySource;
      return { keySource: p.keySource };
    },
    'secret.set': (p) => {
      const now = new Date().toISOString();
      this.state.secrets = [
        ...this.state.secrets.filter((s) => s.name !== p.name),
        { name: p.name, updatedAt: now },
      ];
      // Replacing a channel's token reconnects it (JOURNEYS §4 "Replace token").
      const ch = /^channel\.([^.]+)\./.exec(p.name)?.[1];
      const c = ch ? this.state.channels.get(ch) : undefined;
      if (c && c.status === 'error') {
        const next = { ...c, status: 'connecting' as const, error: undefined };
        this.putChannel(next);
        setTimeout(() => this.putChannel({ ...next, status: 'connected' }), 900);
      }
      return OK;
    },
    'secret.delete': (p) => {
      this.state.secrets = this.state.secrets.filter((s) => s.name !== p.name);
      return OK;
    },

    // ── schedules
    'schedule.list': (p) => ({
      schedules: this.state.schedules.filter((s) => !p.agent || s.agent === p.agent),
    }),
    'schedule.add': (p) => {
      const s = ScheduleConfig.parse({ ...p, id: `sch_${Date.now().toString(36)}` });
      this.state.schedules.push(s);
      this.audit({
        agent: s.agent,
        actor: 'alice',
        type: 'schedule.added',
        severity: 'info',
        summary: `alice added a ${s.kind} schedule to ${s.agent}`,
      });
      if (s.kind !== 'webhook') return s;
      // Webhook secrets are shown once (agents screen). Built at runtime, never a literal.
      const secret = Array.from(
        { length: 32 },
        () => 'abcdefghijkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 32)],
      ).join('');
      return { ...s, webhook: { url: `http://127.0.0.1:7878${s.spec}`, secret } };
    },
    'schedule.update': (p) => {
      const i = this.state.schedules.findIndex((s) => s.id === p.id);
      if (i === -1) return fail('not_found', `No schedule ${p.id}`);
      const s = ScheduleConfig.parse({ ...this.state.schedules[i], ...p.patch, id: p.id });
      this.state.schedules[i] = s;
      return s;
    },
    'schedule.remove': (p) => {
      this.state.schedules = this.state.schedules.filter((s) => s.id !== p.id);
      return OK;
    },
    'schedule.run': (p) => {
      const s = this.state.schedules.find((x) => x.id === p.id) ?? fail('not_found', `No schedule ${p.id}`);
      this.audit({
        agent: s.agent,
        actor: 'alice',
        type: 'schedule.run',
        severity: 'info',
        summary: `alice ran ${s.id} now`,
      });
      return OK;
    },

    // ── deploy
    'deploy.providers': () => {
      // A provider counts as configured once its API token is in the vault (`deploy/<id>/token`).
      const has = (id: string) => this.state.secrets.some((s) => s.name === `deploy/${id}/token`);
      return {
        providers: [
          { id: 'hetzner', displayName: 'Hetzner Cloud', kind: 'vps' as const, configured: true },
          {
            id: 'digitalocean',
            displayName: 'DigitalOcean',
            kind: 'vps' as const,
            configured: has('digitalocean'),
          },
          { id: 'fly', displayName: 'Fly.io', kind: 'paas' as const, configured: true },
          { id: 'render', displayName: 'Render', kind: 'paas' as const, configured: has('render') },
          { id: 'railway', displayName: 'Railway', kind: 'paas' as const, configured: has('railway') },
        ],
      };
    },
    'deploy.options': (p) => {
      const opts: Record<string, Result<'deploy.options'>> = {
        hetzner: {
          sizes: [
            { id: 'cx22', label: 'cx22 · 2 vCPU · 4 GB · 40 GB', monthlyUsd: 4.9 },
            { id: 'cx32', label: 'cx32 · 4 vCPU · 8 GB · 80 GB', monthlyUsd: 8.2 },
            { id: 'cax21', label: 'cax21 · 4 vCPU Arm · 8 GB', monthlyUsd: 7.6 },
          ],
          regions: [
            { id: 'fsn1', label: 'Falkenstein (fsn1)' },
            { id: 'nbg1', label: 'Nuremberg (nbg1)' },
            { id: 'hel1', label: 'Helsinki (hel1)' },
            { id: 'ash', label: 'Ashburn (ash)' },
          ],
        },
        fly: {
          sizes: [
            { id: 'shared-cpu-1x', label: 'shared-cpu-1x · 1 GB', monthlyUsd: 5.7 },
            { id: 'shared-cpu-2x', label: 'shared-cpu-2x · 2 GB', monthlyUsd: 11.4 },
          ],
          regions: [
            { id: 'ams', label: 'Amsterdam (ams)' },
            { id: 'fra', label: 'Frankfurt (fra)' },
            { id: 'iad', label: 'Ashburn (iad)' },
          ],
        },
      };
      return (
        opts[p.provider] ?? {
          sizes: [{ id: 'basic', label: 'Basic · 1 vCPU · 1 GB', monthlyUsd: 6 }],
          regions: [{ id: 'default', label: 'Default region' }],
        }
      );
    },
    'deploy.plan': (p) => {
      this.checkDeployMounts(p.agent, p.mounts);
      const isVps = p.provider === 'hetzner' || p.provider === 'digitalocean';
      const cost = p.provider === 'hetzner' ? 4.9 : p.provider === 'fly' ? 5.7 : 7;
      const actions = [
        {
          op: 'create',
          resource: 'server',
          detail: `${p.provider} ${p.size ?? 'default'} · ${p.region ?? 'default'}`,
        },
        { op: 'create', resource: 'firewall', detail: 'outbound only, 0 inbound ports' },
        { op: 'install', resource: 'beamhopd', detail: 'beamhopd 0.1.0, srt, bubblewrap' },
        ...(p.mode === 'move'
          ? [
              { op: 'move', resource: 'identity', detail: `${p.agent} → remote vault` },
              { op: 'keep', resource: 'secrets', detail: 'API keys stay local, brokered' },
              { op: 'clone', resource: '~/code/app', detail: 'git, github.com/acme/app' },
              { op: 'stop', resource: 'local agent', detail: p.agent },
            ]
          : []),
      ];
      return {
        provider: p.provider,
        actions,
        monthlyCostUsd: cost,
        warnings: isVps ? [] : ['filesystem isolation = container only (srt cannot use namespaces here)'],
      };
    },
    'deploy.apply': (p) => {
      this.checkDeployMounts(p.agent, p.mounts);
      const d: DeploymentView = {
        id: `dep_${p.provider}_${Date.now().toString(36)}`,
        provider: p.provider,
        agent: p.agent,
        status: 'provisioning',
        region: p.region,
        size: p.size,
        createdAt: new Date().toISOString(),
        monthlyCostUsd: p.provider === 'hetzner' ? 4.9 : 5.7,
      };
      this.state.deployments.unshift(d);
      setTimeout(() => {
        const i = this.state.deployments.findIndex((x) => x.id === d.id);
        if (i !== -1) this.state.deployments[i] = { ...d, status: 'running' };
        const a = this.state.agents.get(p.agent);
        if (a) this.putAgent({ ...a, location: { kind: 'cloud', provider: p.provider } });
        this.audit({
          agent: p.agent,
          actor: 'alice',
          type: 'deploy.applied',
          severity: 'info',
          summary: `${p.agent} is running on ${p.provider}`,
        });
      }, 8000);
      return d;
    },
    'deploy.list': () => ({ deployments: this.state.deployments }),
    'deploy.destroy': (p) => {
      const d =
        this.state.deployments.find((x) => x.id === p.id) ?? fail('not_found', `No deployment ${p.id}`);
      this.state.deployments = this.state.deployments.map((x) =>
        x.id === d.id ? { ...x, status: 'destroyed' } : x,
      );
      this.audit({
        agent: d.agent,
        actor: 'alice',
        type: 'deploy.destroyed',
        severity: 'warn',
        summary: `alice destroyed ${d.agent} on ${d.provider}`,
      });
      return OK;
    },

    // ── audit & usage
    'audit.query': (p) => ({
      events: this.state.audit
        .filter(
          (e) =>
            (!p.agent || e.agent === p.agent) &&
            (!p.severity || e.severity === p.severity) &&
            (!p.before || e.at < p.before),
        )
        .slice(0, p.limit),
    }),
    'usage.query': (p) => {
      const since = new Date(Date.now() - (p.days - 1) * 86_400_000).toISOString().slice(0, 10);
      return { rows: this.state.usage.filter((r) => r.day >= since && (!p.agent || r.agent === p.agent)) };
    },

    // ── devices
    'device.list': () => ({ devices: this.state.devices }),
    'device.pairStart': (p) => this.pairing.start(p.name, p.requireConfirm),
    'device.pairComplete': (p) => {
      // A code from a pairing started on this daemon follows the real flow (awaiting confirm).
      const answered = this.pairing.complete(p.code, p.pubkey, p.name);
      if (answered) return answered;
      const d = {
        id: `dev_${Date.now().toString(36)}`,
        name: p.name,
        pubkey: p.pubkey,
        pairedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        pushEnabled: false,
      };
      this.state.devices.push(d);
      this.audit({
        actor: 'alice',
        type: 'device.paired',
        severity: 'info',
        summary: `alice paired ${p.name}`,
      });
      return d;
    },
    'device.remove': (p) => {
      const d = this.state.devices.find((x) => x.id === p.id) ?? fail('not_found', `No device ${p.id}`);
      this.state.devices = this.state.devices.filter((x) => x.id !== p.id);
      this.audit({
        actor: 'alice',
        type: 'device.removed',
        severity: 'warn',
        summary: `alice removed ${d.name}`,
      });
      return OK;
    },
    'device.pushSubscribe': (p) => {
      const on = p.subscription != null;
      this.state.devices = this.state.devices.map((d) => (d.id === p.id ? { ...d, pushEnabled: on } : d));
      return OK;
    },
    // A well-formed (uncompressed P-256 point, base64url) but meaningless demo key.
    'device.pushKey': () => ({ publicKey: `B${'A'.repeat(86)}` }),
    'device.pushPrefs': (p) => {
      const cur = { approvals: true, budget: true, crash: true, offline: true, security: true };
      const next = { ...cur, ...(this.pushPrefs.get(p.id) ?? {}), ...(p.prefs ?? {}) };
      this.pushPrefs.set(p.id, next);
      return { id: p.id, prefs: next };
    },

    // ── identity
    'identity.get': () => ({
      npub: OWNER.npub,
      ownerKeyHeld: true,
      daemonNpub: this.pairing.daemonKey.npub,
      agents: [...this.state.agents.values()].map((a) => ({
        name: a.config.name,
        npub: a.config.identity.npub,
        nip05: a.config.identity.nip05,
      })),
    }),
    'identity.nip05': (p) => {
      const names = p.names ?? { reviewer: NPUBS.reviewer, help: NPUBS.helpdesk };
      const json = JSON.stringify({ names, relays: {} }, null, 2);
      return {
        json,
        snippets: {
          static: `Upload as https://${p.domain}/.well-known/nostr.json`,
          nginx: `location = /.well-known/nostr.json {\n  add_header Access-Control-Allow-Origin *;\n  default_type application/json;\n}`,
          cloudflare: `/.well-known/nostr.json\n  Access-Control-Allow-Origin: *`,
        },
      };
    },

    // ── data
    'data.export': () => ({
      path: `~/.beamhop/exports/beamhop-${new Date().toISOString().slice(0, 10)}.tar.gz`,
    }),
    'data.purge': (p) => {
      const before = p.before ?? new Date().toISOString();
      const n = this.state.audit.length;
      this.state.audit = this.state.audit.filter(
        (e) => !((!p.agent || e.agent === p.agent) && e.at < before),
      );
      return { deleted: n - this.state.audit.length };
    },

    // ── identity / pairing / onboarding (minimal mock; screen builders may enrich)
    'device.pairStatus': (p) => this.pair(() => this.pairing.status(p.pairingId)),
    'device.pairConfirm': (p) => this.pair(() => this.pairing.confirm(p.pairingId, p.accept)),
    'identity.ownerCreate': () => ({ npub: MOCK_OWNER_NPUB }),
    'identity.ownerImport': (p) => ({ npub: p.npub }),
    'identity.ownerExport': () => ({ nsec: 'nsec1…(mock: never shown in demo)' }),
    'identity.attestationTemplate': (p) => ({
      template: {
        kind: 30078,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['d', `beamhop-agent:${p.name}`]],
        content: '',
      },
      ownerNpub: MOCK_OWNER_NPUB,
      agentNpub: `npub1${p.name}…`,
    }),
    'identity.attest': () => ({ ok: true as const }),
    'identity.publish': (p) => ({
      npub: `npub1${p.name}…`,
      published: [{ kind: 0, id: 'mock', relays: ['wss://relay.damus.io'] }],
      attestation: 'published' as const,
    }),
    'onboarding.hello': (p) => {
      const a = this.agent(p.agent);
      return {
        to: OWNER.npub,
        from: a.config.identity.npub ?? `npub1${p.agent}`,
        id: `hello_${Date.now().toString(36)}`,
        sentAt: this.pairing.hello(p.agent),
      };
    },
    'onboarding.helloStatus': (p) => this.pairing.helloStatus(p.agent),
  };
}

const MOCK_OWNER_NPUB = OWNER.npub;

export const describeApproval = (a: ApprovalView): string => {
  const i = (a.input ?? {}) as Record<string, unknown>;
  return String(i.command ?? i.host ?? i.path ?? a.title);
};

export { ago };
