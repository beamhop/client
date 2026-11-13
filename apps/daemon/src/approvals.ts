/**
 * Approvals (§3.2, §6): beamhop is the single gate. Harness permission requests are checked
 * against the sender's role (allow / deny / approve); approvals go to owners (channel DM with
 * buttons, PWA event), use the ApprovalPolicy quorum, expire after the timeout (→ "denied: timed
 * out") and can be undone within the undo window before they take effect.
 */
import {
  ApprovalPolicy,
  type ApprovalState,
  authorizeCommand,
  checkToolDetailed,
  effectiveRoleDef,
  normalizePrincipal,
  type RoleOverride,
  resolveRole,
  toolNameVariants,
} from '@beamhop/authz';
import {
  type AgentConfig,
  type ApprovalRule,
  type ApprovalView,
  BeamhopError,
  type ChannelConn,
  type HarnessEvent,
  type InboundMsg,
  newId,
  type PermissionDecision,
} from '@beamhop/core';
import { type Daemon, LOCAL_OWNER } from './daemon.ts';
import { buildRule, cleanReason, ruleMatches, withRule } from './rules.ts';
import type { LiveSession, Turn } from './sessions.ts';
import { errMsg } from './util.ts';

type PermissionRequest = Extract<HarnessEvent, { type: 'permission_request' }>;

interface Waiter {
  sessionId: string;
  resolve: (d: PermissionDecision) => void;
  always: boolean;
  tool: string;
}

const ACCESS_DENIED_COOLDOWN_MS = 24 * 3600_000;

/** Options of an `approval.decide` vote. */
export interface DecideOptions {
  /** Persist an "always allow" rule for this agent (`rule`, or the exact request). */
  always?: boolean;
  /** Allow this tool for the rest of the session. */
  session?: boolean;
  /** With `always`: the policy value (`bash:<prefix>`, host / `*.domain`, file or `dir/`). */
  rule?: string;
  /** With a deny: short reason, stored, audited and passed to the agent. */
  reason?: string;
  grantRole?: string;
}

/** A daemon action held until an approval settles (e.g. `session.openPr` pushing a branch). */
export interface ActionRequest {
  agent: string;
  sessionId: string;
  requestedBy: ApprovalView['requestedBy'];
  tool: string;
  title: string;
  input: unknown;
  risk: ApprovalView['risk'];
  run: () => Promise<void>;
}

export class ApprovalManager {
  private readonly waiters = new Map<string, Waiter>();
  private readonly settleTimers = new Map<string, NodeJS.Timeout>();
  private readonly grants = new Map<string, string>();
  private readonly settled = new Set<string>();
  /** "Always" rules waiting for their approval to settle. */
  private readonly rules = new Map<string, ApprovalRule>();
  /** Daemon actions waiting for their approval to settle. */
  private readonly actions = new Map<string, ActionRequest['run']>();

  constructor(private readonly d: Daemon) {}

  get undoMs(): number {
    return this.d.opts.approvalUndoMs ?? 30_000;
  }

  /** Who may decide approvals for an agent: owners (incl. linked identities), the local owner, and roles with canApprove. */
  approvers(agent?: AgentConfig): string[] {
    const d = this.d;
    const g = d.global();
    const out = new Set<string>([...d.ownerPrincipals(), LOCAL_OWNER]);
    const roles = g.roles as RoleOverride[];
    const grants = { ...g.grants, ...(agent?.grants ?? {}) };
    for (const [p, r] of Object.entries(grants)) {
      if (p.includes(':') && effectiveRoleDef(r, roles)?.canApprove) out.add(normalizePrincipal(p));
      else if (effectiveRoleDef(r, roles)?.canApprove)
        for (const pp of g.people[p] ?? []) out.add(normalizePrincipal(pp));
    }
    return [...out];
  }

  policy(agent?: AgentConfig): ApprovalPolicy {
    return new ApprovalPolicy({
      approvers: this.approvers(agent),
      // One vote per person across linked principals (review wave B AUTHZ-2).
      people: this.d.global().people,
      quorum: this.d.global().approvals.quorum,
      timeoutMinutes: agent?.approvalTimeoutMinutes ?? 15,
      undoWindowMs: this.undoMs,
      now: this.d.now,
    });
  }

  private agentOf(name: string): AgentConfig | undefined {
    try {
      return this.d.agent(name);
    } catch {
      return undefined;
    }
  }

