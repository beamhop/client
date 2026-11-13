/**
 * Cloud-daemon side of the deploy contract (packages/deploy cloud-init / PaaS env, §8, §10).
 *
 * With `BEAMHOP_AWAIT_PROVISIONING=1` the daemon starts with no secrets. It announces its control
 * key to the one-time provisioning key (`BEAMHOP_PROVISIONING_PUBKEY`) until a `beamhop.provision`
 * request arrives over the Nostr control plane. Only the owner (`BEAMHOP_OWNER_NPUB`) or, once, the
 * provisioning key may provision; everything is NIP-44 encrypted to this daemon's key. After that
 * the provisioning key is dropped from the control allowlist, the controller npubs become paired
 * devices (they may panic/resume this daemon) and a heartbeat goes to owners and devices.
 */
import { AgentConfig, BeamhopError, ChannelConfig, type RpcRequest, type RpcResponse } from '@beamhop/core';
import { z } from 'zod';
import type { Daemon } from './daemon.ts';
import { loadNostr } from './identity.ts';
import { HELLO_METHOD, isLocalOnlySecret, PROVISION_VERSION } from './remote.ts';
import { errMsg } from './util.ts';

const NS = 'cloud';
const SECRET_NAME = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/;

export const ProvisionParams = z.object({
  v: z.literal(PROVISION_VERSION),
  agent: z.record(z.string(), z.unknown()),
  channels: z.array(z.record(z.string(), z.unknown())).max(20).default([]),
  secrets: z
    .record(z.string().regex(SECRET_NAME), z.string().max(16_384))
    .refine((r) => Object.keys(r).length <= 64, 'too many secrets'),
  controllers: z.array(z.string().max(100)).max(8).default([]),
  relays: z
    .array(
      z
        .string()
        .regex(/^wss?:\/\//)
        .max(300),
    )
    .max(16)
    .optional(),
});

type ControlClient = ReturnType<NonNullable<Awaited<ReturnType<typeof loadNostr>>>['createControlClient']>;

export class CloudSide {
  private hello: ControlClient | undefined;
  private lastHello = Number.NEGATIVE_INFINITY;
  private lastBeat = Number.NEGATIVE_INFINITY;
  private provisioningHex: string | undefined;
  private ownerHex: string | undefined;

  constructor(
    private readonly d: Daemon,
    private readonly opts: { helloMs?: number; heartbeatMs?: number; callTimeoutMs?: number } = {},
  ) {}

  /** Started from a cloud deploy (env contract)? */
  get enabled(): boolean {
    return this.d.deployEnv.awaitProvisioning;
  }

  provisioned(): boolean {
    return this.d.store.kv.get<boolean>(NS, 'provisioned') === true;
  }

  /** Waiting for its secrets: channels and schedules stay off until then. */
  awaiting(): boolean {
    return this.enabled && !this.provisioned();
  }

  /** Extra control-plane senders: the provisioning key, until provisioning is done. */
  allowlistExtra(): string[] {
    return this.awaiting() && this.provisioningHex ? [this.provisioningHex] : [];
  }

  async init(): Promise<void> {
    if (!this.enabled) return;
    const m = await loadNostr();
    if (!m) return;
    const env = this.d.deployEnv;
    if (env.provisioningPubkey) {
      const hex = m.tryDecodePubkey(env.provisioningPubkey);
      if (hex) this.provisioningHex = hex;
      else this.d.log.warn('BEAMHOP_PROVISIONING_PUBKEY is not a valid pubkey; only the owner can provision');
    }
    if (env.ownerNpub) this.ownerHex = m.tryDecodePubkey(env.ownerNpub);
  }

  close(): void {
    this.hello?.close();
    this.hello = undefined;
  }

  /** Called from the daemon tick: announce while awaiting, heartbeat once provisioned. */
  async tick(): Promise<void> {
    if (!this.enabled || !this.d.control) return;
    const now = this.d.now();
    if (this.awaiting()) {
      if (now - this.lastHello >= (this.opts.helloMs ?? 20_000)) {
        this.lastHello = now;
        await this.announce();
      }
      return;
    }
    if (now - this.lastBeat >= (this.opts.heartbeatMs ?? 60_000)) {
      this.lastBeat = now;
      await this.heartbeat();
    }
  }

  /** Tell the provisioning key who we are (no secrets; it only learns our control npub). */
  private async announce(): Promise<void> {
    if (!this.provisioningHex) return;
    const m = await loadNostr();
    if (!m) return;
    const { nsec, npub } = await this.d.controlKey();
    if (!this.hello) {
      const { proxyWebSocket } = await import('./net.ts');
      const WebSocket = this.d.opts.nostrWebSocket ?? proxyWebSocket();
      this.hello = m.createControlClient({
        key: nsec,
        daemonPubkey: this.provisioningHex,
        relays: this.d.global().nostr.relays,
        ...(WebSocket ? { WebSocket: WebSocket as never } : {}),
        timeoutMs: this.opts.callTimeoutMs ?? 15_000,
      });
      await this.hello.ready();
    }
    try {
      await this.hello.call(HELLO_METHOD, {
        agent: this.d.deployEnv.agent ?? '',
        npub,
        provider: this.d.deployEnv.provider ?? '',
      });
    } catch (e) {
      this.d.log.debug('provisioning hello not answered', { error: errMsg(e) });
    }
  }

  async heartbeat(): Promise<void> {
    const c = this.d.control;
    if (!c) return;
    const agent = this.d.deployEnv.agent;
    await c
      .notify({
        type: 'daemon.heartbeat',
        heartbeat: {
          npub: c.npub,
          ...(agent ? { agent } : {}),
          at: new Date(this.d.now()).toISOString(),
          panic: this.d.isPanic(),
          activeSessions: this.d.sessions.all().filter((s) => !s.ended).length,
          version: (await import('./daemon.ts')).VERSION,
        },
      })
      .catch((e) => this.d.log.warn('heartbeat failed', { error: errMsg(e) }));
  }

  /** `beamhop.provision` over the control plane. `sender` is the verified hex pubkey. */
  async handleProvision(req: RpcRequest, sender: string): Promise<RpcResponse> {
    const err = (code: string, message: string): RpcResponse => ({
      jsonrpc: '2.0',
      id: req.id,
      error: { code: -32000, message, data: { code } },
    });
    if (!this.enabled) return err('forbidden', 'this daemon was not started for provisioning');
    const byOwner = !!this.ownerHex && sender === this.ownerHex;
    const byKey = !!this.provisioningHex && sender === this.provisioningHex && this.awaiting();
    if (!byOwner && !byKey) {
      this.d.audit({
        type: 'cloud.provision_refused',
        severity: 'security',
        summary: 'Refused a provisioning request from a key that is not the owner or the provisioning key',
        actor: `nostr:${sender}`,
      });
      return err('forbidden', 'only the owner (or the one-time provisioning key) may provision');
    }
    const parsed = ProvisionParams.safeParse(req.params);
    if (!parsed.success)
      return err(
        'invalid_input',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    try {
      await this.apply(parsed.data);
    } catch (e) {
      return err((e as BeamhopError).code ?? 'internal', errMsg(e));
    }
    return { jsonrpc: '2.0', id: req.id, result: { ok: true, npub: this.d.control?.npub } };
  }

  private async apply(p: z.infer<typeof ProvisionParams>): Promise<void> {
    const d = this.d;
    const m = await loadNostr();
    if (!m) throw new BeamhopError('unavailable', 'provisioning needs @beamhop/channel-nostr');
    const want = d.deployEnv.agent;
    if (want && p.agent.name !== want)
      throw new BeamhopError('invalid_input', `this host runs agent ${want}, not ${String(p.agent.name)}`);
    for (const name of Object.keys(p.secrets))
      if (isLocalOnlySecret(name))
        throw new BeamhopError('forbidden', `secret ${name} cannot be provisioned`);
    const controllers = p.controllers.map((c) => {
      const hex = m.tryDecodePubkey(c);
      if (!hex) throw new BeamhopError('invalid_input', 'invalid controller key');
      return m.npubEncode(hex);
    });
    // Validate configs before writing anything.
    const channels = p.channels.map((c) => {
      const r = ChannelConfig.safeParse(c);
      if (!r.success) throw new BeamhopError('invalid_input', `invalid channel config: ${r.error.message}`);
      return r.data;
    });
    const agentCheck = AgentConfig.safeParse(p.agent);
    if (!agentCheck.success)
      throw new BeamhopError('invalid_input', `invalid agent config: ${agentCheck.error.message}`);
    for (const [name, value] of Object.entries(p.secrets)) await d.secrets.set(name, value);
    d.invalidateSecretCache();
    if (p.relays?.length) d.updateGlobal((c) => ({ ...c, nostr: { ...c.nostr, relays: p.relays! } }));
    for (const c of channels) d.config.channels.save(c);
    const agent = d.config.agents.save(p.agent);
    for (const npub of controllers)
      if (!d.store.devices.list().some((dev) => dev.pubkey === npub))
        d.store.devices.add({ name: 'beamhop controller', pubkey: npub });
    d.store.kv.set(NS, 'provisioned', true);
    d.refreshControlAllowlist();
    this.close();
    d.audit({
      type: 'cloud.provisioned',
      severity: 'security',
      summary: `Provisioned agent ${agent.name} with ${Object.keys(p.secrets).length} secrets and ${controllers.length} controller(s)`,
      actor: 'system:provision',
      agent: agent.name,
      data: { secrets: Object.keys(p.secrets), controllers },
    });
    d.emitAgent(agent.name);
    // Bring the agent up (channels, schedules) unless an emergency stop is active.
    setTimeout(() => void this.bringUp(agent.identity.nostrKeyRef !== undefined), 0).unref?.();
  }

  private async bringUp(agentKeyed: boolean): Promise<void> {
    const d = this.d;
    if (d.isPanic()) return;
    try {
      if (agentKeyed) await d.identity.ensureDefaultChannel();
      await d.channels.startAll();
      d.scheduler.start();
      this.lastBeat = Number.NEGATIVE_INFINITY;
      await this.heartbeat();
    } catch (e) {
      d.log.warn('starting the provisioned agent failed', { error: errMsg(e) });
    }
  }
}
