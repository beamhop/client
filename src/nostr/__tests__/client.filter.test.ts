import { describe, expect, test } from "bun:test";
import { finalizeEvent, generateSecretKey } from "nostr-tools";
import type { Event as NostrEvent } from "nostr-tools";
import { clientWithFakePool } from "../../../test/fake-pool.ts";
import { NostrClient, nowSeconds } from "../client.ts";
import { buildNote } from "../events.ts";
import { createLocalIdentity } from "../keys.ts";
import { Kind } from "../types.ts";

const sk = generateSecretKey();
const note = (over: Partial<NostrEvent> = {}): NostrEvent =>
  finalizeEvent(
    { kind: Kind.Note, created_at: over.created_at ?? 1, tags: over.tags ?? [], content: over.content ?? "" },
    sk,
  );

describe("empty-relay short circuits (no network)", () => {
  test("list returns only matching local events", async () => {
    const { client, pool } = clientWithFakePool();
    const identity = createLocalIdentity();
    pool.publishAccepts = true;
    const published = await client.publish(["wss://w"], identity, buildNote("local note"));

    expect(await client.list([], { kinds: [Kind.Note], authors: [identity.pubkey] })).toEqual([published]);
  });

  test("get returns the newest matching local event", async () => {
    const { client, pool } = clientWithFakePool();
    const identity = createLocalIdentity();
    pool.publishAccepts = true;
    const a = await client.publish(["wss://w"], identity, buildNote("older"));
    const b = await client.publish(["wss://w"], identity, {
      ...buildNote("newer"),
      created_at: nowSeconds() + 10,
    });
    void a;
    expect((await client.get([], { kinds: [Kind.Note] }))?.id).toBe(b.id);
  });

  test("subscribe with no relays is an inert no-op", () => {
    const client = new NostrClient();
    const unsub = client.subscribe([], { kinds: [Kind.Note] }, () => {
      throw new Error("should never fire");
    });
    expect(typeof unsub).toBe("function");
    unsub();
  });
});

describe("subscribe", () => {
  test("delivers events once (deduped by id), then signals EOSE; closing unsubscribes", () => {
    const { client, pool } = clientWithFakePool();
    const seen: string[] = [];
    let eosed = false;
    const unsub = client.subscribe(
      ["wss://r"],
      { kinds: [Kind.Note] },
      (event) => seen.push(event.id),
      () => {
        eosed = true;
      },
    );

    const ev = note({ content: "live" });
    pool.emit(ev);
    pool.emit(ev); // duplicate id — must be ignored
    pool.eose();
    expect(seen).toEqual([ev.id]);
    expect(eosed).toBe(true);

    unsub();
    expect(pool.openSubscriptions).toBe(0);
    pool.emit(note({ content: "after-close" }));
    expect(seen).toEqual([ev.id]); // no delivery after unsubscribe
  });
});

describe("publish fan-out", () => {
  test("resolves when at least one relay accepts and caches the event locally", async () => {
    const { client, pool } = clientWithFakePool();
    const event = await client.publish(["wss://a", "wss://b"], createLocalIdentity(), buildNote("hi"));
    expect(pool.published).toHaveLength(1);
    expect((await client.get([], { ids: [event.id] }))?.id).toBe(event.id);
  });

  test("throws when no relay accepts the event", async () => {
    const { client, pool } = clientWithFakePool();
    pool.publishAccepts = false;
    expect(client.publish(["wss://a"], createLocalIdentity(), buildNote("hi"))).rejects.toThrow(
      "No relay accepted the event",
    );
  });
});

describe("list/get merge relay + local results", () => {
  test("dedupes by id, sorts newest-first, and honors the limit", async () => {
    const { client, pool } = clientWithFakePool();
    const identity = createLocalIdentity();
    const local = await client.publish(["wss://w"], identity, buildNote("local"));

    const relayOld = note({ created_at: 1, content: "relay-old" });
    const relayNew = note({ created_at: 9_999_999_999, content: "relay-new" });
    pool.querySyncResult = [relayOld, relayNew, local]; // local also echoed back by relay

    const listed = await client.list(["wss://r"], { kinds: [Kind.Note], limit: 2 });
    expect(listed).toHaveLength(2);
    expect(listed[0]?.id).toBe(relayNew.id); // newest first
    expect(listed.filter((e) => e.id === local.id)).toHaveLength(1); // deduped
  });

  test("get prefers the newest event across relay and local sources", async () => {
    const { client, pool } = clientWithFakePool();
    pool.getResult = note({ created_at: 5, content: "relay" });
    const identity = createLocalIdentity();
    const local = await client.publish(["wss://w"], identity, {
      ...buildNote("local-newer"),
      created_at: 10,
    });
    expect((await client.get(["wss://r"], { kinds: [Kind.Note] }))?.id).toBe(local.id);
  });
});

describe("local matchesFilter coverage", () => {
  const seed = async (): Promise<NostrClient> => {
    const { client } = clientWithFakePool();
    const identity = createLocalIdentity();
    await client.publish(["wss://w"], identity, {
      ...buildNote("hello #beamhop world"),
      created_at: 1000,
      tags: [["t", "beamhop"], ["e", "root1"]],
    });
    return client;
  };

  test("matches by kind", async () => {
    const client = await seed();
    expect(await client.list([], { kinds: [Kind.Note] })).toHaveLength(1);
    expect(await client.list([], { kinds: [Kind.Reaction] })).toHaveLength(0);
  });

  test("matches authors and ids by prefix", async () => {
    const { client } = clientWithFakePool();
    const identity = createLocalIdentity();
    const ev = await client.publish(["wss://w"], identity, buildNote("x"));
    expect(await client.list([], { authors: [identity.pubkey.slice(0, 10)] })).toHaveLength(1);
    expect(await client.list([], { ids: [ev.id.slice(0, 8)] })).toHaveLength(1);
    expect(await client.list([], { authors: ["deadbeef"] })).toHaveLength(0);
  });

  test("honors since/until windows", async () => {
    const client = await seed();
    expect(await client.list([], { since: 2000 })).toHaveLength(0);
    expect(await client.list([], { until: 500 })).toHaveLength(0);
    expect(await client.list([], { since: 500, until: 2000 })).toHaveLength(1);
  });

  test("matches #-tag filters and rejects when the tag is absent", async () => {
    const client = await seed();
    expect(await client.list([], { "#t": ["beamhop"] })).toHaveLength(1);
    expect(await client.list([], { "#t": ["other"] })).toHaveLength(0);
    expect(await client.list([], { "#e": ["root1"] })).toHaveLength(1);
  });

  test("matches a case-insensitive content search", async () => {
    const client = await seed();
    expect(await client.list([], { search: "HELLO" })).toHaveLength(1);
    expect(await client.list([], { search: "absent" })).toHaveLength(0);
  });
});

describe("close", () => {
  test("delegates to the pool", () => {
    const { client, pool } = clientWithFakePool();
    client.close(["wss://a"]);
    expect(pool.closed).toEqual([["wss://a"]]);
  });
});
