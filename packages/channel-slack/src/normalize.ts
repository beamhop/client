import { type Attachment, type InboundMsg, safeFileName } from '@beamhop/core';
import { decodeSlackEntities } from './mrkdwn.ts';

/**
 * Slack Events API payload shapes (subset we read).
 * - Envelope: https://api.slack.com/apis/socket-mode#events  (`payload` = event_callback)
 * - message: https://api.slack.com/events/message  (+ subtypes, threads: thread_ts/parent_user_id)
 * - app_mention: https://api.slack.com/events/app_mention
 */
export interface SlackFile {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
}

export interface SlackMessageEvent {
  type: 'message' | 'app_mention';
  subtype?: string;
  channel: string;
  channel_type?: 'im' | 'mpim' | 'channel' | 'group' | 'app_home';
  user?: string;
  bot_id?: string;
  bot_profile?: { id?: string; name?: string; user_id?: string; team_id?: string };
  username?: string;
  text?: string;
  ts: string;
  event_ts?: string;
  thread_ts?: string;
  parent_user_id?: string;
  team?: string;
  user_team?: string;
  files?: SlackFile[];
  metadata?: { event_type?: string; event_payload?: Record<string, unknown> };
  hidden?: boolean;
}

export interface SlackEventCallback {
  type: 'event_callback';
  team_id?: string;
  api_app_id?: string;
  event_id?: string;
  event_time?: number;
  event: { type: string; [k: string]: unknown };
}

export interface SlackSelf {
  teamId: string;
  userId: string;
  botId?: string;
  name: string;
}

/** Message subtypes that carry real user content; everything else (edits, joins, deletes…) is ignored. */
export const CONTENT_SUBTYPES = new Set([
  undefined,
  'file_share',
  'thread_broadcast',
  'bot_message',
  'me_message',
]);

export const MESH_EVENT_TYPE = 'beamhop_mesh';

/** Hard ceiling on a peer-supplied hop count (matches the Nostr channel). */
const MAX_HOPS = 1000;

/** Slack team / user / bot ids are short upper-case alphanumerics (T…, U…, W…, B…). */
const SLACK_ID = /^[A-Za-z0-9]{1,32}$/;

export interface NormalizeOptions {
  channelName: string;
  self: SlackSelf;
  /** Slack user ids (U…) or bot ids (B…) of peer agents whose bot messages are accepted. */
  meshPeers?: ReadonlySet<string>;
  displayName?: string;
  now?: () => Date;
}

export type NormalizeResult = { ok: true; msg: InboundMsg } | { ok: false; reason: string };

export const slackConversationKind = (ev: SlackMessageEvent): InboundMsg['conversation']['kind'] => {
  const t = ev.channel_type ?? (ev.channel.startsWith('D') ? 'im' : undefined);
  if (t === 'im' || t === 'app_home') return 'dm';
  if (t === 'mpim') return 'group';
  return 'channel';
};

export const normalizeSlackMessage = (
  ev: SlackMessageEvent,
  envelope: Pick<SlackEventCallback, 'team_id'> | undefined,
  opts: NormalizeOptions,
): NormalizeResult => {
  if (ev.type !== 'message' && ev.type !== 'app_mention') return { ok: false, reason: 'not-a-message' };
  if (!CONTENT_SUBTYPES.has(ev.subtype)) return { ok: false, reason: `subtype:${ev.subtype}` };
  if (ev.hidden) return { ok: false, reason: 'hidden' };

  const { self } = opts;
  const isSelf =
    (ev.user !== undefined && ev.user === self.userId) ||
    (ev.bot_id !== undefined && self.botId !== undefined && ev.bot_id === self.botId) ||
    ev.bot_profile?.user_id === self.userId;
  if (isSelf) return { ok: false, reason: 'self' };

  const isBot = ev.bot_id !== undefined || ev.subtype === 'bot_message';
  const senderId = ev.user ?? ev.bot_profile?.user_id ?? ev.bot_id;
  if (!senderId) return { ok: false, reason: 'no-sender' };
  if (!SLACK_ID.test(senderId)) return { ok: false, reason: 'bad-sender' };
  if (isBot) {
    const peers = opts.meshPeers ?? new Set<string>();
    const peer = [ev.user, ev.bot_id, ev.bot_profile?.user_id].some(
      (id) => id !== undefined && peers.has(id),
    );
    if (!peer) return { ok: false, reason: 'bot' };
  }

  const team = ev.user_team ?? ev.team ?? envelope?.team_id ?? self.teamId;
  if (!SLACK_ID.test(team)) return { ok: false, reason: 'bad-team' };
  const kind = slackConversationKind(ev);
  const raw = typeof ev.text === 'string' ? ev.text : '';
  const selfMention = `<@${self.userId}>`;
  const mentionsAgent =
    ev.type === 'app_mention' || raw.includes(selfMention) || raw.includes(`<@${self.userId}|`);
  const text = decodeSlackEntities(
    raw.replace(new RegExp(`<@${self.userId}(\\|[^>]*)?>`, 'g'), `@${self.name}`),
  ).trim();

  // DMs without a thread form one continuous session (core: threadId defaults to the
  // conversation id for DMs). Elsewhere a top-level message starts a thread rooted at its ts.
  const threadId = ev.thread_ts ?? (kind === 'dm' ? ev.channel : ev.ts);
  const replyToAgent =
    ev.thread_ts !== undefined && ev.thread_ts !== ev.ts && ev.parent_user_id === self.userId;

  const attachments: Attachment[] = (Array.isArray(ev.files) ? ev.files : []).map((f) => ({
    name: safeFileName(String(f.name ?? f.title ?? f.id)),
    mime: f.mimetype ?? 'application/octet-stream',
    ...(f.size !== undefined ? { size: f.size } : {}),
    // Requires the bot token to download; fetched through the broker (PLAN §3.3).
    ...(f.url_private_download || f.url_private ? { url: f.url_private_download ?? f.url_private } : {}),
  }));

  const hopsRaw = ev.metadata?.event_type === MESH_EVENT_TYPE ? ev.metadata.event_payload?.hops : undefined;
  const hops =
    typeof hopsRaw === 'number' && Number.isInteger(hopsRaw) && hopsRaw >= 0
      ? Math.min(hopsRaw, MAX_HOPS)
      : 0;

  const displayName = opts.displayName ?? ev.bot_profile?.name ?? ev.username;
  const msg: InboundMsg = {
    id: ev.ts,
    channel: opts.channelName,
    provider: 'slack',
    conversation: { kind, id: ev.channel },
    threadId,
    from: {
      principal: `slack:${team}/${senderId}`,
      ...(displayName ? { displayName } : {}),
      isBot,
    },
    text,
    attachments,
    mentionsAgent,
    replyToAgent,
    ...(ev.thread_ts && ev.thread_ts !== ev.ts ? { replyToId: ev.thread_ts } : {}),
    hops,
    receivedAt: (opts.now?.() ?? new Date()).toISOString(),
    raw: ev,
  };
  return { ok: true, msg };
};
