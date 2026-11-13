/**
 * Cloud daemons seen from the owner's daemon (§7A emergency stop, §9B heartbeats, §10 deploys).
 *
 * Provisioning (local side of the packages/deploy contract):
 *  1. `deploy.apply` creates a one-time provisioning key P per agent (secret half stays here, as
 *     `beamhop.provision.<agent>.nsec`); the deployer puts P's pubkey into the host's environment
 *     (`BEAMHOP_PROVISIONING_PUBKEY`) next to `BEAMHOP_AWAIT_PROVISIONING=1`.
 *  2. The fresh host generates its control key E and announces it to P over the Nostr control
 *     plane (`beamhop.provision.hello`, NIP-44 encrypted, signed by E).
 *  3. On the first hello for a pending deployment, this daemon sends `beamhop.provision` to E:
 *     agent config, channel configs, the secrets they need (LLM keys, channel tokens, the agent's
 *     nsec) and this daemon's controller npub, encrypted to E and signed by the owner key (when the
 *     daemon holds it) or by P. P is then deleted; provider tokens and `beamhop.*` secrets never go.
 *
 * Afterwards a control client (keyed with a dedicated controller key that the host trusts as a
 * paired device) receives the host's heartbeats and carries panic/resume to it.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  BeamhopError,
  type ChannelConfig,
  type RemoteDaemonView,
  type RpcRequest,
  type RpcResponse,
  type ServerEvent,
} from '@beamhop/core';
import type { DeploymentRecord } from '@beamhop/store';
import type { Daemon } from './daemon.ts';
import { isInternalSecret } from './home.ts';
import { loadNostr, OWNER_KEY_REF } from './identity.ts';
import { errMsg } from './util.ts';

type NostrMod = NonNullable<Awaited<ReturnType<typeof loadNostr>>>;
type Pool = InstanceType<NostrMod['RelayPool']>;
type ControlClient = ReturnType<NostrMod['createControlClient']>;
type ControlServer = ReturnType<NostrMod['createControlServer']>;

export const PROVISION_METHOD = 'beamhop.provision';
export const HELLO_METHOD = 'beamhop.provision.hello';
export const CONTROLLER_KEY_REF = 'beamhop.controller.nsec';
export const provisionKeyRef = (agent: string): string => `beamhop.provision.${agent}.nsec`;
/** One-time binding token for an agent's provisioning (review wave C PROV-1). */
export const provisionTokenRef = (agent: string): string => `beamhop.provision.${agent}.token`;

/**
 * Proof in the host's hello that it was started from *this* deploy: an HMAC of the agent name and
 * the host's control pubkey under the one-time token from its environment. Without it anyone who
 * learns the provisioning pubkey (it is public, and visible as a `p` tag on relays once the real
 * host says hello) could answer first and receive the agent's secrets.
 */
export const provisionProof = (token: string, agent: string, pubkeyHex: string): string =>
  createHmac('sha256', token).update(`beamhop-provision-v1\n${agent}\n${pubkeyHex}`).digest('hex');

const proofMatches = (expected: string, got: unknown): boolean => {
  if (typeof got !== 'string' || got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(got));
};
/** Wire version of the provisioning payload. */
export const PROVISION_VERSION = 1;

export interface RemoteOptions {
  /** Cloud side: heartbeat interval (default 60 s). The local side expects the same interval. */
  heartbeatMs?: number;
  /** Local side: a remote is offline after this many missed heartbeats (default 3). */
  missedHeartbeats?: number;
  /** Cloud side: re-announce interval while waiting for provisioning (default 20 s). */
  helloMs?: number;
  /** Timeout for provisioning / panic calls (default 15 s). */
  callTimeoutMs?: number;
}

export interface ProvisionPayload {
  v: number;
  agent: Record<string, unknown>;
  channels: Record<string, unknown>[];
  secrets: Record<string, string>;
  controllers: string[];
  relays?: string[];
}

interface RemoteState {
  online: boolean;
  /** ms (daemon clock). */
  lastHeartbeatAt?: number;
  remotePanic?: boolean;
  /** An offline alert went out and no heartbeat arrived since. */
  offlineAlerted?: boolean;
  command?: RemoteDaemonView['command'];
}

type DeployData = {
  provisioning?: 'pending' | 'done' | 'failed';
  provisioningPubkey?: string;
  daemonNpub?: string;
  provisionedAt?: string;
};

