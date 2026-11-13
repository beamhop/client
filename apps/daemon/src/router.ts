/**
 * Router / core loop (§5, §6, §6A): dedupe → memberships → role → commands → triggers → budgets →
 * mesh guardrails → session selection → harness.
 */
import {
  authorizeCommand,
  budgetKey,
  type Command,
  checkMesh,
  globMatch,
  helpText,
  isAddressedTo,
  normalizePrincipal,
  parseCommand,
  resolveRole,
  resolveRoleDetailed,
  shouldTrigger,
} from '@beamhop/authz';
import {
  type AgentConfig,
  type ButtonPress,
  type ChannelConn,
  formatPreamble,
  type InboundMsg,
  type Membership,
  type RoleDef,
} from '@beamhop/core';
import { meshThreadKey } from '@beamhop/store';
import type { Daemon } from './daemon.ts';
import { errMsg, personBudgetKey } from './util.ts';

export interface HistoryEntry {
  id: string;
  threadId: string;
  principal: string;
  name?: string;
  text: string;
  at: string;
  role?: string;
}

const HISTORY_MAX = 200;
const UNKNOWN_SENDER_AUDIT_MS = 60 * 60_000;
const PAIR_FAIL_LIMIT = 5;
const PAIR_FAIL_WINDOW_MS = 10 * 60_000;
const SEEN_AGENTS_MAX = 5000;

/** Does a mesh allow/block list name this principal? Bare keys in the list mean Nostr keys. */
export const meshListIncludes = (list: readonly string[], principal: string): boolean => {
  const p = normalizePrincipal(principal);
  return list.some((e) => {
    const entry = e.includes(':') ? e : `nostr:${e}`;
    return normalizePrincipal(entry) === p;
  });
};

/** Normalize a channel target for comparisons (channel + kind lower-case, id verbatim). */
const normTarget = (t: string): string => {
  const c = t.indexOf(':');
  if (c < 0) return t.toLowerCase();
  const rest = t.slice(c + 1);
  const s = rest.indexOf('/');
  const kind = s < 0 ? rest : rest.slice(0, s);
  return `${t.slice(0, c).toLowerCase()}:${kind.toLowerCase()}${s < 0 ? '' : rest.slice(s)}`;
};

export const conversationTarget = (channel: string, kind: string, id: string): string =>
  `${channel}:${kind}/${id}`;

export type MembershipMatch = { membership: Membership; exact: boolean };

/** The membership of `agent` that covers this conversation: exact target first, then `<channel>:<kind>` / globs. */
export const matchMembership = (
  agent: Pick<AgentConfig, 'memberships'>,
  channel: string,
  kind: string,
  id: string,
): MembershipMatch | undefined => {
  const full = normTarget(conversationTarget(channel, kind, id));
  const exact = agent.memberships.find((m) => normTarget(m.target) === full);
  if (exact) return { membership: exact, exact: true };
  const wild = normTarget(`${channel}:${kind}`);
  const w = agent.memberships.find(
    (m) =>
      !m.revokedAt &&
      (normTarget(m.target) === wild ||
        (m.target.includes('*') && globMatch(normTarget(m.target), full, { caseInsensitive: false }))),
  );
  return w ? { membership: w, exact: false } : undefined;
};

export class Router {
  private readonly unknownSeen = new Map<string, number>();
  private readonly pairFails = new Map<string, number[]>();
  /** Principals that sent a peer (hops) message before. */
  private readonly seenAgents = new Set<string>();

  constructor(private readonly d: Daemon) {}

  // ───────────────────────────── history (channel_history) ─────────────────────────────

  recordHistory(channel: string, conversationId: string, e: HistoryEntry): void {
    const key = `${channel}|${conversationId}`;
    const list = this.d.store.kv.get<HistoryEntry[]>('history', key) ?? [];
    list.push({ ...e, text: e.text.slice(0, 4000) });
    this.d.store.kv.set('history', key, list.slice(-HISTORY_MAX));
  }

