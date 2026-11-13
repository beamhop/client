/**
 * Nostr identities (§4): owner key, per-agent keys, public profile / attestation / NIP-89 card,
 * the default agent-keyed `nostr` channel, and the onboarding hello round trip (§9A step 6).
 */
import { normalizePrincipal } from '@beamhop/authz';
import { type AgentConfig, BeamhopError, type ChannelConn, type InboundMsg } from '@beamhop/core';
import { agentConnName, isAgentKeyed } from './channels.ts';
import type { Daemon } from './daemon.ts';
import { errMsg } from './util.ts';

type NostrMod = typeof import('@beamhop/channel-nostr');

/** Secret names. `beamhop.*` names are internal (hidden from secret.list, not settable via the API). */
export const OWNER_KEY_REF = 'beamhop.owner.nsec';
export const CONTROL_KEY_REF = 'beamhop.control.nsec';
export const agentKeyRef = (agent: string): string => `agent.${agent}.nsec`;
export const DEFAULT_NOSTR_CHANNEL = 'nostr';

let modP: Promise<NostrMod | undefined> | undefined;
/** The nostr package is optional at runtime (the daemon works with any subset of plugins). */
export const loadNostr = (): Promise<NostrMod | undefined> => {
  modP ??= import(/* @vite-ignore */ '@beamhop/channel-nostr').then(
    (m) => m as NostrMod,
    () => undefined,
  );
  return modP;
};

export const requireNostr = async (): Promise<NostrMod> => {
  const m = await loadNostr();
  if (!m) throw new BeamhopError('unavailable', 'Nostr identities need the @beamhop/channel-nostr package');
  return m;
};

interface NostrConnLike extends ChannelConn {
  pubkey: string;
  npub: string;
  publish(t: unknown, relays?: string[]): Promise<{ id: string; ok: string[]; failed: unknown[] }>;
  pool: { publish(ev: unknown, opts?: { relays?: string[] }): Promise<{ id: string; ok: string[] }> };
}

interface HelloState {
  to: string;
  from: string;
  id: string;
  sentAt: string;
  repliedAt?: string;
  replyFrom?: string;
  text?: string;
}

export class IdentityManager {
  constructor(private readonly d: Daemon) {}

  // ───────────────────────────── owner ─────────────────────────────

  ownerNpub(): string | undefined {
    return this.d.global().nostr.ownerNpub;
  }

  async ownerKeyHeld(): Promise<boolean> {
    const npub = this.ownerNpub();
    const nsec = await this.d.secrets.get(OWNER_KEY_REF);
    if (!npub || !nsec) return false;
    const m = await loadNostr();
    if (!m) return false;
    try {
      return m.npubEncode(m.pubkeyOf(m.decodeSecretKey(nsec))) === npub;
    } catch {
      return false;
    }
  }

  private setOwner(npub: string): void {
    this.d.updateGlobal((c) => {
      const principal = `nostr:${npub}`;
      const prev = c.nostr.ownerNpub ? normalizePrincipal(`nostr:${c.nostr.ownerNpub}`) : undefined;
      const owners = c.owners.filter((o) => !prev || normalizePrincipal(o) !== prev);
      if (!owners.some((o) => normalizePrincipal(o) === normalizePrincipal(principal)))
        owners.push(principal);
      const people = { ...c.people };
      const list = (people.owner ?? []).filter((p) => !prev || normalizePrincipal(p) !== prev);
      if (!list.some((p) => normalizePrincipal(p) === normalizePrincipal(principal))) list.unshift(principal);
      people.owner = list;
      return { ...c, owners, people, nostr: { ...c.nostr, ownerNpub: npub } };
    });
    this.d.refreshControlAllowlist();
  }

  async createOwner(replace: boolean): Promise<string> {
    const m = await requireNostr();
    const cur = this.ownerNpub();
    if (cur && !replace)
      throw new BeamhopError('conflict', `an owner key is already set (${cur}); pass replace to change it`);
    const k = m.generateAgentKey();
    await this.d.secrets.set(OWNER_KEY_REF, k.nsec);
    this.d.store.kv.delete('identity', 'owner-exported');
    this.d.invalidateSecretCache();
    this.setOwner(k.npub);
    this.republishAll();
    return k.npub;
  }

