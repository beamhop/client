import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  type Attachment,
  BeamhopError,
  type Button,
  type ButtonPress,
  type ChannelConn,
  type InboundMsg,
  type Logger,
  OutboundMsg,
  type OutboundMsgInput,
  type SentMessage,
} from '@beamhop/core';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Client,
  Events,
  type Guild,
  type Interaction,
  type Message,
  type MessageCreateOptions,
  type MessageEditOptions,
} from 'discord.js';
import { markdownToDiscord } from './format.ts';
import { type DiscordSelf, normalizeDiscordMessage } from './normalize.ts';
import { AsyncQueue } from './queue.ts';
import { splitText } from './split.ts';

/**
 * Limits (https://discord.com/developers/docs/resources/message#create-message,
 * https://discord.com/developers/docs/interactions/message-components):
 * content ≤ 2000 chars; ≤ 10 files per message; ≤ 5 action rows × 5 buttons;
 * custom_id ≤ 100 chars; button label ≤ 80 chars.
 */
export const DISCORD_CHUNK_LIMIT = 2000;
const MAX_FILES_PER_MESSAGE = 10;
const MAX_BUTTONS = 25;
const CUSTOM_ID_PREFIX = 'bh:';

/** Never ping anyone from agent output (no @everyone/@here, users or roles). */
export const NO_MENTIONS = { parse: [] as never[] };

const STYLE: Record<Button['style'], ButtonStyle> = {
  primary: ButtonStyle.Primary,
  danger: ButtonStyle.Danger,
  default: ButtonStyle.Secondary,
};

const clamp = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

type SendableLike = {
  id: string;
  send(options: MessageCreateOptions): Promise<Message>;
  sendTyping(): Promise<void>;
};

export interface DiscordConnDeps {
  name: string;
  client: Client;
  self: DiscordSelf;
  log: Logger;
  meshPeers?: string[];
  /**
   * Fetches `Attachment.url` for upload. No default: a plain `fetch` runs on the host, outside the
   * sandbox, so an agent-chosen URL (loopback, metadata, LAN) would be read and posted. The daemon
   * passes a broker-backed fetch; without one, URL attachments are refused.
   */
  fetchAttachment?: (url: string) => Promise<Response>;
  readFile?: (path: string) => Promise<Uint8Array>;
  now?: () => Date;
}

export class DiscordConn implements ChannelConn {
  readonly name: string;
  readonly provider = 'discord';
  readonly self: ChannelConn['self'];
  readonly capabilities = { edit: true, buttons: true, typing: true, files: true, threads: true };

  private readonly queue = new AsyncQueue<InboundMsg>();
  private readonly buttonHandlers: ((p: ButtonPress) => void)[] = [];
  private readonly removedHandlers: ((id: string) => void)[] = [];
  /** custom_id → button id, for ids too long to inline in custom_id. */
  private readonly longIds = new Map<string, string>();
  /** message id carrying buttons → logical SentMessage.id. */
  private readonly buttonOwners = new Map<string, string>();
  /** conversation id → channel id of the latest inbound (thread or channel), for typing. */
  private readonly lastChannel = new Map<string, string>();
  /** guild id → conversation ids seen there. */
  private readonly guildConversations = new Map<string, Set<string>>();
  private readonly peers: ReadonlySet<string>;
  private closed = false;

  constructor(private readonly d: DiscordConnDeps) {
    this.name = d.name;
    this.self = { principal: `discord:${d.self.id}`, displayName: d.self.name, handle: `<@${d.self.id}>` };
    this.peers = new Set(d.meshPeers ?? []);
    const c = d.client;
    c.on(Events.MessageCreate, (m) => this.onMessage(m));
    c.on(Events.InteractionCreate, (i) => {
      void this.onInteraction(i).catch((err) =>
        d.log.warn('discord interaction failed', { err: String(err) }),
      );
    });
    // discord.js drops a guild's channels from its caches *before* emitting guildDelete,
    // so keep our own snapshot of channel ids per guild.
    for (const g of c.guilds.cache.values()) this.snapshotGuild(g);
    c.on(Events.GuildCreate, (g) => this.snapshotGuild(g));
    c.on(Events.GuildAvailable, (g) => this.snapshotGuild(g));
    c.on(Events.ChannelCreate, (ch) => this.trackConversation(ch.guildId, ch.id));
    c.on(Events.GuildDelete, (g) => this.onGuildDelete(g));
    c.on(Events.ChannelDelete, (ch) => {
      if ('guildId' in ch && ch.guildId) this.guildConversations.get(ch.guildId)?.delete(ch.id);
      this.removed(ch.id);
    });
    c.on(Events.Error, (err) => d.log.error('discord client error', { err: String(err) }));
  }

