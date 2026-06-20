import { describe, expect, test } from "bun:test";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import { NostrClient } from "../src/nostr/client.ts";
import {
  buildContacts,
  buildLongForm,
  buildNote,
  buildReaction,
  buildRepost,
  decodeLongForm,
  decodeNote,
  decodeReaction,
  decodeRepostPointer,
} from "../src/nostr/events.ts";
import { buildDm, decodeDm, encryptDm } from "../src/nostr/dm.ts";
import { Kind } from "../src/nostr/types.ts";
import type { Identity } from "../src/nostr/keys.ts";

/**
 * Live network integration tests for the social graph: reactions, reposts,
 * contacts, encrypted DMs, and long-form replacement. Requires internet and
 * public relays. Run with `bun run test:e2e`.
 */
const RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"];

const localIdentity = (): Identity => {
  const sk = generateSecretKey();
  return { kind: "local", secretKey: sk, pubkey: getPublicKey(sk) };
};

describe("reactions and reposts round-trip", () => {
  test(
    "a note can be liked and reposted, and both resolve back to it",
    async () => {
      const client = new NostrClient();
      const me = localIdentity();

      const note = await client.publish(RELAYS, me, buildNote(`e2e social ${Date.now()}`));
      const decodedNote = decodeNote(note);

      const reaction = await client.publish(RELAYS, me, buildReaction(decodedNote, "🤙"));
      const repost = await client.publish(RELAYS, me, buildRepost(decodedNote));
      await Bun.sleep(1500);

      const likes = await client.list(RELAYS, { kinds: [Kind.Reaction], "#e": [note.id] });
      const decodedReaction = likes.map(decodeReaction).find((r) => r?.id === reaction.id);
      expect(decodedReaction?.targetId).toBe(note.id);
      expect(decodedReaction?.content).toBe("🤙");

      const reposts = await client.list(RELAYS, { kinds: [Kind.Repost], "#e": [note.id] });
      const pointer = reposts.map(decodeRepostPointer).find((p) => p?.noteId === note.id);
      expect(pointer?.noteId).toBe(note.id);
      expect(repost.kind).toBe(Kind.Repost);

      client.close(RELAYS);
    },
    30_000,
  );
});

describe("contacts (follow list)", () => {
  test(
    "a published kind-3 contact list reads back with its p-tags",
    async () => {
      const client = new NostrClient();
      const me = localIdentity();
      const follows = [getPublicKey(generateSecretKey()), getPublicKey(generateSecretKey())];

      await client.publish(RELAYS, me, buildContacts(follows));
      await Bun.sleep(1500);

      const event = await client.get(RELAYS, { kinds: [Kind.Contacts], authors: [me.pubkey] });
      expect(event).not.toBeNull();
      const tagged = (event?.tags ?? []).flatMap((t) => (t[0] === "p" && t[1] ? [t[1]] : []));
      for (const follow of follows) expect(tagged).toContain(follow);

      client.close(RELAYS);
    },
    30_000,
  );
});

describe("encrypted DM round-trip", () => {
  test(
    "alice sends bob an encrypted DM that bob decrypts back to plaintext",
    async () => {
      const client = new NostrClient();
      const alice = localIdentity();
      const bob = localIdentity();
      const message = `e2e secret ${Date.now()}`;

      const ciphertext = await encryptDm(alice, bob.pubkey, message);
      const sent = await client.publish(RELAYS, alice, buildDm(bob.pubkey, ciphertext));
      await Bun.sleep(1500);

      const event = await client.get(RELAYS, { kinds: [Kind.EncryptedDM], ids: [sent.id] });
      expect(event).not.toBeNull();
      if (event) {
        const decoded = await decodeDm(bob, bob.pubkey, event);
        expect(decoded?.content).toBe(message);
        expect(decoded?.fromMe).toBe(false);
      }

      client.close(RELAYS);
    },
    30_000,
  );
});

describe("long-form replacement (NIP-23)", () => {
  test(
    "re-publishing a doc with the same identifier supersedes the original",
    async () => {
      const client = new NostrClient();
      const me = localIdentity();
      const identifier = `e2e-edit-${Date.now()}`;

      await client.publish(
        RELAYS,
        me,
        buildLongForm({ identifier, title: "Draft", summary: "v1", body: "first", hashtags: [], kind: "doc" }),
      );
      await Bun.sleep(1200);
      await client.publish(
        RELAYS,
        me,
        buildLongForm({
          identifier,
          title: "Final",
          summary: "v2",
          body: "second",
          hashtags: ["edited"],
          kind: "doc",
          publishedAt: Math.floor(Date.now() / 1000) + 5,
        }),
      );
      await Bun.sleep(1500);

      const event = await client.get(RELAYS, {
        kinds: [Kind.LongForm],
        "#d": [identifier],
        authors: [me.pubkey],
      });
      expect(event).not.toBeNull();
      if (event) {
        const decoded = decodeLongForm(event);
        expect(decoded.title).toBe("Final");
        expect(decoded.body).toBe("second");
        expect(decoded.hashtags).toContain("edited");
      }

      client.close(RELAYS);
    },
    30_000,
  );
});
