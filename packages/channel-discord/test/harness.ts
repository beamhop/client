/**
 * Test harness: a REAL discord.js `Client` with
 *  - the gateway replaced by a fake: `login()` is stubbed and raw dispatch packets are
 *    fed through `client.ws.handlePacket` exactly as the websocket shard would, so
 *    discord.js builds its real Message / Interaction / Guild structures; and
 *  - the HTTP layer replaced via `rest.makeRequest` (official @discordjs/rest hook), so
 *    every REST call is recorded and answered with recorded-shape JSON.
 *
 * Payload shapes follow https://discord.com/developers/docs/topics/gateway-events.
 */
import { Client, type ClientOptions } from 'discord.js';

export const BOT_ID = '1100000000000000001';
export const ALICE = '1200000000000000002';
export const GUILD = '1300000000000000003';
export const BOT_ROLE = '1300000000000000004';
export const GENERAL = '1300000000000000010';
export const RANDOM = '1300000000000000011';
export const THREAD = '1300000000000000020';
export const DM = '1400000000000000004';
export const PEER_BOT = '1500000000000000005';
export const OTHER_BOT = '1500000000000000006';
export const TOKEN = 'MTEwMDAwMDAwMDAwMDAwMDAwMQ.GaBcDe.fakefakefakefakefakefakefakefakefake12';

export const botUser = {
  id: BOT_ID,
  username: 'beamhop-agent',
  global_name: null,
  discriminator: '0000',
  avatar: 'a1b2c3d4e5f6',
  bot: true,
  flags: 0,
};
export const aliceUser = {
  id: ALICE,
  username: 'alice',
  global_name: 'Alice',
  discriminator: '0',
  avatar: null,
  public_flags: 0,
};

let snow = 1600000000000000000n;
export const nextId = () => String(snow++);

const ts = '2026-11-13T00:00:00.000000+00:00';

export const guildCreate = () => ({
  id: GUILD,
  name: 'Acme',
  icon: null,
  owner_id: ALICE,
  afk_timeout: 300,
  verification_level: 1,
  default_message_notifications: 1,
  explicit_content_filter: 0,
  mfa_level: 0,
  nsfw_level: 0,
  premium_tier: 0,
  preferred_locale: 'en-US',
  system_channel_flags: 0,
  features: [],
  roles: [
    {
      id: GUILD,
      name: '@everyone',
      permissions: '1071698660929',
      position: 0,
      color: 0,
      hoist: false,
      managed: false,
      mentionable: false,
      flags: 0,
    },
    {
      id: BOT_ROLE,
      name: 'beamhop-agent',
      permissions: '277025492032',
      position: 1,
      color: 0,
      hoist: false,
      managed: true,
      mentionable: false,
      flags: 0,
      tags: { bot_id: BOT_ID },
    },
  ],
  emojis: [],
  stickers: [],
  channels: [
    {
      id: GENERAL,
      type: 0,
      name: 'general',
      position: 0,
      permission_overwrites: [],
      parent_id: null,
      topic: null,
      nsfw: false,
      rate_limit_per_user: 0,
      last_message_id: null,
      flags: 0,
    },
    {
      id: RANDOM,
      type: 0,
      name: 'random',
      position: 1,
      permission_overwrites: [],
      parent_id: null,
      topic: null,
      nsfw: false,
      rate_limit_per_user: 0,
      last_message_id: null,
      flags: 0,
    },
  ],
  threads: [
    {
      id: THREAD,
      type: 11,
      name: 'PR 42 review',
      guild_id: GUILD,
      parent_id: GENERAL,
      owner_id: ALICE,
      last_message_id: null,
      message_count: 1,
      member_count: 2,
      rate_limit_per_user: 0,
      flags: 0,
      thread_metadata: {
        archived: false,
        auto_archive_duration: 1440,
        archive_timestamp: ts,
        locked: false,
        create_timestamp: ts,
      },
      total_message_sent: 1,
    },
  ],
  members: [],
  member_count: 2,
  presences: [],
  voice_states: [],
  stage_instances: [],
  guild_scheduled_events: [],
  soundboard_sounds: [],
  large: false,
  unavailable: false,
  joined_at: ts,
});

const member = (nick: string | null = null) => ({
  nick,
  avatar: null,
  roles: [],
  joined_at: ts,
  premium_since: null,
  deaf: false,
  mute: false,
  flags: 0,
  pending: false,
});

export const messagePayload = (over: Record<string, unknown> = {}) => ({
  id: nextId(),
  type: 0,
  content: 'hello',
  channel_id: GENERAL,
  guild_id: GUILD,
  author: aliceUser,
  member: member('Ally'),
  attachments: [],
  embeds: [],
  mentions: [],
  mention_roles: [],
  mention_everyone: false,
  pinned: false,
  tts: false,
  timestamp: ts,
  edited_timestamp: null,
  flags: 0,
  components: [],
  nonce: '1234',
  ...over,
});

/** DM MESSAGE_CREATE: no guild_id/member, `channel_type: 1`. */
export const dmPayload = (over: Record<string, unknown> = {}) => {
  const { guild_id: _g, member: _m, ...rest } = messagePayload({ channel_id: DM, ...over });
  return { ...rest, channel_type: 1 };
};

