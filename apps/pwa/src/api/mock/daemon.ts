/**
 * The fake daemon: implements EVERY method in `@beamhop/core` `methods` against in-memory state
 * (seed.ts) and pushes `ServerEvent`s like the real daemon would. Params are validated with the
 * real zod schemas, so a screen that works against the mock sends valid requests to beamhopd.
 */
import { RpcError } from '@beamhop/client';
import {
  AgentConfig,
  type AgentView,
  type ApprovalView,
  type AuditEvent,
  ChannelConfig,
  type ChannelView,
  type DeploymentView,
  isMethod,
  type MethodName,
  methods,
  type ParsedParams,
  PRESETS,
  type Result,
  SandboxPolicy,
  ScheduleConfig,
  type ServerEvent,
  type SessionEventView,
  type SessionView,
} from '@beamhop/core';
import { ago, ahead, type MockState, NPUBS, OWNER, seed } from './seed.ts';

type Handler<M extends MethodName> = (p: ParsedParams<M>) => Result<M> | Promise<Result<M>>;
type Handlers = { [M in MethodName]: Handler<M> };

const ERR = {
  not_found: -32004,
  invalid_input: -32602,
  conflict: -32009,
  unavailable: -32010,
} as const;

export const fail = (code: keyof typeof ERR, message: string): never => {
  throw new RpcError(ERR[code], message, { code });
};

const OK = { ok: true as const };
const UNDO_WINDOW_MS = 5000;

export class MockDaemon {
  state: MockState;
  private listeners = new Set<(e: ServerEvent) => void>();
  /** Decisions inside their 5 s commit window (JOURNEYS §2.6). */
  private commitTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Hook for the simulator: called when an approval's decision is released to the agent. */
  onDecisionReleased?: (a: ApprovalView) => void;
  /** Hook for the simulator: called after a user message so the agent can answer. */
  onUserMessage?: (sessionId: string, text: string) => void;

  constructor(now = Date.now()) {
    this.state = seed(now);
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
    'agent.instructions': (p) => {
      const a = this.agent(p.name);
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
    },

    // ── harnesses
    'harness.scan': () => ({ harnesses: this.state.harnesses }),
    'harness.list': () => ({ harnesses: this.state.harnesses }),
    'harness.add': (p) => {
      const h = {
        id: `acp:${p.id}`,
        displayName: p.id,
        command: [p.command, ...p.args].join(' '),
        status: 'ready' as const,
        protocol: 'acp',
        message: 'ACP handshake ok',
      };
      this.state.harnesses.push(h);
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
    'channel.validate': (p) => {
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
      if (!token) return { ok: false, message: 'The token is empty.' };
      return { ok: true, message: 'Valid', identity: { name: 'beamhop', handle: '@beamhop' } };
    },
    'channel.add': (p) => {
      if (this.state.channels.has(p.name)) return fail('conflict', `A channel named ${p.name} exists`);
      const c: ChannelView = {
        config: ChannelConfig.parse({
          name: p.name,
          provider: p.provider,
          settings: p.values,
          secretRefs: Object.keys(p.secrets).map((k) => `channel/${p.name}/${k}`),
          createdAt: new Date().toISOString(),
        }),
        status: 'connecting',
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
      const next = this.putApproval({
        ...a,
        status: p.allow ? 'approved' : 'denied',
        decidedBy: 'alice',
        decidedAt: new Date().toISOString(),
      });
      this.commitTimers.set(
        a.id,
        setTimeout(() => {
          this.commitTimers.delete(a.id);
          this.audit({
            agent: a.agent,
            actor: 'alice',
            type: 'approval.decided',
            severity: 'info',
            summary: `alice ${p.allow ? (p.always ? 'always allowed' : 'allowed') : 'denied'} ${describeApproval(a)}`,
            data: { approvalId: a.id, always: p.always },
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
      return this.putApproval({ ...a, status: 'pending', decidedBy: undefined, decidedAt: undefined });
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
    'principal.link': () => OK,
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
      return this.state.policies.get(p.name) ?? { profile: 'workspace', effective: SandboxPolicy.parse({}) };
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
      this.state.suggestions = this.state.suggestions.filter((x) => x.id !== p.id);
      if (p.accept) {
        const pol = this.state.policies.get(s.agent);
        if (pol && s.kind === 'net.allow') pol.effective.net.allow.push(s.value);
        if (pol && s.kind === 'fs.read') pol.effective.fs.read.push(s.value);
      }
      this.audit({
        agent: s.agent,
        actor: 'alice',
        type: 'policy.suggestion',
        severity: 'info',
        summary: `alice ${p.accept ? 'allowed' : 'kept blocked'} ${s.value} for ${s.agent}`,
      });
      return OK;
    },

    // ── secrets (names only, never values)
    'secret.list': () => ({ secrets: this.state.secrets, backend: 'OS keychain (libsecret)' }),
    'secret.set': (p) => {
      const now = new Date().toISOString();
      this.state.secrets = [
        ...this.state.secrets.filter((s) => s.name !== p.name),
        { name: p.name, updatedAt: now },
      ];
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
    'deploy.providers': () => ({
      providers: [
        { id: 'hetzner', displayName: 'Hetzner Cloud', kind: 'vps' as const, configured: true },
        { id: 'digitalocean', displayName: 'DigitalOcean', kind: 'vps' as const, configured: false },
        { id: 'fly', displayName: 'Fly.io', kind: 'paas' as const, configured: true },
        { id: 'render', displayName: 'Render', kind: 'paas' as const, configured: false },
        { id: 'railway', displayName: 'Railway', kind: 'paas' as const, configured: false },
      ],
    }),
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
    'device.pairStart': () => {
      // Runtime-built one-time token (never a literal in source).
      const token = Array.from(
        { length: 24 },
        () => 'abcdefghjkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 31)],
      ).join('');
      return {
        uri: `https://app.beamhop.dev/pair#${token}`,
        code: 'AMBR-RLY8',
        expiresAt: ahead(Date.now(), 2),
      };
    },
    'device.pairComplete': (p) => {
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
      this.state.devices = this.state.devices.map((d) => (d.id === p.id ? { ...d, pushEnabled: true } : d));
      return OK;
    },

    // ── identity
    'identity.get': () => ({
      npub: OWNER.npub,
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
    'device.pairStatus': (p) => ({
      pairingId: p.pairingId,
      status: 'awaiting-confirm' as const,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      safetyPhrase: ['amber', 'relay', 'harbor', 'violet'],
    }),
    'device.pairConfirm': (p) => ({
      pairingId: p.pairingId,
      status: p.accept ? ('paired' as const) : ('rejected' as const),
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      safetyPhrase: ['amber', 'relay', 'harbor', 'violet'],
    }),
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
    'onboarding.hello': (p) => ({
      to: MOCK_OWNER_NPUB,
      from: `npub1${p.agent}…`,
      id: 'mock',
      sentAt: new Date().toISOString(),
    }),
    'onboarding.helloStatus': () => ({
      sent: true,
      replied: true,
      sentAt: new Date().toISOString(),
      repliedAt: new Date().toISOString(),
      from: MOCK_OWNER_NPUB,
    }),
  };
}

const MOCK_OWNER_NPUB = 'npub1owner…';

export const describeApproval = (a: ApprovalView): string => {
  const i = (a.input ?? {}) as Record<string, unknown>;
  return String(i.command ?? i.host ?? i.path ?? a.title);
};

export { ago };