  history(channel: string, conversationId: string): HistoryEntry[] {
    return this.d.store.kv.get<HistoryEntry[]>('history', `${channel}|${conversationId}`) ?? [];
  }

  // ───────────────────────────── inbound ─────────────────────────────

  async handle(conn: ChannelConn, msg: InboundMsg): Promise<void> {
    const d = this.d;
    if (d.isPanic()) return;
    // Long-term replay guard (review wave B NOS-1/R-B8): channel-level dedupe is in-memory and
    // bounded; the store remembers message ids for 30 days. Keyed by our channel name.
    if (!d.store.dedupe.firstSeen(conn.name, msg.id)) return;
    if (normalizePrincipal(msg.from.principal) === normalizePrincipal(conn.self.principal)) return;
    const channel = conn.name;
    // Agent-bound connection (`nostr@reviewer`): only that agent is reachable through it, and its
    // memberships are written against the shared channel name (`nostr:dm`).
    const bound = d.channels.binding(conn.name);
    const memberChannel = bound?.channel ?? channel;
    const isDm = msg.conversation.kind === 'dm';
    if (isDm) d.rememberDm(msg.from.principal, channel, msg.conversation.id);
    d.identity.noteInbound(conn, msg);

    // Replies to an outstanding mesh_ask_agent are consumed by the mesh provider.
    if (d.mesh?.onInbound?.(conn, msg)) return;

    const parsed = parseCommand(msg.text);
    const botNames = [conn.self.handle, conn.self.displayName].filter((x): x is string => !!x);

    // Channel-level commands: /pair (anyone) and /approve, /deny (approvers), handled once.
    if (
      parsed?.ok &&
      (parsed.command.name === 'pair' || parsed.command.name === 'approve' || parsed.command.name === 'deny')
    ) {
      if (!isAddressedTo(parsed, botNames)) return;
      const addressed = isDm || msg.mentionsAgent || msg.replyToAgent || !!parsed.addressedTo;
      if (!addressed) return;
      if (parsed.command.name === 'pair') return this.pair(conn, msg, parsed.command.code);
      return this.approveCommand(conn, msg, parsed.command.name === 'approve', parsed.command.id);
    }

    const g = d.authzGlobal();
    const peerHint = msg.from.isBot || msg.hops > 0;
    if (peerHint) this.rememberAgent(msg.from.principal);
    let knownAgent: Promise<boolean> | undefined;
    const isKnownAgent = () => (knownAgent ??= this.knownAgent(msg.from.principal));
    let recorded = false;
    for (const agent of d.config.agents.list()) {
      if (bound && agent.name !== bound.agent) continue;
      const match = matchMembership(agent, memberChannel, msg.conversation.kind, msg.conversation.id);
      if (!match) continue;
      const { membership } = match;
      if (membership.revokedAt) continue;
      if (!recorded) {
        recorded = true;
        this.recordHistory(channel, msg.conversation.id, {
          id: msg.id,
          threadId: msg.threadId,
          principal: msg.from.principal,
          ...(msg.from.displayName ? { name: msg.from.displayName } : {}),
          text: msg.text,
          at: msg.receivedAt,
        });
      }
      if (d.isAgentStopped(agent.name)) continue;
      // A Nostr peer that drops the hops tag is still an agent when we know it as one (R-B1).
      const isPeer =
        peerHint || meshListIncludes(agent.mesh.allow, msg.from.principal) || (await isKnownAgent());
      const res = resolveRoleDetailed({
        principal: msg.from.principal,
        agent,
        global: g,
        membership,
        isAgent: isPeer,
      });
      if (res.role === null) {
        if (res.reason === 'unknown-sender' || res.reason === 'blocked')
          this.unknownSender(conn, agent, msg, res.reason);
        continue;
      }
      const role = d.roleDef(res.role);
      const trig = shouldTrigger(msg, membership, role, { botNames });
      if (!trig.trigger) continue;
      try {
        if (trig.command) {
          if (!trig.command.ok) {
            if (isDm && trig.command.known)
              await this.reply(conn, msg, agent, role, membership, `⚠️ ${trig.command.error}`);
            else if (isDm)
              await this.reply(conn, msg, agent, role, membership, `Unknown command. ${helpShort}`);
            continue;
          }
          await this.command(conn, msg, agent, membership, role, trig.command.command);
          continue;
        }
        await this.prompt(conn, msg, agent, membership, role, isPeer);
      } catch (e) {
        d.log.error('routing failed', { agent: agent.name, error: errMsg(e) });
      }
    }
  }

