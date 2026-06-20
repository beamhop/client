import { describe, expect, test } from "bun:test";
import type { Event as NostrEvent } from "nostr-tools";
import { NostrClient } from "../client.ts";
import { createLocalIdentity } from "../keys.ts";
import { buildLongForm } from "../events.ts";
import { ARTICLE_MARKER, DOC_MARKER, Kind } from "../types.ts";

type FakePool = {
  publish: () => Promise<void>[];
  querySync: () => Promise<NostrEvent[]>;
  get: () => Promise<NostrEvent | null>;
  close: () => void;
};

const setFakePool = (client: NostrClient, pool: FakePool): void => {
  (client as unknown as { pool: FakePool }).pool = pool;
};

describe("NostrClient local publish cache", () => {
  test("includes accepted local publishes in later list/get calls", async () => {
    const client = new NostrClient();
    setFakePool(client, {
      publish: () => [Promise.resolve()],
      querySync: async () => [],
      get: async () => null,
      close: () => undefined,
    });

    const identity = createLocalIdentity();
    const event = await client.publish(
      ["wss://write.example"],
      identity,
      buildLongForm({
        identifier: "local-article",
        title: "Local article",
        summary: "",
        body: "Published locally first",
        hashtags: [],
        kind: "article",
      }),
    );

    await expect(client.list([], { kinds: [Kind.LongForm], "#t": [DOC_MARKER] })).resolves.toEqual([]);

    const listed = await client.list([], {
      kinds: [Kind.LongForm],
      authors: [identity.pubkey],
      "#t": [ARTICLE_MARKER],
    });
    expect(listed.map((item) => item.id)).toEqual([event.id]);

    const fetched = await client.get([], { ids: [event.id.slice(0, 16)] });
    expect(fetched?.id).toBe(event.id);
  });
});
