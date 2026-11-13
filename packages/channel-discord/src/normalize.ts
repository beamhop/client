import type { Attachment, InboundMsg } from '@beamhop/core';
import { ChannelType, type Message, MessageType } from 'discord.js';

/**
 * discord.js `Message` → InboundMsg.
 *
 * Gateway MESSAGE_CREATE: https://discord.com/developers/docs/topics/gateway-events#message-create
 * Message object: https://discord.com/developers/docs/resources/message#message-object
 *  - DMs: channel type DM (1); guild text: GUILD_TEXT (0) / GUILD_ANNOUNCEMENT (5)
 *  - Threads (10/11/12) are channels with `parent_id` → conversation = parent, threadId = thread id
 *  - Replies carry `message_reference` + `referenced_message` (discord.js: `mentions.repliedUser`)
 */

export interface DiscordSelf {
  id: string;
  name: string;
}

export interface NormalizeOptions {
  channelName: string;
  self: DiscordSelf;
  meshPeers?: ReadonlySet<string>;
  now?: () => Date;
}

export type NormalizeResult =
  | { ok: true; msg: InboundMsg; guildId: string | null }
  | { ok: false; reason: string };

const CONTENT_TYPES = new Set<number>([MessageType.Default, MessageType.Reply]);

const THREAD_TYPES = new Set<number>([
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
]);

export const normalizeDiscordMessage = (message: Message, opts: NormalizeOptions): NormalizeResult => {
  const { self } = opts;
  if (message.author.id === self.id) return { ok: false, reason: 'self' };
  if (message.system || !CONTENT_TYPES.has(message.type))
    return { ok: false, reason: `type:${message.type}` };
  const isBot = message.author.bot || message.webhookId != null;
  if (isBot && !(opts.meshPeers?.has(message.author.id) ?? false)) return { ok: false, reason: 'bot' };

  const channel = message.channel;
  const channelType = channel?.type;
  const isDm =
    channelType === ChannelType.DM || channelType === ChannelType.GroupDM || message.guildId == null;
  const isThread = channelType !== undefined && THREAD_TYPES.has(channelType);
  const parentId = isThread ? ((channel as { parentId?: string | null }).parentId ?? undefined) : undefined;

  const conversationId = isThread && parentId ? parentId : message.channelId;
  const threadId = message.channelId; // thread channel id for threads; channel id otherwise
  const title = !isDm ? ((channel as { name?: string }).name ?? undefined) : undefined;
  const parentTitle =
    isThread && parentId ? (message.guild?.channels.cache.get(parentId)?.name ?? undefined) : undefined;

  const content = message.content ?? '';
  const mentionRe = new RegExp(`<@!?${self.id}>`, 'g');
  const roleMention = message.mentions.roles.some((r) => r.tags?.botId === self.id);
  const mentionsAgent = mentionRe.test(content) || roleMention;
  const text = content.replace(new RegExp(`<@!?${self.id}>`, 'g'), `@${self.name}`).trim();

  const replyToAgent = message.reference?.messageId != null && message.mentions.repliedUser?.id === self.id;

  const attachments: Attachment[] = [...message.attachments.values()].map((a) => ({
    name: a.name,
    mime: a.contentType ?? 'application/octet-stream',
    size: a.size,
    // CDN URL (signed, expiring); fetched through the broker (PLAN §3.3).
    url: a.url,
  }));

  const displayName = message.member?.displayName ?? message.author.globalName ?? message.author.username;

  const msg: InboundMsg = {
    id: message.id,
    channel: opts.channelName,
    provider: 'discord',
    conversation: {
      kind: isDm ? 'dm' : 'channel',
      id: conversationId,
      ...((parentTitle ?? title) ? { title: parentTitle ?? title } : {}),
    },
    threadId,
    from: { principal: `discord:${message.author.id}`, displayName, isBot },
    text,
    attachments,
    mentionsAgent,
    replyToAgent,
    ...(message.reference?.messageId ? { replyToId: message.reference.messageId } : {}),
    hops: 0,
    receivedAt: (opts.now?.() ?? new Date()).toISOString(),
    raw: { id: message.id, channelId: message.channelId, guildId: message.guildId },
  };
  return { ok: true, msg, guildId: message.guildId };
};
