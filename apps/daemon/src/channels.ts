/** Channel connections: connect enabled channels, pump inbound messages into the router. */
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
}

export const channelSecretName = (channel: string, field: string): string => `channel.${channel}.${field}`;

export class ChannelManager {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly d: Daemon) {}

  get(name: string): ChannelConn | undefined {
    return this.entries.get(name)?.conn;
  }

  connected(): ChannelConn[] {
    return [...this.entries.values()].flatMap((e) => (e.conn ? [e.conn] : []));
  }

  view(cfg: ChannelConfig): ChannelView {
    const e = this.entries.get(cfg.name);
    const v: ChannelView = { config: cfg, status: cfg.enabled ? (e?.status ?? 'disconnected') : 'disabled' };
    if (e?.conn) v.self = { ...e.conn.self };
    if (e?.error) v.error = e.error;
    return v;
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

  async connect(cfg: ChannelConfig): Promise<ChannelConn> {
    if (this.d.isPanic()) throw new BeamhopError('unavailable', 'panic mode is active');
    await this.disconnect(cfg.name);
    const plugin = this.d.registry.channel(cfg.provider);
    const entry: Entry = { cfg, status: 'connecting' };
    this.entries.set(cfg.name, entry);
    if (!plugin) {
      entry.status = 'error';
      entry.error = `channel provider "${cfg.provider}" is not installed`;
      this.emit(cfg.name);
      throw new BeamhopError('unavailable', entry.error);
    }
    this.emit(cfg.name);
    try {
      const conn = await plugin.connect({
        name: cfg.name,
        settings: cfg.settings,
        secrets: await this.secretsFor(cfg),
        log: this.d.log.child({ channel: cfg.name }),
        state: this.d.store.kv.namespace(`channel:${cfg.name}`),
      });
      if (this.entries.get(cfg.name) !== entry) {
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
      this.d.log.info('channel connected', { channel: cfg.name, provider: cfg.provider });
      return conn;
    } catch (e) {
      if (this.entries.get(cfg.name) === entry) {
        entry.status = 'error';
        entry.error = errMsg(e);
        this.emit(cfg.name);
      }
      this.d.log.warn('channel connect failed', { channel: cfg.name, error: errMsg(e) });
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
        this.emit(conn.name);
      }
    }
  }

  async disconnect(name: string): Promise<void> {
    const e = this.entries.get(name);
    if (!e) return;
    this.entries.delete(name);
    const conn = e.conn;
    e.conn = undefined;
    e.status = 'disconnected';
    if (conn) await conn.close().catch(() => {});
    const cfg = this.d.config.channels.get(name);
    if (cfg) this.d.emit({ type: 'channel.updated', channel: this.view(cfg) });
  }
}