export interface RecordedRequest {
  method: string;
  path: string;
  // biome-ignore lint/suspicious/noExplicitAny: decoded JSON body
  body: any;
  files: string[];
  auth?: string;
}

type Override = {
  method: string;
  path: RegExp;
  times: number;
  respond: (req: RecordedRequest) => Response;
};

export class FakeDiscord {
  requests: RecordedRequest[] = [];
  options?: ClientOptions;
  client?: Client;
  appFlags = 1 << 19;
  private overrides: Override[] = [];
  private seq = 1;

  override(method: string, path: RegExp, respond: (req: RecordedRequest) => Response, times = 1) {
    this.overrides.push({ method, path, respond, times });
    return this;
  }

  req(method: string, path: RegExp) {
    return this.requests.filter((r) => r.method === method && path.test(r.path));
  }

  makeRequest = async (
    url: string,
    init: { method?: string; body?: unknown; headers?: unknown },
  ): Promise<Response> => {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname.replace(/^\/api\/v\d+/, ''));
    const method = (init.method ?? 'GET').toUpperCase();
    let body: unknown;
    const files: string[] = [];
    if (init.body instanceof FormData) {
      for (const [k, v] of init.body.entries()) {
        if (k === 'payload_json') body = JSON.parse(String(v));
        else if (typeof v !== 'string') files.push((v as File).name);
      }
    } else if (typeof init.body === 'string') {
      body = JSON.parse(init.body);
    }
    const headers = new Headers(init.headers as HeadersInit);
    const auth = headers.get('authorization') ?? undefined;
    const rec: RecordedRequest = { method, path, body, files, ...(auth ? { auth } : {}) };
    this.requests.push(rec);

    const o = this.overrides.find((x) => x.method === method && x.path.test(path) && x.times > 0);
    if (o) {
      o.times--;
      return o.respond(rec);
    }
    return this.route(rec);
  };

  private route(r: RecordedRequest): Response {
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    let m: RegExpExecArray | null = /^\/channels\/(\d+)\/messages$/.exec(r.path);
    if (m && r.method === 'POST') {
      return json(
        messagePayload({
          id: nextId(),
          channel_id: m[1],
          guild_id: m[1] === DM ? undefined : GUILD,
          author: botUser,
          member: undefined,
          content: r.body?.content ?? '',
          components: r.body?.components ?? [],
          attachments: r.files.map((f, i) => ({
            id: nextId(),
            filename: f,
            size: 10 + i,
            url: `https://cdn.discordapp.com/attachments/${m?.[1]}/x/${f}`,
            proxy_url: 'x',
          })),
          ...(r.body?.message_reference ? { type: 19, message_reference: r.body.message_reference } : {}),
        }),
      );
    }
    m = /^\/channels\/(\d+)\/messages\/(\d+)$/.exec(r.path);
    if (m && r.method === 'PATCH') {
      return json(
        messagePayload({
          id: m[2],
          channel_id: m[1],
          author: botUser,
          member: undefined,
          content: r.body?.content ?? '',
          components: r.body?.components ?? [],
          edited_timestamp: ts,
        }),
      );
    }
    if (m && r.method === 'DELETE') return new Response(null, { status: 204 });
    if (/^\/channels\/\d+\/typing$/.test(r.path)) return new Response(null, { status: 204 });
    if (/^\/interactions\/\d+\/[^/]+\/callback$/.test(r.path)) return new Response(null, { status: 204 });
    if (r.path === '/users/@me') return json(botUser);
    if (r.path === '/applications/@me')
      return json({ id: BOT_ID, name: 'beamhop-agent', flags: this.appFlags, bot_public: false });
    m = /^\/channels\/(\d+)$/.exec(r.path);
    // GET /channels/{dm id} → DM channel object (https://discord.com/developers/docs/resources/channel#get-channel)
    if (m && r.method === 'GET' && m[1] === DM)
      return json({ id: DM, type: 1, last_message_id: null, flags: 0, recipients: [aliceUser] });
    if (m && r.method === 'GET') return json({ message: 'Unknown Channel', code: 10003 }, 404);
    return json({ message: '404: Not Found', code: 0 }, 404);
  }

  /** Client factory to pass as `clientFactory`. */
  factory = (options: ClientOptions): Client => {
    this.options = options;
    const client = new Client({ ...options, rest: { makeRequest: this.makeRequest as never, offset: 0 } });
    (client as unknown as { login: (t: string) => Promise<string> }).login = async (token: string) => {
      client.token = token;
      client.rest.setToken(token);
      this.dispatch('READY', {
        v: 10,
        user: botUser,
        guilds: [{ id: GUILD, unavailable: true }],
        session_id: 'sess',
        resume_gateway_url: 'wss://gateway.discord.gg',
        application: { id: BOT_ID, flags: this.appFlags },
      });
      this.ws().triggerClientReady();
      this.dispatch('GUILD_CREATE', guildCreate());
      return token;
    };
    this.client = client;
    return client;
  };

  private ws() {
    return (
      this.client as unknown as {
        ws: { handlePacket(p: unknown, s: unknown): void; triggerClientReady(): void };
      }
    ).ws;
  }

  dispatch(t: string, d: unknown) {
    this.ws().handlePacket({ op: 0, t, s: this.seq++, d }, { id: 0, checkReady() {} });
  }
}