  inbound(): AsyncIterable<InboundMsg> {
    return this.queue;
  }

  onButton(handler: (press: ButtonPress) => void): void {
    this.buttonHandlers.push(handler);
  }

  onRemoved(handler: (conversationId: string) => void): void {
    this.removedHandlers.push(handler);
  }

  // ───────────── inbound ─────────────

  private onMessage(message: Message) {
    if (this.closed) return;
    const r = normalizeDiscordMessage(message, {
      channelName: this.name,
      self: this.d.self,
      meshPeers: this.peers,
      ...(this.d.now ? { now: this.d.now } : {}),
    });
    if (!r.ok) {
      this.d.log.debug('discord message ignored', { reason: r.reason });
      return;
    }
    this.lastChannel.set(r.msg.conversation.id, message.channelId);
    if (r.guildId) this.trackConversation(r.guildId, r.msg.conversation.id);
    this.queue.push(r.msg);
  }

  private trackConversation(guildId: string | null, conversationId: string) {
    if (!guildId) return;
    let set = this.guildConversations.get(guildId);
    if (!set) {
      set = new Set();
      this.guildConversations.set(guildId, set);
    }
    set.add(conversationId);
  }

  private snapshotGuild(guild: Guild) {
    for (const ch of guild.channels.cache.values()) {
      if (!ch.isThread()) this.trackConversation(guild.id, ch.id);
    }
  }

  private async onInteraction(i: Interaction) {
    if (this.closed || !i.isButton()) return;
    const id = i.customId;
    if (!id.startsWith(CUSTOM_ID_PREFIX) && !id.startsWith('bh#')) return;
    const buttonId = id.startsWith('bh#') ? this.longIds.get(id) : id.slice(CUSTOM_ID_PREFIX.length);
    // Acknowledge within 3 s (https://discord.com/developers/docs/interactions/receiving-and-responding).
    await i
      .deferUpdate()
      .catch((err) => this.d.log.debug('discord deferUpdate failed', { err: String(err) }));
    if (buttonId === undefined) return;
    const ch = i.channel;
    const conversationId = ch?.isThread() ? (ch.parentId ?? i.channelId) : i.channelId;
    const press: ButtonPress = {
      messageId: this.buttonOwners.get(i.message.id) ?? i.message.id,
      buttonId,
      principal: `discord:${i.user.id}`,
      conversationId,
    };
    for (const h of this.buttonHandlers) h(press);
  }

  private onGuildDelete(guild: Guild) {
    // discord.js emits guildDelete only for real removals (kick/ban/leave/deleted);
    // outages surface as guildUnavailable instead. https://discord.com/developers/docs/topics/gateway-events#guild-delete
    if (guild.available === false) return;
    const ids = new Set(this.guildConversations.get(guild.id) ?? []);
    for (const ch of guild.channels.cache.values()) if (!ch.isThread()) ids.add(ch.id);
    this.guildConversations.delete(guild.id);
    this.d.log.info('discord: removed from guild', { guildId: guild.id });
    for (const id of ids) this.removed(id);
  }

  private removed(conversationId: string) {
    for (const h of this.removedHandlers) h(conversationId);
  }

  // ───────────── outbound ─────────────

  private customId(buttonId: string): string {
    const direct = `${CUSTOM_ID_PREFIX}${buttonId}`;
    if (direct.length <= 100) return direct;
    const hashed = `bh#${createHash('sha256').update(buttonId).digest('hex').slice(0, 40)}`;
    this.longIds.set(hashed, buttonId);
    return hashed;
  }

  private components(buttons: Button[]) {
    if (buttons.length > MAX_BUTTONS)
      this.d.log.warn('discord: too many buttons, truncating', { n: buttons.length });
    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    buttons.slice(0, MAX_BUTTONS).forEach((b, i) => {
      if (i % 5 === 0) rows.push(new ActionRowBuilder<ButtonBuilder>());
      rows[rows.length - 1]?.addComponents(
        new ButtonBuilder()
          .setCustomId(this.customId(b.id))
          .setLabel(clamp(b.label, 80))
          .setStyle(STYLE[b.style]),
      );
    });
    return rows;
  }

  private async channel(id: string): Promise<SendableLike> {
    const ch = await this.d.client.channels.fetch(id).catch((err) => {
      throw new BeamhopError('not_found', `discord channel ${id} not found`, { cause: String(err) });
    });
    if (!ch?.isSendable()) throw new BeamhopError('invalid_input', `discord channel ${id} is not sendable`);
    return ch as unknown as SendableLike;
  }