  async importOwner(npub: string, replace = false): Promise<string> {
    const m = await requireNostr();
    let hex: string;
    try {
      hex = m.decodePubkey(npub);
    } catch {
      throw new BeamhopError('invalid_input', 'expected an npub1… or 64-char hex public key');
    }
    const n = m.npubEncode(hex);
    // An agent's (or this daemon's) own key as owner would let that agent act as its owner.
    const agent = this.d.config.agents.list().find((a) => a.identity.npub === n);
    if (agent)
      throw new BeamhopError('invalid_input', `${n} is agent ${agent.name}'s own key, not an owner key`);
    if (this.d.control?.npub === n)
      throw new BeamhopError('invalid_input', `${n} is this beamhop's own control key, not an owner key`);
    // Same rule as createOwner: dropping a key only the daemon holds is not undoable.
    if (!replace && (await this.ownerKeyHeld()))
      throw new BeamhopError(
        'conflict',
        `this beamhop holds the current owner key (${this.ownerNpub()}); importing ${n} deletes it. Export it first if you need it, then pass replace to change it`,
      );
    // A key the daemon held for a previous owner is useless now; drop it.
    if (await this.d.secrets.get(OWNER_KEY_REF)) await this.d.secrets.delete(OWNER_KEY_REF);
    this.d.invalidateSecretCache();
    this.setOwner(n);
    this.republishAll();
    return n;
  }

  /** The owner nsec, revealed once (then only by creating a new key). */
  async exportOwner(): Promise<string> {
    if (!(await this.ownerKeyHeld()))
      throw new BeamhopError('not_found', 'this beamhop does not hold an owner key');
    if (this.d.store.kv.get<boolean>('identity', 'owner-exported'))
      throw new BeamhopError('forbidden', 'the owner key was already exported once');
    const nsec = await this.d.secrets.get(OWNER_KEY_REF);
    if (!nsec) throw new BeamhopError('not_found', 'owner key missing');
    this.d.store.kv.set('identity', 'owner-exported', true);
    return nsec;
  }

  // ───────────────────────────── agents ─────────────────────────────

  /**
   * Give a new agent its own Nostr key (§4: "each agent has its own keypair"). Agents created with
   * an explicit npub (key held elsewhere) or key ref are left alone.
   */
  async ensureAgentKey(cfg: AgentConfig): Promise<AgentConfig> {
    const m = await loadNostr();
    if (!m) return cfg;
    const id = cfg.identity;
    if (id.nostrKeyRef) {
      if (id.npub) return cfg;
      const nsec = await this.d.secrets.get(id.nostrKeyRef);
      if (!nsec) throw new BeamhopError('not_found', `secret ${id.nostrKeyRef} not found`);
      return { ...cfg, identity: { ...id, npub: m.npubEncode(m.pubkeyOf(m.decodeSecretKey(nsec))) } };
    }
    if (id.npub) return cfg;
    const k = m.generateAgentKey();
    const ref = agentKeyRef(cfg.name);
    await this.d.secrets.set(ref, k.nsec);
    this.d.invalidateSecretCache();
    return { ...cfg, identity: { ...id, nostrKeyRef: ref, npub: k.npub } };
  }

  async deleteAgentKey(cfg: AgentConfig): Promise<void> {
    if (cfg.identity.nostrKeyRef === agentKeyRef(cfg.name)) {
      await this.d.secrets.delete(agentKeyRef(cfg.name)).catch(() => {});
      this.d.invalidateSecretCache();
    }
    this.d.store.kv.delete('attested', cfg.name);
    this.d.store.kv.delete('hello', cfg.name);
  }

  /**
   * Create the default agent-keyed `nostr` channel (configured relays) if the nostr plugin is
   * installed and no channel of that name exists. Returns true when it exists afterwards.
   */
  async ensureDefaultChannel(): Promise<boolean> {
    const d = this.d;
    const existing = d.config.channels.get(DEFAULT_NOSTR_CHANNEL);
    if (existing) return isAgentKeyed(existing);
    if (!d.registry.channel('nostr')) return false;
    const cfg = d.config.channels.save({
      name: DEFAULT_NOSTR_CHANNEL,
      provider: 'nostr',
      settings: { relays: d.global().nostr.relays, agentKeys: true },
      secretRefs: [],
      enabled: true,
      createdAt: new Date(d.now()).toISOString(),
    });
    d.audit({
      type: 'channel.added',
      severity: 'security',
      summary: 'Default Nostr channel created (one key per agent)',
      actor: 'system',
    });
    if (!d.isPanic()) await d.channels.connect(cfg).catch(() => {});
    return true;
  }

