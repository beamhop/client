import { describe, expect, test } from "bun:test";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import { NostrClient } from "../src/nostr/client.ts";
import { buildNote, buildLongForm, decodeLongForm } from "../src/nostr/events.ts";
import { Kind } from "../src/nostr/types.ts";

/**
 * Live network integration test — requires internet and public relays. Run with
 * `bun run test:e2e`. Publishes a note and a documentation (NIP-23) and reads
 * them back through the same NostrClient the app uses.
 */
const RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"];

describe("live relay round-trip", () => {
  test(
    "publishes a note and a doc, then fetches them back",
    async () => {
      const sk = generateSecretKey();
      const identity = { kind: "local", secretKey: sk, pubkey: getPublicKey(sk) } as const;
      const client = new NostrClient();

      const note = await client.publish(RELAYS, identity, buildNote(`e2e note ${Date.now()}`));
      const id = `e2e-doc-${Date.now()}`;
      const doc = await client.publish(
        RELAYS,
        identity,
        buildLongForm({
          identifier: id,
          title: "E2E doc",
          summary: "round-trip",
          body: "# Hello from the test",
          hashtags: ["e2e"],
          kind: "doc",
        }),
      );

      await Bun.sleep(1500);

      const backNote = await client.get(RELAYS, { ids: [note.id] });
      expect(backNote?.id).toBe(note.id);

      const backDoc = await client.get(RELAYS, { kinds: [Kind.LongForm], "#d": [id], authors: [doc.pubkey] });
      expect(backDoc).not.toBeNull();
      if (backDoc) {
        const decoded = decodeLongForm(backDoc);
        expect(decoded.kind).toBe("doc");
        expect(decoded.title).toBe("E2E doc");
        expect(decoded.hashtags).toContain("e2e");
      }

      client.close(RELAYS);
    },
    30_000,
  );
});
