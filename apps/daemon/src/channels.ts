/**
 * Channel connections: connect enabled channels, pump inbound messages into the router.
 *
 * Agent-keyed channels (the default `nostr` channel, `settings.agentKeys: true`) open one
 * connection per agent key, named `<channel>@<agent>`. Each connection only ever routes to its own
 * agent, while memberships keep using the shared channel name (`nostr:dm`). Sessions record the
 * connection name, so replies go out with the right key.
 */
import { baseChannelName } from '@beamhop/authz';
import {
  BeamhopError,
  type ChannelConfig,
  type ChannelConn,
  type ChannelView,
  InboundMsg,
} from '@beamhop/core';
import type { Daemon } from './daemon.ts';
import { errMsg } from './util.ts';

interface Entry {
  cfg: ChannelConfig;
  conn?: ChannelConn;
  status: ChannelView['status'];
  error?: string;
  pump?: Promise<void>;
  /** For agent-bound connections. */
  agent?: string;
}

export const channelSecretName = (channel: string, field: string): string => `channel.${channel}.${field}`;
export const agentConnName = (channel: string, agent: string): string => `${channel}@${agent}`;
export const isAgentKeyed = (cfg: ChannelConfig): boolean =>
  cfg.provider === 'nostr' && cfg.settings.agentKeys === true;

/** An owner paired through `/pair` on a channel (`settings.pairings`, non-secret). */
export interface ChannelPairing {
  principal: string;
  displayName: string;
  handle?: string;
  role: string;
  pairedAt: string;
}

/** A group chat / channel the bot is known to be in (`settings.chats`). */
export interface ChannelChat {
  /** `<kind>/<conversation id>`, the membership target suffix. */
  target: string;
  title: string;
}

const MAX_CHATS = 200;

