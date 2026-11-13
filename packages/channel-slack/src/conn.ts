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
import type { FetchLike, SlackApi } from './api.ts';
import { markdownToMrkdwn } from './mrkdwn.ts';
import {
  MESH_EVENT_TYPE,
  normalizeSlackMessage,
  type SlackEventCallback,
  type SlackMessageEvent,
  type SlackSelf,
} from './normalize.ts';
import { AsyncQueue } from './queue.ts';
import { splitText } from './split.ts';

/** What `@slack/socket-mode`'s SocketModeClient emits on `slack_event`. */
export interface SlackSocketEvent {
  ack: (response?: Record<string, unknown>) => Promise<void>;
  envelope_id?: string;
  /** `events_api` | `interactive` | `slash_commands` */
  type: string;
  // biome-ignore lint/suspicious/noExplicitAny: provider payload, narrowed at use sites
  body: any;
  retry_num?: number;
  retry_reason?: string;
}

/** Subset of `SocketModeClient` we use (injectable for tests). */
export interface SlackSocketLike {
  on(event: 'slack_event', listener: (e: SlackSocketEvent) => void): unknown;
  start(): Promise<unknown>;
  disconnect(): Promise<void>;
}

/**
 * Block Kit limits (https://api.slack.com/reference/block-kit/blocks):
 * section text ≤ 3000 chars; actions block ≤ 25 elements; button text ≤ 75 chars,
 * value ≤ 2000 chars, action_id ≤ 255 chars.
 */
export const SLACK_CHUNK_LIMIT = 3000;
const MAX_ACTIONS_PER_BLOCK = 25;
export const TYPING_REACTION = 'hourglass_flowing_sand';

const clamp = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export const buttonBlocks = (buttons: Button[]) => {
  const blocks: Record<string, unknown>[] = [];
  for (let i = 0; i < buttons.length; i += MAX_ACTIONS_PER_BLOCK) {
    blocks.push({
      type: 'actions',
      block_id: `bh_actions_${i / MAX_ACTIONS_PER_BLOCK}`,
      elements: buttons.slice(i, i + MAX_ACTIONS_PER_BLOCK).map((b, j) => ({
        type: 'button',
        action_id: clamp(`bh:${i + j}:${b.id}`, 255),
        text: { type: 'plain_text', text: clamp(b.label, 75), emoji: true },
        value: b.id.slice(0, 2000),
        ...(b.style === 'primary' || b.style === 'danger' ? { style: b.style } : {}),
      })),
    });
  }
  return blocks;
};

export interface SlackConnDeps {
  name: string;
  api: SlackApi;
  socket: SlackSocketLike;
  self: SlackSelf;
  log: Logger;
  meshPeers?: string[];
  fetch?: FetchLike;
  readFile?: (path: string) => Promise<Uint8Array>;
  resolveNames?: boolean;
  now?: () => Date;
}

export class SlackConn implements ChannelConn {
  readonly name: string;
  readonly provider = 'slack';
  readonly self: ChannelConn['self'];
  readonly capabilities = { edit: true, buttons: true, typing: true, files: true, threads: true };