  private rememberAgent(principal: string): void {
    const p = normalizePrincipal(principal);
    this.seenAgents.delete(p);
    this.seenAgents.add(p);
    if (this.seenAgents.size > SEEN_AGENTS_MAX) {
      const first = this.seenAgents.values().next().value;
      if (first !== undefined) this.seenAgents.delete(first);
    }
  }

  /** Known peer agent: seen with a hops tag before, or published as an agent (capability card / attestation). */
  private async knownAgent(principal: string): Promise<boolean> {
    const p = normalizePrincipal(principal);
    if (!p.startsWith('nostr:')) return false;
    if (this.seenAgents.has(p)) return true;
    // Owners are humans by definition; skip the relay lookup for them.
    if (this.d.ownerPrincipals().includes(p)) return false;
    try {
      return (await this.d.mesh?.isKnownAgent?.(p)) === true;
    } catch {
      return false;
    }
  }

  private unknownSender(conn: ChannelConn, agent: AgentConfig, msg: InboundMsg, reason: string): void {
    const d = this.d;
    const key = `${agent.name}|${normalizePrincipal(msg.from.principal)}`;
    const last = this.unknownSeen.get(key) ?? Number.NEGATIVE_INFINITY;
    if (d.now() - last >= UNKNOWN_SENDER_AUDIT_MS) {
      this.unknownSeen.set(key, d.now());
      d.audit({
        type: reason === 'blocked' ? 'sender.blocked' : 'sender.unknown',
        severity: 'security',
        summary: `Ignored message from ${reason} sender ${msg.from.principal} on ${conn.name}`,
        actor: msg.from.principal,
        agent: agent.name,
        data: { channel: conn.name, conversation: msg.conversation.id },
      });
    }
    if (reason === 'unknown-sender' && msg.conversation.kind === 'dm' && !agent.public)
      void d.approvals
        .accessRequest(agent, conn, msg)
        .catch((e) => d.log.warn('access request failed', { error: errMsg(e) }));
  }