const NS = 'remote';

/** Secrets that must never leave this machine (provider tokens, daemon-internal keys). */
export const isLocalOnlySecret = (name: string): boolean =>
  isInternalSecret(name) || name.startsWith('deploy.');

export class RemoteManager {
  private pool: Pool | undefined;
  private readonly clients = new Map<string, { npub: string; client: ControlClient; off: () => void }>();
  private readonly listeners = new Map<string, ControlServer>();
  private readonly inflight = new Set<string>();
  private readonly followedAt = new Map<string, number>();
  private readonly tasks = new Set<Promise<unknown>>();
  private started = false;
  private closed = false;

  constructor(
    private readonly d: Daemon,
    private readonly opts: RemoteOptions = {},
  ) {}

  get heartbeatMs(): number {
    return this.opts.heartbeatMs ?? 60_000;
  }

  private get timeoutMs(): number {
    return this.opts.callTimeoutMs ?? 15_000;
  }

  /** Wait for background provisioning work (tests). */
  async settled(): Promise<void> {
    while (this.tasks.size) await Promise.allSettled([...this.tasks]);
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.tasks.add(p);
    void p.finally(() => this.tasks.delete(p)).catch(() => {});
    return p;
  }

  private async nostr(): Promise<NostrMod> {
    const m = await loadNostr();
    if (!m) throw new BeamhopError('unavailable', 'cloud control needs @beamhop/channel-nostr');
    return m;
  }

  private async getPool(): Promise<Pool> {
    if (this.pool) return this.pool;
    const m = await this.nostr();
    const { proxyWebSocket } = await import('./net.ts');
    const WebSocket = this.d.opts.nostrWebSocket ?? proxyWebSocket();
    this.pool = new m.RelayPool({
      relays: this.relays(),
      ...(WebSocket ? { WebSocket } : {}),
      log: this.d.log.child({ component: 'remote' }),
    });
    return this.pool;
  }

  private relays(): string[] {
    return this.d.global().nostr.relays;
  }

  private data(rec: DeploymentRecord): DeployData {
    return (rec.data ?? {}) as DeployData;
  }

  private setData(id: string, patch: DeployData): DeploymentRecord | undefined {
    const rec = this.d.store.deployments.get(id);
    if (!rec) return undefined;
    return this.d.store.deployments.upsert({ ...rec, data: { ...(rec.data ?? {}), ...patch } });
  }

  private state(id: string): RemoteState {
    return this.d.store.kv.get<RemoteState>(NS, id) ?? { online: false };
  }

  private setState(id: string, patch: Partial<RemoteState>): RemoteState {
    const next = { ...this.state(id), ...patch };
    this.d.store.kv.set(NS, id, next);
    return next;
  }

  // ───────────────────────────── provisioning keys ─────────────────────────────

  /** The one-time provisioning key for an agent (created on first use). Returns its hex pubkey. */
  async provisioningKey(agent: string): Promise<string> {
    const m = await this.nostr();
    const ref = provisionKeyRef(agent);
    let nsec = await this.d.secrets.get(ref);
    if (!nsec) {
      nsec = m.generateAgentKey().nsec;
      await this.d.secrets.set(ref, nsec);
      this.d.invalidateSecretCache();
    }
    return m.pubkeyOf(m.decodeSecretKey(nsec));
  }

  /** The one-time binding token for an agent's next provisioning (created on first use). */
  async provisioningToken(agent: string): Promise<string> {
    const ref = provisionTokenRef(agent);
    let token = await this.d.secrets.get(ref);
    if (!token) {
      // Hex: can never look like a provider token to the deploy secret scanner.
      token = randomBytes(32).toString('hex');
      await this.d.secrets.set(ref, token);
      this.d.invalidateSecretCache();
    }
    return token;
  }

