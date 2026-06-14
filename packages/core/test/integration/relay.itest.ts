/**
 * Integration tests that talk to REAL public Nostr relays.
 * Run with: `bun run test:integration` (kept out of the default unit run
 * because it depends on live network + third-party relay availability).
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { generateKeyPair } from '../../src/keys.js';
import { LocalSigner } from '../../src/signer.js';
import { NostrClient } from '../../src/client.js';
import { RelayPool } from '../../src/relays.js';
import { Kind } from '../../src/types.js';
import type { DirectMessage } from '../../src/types.js';

// A small, generally-reliable relay set for CI-style checks.
const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];

const pools: RelayPool[] = [];
function newClient() {
  const pool = new RelayPool(RELAYS);
  pools.push(pool);
  return new NostrClient({ signer: new LocalSigner(generateKeyPair()), pool });
}

afterAll(() => {
  for (const p of pools) p.destroy();
});

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('real relay round-trips', () => {
  test(
    'publishes a note and reads it back',
    async () => {
      const client = newClient();
      const marker = `verity-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const { event, results } = await client.publishNote(`hello from verity ${marker}`);
      expect(results.some((r) => r.status === 'fulfilled')).toBe(true);

      await delay(1500);
      const notes = await client.fetchNotes({ authors: [event.pubkey] });
      expect(notes.some((n) => n.content.includes(marker))).toBe(true);
    },
    20000,
  );

  test(
    'sends an encrypted DM that the recipient can read',
    async () => {
      const alice = newClient();
      const bob = newClient();
      const bobPk = await bob.pubkey();
      const secret = `dm-secret-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      await alice.sendDirectMessage(bobPk, secret);

      // Poll bob's inbox.
      let received: DirectMessage[] = [];
      for (let i = 0; i < 8 && !received.some((m) => m.content === secret); i++) {
        await delay(1500);
        received = await bob.fetchDirectMessages();
      }
      expect(received.some((m) => m.content === secret)).toBe(true);
      const msg = received.find((m) => m.content === secret)!;
      expect(msg.from).toBe(await alice.pubkey());
    },
    40000,
  );

  test(
    'publishes and reads a profile',
    async () => {
      const client = newClient();
      const name = `Verity Tester ${Date.now()}`;
      await client.setProfile({ name, about: 'integration test profile' });
      await delay(1500);
      let profile = await client.fetchProfile(await client.pubkey());
      for (let i = 0; i < 5 && !profile; i++) {
        await delay(1500);
        profile = await client.fetchProfile(await client.pubkey());
      }
      expect(profile?.metadata.name).toBe(name);
    },
    30000,
  );

  test(
    'reposts and likes reference the target event',
    async () => {
      const client = newClient();
      const { event } = await client.publishNote(`target ${Date.now()}`);
      const like = await client.like(event);
      const repost = await client.repost(event);
      expect(like.event.kind).toBe(Kind.Reaction);
      expect(repost.event.kind).toBe(Kind.Repost);
      expect(like.event.tags.some((t) => t[0] === 'e' && t[1] === event.id)).toBe(true);
      expect(repost.event.tags.some((t) => t[0] === 'e' && t[1] === event.id)).toBe(true);
    },
    20000,
  );
});