  /** A message that should reach the harness. */
  private async prompt(
    conn: ChannelConn,
    msg: InboundMsg,
    agent: AgentConfig,
    membership: Membership,
    role: RoleDef,
    isPeer: boolean,
  ): Promise<void> {
    const d = this.d;
    const principal = msg.from.principal;
    // Mesh guardrails (§6A.6): human messages reset the thread, peer messages are capped.
    const mkey = meshThreadKey(agent.name, conn.name, msg.conversation.id, msg.threadId);
    let outgoingHops = 0;
    const thread = d.store.meshThreads.get(mkey);
    const mesh = checkMesh({
      thread,
      hops: msg.hops,
      config: agent.mesh,
      fromHuman: !isPeer,
      now: new Date(d.now()).toISOString(),
    });
    if (isPeer || thread.turns || thread.humanRequired) d.store.meshThreads.put(mkey, agent.name, mesh.next);
    if (mesh.action === 'drop') {
      d.audit({
        type: 'mesh.limit',
        severity: 'security',
        summary: `Dropped peer message from ${principal}: ${mesh.message}`,
        actor: principal,
        agent: agent.name,
        data: { reason: mesh.reason, hops: msg.hops, conversation: msg.conversation.id },
      });
      return;
    }
    if (isPeer) outgoingHops = mesh.outgoingHops;

    // Budgets & rate limits.
    const entries = [
      { key: budgetKey.agent(agent.name), budget: agent.budgets },
      { key: budgetKey.principal(agent.name, normalizePrincipal(principal)), budget: role.budget },
    ];
    const personKey = personBudgetKey(agent.name, d.global().people, principal);
    if (personKey) entries.push({ key: personKey, budget: role.budget });
    if (isPeer)
      entries.push({
        key: budgetKey.peer(agent.name, normalizePrincipal(principal)),
        budget: agent.mesh.perPeerBudget,
      });
    const adm = d.budgets.admit(entries);
    if (!adm.ok) {
      d.audit({
        type: adm.reason === 'rate_limited' ? 'budget.rate_limited' : 'budget.exceeded',
        severity: 'warn',
        summary: `Refused message from ${principal}: ${adm.message}`,
        actor: principal,
        agent: agent.name,
        data: { reason: adm.reason },
      });
      if (!isPeer) await this.reply(conn, msg, agent, role, membership, `⏳ ${adm.message}`);
      return;
    }

    await d.sessions.submit({
      agent,
      channel: conn.name,
      conversation: msg.conversation,
      threadId: msg.threadId,
      membership,
      turn: {
        text: msg.text,
        promptFor: (m) => formatPreamble(m ?? msg, role.name),
        msg,
        from: {
          principal,
          ...(msg.from.displayName ? { displayName: msg.from.displayName } : {}),
          role: role.name,
        },
        role,
        attachments: msg.attachments,
        replyToId: msg.id,
        hops: outgoingHops,
        ...(isPeer ? { peer: principal } : {}),
        source: 'channel',
      },
    });
  }

  async reply(
    conn: ChannelConn,
    msg: InboundMsg,
    agent: AgentConfig,
    role: RoleDef,
    membership: Membership | undefined,
    markdown: string,
    buttons: { id: string; label: string; style?: 'primary' | 'danger' | 'default' }[] = [],
  ): Promise<void> {
    await this.d.sendOutbound(
      conn,
      {
        conversation: { kind: msg.conversation.kind, id: msg.conversation.id },
        threadId: msg.threadId,
        replyToId: msg.id,
        markdown,
        buttons: conn.capabilities.buttons ? buttons : [],
      },
      {
        agent: agent.name,
        dlp: this.d.dlpFor(msg.conversation.kind, role.name, membership?.defaultRole),
        recipient:
          msg.conversation.kind === 'dm'
            ? msg.from.principal
            : `${conn.name}:${msg.conversation.kind}/${msg.conversation.id}`,
      },
    );
  }

  private async plainReply(conn: ChannelConn, msg: InboundMsg, markdown: string): Promise<void> {
    const ownerish = this.d.ownerPrincipals().includes(normalizePrincipal(msg.from.principal));
    await this.d.sendOutbound(
      conn,
      {
        conversation: { kind: msg.conversation.kind, id: msg.conversation.id },
        threadId: msg.threadId,
        replyToId: msg.id,
        markdown,
      },
      {
        agent: '(daemon)',
        dlp: ownerish && msg.conversation.kind === 'dm' ? 'warn' : 'redact',
        recipient: msg.from.principal,
      },
    );
  }

  // ───────────────────────────── /pair (§5 step 5) ─────────────────────────────