  /** The controller key the cloud daemons trust as a paired device. */
  async controllerKey(): Promise<{ nsec: string; npub: string }> {
    const m = await this.nostr();
    let nsec = await this.d.secrets.get(CONTROLLER_KEY_REF);
    if (!nsec) {
      nsec = m.generateAgentKey().nsec;
      await this.d.secrets.set(CONTROLLER_KEY_REF, nsec);
      this.d.invalidateSecretCache();
    }
    return { nsec, npub: m.npubEncode(m.pubkeyOf(m.decodeSecretKey(nsec))) };
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  /** Resume listeners for pending provisionings and trackers for provisioned hosts. */
  async start(): Promise<void> {
    if (this.started || this.closed) return;
    this.started = true;
    for (const rec of this.d.store.deployments.list()) {
      const data = this.data(rec);
      if (data.provisioning === 'pending')
        await this.listen(rec).catch((e) =>
          this.d.log.warn('provisioning listener failed', { id: rec.id, error: errMsg(e) }),
        );
      else if (data.daemonNpub)
        await this.follow(rec.id, data.daemonNpub).catch((e) =>
          this.d.log.warn('remote tracking failed', { id: rec.id, error: errMsg(e) }),
        );
    }
  }

  close(): void {
    this.closed = true;
    for (const l of this.listeners.values()) l.close();
    this.listeners.clear();
    for (const c of this.clients.values()) {
      c.off();
      c.client.close();
    }
    this.clients.clear();
    this.pool?.close();
    this.pool = undefined;
  }

  /** Called by `deploy.apply` once the host was created: wait for its hello, then provision it. */
  async afterApply(rec: DeploymentRecord): Promise<void> {
    if (this.data(rec).provisioning === 'done') return;
    const pubkey = await this.provisioningKey(rec.agent);
    const next = this.setData(rec.id, { provisioning: 'pending', provisioningPubkey: pubkey });
    this.setState(rec.id, { online: false });
    if (next && this.started) await this.listen(next);
  }

  /** Forget a destroyed deployment. */
  async forget(id: string): Promise<void> {
    const rec = this.d.store.deployments.get(id);
    this.listeners.get(id)?.close();
    this.listeners.delete(id);
    const c = this.clients.get(id);
    if (c) {
      c.off();
      c.client.close();
      this.clients.delete(id);
    }
    this.d.store.kv.delete(NS, id);
    this.followedAt.delete(id);
    if (rec) {
      await this.d.secrets.delete(provisionKeyRef(rec.agent)).catch(() => {});
      await this.d.secrets.delete(provisionTokenRef(rec.agent)).catch(() => {});
    }
  }

  private async listen(rec: DeploymentRecord): Promise<void> {
    if (this.listeners.has(rec.id) || this.closed) return;
    const nsec = await this.d.secrets.get(provisionKeyRef(rec.agent));
    if (!nsec) {
      this.setData(rec.id, { provisioning: 'failed' });
      return;
    }
    const m = await this.nostr();
    const pool = await this.getPool();
    const id = rec.id;
    const server = m.createControlServer({
      key: nsec,
      allowlist: [],
      relays: this.relays(),
      pool,
      log: this.d.log.child({ component: 'provision' }),
      publicMethods: [HELLO_METHOD],
      publicRateLimit: { perSender: 5, global: 20, windowMs: 60_000 },
      handle: (req, ctx) => this.onHello(id, req, ctx.sender),
    });
    this.listeners.set(id, server);
    await server.ready();
  }

  private async onHello(id: string, req: RpcRequest, sender: string): Promise<RpcResponse> {
    const fail = (message: string): RpcResponse => ({
      jsonrpc: '2.0',
      id: req.id,
      error: { code: -32000, message, data: { code: 'forbidden' } },
    });
    if (req.method !== HELLO_METHOD) return fail('unknown method');
    const rec = this.d.store.deployments.get(id);
    const p = (req.params ?? {}) as { agent?: unknown; proof?: unknown };
    if (!rec || this.data(rec).provisioning !== 'pending') return fail('nothing to provision');
    if (p.agent !== rec.agent) return fail('agent mismatch');
    // Hosts deployed with a binding token must prove they hold it (deployments made before the
    // token existed fall back to first-hello-wins).
    const token = await this.d.secrets.get(provisionTokenRef(rec.agent));
    if (token && !proofMatches(provisionProof(token, rec.agent, sender), p.proof)) {
      this.d.audit({
        type: 'deploy.hello_refused',
        severity: 'security',
        summary: `Refused a provisioning hello for ${rec.agent} without a valid deploy proof`,
        actor: `nostr:${sender}`,
        agent: rec.agent,
        data: { deployment: id },
      });
      return fail('invalid provisioning proof');
    }
    // First hello wins; a failed attempt can be retried by the next hello.
    if (!this.inflight.has(id)) {
      this.inflight.add(id);
      void this.track(
        this.provision(id, sender).finally(() => {
          this.inflight.delete(id);
        }),
      );
    }
    return { jsonrpc: '2.0', id: req.id, result: { ok: true } };
  }

  /** Build the provisioning payload for an agent: config, its channels and the secrets they need. */
  async payload(agentName: string): Promise<ProvisionPayload> {
    const d = this.d;
    const agent = d.agent(agentName);
    const secrets: Record<string, string> = {};
    const add = async (name: string | undefined) => {
      if (!name || isLocalOnlySecret(name) || name in secrets) return;
      const v = await d.secrets.get(name);
      if (v !== undefined) secrets[name] = v;
    };
    await add(agent.identity.nostrKeyRef);
    const { DEFAULT_ROUTES } = await import('@beamhop/broker');
    for (const r of d.opts.llmRoutes ?? DEFAULT_ROUTES) await add(r.secretName);
    const channelNames = new Set(
      agent.memberships.map((mb) => mb.target.slice(0, mb.target.indexOf(':'))).filter(Boolean),
    );
    const channels: ChannelConfig[] = [];
    for (const name of channelNames) {
      const cfg = d.config.channels.get(name);
      if (!cfg) continue;
      channels.push(cfg);
      for (const ref of cfg.secretRefs) await add(ref);
    }
    const { npub } = await this.controllerKey();
    return {
      v: PROVISION_VERSION,
      agent: agent as unknown as Record<string, unknown>,
      channels: channels as unknown as Record<string, unknown>[],
      secrets,
      controllers: [npub],
      relays: this.relays(),
    };
  }

  private async provision(id: string, remotePubkey: string): Promise<void> {
    const d = this.d;
    const rec = d.store.deployments.get(id);
    if (!rec) return;
    const m = await this.nostr();
    const pNsec = await d.secrets.get(provisionKeyRef(rec.agent));
    if (!pNsec) return;
    // Owner-signed when this daemon holds the owner key; otherwise signed by the one-time key P.
    const signer = (await d.secrets.get(OWNER_KEY_REF)) ?? pNsec;
    const remoteNpub = m.npubEncode(remotePubkey);
    const client = m.createControlClient({
      key: signer,
      daemonPubkey: remotePubkey,
      relays: this.relays(),
      pool: await this.getPool(),
      timeoutMs: this.timeoutMs,
    });
    try {
      await client.ready();
      const payload = await this.payload(rec.agent);
      await client.call(PROVISION_METHOD, payload, this.timeoutMs);
      this.setData(id, {
        provisioning: 'done',
        daemonNpub: remoteNpub,
        provisionedAt: new Date(d.now()).toISOString(),
      });
      this.listeners.get(id)?.close();
      this.listeners.delete(id);
      await d.secrets.delete(provisionKeyRef(rec.agent));
      await d.secrets.delete(provisionTokenRef(rec.agent)).catch(() => {});
      d.invalidateSecretCache();
      d.audit({
        type: 'deploy.provisioned',
        severity: 'security',
        summary: `Provisioned cloud daemon ${remoteNpub} for ${rec.agent} (${Object.keys(payload.secrets).length} secrets)`,
        actor: 'system:deploy',
        agent: rec.agent,
        data: { deployment: id, npub: remoteNpub, secrets: Object.keys(payload.secrets) },
      });
      this.setState(id, { online: true });
      await this.follow(id, remoteNpub);
    } catch (e) {
      d.audit({
        type: 'deploy.provision_failed',
        severity: 'warn',
        summary: `Provisioning ${rec.agent} on ${rec.provider} failed: ${errMsg(e)}`,
        actor: 'system:deploy',
        agent: rec.agent,
        data: { deployment: id },
      });
    } finally {
      client.close();
    }
  }

  // ───────────────────────────── tracking ─────────────────────────────

  private async follow(id: string, npub: string): Promise<void> {
    if (this.closed) return;
    const existing = this.clients.get(id);
    if (existing?.npub === npub) return;
    if (existing) {
      existing.off();
      existing.client.close();
    }
    const m = await this.nostr();
    const key = await this.controllerKey();
    const client = m.createControlClient({
      key: key.nsec,
      daemonPubkey: npub,
      relays: this.relays(),
      pool: await this.getPool(),
      timeoutMs: this.timeoutMs,
    });
    const off = client.onEvent((ev) => this.onRemoteEvent(id, npub, ev));
    this.clients.set(id, { npub, client, off });
    this.followedAt.set(id, this.d.now());
    await client.ready();
  }

  private onRemoteEvent(id: string, npub: string, ev: ServerEvent): void {
    const rec = this.d.store.deployments.get(id);
    if (!rec) return;
    if (ev.type === 'daemon.heartbeat') {
      if (ev.heartbeat.npub !== npub) return;
      const was = this.state(id);
      this.setState(id, {
        online: true,
        offlineAlerted: false,
        lastHeartbeatAt: this.d.now(),
        remotePanic: ev.heartbeat.panic === true,
      });
      if (was.offlineAlerted)
        this.d.audit({
          type: 'remote.online',
          severity: 'info',
          summary: `Cloud daemon for ${rec.agent} is back online`,
          actor: 'system:remote',
          agent: rec.agent,
          data: { deployment: id, provider: rec.provider },
        });
    } else if (ev.type === 'panic') this.setState(id, { remotePanic: ev.active });
  }

  /** Mark remotes offline after `missedHeartbeats` intervals without a beat (alert once). */
  tick(): void {
    const now = this.d.now();
    const configured = this.d.global().alerts?.heartbeatMinutes;
    const limit =
      configured !== undefined ? configured * 60_000 : (this.opts.missedHeartbeats ?? 3) * this.heartbeatMs;
    for (const [id] of this.clients) {
      const rec = this.d.store.deployments.get(id);
      if (!rec || rec.status === 'destroyed' || rec.status === 'stopped') continue;
      const s = this.state(id);
      // Never alert before a full window has passed since tracking (re)started (daemon restart).
      const last = Math.max(s.lastHeartbeatAt ?? 0, this.followedAt.get(id) ?? now);
      if (now - last <= limit || s.offlineAlerted) continue;
      this.setState(id, { online: false, offlineAlerted: true });
      this.d.audit({
        type: 'remote.offline',
        severity: 'warn',
        summary: `Cloud daemon for ${rec.agent} missed ${this.opts.missedHeartbeats ?? 3} heartbeats`,
        actor: 'system:remote',
        agent: rec.agent,
        data: { deployment: id, provider: rec.provider },
      });
    }
  }

  // ───────────────────────────── commands ─────────────────────────────

  /** Send panic or resume to every provisioned cloud daemon; per-remote outcome lands in views(). */
  async command(kind: 'panic' | 'resume', reason?: string): Promise<void> {
    const at = () => new Date(this.d.now()).toISOString();
    await Promise.all(
      [...this.clients.entries()].map(async ([id, c]) => {
        this.setState(id, { command: { kind, state: 'pending', at: at() } });
        try {
          await c.client.call(
            kind === 'panic' ? 'system.panic' : 'system.resume',
            kind === 'panic' && reason ? { reason } : {},
            this.timeoutMs,
          );
          this.setState(id, { command: { kind, state: 'acked', at: at() }, remotePanic: kind === 'panic' });
        } catch (e) {
          const error = errMsg(e) || 'no answer';
          this.setState(id, { command: { kind, state: 'failed', at: at(), error } });
          this.d.log.warn(`remote ${kind} failed`, { deployment: id, error });
        }
      }),
    );
  }

  views(): RemoteDaemonView[] {
    const out: RemoteDaemonView[] = [];
    for (const rec of this.d.store.deployments.list()) {
      const data = this.data(rec);
      if (!data.provisioning && !data.daemonNpub) continue;
      const s = this.state(rec.id);
      const v: RemoteDaemonView = {
        deployment: rec.id,
        agent: rec.agent,
        provider: rec.provider,
        provisioning: data.provisioning ?? 'done',
        online: s.online,
      };
      if (data.daemonNpub) v.npub = data.daemonNpub;
      if (s.lastHeartbeatAt !== undefined) v.lastHeartbeatAt = new Date(s.lastHeartbeatAt).toISOString();
      if (s.remotePanic !== undefined) v.remotePanic = s.remotePanic;
      if (s.command) v.command = s.command;
      out.push(v);
    }
    return out;
  }
}