  /** Name shown for a voter: the linked person, or the principal. */
  private voterName(principal: string): string {
    const n = normalizePrincipal(principal);
    for (const [person, ps] of Object.entries(this.d.global().people))
      if (ps.some((p) => normalizePrincipal(p) === n)) return person;
    return principal;
  }

  /** API view: quorum (when more than one approval is needed) and the votes cast so far. */
  view(s: ApprovalState): ApprovalView {
    const v = ApprovalPolicy.toView(s);
    const q = this.policy(this.agentOf(s.agent)).quorumFor(s);
    if (q.needed > 1) v.quorum = q;
    if (s.votes?.length)
      v.votes = s.votes.map((x) => ({ by: this.voterName(x.by), allow: x.allow, at: x.at }));
    return v;
  }

  /** Stored deny reason of an approval, if any. */
  reasonOf(id: string): string | undefined {
    return this.d.store.kv.get<string>('approval-reason', id);
  }

  // ───────────────────────────── tool permissions ─────────────────────────────

  async requestTool(
    live: LiveSession,
    agent: AgentConfig,
    turn: Turn,
    ev: PermissionRequest,
  ): Promise<PermissionDecision> {
    const d = this.d;
    const { role, mode } = d.sessions.checkRole(live, turn.role);
    const check = checkToolDetailed({ role, tool: ev.tool, input: ev.input, ...(mode ? { mode } : {}) });
    const record = (decision: string, extra: Record<string, unknown> = {}) =>
      d.sessions.event(live.id, {
        kind: 'permission',
        text: `${ev.title || ev.tool}: ${decision}`,
        tool: { id: ev.id, name: ev.tool, title: ev.title, input: ev.input },
        ...(extra.approvalId ? { approvalId: extra.approvalId as string } : {}),
      });
    if (check.decision === 'deny') {
      record(`denied (${check.reason})`);
      d.audit({
        type: 'tool.denied',
        severity: 'warn',
        summary: `Denied ${ev.tool} for ${turn.from.principal} (${role.name}): ${check.reason}`,
        actor: `agent:${agent.name}`,
        agent: agent.name,
        data: { tool: ev.tool, role: role.name, reason: check.reason, session: live.id },
      });
      return { allow: false, reason: `denied: ${check.reason}` };
    }
    const always = toolNameVariants(ev.tool).some((v) => live.alwaysAllow.has(v));
    if (check.decision === 'allow' || always) {
      record(always ? 'allowed (always for this session)' : 'allowed');
      return { allow: true };
    }
    const rule = (agent.approvalRules ?? []).find((r) =>
      ruleMatches(r, { tool: ev.tool, input: ev.input, role: role.name }),
    );
    if (rule) {
      record(`allowed (always rule ${rule.kind} ${rule.value})`);
      d.audit({
        type: 'tool.allowed.rule',
        severity: 'info',
        summary: `Allowed ${ev.tool} for ${turn.from.principal} (${role.name}) by rule ${rule.kind} ${rule.value}`,
        actor: `agent:${agent.name}`,
        agent: agent.name,
        data: { tool: ev.tool, role: role.name, rule: rule.value, kind: rule.kind, session: live.id },
      });
      return { allow: true };
    }
    const id = newId('apr');
    const policy = this.policy(agent);
    const state = policy.create({
      id,
      agent: agent.name,
      sessionId: live.id,
      requestedBy: {
        principal: turn.from.principal,
        ...(turn.from.displayName ? { displayName: turn.from.displayName } : {}),
        role: role.name,
      },
      tool: ev.tool,
      title: ev.title || ev.tool,
      input: ev.input,
      risk: check.risk,
    });
    d.store.approvals.put(state);
    record('waiting for approval', { approvalId: id });
    d.emit({ type: 'approval.created', approval: this.view(state) });
    d.audit({
      type: 'approval.requested',
      severity: 'info',
      summary: `${agent.name} asks to run ${ev.tool} (${check.risk} risk) for ${turn.from.principal}`,
      actor: `agent:${agent.name}`,
      agent: agent.name,
      data: { approval: id, tool: ev.tool, risk: check.risk, session: live.id },
    });
    const decision = new Promise<PermissionDecision>((resolve) => {
      this.waiters.set(id, { sessionId: live.id, resolve, always: false, tool: ev.tool });
    });
    await this.notify(state, live);
    return decision;
  }