  private async files(atts: Attachment[]) {
    const out: { attachment: Buffer | string; name: string }[] = [];
    for (const a of atts) {
      if (a.localPath) {
        out.push({
          attachment: Buffer.from(await (this.d.readFile ?? readFile)(a.localPath)),
          name: a.name || basename(a.localPath),
        });
      } else if (a.url) {
        if (!this.d.fetchAttachment)
          throw new BeamhopError(
            'invalid_input',
            `attachment ${a.name}: URL attachments need a broker fetch (fetchAttachment); refusing to fetch from the host`,
          );
        const res = await this.d.fetchAttachment(a.url);
        if (!res.ok) throw new BeamhopError('unavailable', `attachment fetch failed: HTTP ${res.status}`);
        out.push({ attachment: Buffer.from(await res.arrayBuffer()), name: a.name || 'file' });
      } else {
        throw new BeamhopError('invalid_input', `attachment ${a.name} has neither localPath nor url`);
      }
    }
    return out;
  }

  async typing(conversationId: string): Promise<void> {
    const target = this.lastChannel.get(conversationId) ?? conversationId;
    try {
      await (await this.channel(target)).sendTyping(); // lasts ~10 s or until we send
    } catch (err) {
      this.d.log.debug('discord typing failed', { err: String(err) });
    }
  }

  async send(input: OutboundMsgInput): Promise<SentMessage> {
    if (this.closed) throw new BeamhopError('unavailable', 'discord connection closed');
    const msg = OutboundMsg.parse(input);
    const targetId =
      msg.threadId && msg.threadId !== msg.conversation.id ? msg.threadId : msg.conversation.id;
    const channel = await this.channel(targetId);
    const rows = this.components(msg.buttons);
    const files = await this.files(msg.attachments);

    const chunks = (() => {
      const md = markdownToDiscord(msg.markdown).trim();
      return md ? splitText(md, DISCORD_CHUNK_LIMIT) : [];
    })();
    // Files go on the last text chunk (or on their own when there is no text), ≤10 per message.
    const fileGroups: (typeof files)[] = [];
    for (let i = 0; i < files.length; i += MAX_FILES_PER_MESSAGE)
      fileGroups.push(files.slice(i, i + MAX_FILES_PER_MESSAGE));
    if (chunks.length === 0 && fileGroups.length === 0) chunks.push('…');

    const reply = msg.replyToId ? { reply: { messageReference: msg.replyToId, failIfNotExists: false } } : {};
    /** Text parts (editable). Buttons live on the last one; the first file group rides along with it. */
    const parts: Message[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      parts.push(
        await channel.send({
          content: chunks[i] ?? '',
          allowedMentions: NO_MENTIONS,
          ...(isLast && fileGroups[0] ? { files: fileGroups[0] } : {}),
          ...(isLast && rows.length ? { components: rows } : {}),
          ...(i === 0 ? reply : {}),
        }),
      );
    }
    const fileParts: Message[] = [];
    const rest = chunks.length ? fileGroups.slice(1) : fileGroups;
    for (let i = 0; i < rest.length; i++) {
      const isLast = i === rest.length - 1;
      fileParts.push(
        await channel.send({
          allowedMentions: NO_MENTIONS,
          files: rest[i] ?? [],
          ...(chunks.length === 0 && isLast && rows.length ? { components: rows } : {}),
          ...(chunks.length === 0 && i === 0 ? reply : {}),
        }),
      );
    }

    const id = parts[0]?.id ?? fileParts[0]?.id ?? '';
    const register = () => {
      for (const [k, v] of this.buttonOwners) if (v === id) this.buttonOwners.delete(k);
      const last = parts.at(-1) ?? fileParts.at(-1);
      if (rows.length && last) this.buttonOwners.set(last.id, id);
    };
    register();

    const edit = async (markdown: string) => {
      const md = markdownToDiscord(markdown).trim();
      const next = md ? splitText(md, DISCORD_CHUNK_LIMIT) : ['…'];
      for (let i = 0; i < next.length; i++) {
        const isLast = i === next.length - 1;
        const part = parts[i];
        if (part) {
          const opts: MessageEditOptions = {
            content: next[i] ?? '',
            allowedMentions: NO_MENTIONS,
            components: isLast ? rows : [],
          };
          parts[i] = (await part.edit(opts)) ?? part;
        } else {
          parts.push(
            await channel.send({
              content: next[i] ?? '',
              allowedMentions: NO_MENTIONS,
              ...(isLast && rows.length ? { components: rows } : {}),
            }),
          );
        }
      }
      for (const extra of parts.splice(next.length)) {
        await extra.delete().catch((err) => this.d.log.debug('discord delete failed', { err: String(err) }));
      }
      register();
    };
    return { id, edit };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.queue.close();
    try {
      await this.d.client.destroy();
    } catch (err) {
      this.d.log.debug('discord destroy failed', { err: String(err) });
    }
  }
}
