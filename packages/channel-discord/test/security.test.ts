// Security review wave B: Discord identity (fuzzed gateway packets), outbound hardening.
import type { InboundMsg, KV } from '@beamhop/core';
import { silentLogger } from '@beamhop/core';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DiscordConn } from '../src/conn.ts';
import { createDiscordPlugin } from '../src/plugin.ts';
import * as h from './harness.ts';

const memKV = (): KV => {
  const m = new Map<string, unknown>();
  return {
    get: async <T>(k: string) => m.get(k) as T | undefined,
    set: async (k, v) => void m.set(k, v),
    delete: async (k) => void m.delete(k),
  };
};

let fake: h.FakeDiscord;
let conn: DiscordConn;
let next: () => Promise<InboundMsg>;
let marker = 0;
const MARKER_AUTHOR = { ...h.aliceUser, id: '1888888888888888888', username: 'marker', bot: false };

beforeAll(async () => {
  fake = new h.FakeDiscord();
  conn = (await createDiscordPlugin({ clientFactory: fake.factory }).connect({
    name: 'acme',
    settings: { meshPeers: [h.PEER_BOT] },
    secrets: { botToken: h.TOKEN },
    log: silentLogger,
    state: memKV(),
  })) as DiscordConn;
  const iter = conn.inbound()[Symbol.asyncIterator]();
  next = async () => {
    const r = await iter.next();
    if (r.done) throw new Error('closed');
    return r.value;
  };
});
afterAll(async () => {
  await conn.close();
});

/** Dispatch one packet and return what (if anything) came out of the normalizer. */
const deliver = async (p: Record<string, unknown>): Promise<InboundMsg | undefined> => {
  const tag = `__marker_${marker++}__`;
  fake.dispatch('MESSAGE_CREATE', p);
  // The marker has its own author with an explicit bot flag: fuzzed packets may re-cache users.
  fake.dispatch('MESSAGE_CREATE', h.messagePayload({ content: tag, author: MARKER_AUTHOR }));
  let got: InboundMsg | undefined;
  for (;;) {
    const m = await next();
    if (m.text === tag) return got;
    got = m;
  }
};

describe('DSC identity', () => {
  it('a webhook message is dropped even when its author object claims a real user id', async () => {
    const m = await deliver(
      h.messagePayload({ webhook_id: '1700000000000000009', author: { ...h.aliceUser, bot: false } }),
    );
    expect(m).toBeUndefined();
  });

  it('attachment file names are reduced to a safe basename', async () => {
    const m = await deliver(
      h.messagePayload({
        attachments: [
          {
            id: h.nextId(),
            filename: '../../.ssh/authorized_keys',
            size: 3,
            url: 'https://cdn.discordapp.com/attachments/1/2/x',
            proxy_url: 'https://media.discordapp.net/attachments/1/2/x',
          },
        ],
      }),
    );
    expect(m?.attachments[0]?.name).toBe('authorized_keys');
  });

  it('property: the principal is always discord:<author id>; bots/webhooks only from mesh peers', async () => {
    const author = fc.record({
      id: fc.constantFrom(h.ALICE, h.PEER_BOT, h.OTHER_BOT, h.BOT_ID, '1999999999999999999'),
      username: fc.string({ unit: 'binary', minLength: 1, maxLength: 20 }),
      global_name: fc.option(fc.string({ unit: 'binary', maxLength: 20 }), { nil: null }),
      discriminator: fc.constant('0'),
      avatar: fc.constant(null),
      bot: fc.option(fc.boolean(), { nil: undefined }),
    });
    await fc.assert(
      fc.asyncProperty(
        author,
        fc.option(fc.constant('1700000000000000009'), { nil: undefined }),
        fc.oneof(fc.string({ unit: 'binary', maxLength: 100 }), fc.constant(`<@${h.BOT_ID}> hi @everyone`)),
        fc.constantFrom(0, 19, 7, 6),
        fc.boolean(),
        async (a, webhook, content, type, dm) => {
          const base = { author: a, content, type, ...(webhook ? { webhook_id: webhook } : {}) };
          const m = await deliver(dm && a.id === h.ALICE ? h.dmPayload(base) : h.messagePayload(base));
          if (!m) return;
          expect(m.from.principal).toBe(`discord:${a.id}`);
          expect(a.id).not.toBe(h.BOT_ID);
          if (a.bot || webhook) expect(a.id).toBe(h.PEER_BOT);
          expect(m.hops).toBe(0);
        },
      ),
      { numRuns: 150, timeout: 2_000 },
    );
  });
});

describe('DSC-1: URL attachments are never fetched from the host', () => {
  it('refuses a URL attachment without a broker fetch', async () => {
    const before = fake.requests.length;
    await expect(
      conn.send({
        conversation: { kind: 'channel', id: h.GENERAL },
        markdown: 'x',
        attachments: [{ name: 'meta', mime: 'text/plain', url: 'http://169.254.169.254/latest/meta-data/' }],
      }),
    ).rejects.toThrow(/broker fetch/);
    expect(fake.requests.length).toBe(before);
  });

  it('every outbound message disables all mention parsing', async () => {
    await conn.send({
      conversation: { kind: 'channel', id: h.GENERAL },
      markdown: '@everyone @here <@&1> <@1>',
    });
    const posts = fake.req('POST', /\/channels\/\d+\/messages$/);
    expect(posts.length).toBeGreaterThan(0);
    for (const p of posts) expect(p.body.allowed_mentions).toEqual({ parse: [] });
  });
});