  /** After agent.create: key → default channel → connect → publish (publishing runs in the background). */
  async onAgentCreated(name: string): Promise<void> {
    const a = this.d.agent(name);
    if (!a.identity.nostrKeyRef) return;
    if (!(await this.ensureDefaultChannel())) return;
    await this.d.channels.syncAgent(name);
    this.track(this.publish(name).then(() => undefined));
  }

  private pending = new Set<Promise<unknown>>();
  private track(p: Promise<unknown>): void {
    const q = p.catch((e) => this.d.log.warn('identity publish failed', { error: errMsg(e) }));
    this.pending.add(q);
    void q.finally(() => this.pending.delete(q));
  }
  /** Wait for background publishes (tests, shutdown). */
  async settled(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  private republishAll(): void {
    for (const a of this.d.config.agents.list())
      if (a.identity.nostrKeyRef && this.conn(a.name)) this.track(this.publish(a.name));
  }

  private conn(agent: string): NostrConnLike | undefined {
    const c = this.d.channels.get(agentConnName(DEFAULT_NOSTR_CHANNEL, agent));
    return c?.provider === 'nostr' ? (c as NostrConnLike) : undefined;
  }

  private requireConn(agent: string): NostrConnLike {
    const a = this.d.agent(agent);
    if (!a.identity.npub) throw new BeamhopError('invalid_input', `agent ${agent} has no Nostr identity`);
    const c = this.conn(agent);
    if (!c) throw new BeamhopError('unavailable', `agent ${agent} is not connected to Nostr`);
    return c;
  }

  /** Publish kind 0 profile, owner attestation (when the daemon holds the owner key) and NIP-89 card. */
  async publish(agent: string): Promise<{
    npub: string;
    published: { kind: number; id: string; relays: string[] }[];
    attestation: 'published' | 'needs-owner-signature' | 'no-owner';
  }> {
    const m = await requireNostr();
    const a = this.d.agent(agent);
    const c = this.requireConn(agent);
    const owner = this.ownerNpub();
    const published: { kind: number; id: string; relays: string[] }[] = [];
    if (!owner) return { npub: c.npub, published, attestation: 'no-owner' };
    const push = (kind: number, r: { id: string; ok: string[] }) =>
      published.push({ kind, id: r.id, relays: r.ok });
    const name = a.displayName ?? a.name;
    push(
      0,
      await c.publish(
        m.buildProfileEvent({
          name,
          owner,
          ...(a.description ? { about: a.description } : {}),
          ...(a.identity.nip05 ? { nip05: a.identity.nip05 } : {}),
        }),
      ),
    );
    let attestation: 'published' | 'needs-owner-signature' = 'needs-owner-signature';
    const ownerNsec = (await this.ownerKeyHeld()) ? await this.d.secrets.get(OWNER_KEY_REF) : undefined;
    if (ownerNsec) {
      const ev = m.buildAttestation(ownerNsec, c.pubkey, { name: a.name });
      const r = await c.pool.publish(ev);
      push(ev.kind, r);
      if (r.ok.length) {
        this.d.store.kv.set('attested', a.name, { id: ev.id, owner });
        attestation = 'published';
      }
    } else if (this.d.store.kv.get<{ owner: string }>('attested', a.name)?.owner === owner)
      attestation = 'published';
    push(
      m.CAPABILITY_CARD_KIND,
      await c.publish(
        m.buildCapabilityCard({
          agentPubkey: c.pubkey,
          owner,
          name,
          ...(a.description ? { about: `${a.description}\n\nAI agent operated by ${owner}` } : {}),
          jobKinds: a.mesh.acceptJobs.filter((k) => k >= 5000 && k <= 5999),
          ...(a.preset ? { capabilities: [a.preset] } : {}),
        }),
      ),
    );
    return { npub: c.npub, published, attestation };
  }

  async attestationTemplate(agent: string) {
    const m = await requireNostr();
    const a = this.d.agent(agent);
    const owner = this.ownerNpub();
    if (!owner) throw new BeamhopError('invalid_input', 'no owner npub set; run beamhop init');
    if (!a.identity.npub) throw new BeamhopError('invalid_input', `agent ${agent} has no Nostr identity`);
    const t = m.buildAttestationTemplate(owner, a.identity.npub, { name: a.name });
    return {
      template: { kind: t.kind, created_at: t.created_at, tags: t.tags, content: t.content },
      ownerNpub: owner,
      agentNpub: a.identity.npub,
    };
  }

  /** Publish an attestation the owner signed on their own device. */
  async attest(agent: string, event: Record<string, unknown>): Promise<void> {
    const m = await requireNostr();
    const a = this.d.agent(agent);
    const owner = this.ownerNpub();
    if (!owner || !a.identity.npub) throw new BeamhopError('invalid_input', 'owner and agent npub required');
    const check = m.verifyAttestation(event as never, { agentPubkey: a.identity.npub, ownerPubkey: owner });
    if (!check.ok) throw new BeamhopError('invalid_input', `attestation rejected: ${check.reason}`);
    const c = this.requireConn(agent);
    const r = await c.pool.publish(event);
    if (!r.ok.length) throw new BeamhopError('unavailable', 'no relay accepted the attestation');
    this.d.store.kv.set('attested', a.name, { id: r.id, owner });
  }

  attested(agent: string): boolean {
    const owner = this.ownerNpub();
    return !!owner && this.d.store.kv.get<{ owner: string }>('attested', agent)?.owner === owner;
  }

  // ───────────────────────────── onboarding hello (§9A step 6) ─────────────────────────────

  async hello(agent: string, text?: string): Promise<HelloState> {
    const a = this.d.agent(agent);
    const owner = this.ownerNpub();
    if (!owner) throw new BeamhopError('invalid_input', 'no owner npub set; run beamhop init');
    const c = this.requireConn(agent);
    const markdown =
      text ?? `Hi, I'm ${a.displayName ?? a.name}. Reply with anything to check the connection.`;
    const sent = await this.d.sendOutbound(
      c,
      { conversation: { kind: 'dm', id: owner }, markdown },
      { agent: a.name, dlp: 'warn', recipient: `nostr:${owner}` },
    );
    if (!sent) throw new BeamhopError('forbidden', 'hello message was blocked');
    this.d.rememberDm(`nostr:${owner}`, c.name, owner);
    const st: HelloState = {
      to: owner,
      from: c.npub,
      id: sent.id,
      sentAt: new Date(this.d.now()).toISOString(),
    };
    this.d.store.kv.set('hello', a.name, st);
    return st;
  }

  helloStatus(agent: string) {
    this.d.agent(agent);
    const st = this.d.store.kv.get<HelloState>('hello', agent);
    if (!st) return { sent: false, replied: false };
    return {
      sent: true,
      replied: !!st.repliedAt,
      sentAt: st.sentAt,
      ...(st.repliedAt ? { repliedAt: st.repliedAt } : {}),
      ...(st.replyFrom ? { from: st.replyFrom } : {}),
      ...(st.text !== undefined ? { text: st.text.slice(0, 500) } : {}),
    };
  }

  /** Router hook: a DM to an agent key from the owner (or a paired device) completes the hello. */
  noteInbound(conn: ChannelConn, msg: InboundMsg): void {
    if (msg.conversation.kind !== 'dm') return;
    const bound = this.d.channels.binding(conn.name);
    if (!bound) return;
    const st = this.d.store.kv.get<HelloState>('hello', bound.agent);
    if (!st || st.repliedAt) return;
    const from = normalizePrincipal(msg.from.principal);
    const trusted =
      this.d.ownerPrincipals().includes(from) ||
      this.d.store.devices.list().some((dev) => normalizePrincipal(`nostr:${dev.pubkey}`) === from);
    if (!trusted) return;
    this.d.store.kv.set('hello', bound.agent, {
      ...st,
      repliedAt: new Date(this.d.now()).toISOString(),
      replyFrom: msg.from.principal,
      text: msg.text,
    });
  }
}