export class ChannelManager {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly d: Daemon) {}

  get(name: string): ChannelConn | undefined {
    return this.entries.get(name)?.conn;
  }

  /** The connection an agent uses on a channel: its own key on agent-keyed channels. */
  forAgent(channel: string, agent: string): ChannelConn | undefined {
    if (channel.includes('@')) return this.get(channel);
    return this.get(agentConnName(channel, agent)) ?? this.get(channel);
  }

  /** Connection name an agent's sessions on `channel` use (`nostr` → `nostr@reviewer` when keyed). */
  connName(channel: string, agent: string): string {
    const cfg = this.d.config.channels.get(channel);
    return cfg && isAgentKeyed(cfg) ? agentConnName(channel, agent) : channel;
  }

  /** `{ channel, agent }` for an agent-bound connection name, else undefined. */
  binding(connName: string): { channel: string; agent: string } | undefined {
    const e = this.entries.get(connName);
    if (e?.agent) return { channel: e.cfg.name, agent: e.agent };
    const at = connName.indexOf('@');
    return at > 0 ? { channel: baseChannelName(connName), agent: connName.slice(at + 1) } : undefined;
  }

  connected(): ChannelConn[] {
    return [...this.entries.values()].flatMap((e) => (e.conn ? [e.conn] : []));
  }

  view(cfg: ChannelConfig): ChannelView {
    const e = this.entries.get(cfg.name);
    const v: ChannelView = { config: cfg, status: cfg.enabled ? (e?.status ?? 'disconnected') : 'disabled' };
    if (isAgentKeyed(cfg)) {
      const kids = this.children(cfg.name);
      const failed = kids.filter((k) => k.status === 'error');
      if (cfg.enabled && e && failed.length) {
        v.status = failed.length === kids.length ? 'error' : v.status;
        v.error = failed.map((k) => `${k.agent}: ${k.error ?? 'error'}`).join('; ');
      }
      return v;
    }
    if (e?.conn) v.self = { ...e.conn.self };
    if (e?.error) v.error = e.error;
    return v;
  }

  private children(channel: string): Entry[] {
    return [...this.entries.values()].filter((e) => e.agent && e.cfg.name === channel);
  }

  async startAll(): Promise<void> {
    await Promise.all(
      this.d.config.channels
        .list()
        .filter((c) => c.enabled)
        .map((c) => this.connect(c).catch(() => {})),
    );
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((n) => this.disconnect(n)));
  }

  private emit(name: string): void {
    const cfg = this.entries.get(name)?.cfg ?? this.d.config.channels.get(name);
    if (cfg) this.d.emit({ type: 'channel.updated', channel: this.view(cfg) });
  }

  /** Update a channel's stored config (settings bookkeeping) and broadcast `channel.updated`. */
  private patchSettings(
    channel: string,
    fn: (s: Record<string, unknown>) => Record<string, unknown> | undefined,
  ) {
    const cur = this.d.config.channels.get(channel);
    if (!cur) return;
    const next = fn(cur.settings);
    if (!next) return;
    const saved = this.d.config.channels.update(channel, (c) => ({ ...c, settings: next }));
    for (const e of this.entries.values()) if (e.cfg.name === channel) e.cfg = saved;
    this.d.emit({ type: 'channel.updated', channel: this.view(saved) });
  }

  /** Record (or refresh) an owner pairing on the channel. */
  recordPairing(channel: string, p: ChannelPairing): void {
    this.patchSettings(channel, (s) => {
      const prev = Array.isArray(s.pairings) ? (s.pairings as ChannelPairing[]) : [];
      return { ...s, pairings: [...prev.filter((x) => x?.principal !== p.principal), p] };
    });
  }

  /** Drop pairings of a principal on every channel (owner removed). */
  forgetPairings(isRemoved: (principal: string) => boolean): void {
    for (const c of this.d.config.channels.list())
      this.patchSettings(c.name, (s) => {
        const prev = Array.isArray(s.pairings) ? (s.pairings as ChannelPairing[]) : [];
        const next = prev.filter((x) => !isRemoved(x?.principal ?? ''));
        return next.length === prev.length ? undefined : { ...s, pairings: next };
      });
  }

  /** Remember a group/channel conversation the bot received a message in (only writes on change). */
  noteChat(channel: string, kind: string, id: string, title?: string): void {
    if ((kind !== 'group' && kind !== 'channel') || !id) return;
    const target = `${kind}/${id}`;
    const name = (title ?? '').trim().slice(0, 120) || id;
    this.patchSettings(channel, (s) => {
      const prev = Array.isArray(s.chats) ? (s.chats as ChannelChat[]) : [];
      const old = prev.find((c) => c?.target === target);
      if (old && (old.title === name || !title)) return undefined;
      const rest = prev.filter((c) => c?.target !== target);
      return {
        ...s,
        chats: [...rest, { target, title: old && !title ? old.title : name }].slice(-MAX_CHATS),
      };
    });
  }

  /** The bot left (or was removed from) a conversation. */
  forgetChat(channel: string, id: string): void {
    this.patchSettings(channel, (s) => {
      const prev = Array.isArray(s.chats) ? (s.chats as ChannelChat[]) : [];
      const next = prev.filter((c) => c?.target?.slice(c.target.indexOf('/') + 1) !== id);
      return next.length === prev.length ? undefined : { ...s, chats: next };
    });
  }

  /** Secrets for a channel, keyed by wizard field id (`channel.<name>.<field>` in the vault). */
  async secretsFor(cfg: ChannelConfig): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const prefix = `channel.${cfg.name}.`;
    for (const ref of cfg.secretRefs) {
      const v = await this.d.secrets.get(ref);
      if (v !== undefined) out[ref.startsWith(prefix) ? ref.slice(prefix.length) : ref] = v;
    }
    return out;
  }

  async connect(cfg: ChannelConfig): Promise<ChannelConn | undefined> {
    if (this.d.isPanic()) throw new BeamhopError('unavailable', 'panic mode is active');
    await this.disconnect(cfg.name);
    if (!isAgentKeyed(cfg)) return this.open(cfg.name, cfg, cfg.settings, await this.secretsFor(cfg));
    const plugin = this.d.registry.channel(cfg.provider);
    const entry: Entry = { cfg, status: plugin ? 'connected' : 'error' };
    if (!plugin) entry.error = `channel provider "${cfg.provider}" is not installed`;
    this.entries.set(cfg.name, entry);
    this.emit(cfg.name);
    if (!plugin) throw new BeamhopError('unavailable', entry.error ?? 'not installed');
    await Promise.all(
      this.d.config.agents
        .list()
        .filter((a) => a.identity.nostrKeyRef)
        .map((a) => this.connectAgent(cfg, a.name).catch(() => {})),
    );
    this.emit(cfg.name);
    return undefined;
  }

  /** Open (or re-open) one agent's connection on an agent-keyed channel. */
  async connectAgent(cfg: ChannelConfig, agent: string): Promise<ChannelConn> {
    const a = this.d.agent(agent);
    const ref = a.identity.nostrKeyRef;
    const nsec = ref ? await this.d.secrets.get(ref) : undefined;
    if (!nsec) throw new BeamhopError('not_found', `agent ${agent} has no Nostr key`);
    const name = agentConnName(cfg.name, agent);
    await this.disconnect(name);
    const settings = { ...cfg.settings, name: a.displayName ?? a.name };
    delete (settings as Record<string, unknown>).agentKeys;
    const conn = await this.open(name, cfg, settings, { nsec }, agent);
    this.emit(cfg.name);
    return conn;
  }

  /** Bring an agent's connections in line with its config (after create/delete/key change). */
  async syncAgent(agent: string): Promise<void> {
    const a = this.d.config.agents.get(agent);
    for (const cfg of this.d.config.channels.list().filter(isAgentKeyed)) {
      const name = agentConnName(cfg.name, agent);
      if (!a?.identity.nostrKeyRef || !cfg.enabled) {
        await this.disconnect(name);
        this.emit(cfg.name);
        continue;
      }
      if (this.d.isPanic() || !this.entries.has(cfg.name)) continue;
      if (!this.get(name)) await this.connectAgent(cfg, agent).catch(() => {});
    }
  }

  private async open(
    name: string,
    cfg: ChannelConfig,
    settings: Record<string, unknown>,
    secrets: Record<string, string>,
    agent?: string,
  ): Promise<ChannelConn> {
    const plugin = this.d.registry.channel(cfg.provider);
    const entry: Entry = { cfg, status: 'connecting', ...(agent ? { agent } : {}) };
    this.entries.set(name, entry);
    if (!plugin) {
      entry.status = 'error';
      entry.error = `channel provider "${cfg.provider}" is not installed`;
      this.emit(cfg.name);
      throw new BeamhopError('unavailable', entry.error);
    }
    this.emit(cfg.name);
    try {
      const conn = await plugin.connect({
        name,
        settings,
        secrets,
        log: this.d.log.child({ channel: name }),
        state: this.d.store.kv.namespace(`channel:${name}`),
      });
      if (this.entries.get(name) !== entry) {
        await conn.close().catch(() => {});
        throw new BeamhopError('conflict', 'channel was reconfigured while connecting');
      }
      entry.conn = conn;
      entry.status = 'connected';
      conn.onButton?.(
        (press) =>
          void this.d.router
            .handleButton(conn, press)
            .catch((e) => this.d.log.error('button handling failed', { error: errMsg(e) })),
      );
      conn.onRemoved?.((conversationId) => this.d.router.handleRemoved(conn, conversationId));
      entry.pump = this.pump(entry, conn);
      this.emit(cfg.name);
      this.d.log.info('channel connected', { channel: name, provider: cfg.provider });
      return conn;
    } catch (e) {
      if (this.entries.get(name) === entry) {
        entry.status = 'error';
        entry.error = errMsg(e);
        this.emit(cfg.name);
      }
      this.d.log.warn('channel connect failed', { channel: name, error: errMsg(e) });
      throw e;
    }
  }

  private async pump(entry: Entry, conn: ChannelConn): Promise<void> {
    try {
      for await (const raw of conn.inbound()) {
        if (entry.conn !== conn) break;
        const parsed = InboundMsg.safeParse(raw);
        if (!parsed.success) {
          this.d.log.warn('dropping malformed inbound message', { channel: conn.name });
          continue;
        }
        try {
          await this.d.router.handle(conn, parsed.data);
        } catch (e) {
          this.d.log.error('inbound handling failed', { channel: conn.name, error: errMsg(e) });
        }
      }
    } catch (e) {
      if (entry.conn === conn) {
        entry.status = 'error';
        entry.error = errMsg(e);
        this.emit(entry.cfg.name);
      }
    }
  }

  async disconnect(name: string): Promise<void> {
    const e = this.entries.get(name);
    if (!e) return;
    this.entries.delete(name);
    if (!e.agent && isAgentKeyed(e.cfg))
      await Promise.all(
        this.children(e.cfg.name).map((k) => this.disconnect(agentConnName(k.cfg.name, k.agent!))),
      );
    const conn = e.conn;
    e.conn = undefined;
    e.status = 'disconnected';
    if (conn) await conn.close().catch(() => {});
    if (e.agent) return;
    const cfg = this.d.config.channels.get(name);
    if (cfg) this.d.emit({ type: 'channel.updated', channel: this.view(cfg) });
  }
}
