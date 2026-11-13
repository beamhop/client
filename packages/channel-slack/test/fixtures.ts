/**
 * Recorded-shape Slack payloads. Shapes follow the official docs/examples:
 *  - Socket Mode envelope: https://api.slack.com/apis/socket-mode#events
 *  - message.im / message.channels: https://api.slack.com/events/message.im
 *  - app_mention: https://api.slack.com/events/app_mention
 *  - block_actions: https://api.slack.com/reference/interaction-payloads/block-actions
 *  - member_left_channel / channel_left: https://api.slack.com/events/member_left_channel
 */
import { EventEmitter } from 'node:events';
import type { SlackSocketEvent, SlackSocketLike } from '../src/conn.ts';

export const TEAM = 'T0001TEAM';
export const BOT_USER = 'U0BOT0001';
export const BOT_ID = 'B0BOT0001';
export const ALICE = 'U0ALICE01';
export const PEER_BOT_USER = 'U0PEERBOT';
export const PEER_BOT_ID = 'B0PEERBOT';

export const authTest = {
  ok: true,
  url: 'https://acme.slack.com/',
  team: 'Acme',
  user: 'beamhop_agent',
  team_id: TEAM,
  user_id: BOT_USER,
  bot_id: BOT_ID,
  is_enterprise_install: false,
};

export const envelope = (event: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: 'events_api',
  envelope_id: `env-${Math.random().toString(36).slice(2)}`,
  body: {
    token: 'XXYYZZ',
    team_id: TEAM,
    api_app_id: 'A0APP0001',
    event,
    type: 'event_callback',
    event_id: 'Ev0EVENT01',
    event_time: 1700000000,
    authorizations: [{ enterprise_id: null, team_id: TEAM, user_id: BOT_USER, is_bot: true }],
    is_ext_shared_channel: false,
    event_context: '4-eyJldCI6Im1lc3NhZ2UifQ',
  },
  retry_num: 0,
  ...extra,
});

export const dmMessage = {
  client_msg_id: 'b3d1c7a0-0000-4000-8000-000000000001',
  type: 'message',
  text: 'Hello &lt;agent&gt; can you *help* me?',
  user: ALICE,
  ts: '1700000001.000100',
  blocks: [{ type: 'rich_text', block_id: 'abc', elements: [] }],
  team: TEAM,
  channel: 'D0DMCHAN1',
  event_ts: '1700000001.000100',
  channel_type: 'im',
};

export const channelMessageWithMention = {
  client_msg_id: 'b3d1c7a0-0000-4000-8000-000000000002',
  type: 'message',
  text: `<@${BOT_USER}> please review PR 42`,
  user: ALICE,
  ts: '1700000002.000200',
  team: TEAM,
  channel: 'C0GENERAL',
  event_ts: '1700000002.000200',
  channel_type: 'channel',
};

export const appMention = {
  client_msg_id: 'b3d1c7a0-0000-4000-8000-000000000002',
  type: 'app_mention',
  text: `<@${BOT_USER}> please review PR 42`,
  user: ALICE,
  ts: '1700000002.000200',
  team: TEAM,
  channel: 'C0GENERAL',
  event_ts: '1700000002.000200',
};

export const channelChatter = {
  type: 'message',
  text: 'lunch anyone?',
  user: ALICE,
  ts: '1700000003.000300',
  team: TEAM,
  channel: 'C0GENERAL',
  event_ts: '1700000003.000300',
  channel_type: 'channel',
};

export const threadReplyToBot = {
  type: 'message',
  text: 'thanks, now fix the tests too',
  user: ALICE,
  ts: '1700000005.000500',
  thread_ts: '1700000004.000400',
  parent_user_id: BOT_USER,
  team: TEAM,
  channel: 'C0GENERAL',
  event_ts: '1700000005.000500',
  channel_type: 'channel',
};