  private async pair(conn: ChannelConn, msg: InboundMsg, code: string): Promise<void> {
    const d = this.d;
    const who = normalizePrincipal(msg.from.principal);
    const now = d.now();
    const fails = (this.pairFails.get(who) ?? []).filter((t) => now - t < PAIR_FAIL_WINDOW_MS);
    if (fails.length >= PAIR_FAIL_LIMIT) {
      d.audit({
        type: 'pairing.locked',
        severity: 'security',
        summary: `Pairing attempt from ${msg.from.principal} ignored: too many failures`,
        actor: msg.from.principal,
        data: { channel: conn.name },
      });
      return;
    }
    const res = d.store.pairingCodes.consume(code, 'channel-pair');
    const okChannel =
      res.ok && res.record.data.channel === (d.channels.binding(conn.name)?.channel ?? conn.name);
    if (!res.ok || !okChannel) {
      fails.push(now);
      this.pairFails.set(who, fails);
      d.audit({
        type: 'pairing.failed',
        severity: 'security',
        summary: `Failed pairing attempt from ${msg.from.principal} on ${conn.name} (${res.ok ? 'wrong channel' : res.reason})`,
        actor: msg.from.principal,
        data: { channel: conn.name, reason: res.ok ? 'wrong-channel' : res.reason },
      });
      if (msg.conversation.kind === 'dm')
        await this.plainReply(conn, msg, '⚠️ That pairing code is invalid or expired.');
      return;
    }
    this.pairFails.delete(who);
    d.updateGlobal((c) => {
      const owners = c.owners.some((o) => normalizePrincipal(o) === who)
        ? c.owners
        : [...c.owners, msg.from.principal];
      const people = { ...c.people };
      const list = people.owner ?? [];
      if (!list.some((p) => normalizePrincipal(p) === who)) people.owner = [...list, msg.from.principal];
      return { ...c, owners, people };
    });
    if (msg.conversation.kind === 'dm') d.rememberDm(msg.from.principal, conn.name, msg.conversation.id);
    d.refreshControlAllowlist();
    d.channels.recordPairing(d.channels.binding(conn.name)?.channel ?? conn.name, {
      principal: msg.from.principal,
      ...(msg.from.displayName ? { displayName: msg.from.displayName } : {}),
    });
    d.audit({
      type: 'pairing.success',
      severity: 'security',
      summary: `Paired ${msg.from.principal} on ${conn.name} as owner`,
      actor: msg.from.principal,
      data: { channel: conn.name },
    });
    await this.plainReply(
      conn,
      msg,
      `✅ Paired. ${msg.from.displayName ?? msg.from.principal} is now an owner of this beamhop.`,
    );
  }

  // ───────────────────────────── /approve, /deny ─────────────────────────────

  private async approveCommand(
    conn: ChannelConn,
    msg: InboundMsg,
    allow: boolean,
    id: string,
  ): Promise<void> {
    try {
      const a = await this.d.approvals.decideFromChannel(id, msg.from.principal, allow);
      await this.plainReply(conn, msg, `${allow ? '✅ Approved' : '🚫 Denied'}: ${a.title} (\`${a.id}\`)`);
    } catch (e) {
      if (msg.conversation.kind === 'dm' || msg.mentionsAgent)
        await this.plainReply(conn, msg, `⚠️ ${errMsg(e)}`);
    }
  }