  private card(a: ApprovalState): string {
    const who = a.requestedBy.displayName ?? a.requestedBy.principal;
    const input = a.input === undefined ? '' : `\n\`${JSON.stringify(a.input).slice(0, 300)}\``;
    if (a.kind === 'access-request')
      return `🔑 *Access request* for *${a.agent}*\n${who} (${a.requestedBy.principal}) wants to talk to the agent.\nReply \`/approve ${a.id}\` to grant access or \`/deny ${a.id}\`.`;
    return `🔐 *Approval needed* (${a.risk} risk)\n*${a.agent}* wants to run **${a.tool}**: ${a.title}${input}\nRequested by ${who} (${a.requestedBy.role}).\nReply \`/approve ${a.id}\` or \`/deny ${a.id}\` — expires ${a.expiresAt.slice(11, 16)} UTC.`;
  }

  private async notify(a: ApprovalState, live?: LiveSession): Promise<void> {
    const d = this.d;
    const buttons = [
      { id: `approve:${a.id}`, label: 'Approve', style: 'primary' as const },
      { id: `deny:${a.id}`, label: 'Deny', style: 'danger' as const },
      ...(live ? [{ id: `details:${live.id}`, label: 'Details', style: 'default' as const }] : []),
    ];
    const approvers = new Set(this.approvers(this.agentOf(a.agent)));
    const n = await d.notifyOwners(this.card(a), {
      buttons,
      principals: [...approvers].filter((p) => p !== LOCAL_OWNER),
    });
    // The requester is an approver in a DM we have not recorded (e.g. first contact): answer there.
    if (
      n === 0 &&
      live &&
      live.conversationKind === 'dm' &&
      approvers.has(normalizePrincipal(a.requestedBy.principal))
    ) {
      const conn = live.conn();
      if (conn)
        await conn
          .send({
            conversation: { kind: 'dm', id: live.key.conversationId },
            threadId: live.key.threadId,
            markdown: this.card(a),
            buttons: conn.capabilities.buttons ? buttons : [],
          })
          .catch((e) => d.log.warn('approval card failed', { error: errMsg(e) }));
    }
  }

  // ───────────────────────────── access requests ─────────────────────────────

  /** One pending access request per (agent, sender); denied requests are not re-raised for 24 h. */
  async accessRequest(
    agent: AgentConfig,
    conn: ChannelConn,
    msg: InboundMsg,
  ): Promise<ApprovalView | undefined> {
    const d = this.d;
    const who = normalizePrincipal(msg.from.principal);
    const pending = d.store.approvals
      .listStates({ status: 'pending', agent: agent.name })
      .find((a) => a.kind === 'access-request' && normalizePrincipal(a.requestedBy.principal) === who);
    if (pending) return undefined;
    const deniedAt = d.store.kv.get<number>('access-denied', `${agent.name}|${who}`);
    if (deniedAt && d.now() - deniedAt < ACCESS_DENIED_COOLDOWN_MS) return undefined;
    const policy = this.policy(agent);
    const state = policy.create({
      id: newId('apr'),
      agent: agent.name,
      sessionId: '',
      requestedBy: {
        principal: msg.from.principal,
        ...(msg.from.displayName ? { displayName: msg.from.displayName } : {}),
        role: 'unknown',
      },
      tool: 'access',
      title: `Access for ${msg.from.displayName ?? msg.from.principal} via ${conn.name}`,
      input: {
        principal: msg.from.principal,
        channel: conn.name,
        conversation: msg.conversation.id,
        preview: msg.text.slice(0, 200),
      },
      kind: 'access-request',
      risk: 'medium',
    });
    // Access requests wait longer than tool approvals (owners may be away).
    state.expiresAt = new Date(d.now() + 7 * 24 * 3600_000).toISOString();
    d.store.approvals.put(state);
    d.emit({ type: 'approval.created', approval: this.view(state) });
    d.audit({
      type: 'access.requested',
      severity: 'security',
      summary: `${msg.from.principal} requested access to ${agent.name}`,
      actor: msg.from.principal,
      agent: agent.name,
      data: { approval: state.id, channel: conn.name },
    });
    await this.notify(state);
    return this.view(state);
  }

  // ───────────────────────────── decisions ─────────────────────────────