export const botSelfMessage = {
  type: 'message',
  subtype: 'bot_message',
  text: 'I am the agent',
  ts: '1700000006.000600',
  bot_id: BOT_ID,
  user: BOT_USER,
  bot_profile: { id: BOT_ID, name: 'beamhop agent', app_id: 'A0APP0001', user_id: BOT_USER, team_id: TEAM },
  channel: 'C0GENERAL',
  event_ts: '1700000006.000600',
  channel_type: 'channel',
};

export const otherBotMessage = {
  type: 'message',
  text: `<@${BOT_USER}> status?`,
  ts: '1700000007.000700',
  bot_id: 'B0RANDOM1',
  user: 'U0RANDOM1',
  bot_profile: { id: 'B0RANDOM1', name: 'Jira', app_id: 'A0JIRA', user_id: 'U0RANDOM1', team_id: TEAM },
  team: TEAM,
  channel: 'C0GENERAL',
  event_ts: '1700000007.000700',
  channel_type: 'channel',
};

export const peerBotMessage = {
  type: 'message',
  text: `<@${BOT_USER}> can you summarise the thread?`,
  ts: '1700000008.000800',
  bot_id: PEER_BOT_ID,
  user: PEER_BOT_USER,
  app_id: 'A0PEERAPP',
  bot_profile: {
    id: PEER_BOT_ID,
    name: 'peer agent',
    app_id: 'A0PEERAPP',
    user_id: PEER_BOT_USER,
    team_id: TEAM,
  },
  metadata: { event_type: 'beamhop_mesh', event_payload: { hops: 2 } },
  team: TEAM,
  channel: 'C0GENERAL',
  event_ts: '1700000008.000800',
  channel_type: 'channel',
};

export const messageChanged = {
  type: 'message',
  subtype: 'message_changed',
  hidden: true,
  channel: 'C0GENERAL',
  ts: '1700000009.000900',
  message: { type: 'message', user: ALICE, text: 'edited', ts: '1700000002.000200' },
  event_ts: '1700000009.000900',
  channel_type: 'channel',
};

export const fileShare = {
  type: 'message',
  subtype: 'file_share',
  text: 'here is the log',
  user: ALICE,
  ts: '1700000010.001000',
  channel: 'D0DMCHAN1',
  channel_type: 'im',
  team: TEAM,
  files: [
    {
      id: 'F0FILE0001',
      created: 1700000010,
      name: 'build.log',
      title: 'build.log',
      mimetype: 'text/plain',
      filetype: 'text',
      size: 2048,
      url_private: 'https://files.slack.com/files-pri/T0001TEAM-F0FILE0001/build.log',
      url_private_download: 'https://files.slack.com/files-pri/T0001TEAM-F0FILE0001/download/build.log',
    },
  ],
};

export const mpimMessage = {
  type: 'message',
  text: 'group dm',
  user: ALICE,
  ts: '1700000011.001100',
  channel: 'G0MPIM0001',
  channel_type: 'mpim',
  team: TEAM,
};

export const memberLeftChannel = {
  type: 'member_left_channel',
  user: BOT_USER,
  channel: 'C0GENERAL',
  channel_type: 'C',
  team: TEAM,
  event_ts: '1700000020.000000',
};

export const memberLeftOther = { ...memberLeftChannel, user: ALICE };

export const channelLeft = {
  type: 'channel_left',
  channel: 'C0PRIVATE',
  actor_id: ALICE,
  event_ts: '1700000021.000000',
};

export const blockActions = (messageTs: string, value: string, channel = 'C0GENERAL') => ({
  type: 'interactive',
  envelope_id: 'env-interactive',
  body: {
    type: 'block_actions',
    user: { id: ALICE, username: 'alice', name: 'alice', team_id: TEAM },
    api_app_id: 'A0APP0001',
    token: 'XXYYZZ',
    container: { type: 'message', message_ts: messageTs, channel_id: channel, is_ephemeral: false },
    trigger_id: '123.456.abc',
    team: { id: TEAM, domain: 'acme' },
    enterprise: null,
    is_enterprise_install: false,
    channel: { id: channel, name: 'general' },
    message: { type: 'message', ts: messageTs, bot_id: BOT_ID, text: 'Approve?' },
    response_url: 'https://hooks.slack.com/actions/T0001TEAM/1/abc',
    actions: [
      {
        action_id: `bh:0:${value}`,
        block_id: 'bh_actions_0',
        text: { type: 'plain_text', text: 'Approve', emoji: true },
        value,
        style: 'primary',
        type: 'button',
        action_ts: '1700000030.000000',
      },
    ],
  },
});

