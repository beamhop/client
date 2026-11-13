import { z } from 'zod';

export const Attachment = z.object({
  name: z.string(),
  mime: z.string(),
  size: z.number().int().nonnegative().optional(),
  /** Remote URL (Blossom/NIP-96/provider file URL). Fetched through the broker, never from the sandbox. */
  url: z.string().optional(),
  /** Local path once downloaded into the session inbox. */
  localPath: z.string().optional(),
  sha256: z.string().optional(),
});
export type Attachment = z.infer<typeof Attachment>;

/** Normalized inbound message from any channel (§5 "Common mapping"). */
export const InboundMsg = z.object({
  id: z.string(),
  /** Channel instance name (e.g. "mybot") */
  channel: z.string(),
  provider: z.string(),
  /** Conversation kind + id, e.g. kind "dm", id "<chat id>" */
  conversation: z.object({
    kind: z.enum(['dm', 'group', 'channel', 'public']),
    id: z.string(),
    title: z.string().optional(),
  }),
  /** Thread id inside the conversation (reply chain root). Defaults to conversation id for DMs. */
  threadId: z.string(),
  from: z.object({
    principal: z.string(),
    displayName: z.string().optional(),
    isBot: z.boolean().default(false),
  }),
  text: z.string(),
  attachments: z.array(Attachment).default([]),
  /** Did this message @mention the agent? */
  mentionsAgent: z.boolean().default(false),
  /** Is this a reply to one of the agent's messages? */
  replyToAgent: z.boolean().default(false),
  replyToId: z.string().optional(),
  /** Mesh hop count carried by agent-to-agent messages (§6A.6). */
  hops: z.number().int().nonnegative().default(0),
  receivedAt: z.string(),
  /** Provider-specific raw payload, for debugging only. */
  raw: z.unknown().optional(),
});
export type InboundMsg = z.infer<typeof InboundMsg>;
export type InboundMsgInput = z.input<typeof InboundMsg>;

export const Button = z.object({
  id: z.string(),
  label: z.string(),
  style: z.enum(['primary', 'danger', 'default']).default('default'),
});
export type Button = z.infer<typeof Button>;

/** Outbound message. `markdown` is rendered per channel by the plugin (§3.3). */
export const OutboundMsg = z.object({
  conversation: z.object({ kind: z.enum(['dm', 'group', 'channel', 'public']), id: z.string() }),
  threadId: z.string().optional(),
  replyToId: z.string().optional(),
  markdown: z.string(),
  attachments: z.array(Attachment).default([]),
  buttons: z.array(Button).default([]),
  hops: z.number().int().nonnegative().optional(),
});
export type OutboundMsg = z.infer<typeof OutboundMsg>;
export type OutboundMsgInput = z.input<typeof OutboundMsg>;

/** A sent message handle; `edit` may be unsupported (Nostr). */
export interface SentMessage {
  id: string;
  /** Live-edit the message (throttled by the caller). */
  edit?(markdown: string): Promise<void>;
}

export interface ButtonPress {
  messageId: string;
  buttonId: string;
  principal: string;
  conversationId: string;
}