  /**
   * Hold a daemon action behind an approval; `run` executes once the approval settles as approved
   * (after the undo window). Denied, expired or cancelled actions never run.
   */
  async requestAction(req: ActionRequest): Promise<ApprovalView> {
    const d = this.d;
    const agent = this.agentOf(req.agent);
    const state = this.policy(agent).create({
      id: newId('apr'),
      agent: req.agent,
      sessionId: req.sessionId,
      requestedBy: req.requestedBy,
      tool: req.tool,
      title: req.title,
      input: req.input,
      risk: req.risk,
    });
    d.store.approvals.put(state);
    this.actions.set(state.id, req.run);
    d.emit({ type: 'approval.created', approval: this.view(state) });
    d.audit({
      type: 'approval.requested',
      severity: 'info',
      summary: `${req.requestedBy.principal} asks to run ${req.tool} for ${req.agent}`,
      actor: req.requestedBy.principal,
      agent: req.agent,
      data: { approval: state.id, tool: req.tool, risk: req.risk, session: req.sessionId },
    });
    await this.notify(state);
    return this.view(state);
  }

  async decide(id: string, by: string, allow: boolean, opts: DecideOptions): Promise<ApprovalView> {
    const d = this.d;
    const state = d.store.approvals.get(id);
    if (!state) throw new BeamhopError('not_found', `approval ${id} not found`);
    const agent = this.agentOf(state.agent);
    const reason = allow ? undefined : cleanReason(opts.reason);
    if (opts.rule !== undefined && !opts.always)
      throw new BeamhopError('invalid_input', '`rule` needs `always: true`');
    let rule: ApprovalRule | undefined;
    if (allow && opts.always) {
      if (state.kind !== 'tool' || this.actions.has(id))
        throw new BeamhopError('invalid_input', 'only tool requests can be allowed always');
      // Validated before the vote counts: an invalid rule leaves the approval pending.
      rule = buildRule({ tool: state.tool, input: state.input, role: state.requestedBy.role }, opts.rule, {
        at: new Date(d.now()).toISOString(),
        by,
      });
    }
    if (allow && opts.session && (state.kind !== 'tool' || this.actions.has(id)))
      throw new BeamhopError('invalid_input', 'only tool requests can be allowed for the session');
    const policy = this.policy(agent);
    const res = policy.decide(state, by, allow);
    if (!res.ok) {
      if (res.reason === 'expired') {
        d.store.approvals.put(res.state);
        this.finish(res.state, { allow: false, reason: 'denied: timed out' });
      }
      const msg: Record<string, string> = {
        not_pending: 'this approval was already decided',
        not_eligible: 'you are not allowed to decide approvals for this agent',
        already_voted: 'you already voted on this approval',
        expired: 'this approval expired (denied: timed out)',
      };
      if (res.reason === 'not_eligible')
        d.audit({
          type: 'approval.unauthorized',
          severity: 'security',
          summary: `${by} tried to decide approval ${id} without permission`,
          actor: by,
          agent: state.agent,
          data: { approval: id },
        });
      throw new BeamhopError(
        res.reason === 'not_eligible' ? 'forbidden' : 'conflict',
        msg[res.reason] ?? res.reason,
      );
    }
    d.store.approvals.put(res.state);
    const w = this.waiters.get(id);
    if (w && allow && (opts.always || opts.session)) w.always = true;
    if (rule) this.rules.set(id, rule);
    if (reason) d.store.kv.set('approval-reason', id, reason);
    if (opts.grantRole) this.grants.set(id, opts.grantRole);
    d.emit({ type: 'approval.updated', approval: this.view(res.state) });
    const scope = rule
      ? ` always (${rule.kind} ${rule.value})`
      : allow && opts.session
        ? ' for the session'
        : '';
    d.audit({
      type: 'approval.vote',
      severity: 'security',
      summary: `${by} ${allow ? 'approved' : 'denied'} ${res.state.tool} for ${state.agent}${scope}${reason ? `: ${reason}` : ''}${res.final ? '' : ' (waiting for quorum)'}`,
      actor: by,
      agent: state.agent,
      data: {
        approval: id,
        allow,
        final: res.final,
        status: res.state.status,
        ...(opts.session ? { session: true } : {}),
        ...(rule ? { always: true, rule: rule.value, ruleKind: rule.kind } : {}),
        ...(reason ? { reason } : {}),
      },
    });
    if (res.final) this.scheduleSettle(res.state);
    return this.view(res.state);
  }