  /**
   * Button presses (Telegram/Slack/Discord). The presser is authenticated by the platform but the
   * button id is not (Telegram `callback_data` can be forged, review wave B R-B2): it is parsed
   * strictly and authorized exactly like the equivalent command.
   */
  async handleButton(conn: ChannelConn, press: ButtonPress): Promise<void> {
    if (this.d.isPanic()) return;
    const m = /^(approve|deny|details):([A-Za-z0-9_-]{1,80})$/.exec(press.buttonId);
    if (!m) {
      this.d.log.debug('ignoring unknown button', { channel: conn.name });
      return;
    }
    const action = m[1] as 'approve' | 'deny' | 'details';
    const id = m[2] as string;
    const reply = async (text: string) => {
      const dm = this.d.store.kv.get<{ channel: string; conversationId: string }>(
        'dm',
        normalizePrincipal(press.principal),
      );
      const convId = press.conversationId || dm?.conversationId;
      if (!convId) return;
      await conn
        .send({
          conversation: { kind: dm?.conversationId === convId ? 'dm' : 'group', id: convId },
          markdown: text,
        })
        .catch(() => {});
    };
    if (action === 'approve' || action === 'deny') {
      try {
        const a = await this.d.approvals.decideFromChannel(id, press.principal, action === 'approve');
        await reply(
          `${action === 'approve' ? '✅ Approved' : '🚫 Denied'}: ${a.title} — undo within ${Math.round(this.d.approvals.undoMs / 1000)} s in the PWA`,
        );
      } catch (e) {
        await reply(`⚠️ ${errMsg(e)}`);
      }
      return;
    }
    if (action === 'details') {
      // Like `/details`, plus: the session id comes from the button, so only an approver of that
      // agent (who was sent the card) may read another conversation's session.
      const s = this.d.sessions.live(id);
      if (!s) return;
      let agent: AgentConfig;
      try {
        agent = this.d.agent(s.agent);
      } catch {
        return;
      }
      const role = resolveRole({ principal: press.principal, agent, global: this.d.authzGlobal() });
      const def = role ? this.d.roleDef(role) : null;
      const allowed = authorizeCommand(def, { name: 'details', args: [] }).allowed && !!def?.canApprove;
      const approver = this.d.approvals.approvers(agent).includes(normalizePrincipal(press.principal));
      if (allowed && approver) await reply(this.d.sessions.detailsText(id));
    }
  }

  // ───────────────────────────── kick-to-revoke (§7A) ─────────────────────────────

  handleRemoved(conn: ChannelConn, conversationId: string): void {
    const d = this.d;
    const at = new Date(d.now()).toISOString();
    const bound = d.channels.binding(conn.name);
    const base = bound?.channel ?? conn.name;
    for (const agent of d.config.agents.list()) {
      if (bound && agent.name !== bound.agent) continue;
      let changed = false;
      const memberships = agent.memberships.map((m) => {
        const t = normTarget(m.target);
        const prefix = normTarget(`${base}:`);
        if (!t.startsWith(prefix) || m.revokedAt) return m;
        const slash = m.target.indexOf('/');
        if (slash >= 0 && m.target.slice(slash + 1) === conversationId) {
          changed = true;
          return { ...m, revokedAt: at };
        }
        return m;
      });
      // A wildcard group/channel membership: add an explicit revoked entry for this conversation.
      for (const kind of ['group', 'channel'] as const) {
        const wild = agent.memberships.find(
          (m) => !m.revokedAt && normTarget(m.target) === normTarget(`${base}:${kind}`),
        );
        if (wild && !memberships.some((m) => m.target === conversationTarget(base, kind, conversationId))) {
          memberships.push({
            ...wild,
            target: conversationTarget(base, kind, conversationId),
            revokedAt: at,
          });
          changed = true;
        }
      }
      if (!changed) continue;
      d.config.agents.save({ ...agent, memberships });
      d.audit({
        type: 'membership.revoked',
        severity: 'security',
        summary: `${agent.name} was removed from ${conn.name}:${conversationId}; membership revoked (no auto-rejoin)`,
        actor: `${conn.name}:platform`,
        agent: agent.name,
        data: { channel: conn.name, conversation: conversationId },
      });
      void d.sessions.endConversation(agent.name, conn.name, conversationId);
      d.emitAgent(agent.name);
    }
  }

  // ───────────────────────────── in-channel commands (§6A.7) ─────────────────────────────