  private readonly queue = new AsyncQueue<InboundMsg>();
  private readonly seen = new Set<string>();
  private readonly buttonHandlers: ((p: ButtonPress) => void)[] = [];
  private readonly removedHandlers: ((id: string) => void)[] = [];
  /** ts of a message carrying buttons → SentMessage.id of the logical message. */
  private readonly buttonOwners = new Map<string, string>();
  private readonly lastInbound = new Map<string, string>();
  private readonly typingOn = new Map<string, string>();
  private readonly names = new Map<string, Promise<string | undefined>>();
  private readonly peers: ReadonlySet<string>;
  private closed = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly d: SlackConnDeps) {
    this.name = d.name;
    this.self = {
      principal: `slack:${d.self.teamId}/${d.self.userId}`,
      displayName: d.self.name,
      handle: `<@${d.self.userId}>`,
    };
    this.peers = new Set(d.meshPeers ?? []);
    d.socket.on('slack_event', (e) => {
      // Process envelopes strictly in arrival order (name lookups are async).
      this.chain = this.chain
        .then(() => this.onSocketEvent(e))
        .catch((err) => d.log.error('slack event handling failed', { err: String(err) }));
    });
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

  /** Exposed for tests; normally driven by the socket. */
  async onSocketEvent(e: SlackSocketEvent): Promise<void> {
    // Socket Mode requires an ack within 3 s or Slack retries the envelope.
    try {
      await e.ack();
    } catch (err) {
      this.d.log.warn('slack ack failed', { err: String(err) });
    }
    if (this.closed) return;
    if (e.type === 'events_api') {
      const body = e.body as SlackEventCallback;
      await this.onEvent(body.event, body);
    } else if (e.type === 'interactive' && e.body?.type === 'block_actions') {
      this.onBlockActions(e.body);
    }
  }

  private markSeen(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > 2000) {
      const first = this.seen.values().next().value;
      if (first !== undefined) this.seen.delete(first);
    }
    return true;
  }

  private async onEvent(event: SlackEventCallback['event'], body: SlackEventCallback): Promise<void> {
    switch (event.type) {
      case 'message':
      case 'app_mention': {
        const ev = event as unknown as SlackMessageEvent;
        // A channel mention arrives twice (message.channels + app_mention): dedupe on channel+ts.
        if (!ev.channel || !ev.ts || !this.markSeen(`${ev.channel}:${ev.ts}`)) return;
        const pre = normalizeSlackMessage(ev, body, {
          channelName: this.name,
          self: this.d.self,
          meshPeers: this.peers,
          ...(this.d.now ? { now: this.d.now } : {}),
        });
        if (!pre.ok) {
          this.d.log.debug('slack message ignored', { reason: pre.reason });
          return;
        }
        const msg = pre.msg;
        if (!msg.from.displayName && ev.user && !msg.from.isBot) {
          const n = await this.lookupName(ev.user);
          if (n) msg.from.displayName = n;
        }
        this.lastInbound.set(msg.conversation.id, ev.ts);
        this.queue.push(msg);
        return;
      }
      case 'member_left_channel': {
        // https://api.slack.com/events/member_left_channel
        if (event.user === this.d.self.userId && typeof event.channel === 'string')
          this.removed(event.channel);
        return;
      }
      case 'channel_left':
      case 'group_left': {
        // https://api.slack.com/events/channel_left — sent to the bot when it is removed.
        if (typeof event.channel === 'string') this.removed(event.channel);
        return;
      }
      default:
        this.d.log.debug('slack event ignored', { type: event.type });
    }
  }

  private removed(channelId: string) {
    this.d.log.info('slack: removed from conversation', { channelId });
    for (const h of this.removedHandlers) h(channelId);
  }

  /** block_actions payload: https://api.slack.com/reference/interaction-payloads/block-actions */
  // biome-ignore lint/suspicious/noExplicitAny: provider payload
  private onBlockActions(body: any) {
    const ts: string | undefined = body.container?.message_ts ?? body.message?.ts;
    const channelId: string | undefined = body.container?.channel_id ?? body.channel?.id;
    const userId: string | undefined = body.user?.id;
    const team: string = body.user?.team_id ?? body.team?.id ?? this.d.self.teamId;
    if (!ts || !channelId || !userId) return;
    for (const a of body.actions ?? []) {
      if (typeof a?.action_id !== 'string' || !a.action_id.startsWith('bh:') || typeof a.value !== 'string')
        continue;
      const press: ButtonPress = {
        messageId: this.buttonOwners.get(ts) ?? ts,
        buttonId: a.value,
        principal: `slack:${team}/${userId}`,
        conversationId: channelId,
      };
      for (const h of this.buttonHandlers) h(press);
    }
  }

  private async lookupName(userId: string): Promise<string | undefined> {
    if (this.d.resolveNames === false) return undefined;
    const cached = this.names.get(userId);
    if (cached) return cached;
    const p = this.fetchName(userId);
    this.names.set(userId, p);
    const n = await p;
    if (!n) this.names.delete(userId);
    if (this.names.size > 5000) this.names.clear();
    return n;
  }

  private async fetchName(userId: string): Promise<string | undefined> {
    try {
      const r = await this.d.api.call<{
        ok: true;
        user?: { name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } };
      }>('users.info', { user: userId });
      const u = r.user;
      return u?.profile?.display_name || u?.real_name || u?.profile?.real_name || u?.name;
    } catch (err) {
      this.d.log.debug('slack users.info failed', { err: String(err) });
      return undefined;
    }
  }

  // ───────────── outbound ─────────────

  async typing(conversationId: string): Promise<void> {
    // Slack has no bot typing indicator outside the legacy RTM API, so we show a
    // :hourglass_flowing_sand: reaction on the latest inbound message and remove it
    // when we reply (reactions.add / reactions.remove, scope reactions:write).
    const ts = this.lastInbound.get(conversationId);
    if (!ts || this.typingOn.get(conversationId) === ts) return;
    try {
      await this.d.api.call('reactions.add', {
        channel: conversationId,
        timestamp: ts,
        name: TYPING_REACTION,
      });
      this.typingOn.set(conversationId, ts);
    } catch (err) {
      if ((err as { slackError?: string }).slackError === 'already_reacted')
        this.typingOn.set(conversationId, ts);
      else this.d.log.debug('slack typing reaction failed', { err: String(err) });
    }
  }

  private async clearTyping(conversationId: string) {
    const ts = this.typingOn.get(conversationId);
    if (!ts) return;
    this.typingOn.delete(conversationId);
    try {
      await this.d.api.call('reactions.remove', {
        channel: conversationId,
        timestamp: ts,
        name: TYPING_REACTION,
      });
    } catch (err) {
      this.d.log.debug('slack typing reaction removal failed', { err: String(err) });
    }
  }

  private chunksFor(markdown: string): string[] {
    const mrk = markdownToMrkdwn(markdown).trim();
    return mrk ? splitText(mrk, SLACK_CHUNK_LIMIT) : [];
  }

  /**
   * `text` is always set (notification/accessibility fallback). Buttons need Block Kit,
   * so the last chunk then also carries a section + actions blocks. On chat.update an
   * empty `blocks` array removes previous blocks (https://api.slack.com/methods/chat.update).
   */
  private payload(chunk: string, isLast: boolean, buttons: Button[], forUpdate = false) {
    const withButtons = isLast && buttons.length > 0;
    if (!withButtons) return forUpdate ? { text: chunk, blocks: [] } : { text: chunk };
    return {
      text: chunk,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: chunk } }, ...buttonBlocks(buttons)],
    };
  }

  async send(input: OutboundMsgInput): Promise<SentMessage> {
    if (this.closed) throw new BeamhopError('unavailable', 'slack connection closed');
    const msg = OutboundMsg.parse(input);
    const channel = msg.conversation.id;
    const threadTs = msg.threadId && msg.threadId !== channel ? msg.threadId : msg.replyToId;
    const metadata =
      msg.hops !== undefined ? { event_type: MESH_EVENT_TYPE, event_payload: { hops: msg.hops } } : undefined;
    await this.clearTyping(channel);

    const chunks = this.chunksFor(msg.markdown);
    if (chunks.length === 0 && msg.attachments.length === 0) chunks.push('…');
    const parts: string[] = [];
    const post = async (chunk: string, isLast: boolean) => {
      const r = await this.d.api.call<{ ok: true; ts: string }>('chat.postMessage', {
        channel,
        ...this.payload(chunk, isLast, msg.buttons),
        thread_ts: threadTs,
        metadata,
        unfurl_links: false,
        unfurl_media: false,
      });
      return r.ts;
    };
    for (let i = 0; i < chunks.length; i++) parts.push(await post(chunks[i] ?? '', i === chunks.length - 1));

    let fileId: string | undefined;
    for (const a of msg.attachments) {
      const up = await this.uploadAttachment(a, channel, threadTs);
      fileId ??= up.fileId;
    }

    const id = parts[0] ?? fileId ?? '';
    const register = () => {
      for (const [k, v] of this.buttonOwners) if (v === id) this.buttonOwners.delete(k);
      const last = parts.at(-1);
      if (msg.buttons.length && last) this.buttonOwners.set(last, id);
    };
    register();

    const edit = async (markdown: string) => {
      const next = this.chunksFor(markdown);
      if (next.length === 0) next.push('…');
      for (let i = 0; i < next.length; i++) {
        const isLast = i === next.length - 1;
        const ts = parts[i];
        if (ts) {
          await this.d.api.call('chat.update', {
            channel,
            ts,
            ...this.payload(next[i] ?? '', isLast, msg.buttons, true),
          });
        } else {
          parts.push(await post(next[i] ?? '', isLast));
        }
      }
      for (const ts of parts.splice(next.length)) {
        await this.d.api.call('chat.delete', { channel, ts }).catch((err) => {
          this.d.log.debug('slack chat.delete failed', { err: String(err) });
        });
      }
      register();
    };
    return parts.length ? { id, edit } : { id };
  }

  private async uploadAttachment(a: Attachment, channelId: string, threadTs: string | undefined) {
    let data: Uint8Array;
    if (a.localPath) {
      data = await (this.d.readFile ?? readFile)(a.localPath);
    } else if (a.url) {
      const res = await (this.d.fetch ?? globalThis.fetch)(a.url);
      if (!res.ok) throw new BeamhopError('unavailable', `attachment fetch failed: HTTP ${res.status}`);
      data = new Uint8Array(await res.arrayBuffer());
    } else {
      throw new BeamhopError('invalid_input', `attachment ${a.name} has neither localPath nor url`);
    }
    const filename = a.name || (a.localPath ? basename(a.localPath) : 'file');
    return this.d.api.uploadFile({ filename, data, channelId, ...(threadTs ? { threadTs } : {}) });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.queue.close();
    try {
      await this.d.socket.disconnect();
    } catch (err) {
      this.d.log.debug('slack socket disconnect failed', { err: String(err) });
    }
  }
}