  /**
   * A vote cast from a channel (`/approve`, `/deny` or an Approve/Deny button). Button data is
   * untrusted (Telegram documents forgeable `callback_data`), so presses and commands share this one
   * check: the sender's role for the approval's agent must be allowed the command and have
   * `canApprove`, and the policy must count the sender as an approver.
   */
  async decideFromChannel(id: string, by: string, allow: boolean): Promise<ApprovalView> {
    const d = this.d;
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new BeamhopError('invalid_input', 'invalid approval id');
    const state = d.store.approvals.get(id);
    if (!state) throw new BeamhopError('not_found', `approval ${id} not found`);
    const agent = this.agentOf(state.agent);
    const roleName = agent
      ? resolveRole({ principal: by, agent, global: d.authzGlobal() })
      : d.ownerPrincipals().includes(normalizePrincipal(by))
        ? 'owner'
        : null;
    const auth = authorizeCommand(roleName ? d.roleDef(roleName) : null, {
      name: allow ? 'approve' : 'deny',
      id,
      args: [],
    });
    if (!auth.allowed) {
      d.audit({
        type: 'approval.unauthorized',
        severity: 'security',
        summary: `${by} tried to decide approval ${id} without permission (${auth.reason})`,
        actor: by,
        agent: state.agent,
        data: { approval: id, role: roleName ?? 'none' },
      });
      throw new BeamhopError('forbidden', 'you are not allowed to decide approvals for this agent');
    }
    return this.decide(id, by, allow, {});
  }

