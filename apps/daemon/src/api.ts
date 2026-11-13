/** API handlers for every method in `@beamhop/core` api.ts. */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  allRoleDefs,
  createPairingCode,
  effectiveRoleDef,
  normalizePrincipal,
  type RoleOverride,
} from '@beamhop/authz';
import {
  AgentConfig,
  type AgentView,
  BeamhopError,
  type ChannelConfig,
  type DoctorCheck,
  expandHome,
  type HarnessView,
  type MethodName,
  methods,
  newId,
  PRESETS,
  type Result,
  type SandboxPolicy,
  type ScheduleConfig,
} from '@beamhop/core';
import { probeSandbox, compilePolicy } from '@beamhop/sandbox';
import { channelSecretName } from './channels.ts';
import { type Daemon, LOCAL_OWNER, VERSION } from './daemon.ts';
import { isInternalSecret } from './home.ts';
import { type CallContext, createDispatcher, type Handler, type Handlers } from './rpc-server.ts';
import { webhookSecretName } from './schedules.ts';
import { stripRecord } from './sessions.ts';
import { errMsg } from './util.ts';

const OK = { ok: true as const };

const deepMerge = (a: unknown, b: unknown): unknown => {
  if (Array.isArray(b) || typeof b !== 'object' || b === null) return b === undefined ? a : b;
  if (typeof a !== 'object' || a === null || Array.isArray(a)) return b;
  const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
  for (const [k, v] of Object.entries(b as Record<string, unknown>)) out[k] = deepMerge(out[k], v);
  return out;
};

const INSTRUCTION_FILES: { file: string; harness: string }[] = [
  { file: 'CLAUDE.md', harness: 'claude' },
  { file: '.claude/CLAUDE.md', harness: 'claude' },
  { file: 'AGENTS.md', harness: 'codex' },
  { file: 'GEMINI.md', harness: 'gemini' },
  { file: '.codex/config.toml', harness: 'codex' },
  { file: '.pi/SYSTEM.md', harness: 'pi' },
  { file: 'opencode.json', harness: 'opencode' },
];

export class ApiHandlers {
  private dispatcher: ReturnType<typeof createDispatcher> | undefined;
  private customHarnesses = new Map<string, HarnessView>();