/** Fake Socket Mode client: an EventEmitter that records acks. */
export class FakeSocket extends EventEmitter implements SlackSocketLike {
  started = false;
  disconnected = false;
  acks: string[] = [];
  async start() {
    this.started = true;
    return {};
  }
  async disconnect() {
    this.disconnected = true;
  }
  /** Deliver an envelope the way SocketModeClient emits `slack_event`. */
  deliver(env: { type: string; envelope_id?: string; body: unknown; retry_num?: number }): SlackSocketEvent {
    const e: SlackSocketEvent = {
      ...env,
      ack: async () => {
        this.acks.push(env.envelope_id ?? '');
      },
    };
    this.emit('slack_event', e);
    return e;
  }
}

export interface RecordedCall {
  method: string;
  args: Record<string, string>;
  auth?: string;
}

type Responder = (args: Record<string, string>, n: number) => Response | Record<string, unknown>;

/** Fake Slack Web API: routes by method name, records form-decoded args. */
export class FakeSlackHttp {
  calls: RecordedCall[] = [];
  uploads: { url: string; bytes: number }[] = [];
  private routes = new Map<string, Responder>();
  private counts = new Map<string, number>();
  private tsCounter = 100;

  constructor() {
    this.on('auth.test', () => authTest);
    this.on('apps.connections.open', () => ({ ok: true, url: 'wss://wss-primary.slack.com/link/?ticket=x' }));
    this.on('users.info', (a) => ({
      ok: true,
      user: {
        id: a.user,
        name: 'alice',
        real_name: 'Alice Liddell',
        profile: { display_name: 'alice', image_72: 'https://avatars.slack-edge.com/a_72.png' },
      },
    }));
    this.on('chat.postMessage', (a) => ({
      ok: true,
      channel: a.channel,
      ts: `1700000100.${String(this.tsCounter++).padStart(6, '0')}`,
      message: { text: a.text },
    }));
    this.on('chat.update', (a) => ({ ok: true, channel: a.channel, ts: a.ts, text: a.text }));
    this.on('chat.delete', (a) => ({ ok: true, channel: a.channel, ts: a.ts }));
    this.on('reactions.add', () => ({ ok: true }));
    this.on('reactions.remove', () => ({ ok: true }));
    this.on('files.getUploadURLExternal', () => ({
      ok: true,
      upload_url: 'https://files.slack.com/upload/v1/ABC',
      file_id: 'F0UPLOAD01',
    }));
    this.on('files.completeUploadExternal', () => ({ ok: true, files: [{ id: 'F0UPLOAD01', title: 'x' }] }));
  }

  on(method: string, r: Responder) {
    this.routes.set(method, r);
    return this;
  }

  byMethod(method: string) {
    return this.calls.filter((c) => c.method === method);
  }

  fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    if (input.startsWith('https://files.slack.com/upload/')) {
      const body = init?.body as Uint8Array;
      this.uploads.push({ url: input, bytes: body.byteLength });
      return new Response('OK - 2048', { status: 200 });
    }
    const method = input.replace('https://slack.com/api/', '');
    const args = Object.fromEntries(new URLSearchParams(String(init?.body ?? '')));
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
    this.calls.push({ method, args, ...(auth ? { auth } : {}) });
    const n = (this.counts.get(method) ?? 0) + 1;
    this.counts.set(method, n);
    const r = this.routes.get(method);
    if (!r) return Response.json({ ok: false, error: 'unknown_method' });
    const out = r(args, n);
    return out instanceof Response ? out : Response.json(out);
  };
}