  /** Decisions take effect after the undo window (unless undone). */
  private scheduleSettle(state: ApprovalState): void {
    const prev = this.settleTimers.get(state.id);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      this.settleTimers.delete(state.id);
      const cur = this.d.store.approvals.get(state.id);
      if (!cur || (cur.status !== 'approved' && cur.status !== 'denied')) return;
      void this.settle(cur).catch((e) => this.d.log.error('approval settle failed', { error: errMsg(e) }));
    }, this.undoMs);
    t.unref?.();
    this.settleTimers.set(state.id, t);
  }

  private async settle(state: ApprovalState): Promise<void> {
    this.settled.add(state.id);
    const allow = state.status === 'approved';
    if (state.kind === 'access-request') {
      const input = state.input as { principal?: string } | undefined;
      const principal = input?.principal ?? state.requestedBy.principal;
      if (allow) {
        const role = this.grants.get(state.id) ?? 'user';
        if (!effectiveRoleDef(role, this.d.global().roles as RoleOverride[]))
          throw new BeamhopError('invalid_input', `unknown role ${role}`);
        this.d.config.agents.update(state.agent, (a) => ({
          ...a,
          grants: { ...a.grants, [principal]: role },
        }));
        this.d.audit({
          type: 'role.grant',
          severity: 'security',
          summary: `Granted ${role} on ${state.agent} to ${principal} (access request)`,
          actor: state.decidedBy ?? 'unknown',
          agent: state.agent,
          data: { principal, role, approval: state.id },
        });
        this.d.emitAgent(state.agent);
      } else
        this.d.store.kv.set('access-denied', `${state.agent}|${normalizePrincipal(principal)}`, this.d.now());
      this.grants.delete(state.id);
      return;
    }
    const action = this.actions.get(state.id);
    if (action) {
      this.actions.delete(state.id);
      if (allow)
        await action().catch((e) => {
          this.d.audit({
            type: 'action.failed',
            severity: 'warn',
            summary: `${state.title} failed: ${errMsg(e)}`,
            actor: 'beamhopd',
            agent: state.agent,
            data: { approval: state.id, tool: state.tool },
          });
          try {
            this.d.sessions.event(state.sessionId, {
              kind: 'error',
              text: `${state.title} failed: ${errMsg(e)}`,
            });
          } catch {
            /* session purged */
          }
        });
      return;
    }
    const w = this.waiters.get(state.id);
    const rule = this.rules.get(state.id);
    this.rules.delete(state.id);
    if (allow && rule) {
      try {
        this.d.config.agents.update(state.agent, (a) => withRule(a, rule));
        this.d.audit({
          type: 'approval.rule',
          severity: 'security',
          summary: `Always allow ${rule.kind} ${rule.value} (${rule.tool}${rule.role ? `, role ${rule.role}` : ''}) on ${state.agent}`,
          actor: state.decidedBy ?? 'unknown',
          agent: state.agent,
          data: { approval: state.id, ...rule },
        });
        this.d.emitAgent(state.agent);
      } catch (e) {
        this.d.log.warn('could not persist approval rule', { error: errMsg(e) });
      }
    }
    if (allow && w?.always) {
      const live = this.d.sessions.live(state.sessionId);
      for (const v of toolNameVariants(state.tool)) live?.alwaysAllow.add(v);
    }
    const reason = this.reasonOf(state.id);
    this.finish(
      state,
      allow
        ? { allow: true, ...(w?.always ? { always: true } : {}) }
        : { allow: false, reason: `denied by ${state.decidedBy ?? 'owner'}${reason ? `: ${reason}` : ''}` },
    );
  }

  private finish(state: ApprovalState, decision: PermissionDecision): void {
    const w = this.waiters.get(state.id);
    if (!w) return;
    this.waiters.delete(state.id);
    w.resolve(decision);
    try {
      this.d.sessions.event(state.sessionId, {
        kind: 'permission',
        text: `${state.title}: ${decision.allow ? 'approved' : (decision.reason ?? 'denied')}`,
        approvalId: state.id,
      });
    } catch {
      /* session purged */
    }
  }

  async undo(id: string, by: string): Promise<ApprovalView> {
    const d = this.d;
    const state = d.store.approvals.get(id);
    if (!state) throw new BeamhopError('not_found', `approval ${id} not found`);
    if (this.settled.has(id)) throw new BeamhopError('conflict', 'the decision was already applied');
    const res = this.policy(this.agentOf(state.agent)).undo(state, by);
    if (!res.ok) {
      const m: Record<string, string> = {
        not_decided: 'nothing to undo',
        window_passed: 'the undo window has passed',
        not_decider: 'only whoever decided can undo',
        expired: 'this approval expired',
      };
      throw new BeamhopError('conflict', m[res.reason] ?? res.reason);
    }
    const t = this.settleTimers.get(id);
    if (t) clearTimeout(t);
    this.settleTimers.delete(id);
    this.rules.delete(id);
    d.store.kv.delete('approval-reason', id);
    d.store.approvals.put(res.state);
    d.emit({ type: 'approval.updated', approval: this.view(res.state) });
    d.audit({
      type: 'approval.undo',
      severity: 'security',
      summary: `${by} undid the decision on ${state.tool} for ${state.agent}`,
      actor: by,
      agent: state.agent,
      data: { approval: id },
    });
    return this.view(res.state);
  }

  /** Expire due approvals (→ deny "denied: timed out"). */
  async tick(): Promise<void> {
    const d = this.d;
    for (const a of d.store.approvals.expireDue(new Date(d.now()))) {
      d.emit({ type: 'approval.updated', approval: this.view(a) });
      d.audit({
        type: 'approval.timeout',
        severity: 'warn',
        summary: `Approval for ${a.tool} on ${a.agent} timed out (denied)`,
        actor: 'system:timeout',
        agent: a.agent,
        data: { approval: a.id },
      });
      this.actions.delete(a.id);
      this.rules.delete(a.id);
      this.finish(a, { allow: false, reason: 'denied: timed out' });
    }
  }

  /** Deny every waiter of a session (e.g. /stop). */
  cancelSession(sessionId: string, reason: string): void {
    for (const [id, w] of this.waiters) {
      if (w.sessionId !== sessionId) continue;
      const st = this.d.store.approvals.get(id);
      if (st?.status === 'pending') {
        const next = {
          ...st,
          status: 'denied' as const,
          decidedAt: new Date(this.d.now()).toISOString(),
          decidedBy: 'system:stop',
        };
        this.d.store.approvals.put(next);
        this.d.emit({ type: 'approval.updated', approval: this.view(next) });
      }
      this.waiters.delete(id);
      w.resolve({ allow: false, reason });
    }
  }

  denyAll(reason: string): void {
    for (const w of [...this.waiters.values()]) this.cancelSession(w.sessionId, reason);
    // Held actions (e.g. a branch push) are cancelled too.
    for (const id of [...this.actions.keys()]) {
      this.actions.delete(id);
      const st = this.d.store.approvals.get(id);
      if (st?.status === 'pending' || st?.status === 'approved') {
        const next = {
          ...st,
          status: 'denied' as const,
          decidedAt: new Date(this.d.now()).toISOString(),
          decidedBy: 'system:stop',
        };
        this.d.store.approvals.put(next);
        this.d.emit({ type: 'approval.updated', approval: this.view(next) });
      }
    }
  }

  dispose(): void {
    for (const t of this.settleTimers.values()) clearTimeout(t);
    this.settleTimers.clear();
    this.denyAll('denied: daemon shutting down');
  }
}