  constructor(private readonly d: Daemon) {}

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
      if (this.d.store.devices.list().some((dev) => dev.pubkey === npub)) return LOCAL_OWNER;
    }
    return ctx.caller;
  }

  private agentView(name: string): AgentView {
    return this.d.agentView(this.d.agent(name));
  }

  private saveAgent(input: unknown): AgentView {
    const a = this.d.config.agents.save(input);
    this.d.emitAgent(a.name);
    return this.d.agentView(a);
  }

  private harnessViews(): HarnessView[] {
    const list = this.d.store.kv.get<HarnessView[]>('harness', 'scan') ?? [];
    const ids = new Set(list.map((h) => h.id));
    for (const h of this.customHarnesses.values()) if (!ids.has(h.id)) list.push(h);
    for (const id of this.d.registry.harnesses.keys())
      if (!list.some((h) => h.id === id))
        list.push({ id, displayName: this.d.registry.harness(id)?.displayName ?? id, command: id, status: 'ready', protocol: 'acp' });
    return list;
  }

  private async scan(): Promise<HarnessView[]> {
    const d = this.d;
    const out: HarnessView[] = [];
    const add = (h: { id: string; displayName: string; command: string; status: HarnessView['status']; protocol: string; version?: string; path?: string; message?: string; install?: HarnessView['install'] }) => {
      if (out.some((x) => x.id === h.id)) return;
      const v: HarnessView = { id: h.id, displayName: h.displayName, command: h.command, status: h.status, protocol: h.protocol };
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
        else add({ id: p.id, displayName: p.displayName, command: p.id, status: 'not-installed', protocol: 'acp' });
      } catch (e) {
        add({ id: p.id, displayName: p.displayName, command: p.id, status: 'error', protocol: 'acp', message: errMsg(e) });
      }
    }
    for (const h of this.customHarnesses.values()) add(h);
    d.store.kv.set('harness', 'scan', out);
    return out;
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

  private effectivePolicy(name: string): { profile: string; effective: SandboxPolicy } {
    const a = this.d.agent(name);
    return {
      profile: a.sandbox.profile,
      effective: compilePolicy(a.sandbox.profile, a.mounts, (a.sandbox.policy ?? {}) as never),
    };
  }

  handlers(): Handlers {
    const d = this.d;
    const h: { [M in MethodName]: Handler<M> } = {
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
        };
      },
      'system.doctor': async () => {
        const checks: DoctorCheck[] = [];
        try {
          checks.push(...(await probeSandbox()));
        } catch (e) {
          checks.push({ id: 'sandbox', title: 'Sandbox', status: 'fail', message: errMsg(e) });
        }
        const hs = await this.scan();
        checks.push({
          id: 'harness.any',
          title: 'Harnesses',
          status: hs.some((x) => x.status === 'ready') ? 'ok' : 'warn',
          message: hs.length ? hs.map((x) => `${x.id}: ${x.status}`).join(', ') : 'no harness adapters installed',
          ...(hs.some((x) => x.status === 'ready') ? {} : { fix: 'Install a harness (e.g. `npm i -g @anthropic-ai/claude-code`) and run `beamhop harness scan`.' }),
        });
        for (const c of d.config.channels.list()) {
          const v = d.channels.view(c);
          checks.push({
            id: `channel.${c.name}`,
            title: `Channel ${c.name} (${c.provider})`,
            status: v.status === 'connected' ? 'ok' : v.status === 'disabled' ? 'skip' : d.isPanic() ? 'warn' : 'fail',
            message: v.error ?? v.status,
          });
        }
        const secretsBackend = d.secrets.backend;
        checks.push({
          id: 'secrets.backend',
          title: 'Secret storage',
          status: secretsBackend === 'memory' ? 'warn' : 'ok',
          message: `backend: ${secretsBackend}`,
          ...(secretsBackend === 'memory' ? { fix: 'Install a keychain (libsecret) or set BEAMHOP_VAULT_PASSPHRASE.' } : {}),
        });
        if (d.isPanic()) checks.push({ id: 'panic', title: 'Panic', status: 'warn', message: 'panic mode is active', fix: 'beamhop resume' });
        return { checks };
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
          throw new BeamhopError('invalid_input', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
        if (d.config.agents.has(parsed.data.name)) throw new BeamhopError('conflict', `agent ${parsed.data.name} exists`);
        const v = this.saveAgent(parsed.data);
        d.audit({ type: 'agent.created', severity: 'info', summary: `Agent ${parsed.data.name} created${preset ? ` from ${preset}` : ''}`, actor: this.principal(ctx), agent: parsed.data.name });
        return v;
      },
      'agent.update': async ({ name, patch }, ctx) => {
        const cur = d.agent(name);
        if (patch.name !== undefined && patch.name !== name) throw new BeamhopError('invalid_input', 'use agent.clone to rename');
        const next = deepMerge(cur, patch);
        const v = this.saveAgent(next);
        const sensitive = ['sandbox', 'grants', 'mounts', 'routes', 'public', 'memberships', 'mesh'].filter((k) => k in patch);
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
        d.agent(name);
        for (const s of d.sessions.all()) if (s.agent === name) await d.sessions.end(s, 'agent deleted', { hard: true });
        d.config.agents.delete(name);
        for (const sc of d.config.schedules.list().filter((s) => s.agent === name)) {
          d.scheduler.disarm(sc.id);
          d.config.schedules.delete(sc.id);
        }
        d.audit({ type: 'agent.deleted', severity: 'warn', summary: `Agent ${name} deleted`, actor: this.principal(ctx), agent: name });
        return OK;
      },
      'agent.start': async ({ name }, ctx) => {
        d.assertNotPanic();
        d.agent(name);
        d.store.kv.delete('agent-stopped', name);
        d.audit({ type: 'agent.start', severity: 'info', summary: `Agent ${name} started`, actor: this.principal(ctx), agent: name });
        d.emitAgent(name);
        return this.agentView(name);
      },
      'agent.stop': async ({ name, hard }, ctx) => {
        d.agent(name);
        d.store.kv.set('agent-stopped', name, true);
        for (const s of d.sessions.all()) if (s.agent === name) await d.sessions.end(s, hard ? 'agent hard-stopped' : 'agent stopped', { hard });
        d.audit({ type: 'agent.stop', severity: hard ? 'security' : 'info', summary: `Agent ${name} stopped${hard ? ' (hard)' : ''}`, actor: this.principal(ctx), agent: name });
        d.emitAgent(name);
        return this.agentView(name);
      },
      'agent.clone': async ({ name, newName }, ctx) => {
        const cur = d.agent(name);
        if (d.config.agents.has(newName)) throw new BeamhopError('conflict', `agent ${newName} exists`);
        // A clone gets its own identity and no memberships (it must be joined explicitly).
        const v = this.saveAgent({ ...cur, name: newName, identity: {}, memberships: [], displayName: cur.displayName ? `${cur.displayName} (copy)` : undefined });
        d.audit({ type: 'agent.cloned', severity: 'info', summary: `Agent ${name} cloned to ${newName}`, actor: this.principal(ctx), agent: newName });
        return v;
      },
      'agent.presets': async () => ({
        presets: PRESETS.map((p) => ({ id: p.id, title: p.title, description: p.description, config: p.config as Record<string, unknown> })),
      }),
      'agent.instructions': async ({ name }) => {
        const a = d.agent(name);
        const files: { path: string; harness: string; content: string }[] = [];
        for (const m of a.mounts) {
          const root = expandHome(m.path);
          for (const f of INSTRUCTION_FILES) {
            const p = join(root, f.file);
            try {
              if (existsSync(p) && statSync(p).isFile() && statSync(p).size < 256 * 1024)
                files.push({ path: p, harness: f.harness, content: readFileSync(p, 'utf8') });
            } catch {
              /* unreadable */
            }
          }
        }
        return { files };
      },

      // ── harnesses ──
      'harness.scan': async () => ({ harnesses: await this.scan() }),
      'harness.list': async () => ({ harnesses: this.harnessViews() }),
      'harness.add': async ({ id, command, args }, ctx) => {
        const hid = id.startsWith('acp:') ? id : `acp:${id}`;
        const factory = d.registry.acpFactory;
        let view: HarnessView = { id: hid, displayName: id, command: [command, ...args].join(' '), status: 'error', protocol: 'acp', message: 'ACP adapter (@beamhop/harness-acp) is not installed' };
        if (factory) {
          const plugin = factory({ id: hid, command, args });
          d.registry.addHarness(plugin);
          try {
            const det = await plugin.detect();
            view = det
              ? { id: hid, displayName: det.displayName, command: det.command, status: det.status, protocol: det.protocol, ...(det.version ? { version: det.version } : {}), ...(det.message ? { message: det.message } : {}) }
              : { ...view, status: 'error', message: 'ACP initialize handshake failed' };
          } catch (e) {
            view = { ...view, message: errMsg(e) };
          }
        }
        this.customHarnesses.set(hid, view);
        d.store.kv.set('harness', 'custom', [...this.customHarnesses.values()]);
        d.store.kv.set('harness-defs', hid, { command, args });
        d.audit({ type: 'harness.added', severity: 'security', summary: `Custom ACP harness ${hid} added (${command})`, actor: this.principal(ctx) });
        return view;
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
          if (!/^[A-Za-z0-9_-]{1,64}$/.test(field)) throw new BeamhopError('invalid_input', `invalid secret field ${field}`);
          const ref = channelSecretName(name, field);
          await d.secrets.set(ref, value);
          refs.push(ref);
        }
        d.invalidateSecretCache();
        const cfg: ChannelConfig = d.config.channels.save({ name, provider, settings: values, secretRefs: refs, enabled: true, createdAt: new Date(d.now()).toISOString() });
        d.audit({ type: 'channel.added', severity: 'security', summary: `Channel ${name} (${provider}) added`, actor: this.principal(ctx) });
        if (!d.isPanic()) await d.channels.connect(cfg).catch(() => {});
        return d.channels.view(cfg);
      },
      'channel.remove': async ({ name }, ctx) => {
        const cfg = d.config.channels.require(name);
        await d.channels.disconnect(name);
        for (const ref of cfg.secretRefs) await d.secrets.delete(ref);
        d.invalidateSecretCache();
        d.config.channels.delete(name);
        d.audit({ type: 'channel.removed', severity: 'security', summary: `Channel ${name} removed`, actor: this.principal(ctx) });
        return OK;
      },
      'channel.pair': async ({ name }, ctx) => {
        const cfg = d.config.channels.require(name);
        const code = createPairingCode({ now: d.now() });
        d.store.pairingCodes.put({ code: code.code, purpose: 'channel-pair', expiresAt: code.expiresAt, data: { channel: name } });
        d.audit({ type: 'pairing.started', severity: 'security', summary: `Pairing code issued for channel ${name}`, actor: this.principal(ctx) });
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
        const memberships = [...a.memberships.filter((x) => x.target !== m.target), m];
        const v = this.saveAgent({ ...a, memberships });
        d.audit({ type: 'membership.join', severity: 'security', summary: `${agent} joined ${m.target} (default role ${m.defaultRole})`, actor: this.principal(ctx), agent, data: { target: m.target } });
        return v;
      },
      'membership.leave': async ({ agent, target }, ctx) => {
        const a = d.agent(agent);
        const v = this.saveAgent({ ...a, memberships: a.memberships.filter((x) => x.target !== target) });
        d.audit({ type: 'membership.leave', severity: 'info', summary: `${agent} left ${target}`, actor: this.principal(ctx), agent });
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
            promptFor: () => `[beamhop] from=local owner via=${ctx.transport} (role=owner) time=${new Date(d.now()).toISOString()}\n\n${text}`,
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
            promptFor: () => `[beamhop] from=local owner via=${ctx.transport} (role=owner) time=${new Date(d.now()).toISOString()}\n\n${text}`,
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
      'approval.list': async ({ status }) => ({ approvals: d.store.approvals.list({ status }) }),
      'approval.decide': async ({ id, allow, always, grantRole }, ctx) =>
        d.approvals.decide(id, this.principal(ctx), allow, { always, ...(grantRole ? { grantRole } : {}) }),
      'approval.undo': async ({ id }, ctx) => d.approvals.undo(id, this.principal(ctx)),

      // ── roles & owners ──
      'role.list': async () => {
        const g = d.global();
        return { roles: allRoleDefs(g.roles as RoleOverride[]), grants: g.grants };
      },
      'role.grant': async ({ principal, role, agent }, ctx) => {
        if (!effectiveRoleDef(role, d.global().roles as RoleOverride[])) throw new BeamhopError('invalid_input', `unknown role ${role}`);
        if (role === 'owner') throw new BeamhopError('invalid_input', 'use owner.add to add owners');
        if (agent) d.config.agents.update(agent, (a) => ({ ...a, grants: { ...a.grants, [principal]: role } }));
        else d.updateGlobal((c) => ({ ...c, grants: { ...c.grants, [principal]: role } }));
        d.audit({ type: 'role.grant', severity: 'security', summary: `Granted ${role} to ${principal}${agent ? ` on ${agent}` : ' globally'}`, actor: this.principal(ctx), ...(agent ? { agent } : {}), data: { principal, role } });
        if (agent) d.emitAgent(agent);
        return OK;
      },
      'role.revoke': async ({ principal, agent }, ctx) => {
        const n = normalizePrincipal(principal);
        const strip = (g: Record<string, string>) => Object.fromEntries(Object.entries(g).filter(([k]) => normalizePrincipal(k) !== n && k !== principal));
        if (agent) d.config.agents.update(agent, (a) => ({ ...a, grants: strip(a.grants) }));
        else d.updateGlobal((c) => ({ ...c, grants: strip(c.grants) }));
        d.audit({ type: 'role.revoke', severity: 'security', summary: `Revoked role of ${principal}${agent ? ` on ${agent}` : ' globally'}`, actor: this.principal(ctx), ...(agent ? { agent } : {}), data: { principal } });
        return OK;
      },
      'principal.link': async ({ person, principal }, ctx) => {
        d.updateGlobal((c) => {
          const list = c.people[person] ?? [];
          if (list.some((p) => normalizePrincipal(p) === normalizePrincipal(principal))) return c;
          return { ...c, people: { ...c.people, [person]: [...list, principal] } };
        });
        d.audit({ type: 'principal.link', severity: 'security', summary: `Linked ${principal} to ${person}`, actor: this.principal(ctx), data: { person, principal } });
        return OK;
      },
      'owner.add': async ({ principal }, ctx) => {
        d.ensureOwner(principal);
        if (principal.startsWith('nostr:') && !d.global().nostr.ownerNpub)
          d.updateGlobal((c) => ({ ...c, nostr: { ...c.nostr, ownerNpub: principal.slice(6) } }));
        d.refreshControlAllowlist();
        d.audit({ type: 'owner.add', severity: 'security', summary: `Added owner ${principal}`, actor: this.principal(ctx), data: { principal } });
        return OK;
      },
      'owner.remove': async ({ principal }, ctx) => {
        const g = d.global();
        const n = normalizePrincipal(principal);
        const rest = g.owners.filter((o) => normalizePrincipal(o) !== n);
        if (rest.length === g.owners.length) throw new BeamhopError('not_found', `${principal} is not an owner`);
        if (rest.length === 0) throw new BeamhopError('conflict', 'at least one owner must remain');
        d.updateGlobal((c) => ({
          ...c,
          owners: rest,
          people: Object.fromEntries(Object.entries(c.people).map(([k, v]) => [k, k === 'owner' ? v.filter((p) => normalizePrincipal(p) !== n) : v])),
          nostr: c.nostr.ownerNpub && n === normalizePrincipal(`nostr:${c.nostr.ownerNpub}`) ? { ...c.nostr, ownerNpub: undefined } : c.nostr,
        }));
        d.refreshControlAllowlist();
        d.audit({ type: 'owner.remove', severity: 'security', summary: `Removed owner ${principal}`, actor: this.principal(ctx), data: { principal } });
        return OK;
      },

      // ── policy ──
      'policy.get': async ({ name }) => this.effectivePolicy(name),
      'policy.set': async ({ name, profile, policy }, ctx) => {
        const prof = profile as 'strict' | 'workspace' | 'custom';
        if (!['strict', 'workspace', 'custom'].includes(prof)) throw new BeamhopError('invalid_input', `unknown profile ${profile}`);
        d.config.agents.update(name, (a) => ({ ...a, sandbox: { profile: prof, ...(policy ? { policy } : a.sandbox.policy ? { policy: a.sandbox.policy } : {}) } }));
        d.audit({ type: 'policy.set', severity: 'security', summary: `Sandbox policy of ${name} set to ${profile}`, actor: this.principal(ctx), agent: name });
        d.emitAgent(name);
        return OK;
      },
      'policy.suggestions': async ({ name }) => ({ suggestions: d.store.policySuggestions.list(name ? { agent: name } : {}) }),
      'policy.applySuggestion': async ({ id, accept }, ctx) => {
        const s = d.store.policySuggestions.get(id);
        if (!s) throw new BeamhopError('not_found', `suggestion ${id} not found`);
        d.store.policySuggestions.resolve(id, accept);
        if (accept) {
          d.config.agents.update(s.agent, (a) => {
            const pol = (a.sandbox.policy ?? {}) as Record<string, Record<string, string[]>>;
            const [sect, key] = s.kind === 'net.allow' ? ['net', 'allow'] : s.kind === 'fs.read' ? ['fs', 'read'] : ['fs', 'write'];
            const cur = pol[sect!] ?? {};
            const list = [...new Set([...(cur[key!] ?? []), s.value])];
            return { ...a, sandbox: { ...a.sandbox, policy: { ...pol, [sect!]: { ...cur, [key!]: list } } as never } };
          });
          d.emitAgent(s.agent);
        }
        d.audit({ type: 'policy.suggestion', severity: 'security', summary: `${accept ? 'Accepted' : 'Rejected'} sandbox suggestion ${s.kind} ${s.value} for ${s.agent}`, actor: this.principal(ctx), agent: s.agent });
        return OK;
      },

      // ── secrets (names only) ──
      'secret.list': async () => ({
        secrets: (await d.secrets.list()).filter((s) => !isInternalSecret(s.name)),
        backend: d.secrets.backend,
      }),
      'secret.set': async ({ name, value }, ctx) => {
        if (isInternalSecret(name)) throw new BeamhopError('forbidden', 'reserved secret name');
        await d.secrets.set(name, value);
        d.invalidateSecretCache();
        d.audit({ type: 'secret.set', severity: 'security', summary: `Secret ${name} set`, actor: this.principal(ctx), data: { name } });
        return OK;
      },
      'secret.delete': async ({ name }, ctx) => {
        if (isInternalSecret(name)) throw new BeamhopError('forbidden', 'reserved secret name');
        await d.secrets.delete(name);
        d.invalidateSecretCache();
        d.audit({ type: 'secret.delete', severity: 'security', summary: `Secret ${name} deleted`, actor: this.principal(ctx), data: { name } });
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
        d.audit({ type: 'schedule.added', severity: 'info', summary: `Schedule ${id} (${s.kind}) added for ${s.agent}`, actor: this.principal(ctx), agent: s.agent });
        return { ...s, ...(webhook ? { webhook } : {}) };
      },
      'schedule.update': async ({ id, patch }, ctx) => {
        const cur = d.config.schedules.require(id);
        const next = { ...cur, ...patch, id } as ScheduleConfig;
        d.scheduler.validate(next);
        const s = d.config.schedules.save(next);
        d.scheduler.rearm(id);
        d.audit({ type: 'schedule.updated', severity: 'info', summary: `Schedule ${id} updated`, actor: this.principal(ctx), agent: s.agent });
        return s;
      },
      'schedule.remove': async ({ id }, ctx) => {
        const s = d.config.schedules.require(id);
        d.scheduler.disarm(id);
        d.config.schedules.delete(id);
        await d.secrets.delete(webhookSecretName(id));
        d.audit({ type: 'schedule.removed', severity: 'info', summary: `Schedule ${id} removed`, actor: this.principal(ctx), agent: s.agent });
        return OK;
      },
      'schedule.run': async ({ id }) => {
        d.assertNotPanic();
        d.config.schedules.require(id);
        void d.scheduler.run(id).catch((e) => d.log.warn('schedule run failed', { id, error: errMsg(e) }));
        return OK;
      },

      // ── deploy ──
      'deploy.providers': async () => {
        const out = [];
        for (const dep of d.registry.deployers.values())
          out.push({ id: dep.id, displayName: dep.displayName, kind: dep.kind, configured: (await d.secrets.get(`deploy.${dep.id}.token`)) !== undefined });
        return { providers: out };
      },
      'deploy.options': async ({ provider }) => {
        const dep = this.requireDeployer(provider);
        return { sizes: await dep.sizes(), regions: await dep.regions() };
      },
      'deploy.plan': async (p) => {
        const dep = this.requireDeployer(p.provider);
        const a = d.agent(p.agent);
        return dep.plan({ ...p, harnesses: [a.harness] });
      },
      'deploy.apply': async (p, ctx) => {
        d.assertNotPanic();
        const dep = this.requireDeployer(p.provider);
        const a = d.agent(p.agent);
        const res = await dep.apply({ ...p, harnesses: [a.harness] });
        const plan = await dep.plan({ ...p, harnesses: [a.harness] }).catch(() => undefined);
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
        d.audit({ type: 'deploy.apply', severity: 'security', summary: `Deployed ${p.agent} to ${p.provider} (${p.mode})`, actor: this.principal(ctx), agent: p.agent, data: { id: res.id } });
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
        d.audit({ type: 'deploy.destroy', severity: 'security', summary: `Destroyed deployment ${id}`, actor: this.principal(ctx), agent: r.agent });
        return OK;
      },

      // ── audit & usage ──
      'audit.query': async ({ agent, severity, limit, before }) => ({
        events: d.store.audit.query({ ...(agent ? { agent } : {}), ...(severity ? { severity } : {}), limit, ...(before ? { before } : {}) }),
      }),
      'usage.query': async ({ days, agent }) => ({ rows: d.store.usage.query({ days, ...(agent ? { agent } : {}) }) }),

      // ── devices ──
      'device.list': async () => ({ devices: d.store.devices.list() }),
      'device.pairStart': async ({ name }, ctx) => {
        const code = createPairingCode({ now: d.now() });
        d.store.pairingCodes.put({ code: code.code, purpose: 'device', expiresAt: code.expiresAt, data: { name } });
        const q = new URLSearchParams({ code: code.code, name });
        const control = d.control as unknown as { npub?: string } | undefined;
        if (control?.npub) q.set('daemon', control.npub);
        if (d.api) q.set('url', d.api.url);
        d.audit({ type: 'device.pairStart', severity: 'security', summary: `Device pairing started (${name})`, actor: this.principal(ctx) });
        return { uri: `beamhop://pair?${q.toString()}`, code: code.code, expiresAt: code.expiresAt };
      },
      'device.pairComplete': async ({ code, pubkey, name }, ctx) => {
        const res = d.store.pairingCodes.consume(code, 'device');
        if (!res.ok) {
          d.audit({ type: 'pairing.failed', severity: 'security', summary: `Failed device pairing (${res.reason})`, actor: ctx.caller });
          throw new BeamhopError('unauthorized', `pairing code ${res.reason}`);
        }
        if (!/^(npub1[02-9ac-hj-np-z]{58}|[0-9a-f]{64})$/.test(pubkey)) throw new BeamhopError('invalid_input', 'pubkey must be an npub or 64-char hex key');
        const dev = d.store.devices.add({ name: name || String(res.record.data.name ?? 'device'), pubkey });
        d.refreshControlAllowlist();
        d.audit({ type: 'device.paired', severity: 'security', summary: `Paired device ${dev.name}`, actor: ctx.caller, data: { device: dev.id } });
        return dev;
      },
      'device.remove': async ({ id }, ctx) => {
        if (!d.store.devices.remove(id)) throw new BeamhopError('not_found', `device ${id} not found`);
        d.refreshControlAllowlist();
        d.audit({ type: 'device.removed', severity: 'security', summary: `Removed device ${id}`, actor: this.principal(ctx), data: { device: id } });
        return OK;
      },
      'device.pushSubscribe': async ({ id, subscription }) => {
        d.store.devices.setPush(id, subscription ?? null);
        return OK;
      },

      // ── identity ──
      'identity.get': async () => {
        const g = d.global();
        return {
          ...(g.nostr.ownerNpub ? { npub: g.nostr.ownerNpub } : {}),
          agents: d.config.agents.list().map((a) => ({
            name: a.name,
            ...(a.identity.npub ? { npub: a.identity.npub } : {}),
            ...(a.identity.nip05 ? { nip05: a.identity.nip05 } : {}),
          })),
        };
      },
      'identity.nip05': async ({ domain, names }) => {
        let mod: { buildNip05Json: (domain: string, names: Record<string, string>) => { body: string; snippets: Record<string, string> } };
        try {
          mod = (await import(/* @vite-ignore */ '@beamhop/channel-nostr')) as never;
        } catch {
          throw new BeamhopError('unavailable', 'NIP-05 needs the @beamhop/channel-nostr package');
        }
        const map: Record<string, string> = names ?? {};
        if (!names)
          for (const a of d.config.agents.list()) if (a.identity.npub) map[a.name] = a.identity.npub;
        if (!Object.keys(map).length) throw new BeamhopError('invalid_input', 'no agents with an npub; pass names');
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
        d.audit({ type: 'data.export', severity: 'security', summary: `Data exported${agent ? ` for ${agent}` : ''}`, actor: this.principal(ctx), ...(agent ? { agent } : {}) });
        return { path };
      },
      'data.purge': async ({ agent, before }, ctx) => {
        const r = d.store.purge({ ...(agent ? { agent } : {}), ...(before ? { before } : {}) });
        d.audit({ type: 'data.purge', severity: 'security', summary: `Purged ${r.deleted} records${agent ? ` for ${agent}` : ''}${before ? ` before ${before}` : ''}`, actor: this.principal(ctx), ...(agent ? { agent } : {}) });
        return { deleted: r.deleted };
      },
    };
    return h as Handlers;
  }
}

/** Every method name of the API contract (to assert coverage in tests). */
export const ALL_METHODS = Object.keys(methods) as MethodName[];
export type { Result };