  private async command(
    conn: ChannelConn,
    msg: InboundMsg,
    agent: AgentConfig,
    membership: Membership,
    role: RoleDef,
    cmd: Command,
  ): Promise<void> {
    const d = this.d;
    const say = (t: string, buttons: Parameters<Router['reply']>[6] = []) =>
      this.reply(conn, msg, agent, role, membership, t, buttons);
    const auth = authorizeCommand(role, cmd);
    if (!auth.allowed) {
      await say(`⛔ ${auth.reason}`);
      return;
    }
    const key = {
      agent: agent.name,
      channel: conn.name,
      conversationId: msg.conversation.id,
      threadId: msg.threadId,
    };
    const live = d.sessions.findForThread(key);
    switch (cmd.name) {
      case 'help':
        return say(helpText(role));
      case 'new': {
        await d.sessions.endThread(key, 'new session requested');
        return say('🆕 Started a new session. The next message begins fresh.');
      }
      case 'stop': {
        const stopped = await d.sessions.stopThread(key);
        return say(stopped ? '⏹ Stopped.' : 'Nothing is running.');
      }
      case 'status': {
        const view = d.agentView(agent);
        const lines = [
          `*${agent.displayName ?? agent.name}* — ${view.status} · harness \`${live?.overrides.harness ?? agent.harness}\` · model \`${live?.overrides.model ?? agent.model}\``,
          live
            ? `Session \`${live.id}\`: ${live.record().status}${live.overrides.mode ? ` · mode ${live.overrides.mode}` : ''}${live.queue.length ? ` · ${live.queue.length} queued` : ''}`
            : 'No active session in this thread.',
          `Active sessions: ${view.activeSessions}/${agent.concurrency.maxSessions} · your role: ${role.name}`,
        ];
        return say(lines.join('\n'));
      }
      case 'details': {
        if (!live) return say('No session in this thread yet.');
        return say(d.sessions.detailsText(live.id));
      }
      case 'resume': {
        const r = d.sessions.resumeThread(key);
        return say(r ? `↩️ Resumed session \`${r}\`.` : 'No earlier session to resume in this thread.');
      }
      case 'model': {
        if (!cmd.model) return say(`Model: \`${live?.overrides.model ?? agent.model}\``);
        d.sessions.setOverride(key, { model: cmd.model }, agent);
        return say(`Model set to \`${cmd.model}\` for this session.`);
      }
      case 'harness': {
        if (!cmd.harness) {
          const available = [...d.registry.harnesses.keys()].join(', ') || 'none installed';
          return say(`Harness: \`${live?.overrides.harness ?? agent.harness}\` (available: ${available})`);
        }
        if (!d.registry.harness(cmd.harness)) return say(`⚠️ Harness \`${cmd.harness}\` is not installed.`);
        d.sessions.setOverride(key, { harness: cmd.harness }, agent);
        return say(`Harness set to \`${cmd.harness}\` for this session.`);
      }
      case 'mode': {
        if (!cmd.mode) return say(`Mode: ${live?.overrides.mode ?? role.permissionMode}`);
        d.sessions.setOverride(key, { mode: cmd.mode }, agent);
        return say(`Mode set to ${cmd.mode} for this session.`);
      }
      case 'usage': {
        const today = d.store.usage.totals({ agent: agent.name });
        const lim = agent.budgets;
        const parts = [
          `Today: ${today.tokens.toLocaleString('en-US')} tokens · $${today.usd.toFixed(2)}${lim.dailyUsd !== undefined ? ` of $${lim.dailyUsd}` : ''} · ${today.minutes.toFixed(1)} min`,
        ];
        if (lim.dailyUsd !== undefined)
          parts.push(`Left: $${Math.max(0, lim.dailyUsd - today.usd).toFixed(2)}`);
        if (lim.dailyTokens !== undefined)
          parts.push(`Tokens left: ${Math.max(0, lim.dailyTokens - today.tokens)}`);
        if (live) {
          const u = live.record().usage;
          parts.push(`This session: ${u.inputTokens + u.outputTokens} tokens · $${u.usd.toFixed(2)}`);
        }
        return say(parts.join('\n'));
      }
      default:
        return say(`Unknown command. ${helpShort}`);
    }
  }
}

const helpShort = 'Send /help for the list of commands.';
