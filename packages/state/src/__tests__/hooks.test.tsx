import { describe, expect, test } from "bun:test";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import type { Event as NostrEvent } from "nostr-tools";
import { act, clientWithFakePool, renderHookWithStore, waitFor } from "../../test/render.tsx";
import { useEngagement, useFeed, useTimelineFeed } from "../hooks.ts";
import { Kind } from "@beamhop/nostr";
import type { Identity } from "@beamhop/nostr";

const sk = generateSecretKey();
const me = getPublicKey(sk);
const myIdentity: Identity = { kind: "local", secretKey: sk, pubkey: me };

const mkNote = (content: string, createdAt: number, tags: string[][] = []): NostrEvent =>
  finalizeEvent({ kind: Kind.Note, created_at: createdAt, tags, content }, sk);

const mkRepost = (noteId: string, createdAt: number, embed?: NostrEvent): NostrEvent =>
  finalizeEvent(
    { kind: Kind.Repost, created_at: createdAt, tags: [["e", noteId], ["p", me]], content: embed ? JSON.stringify(embed) : "" },
    sk,
  );

describe("useFeed", () => {
  test("collects subscribed notes, deduped and newest-first; EOSE clears loading", () => {
    const { result, pool } = renderHookWithStore(() => useFeed({ kinds: [Kind.Note] }, []));
    expect(result.current.loading).toBe(true);

    const older = mkNote("older", 100);
    const newer = mkNote("newer", 200);
    act(() => {
      pool.emit(older);
      pool.emit(newer);
      pool.emit(older); // duplicate id, ignored
    });
    expect(result.current.notes.map((n) => n.content)).toEqual(["newer", "older"]);

    act(() => pool.eose());
    expect(result.current.loading).toBe(false);
  });

  test("ignores non-note events", () => {
    const { result, pool } = renderHookWithStore(() => useFeed({ kinds: [Kind.Note] }, []));
    act(() => pool.emit(finalizeEvent({ kind: Kind.Reaction, created_at: 1, tags: [], content: "+" }, sk)));
    expect(result.current.notes).toHaveLength(0);
  });

  test("disabled feed produces nothing and is not loading", () => {
    const { result } = renderHookWithStore(() => useFeed({ kinds: [Kind.Note] }, [], false));
    expect(result.current.loading).toBe(false);
    expect(result.current.hasMore).toBe(false);
    expect(result.current.notes).toEqual([]);
  });

  test("loadMore pages older notes via a one-shot query", async () => {
    const { result, pool } = renderHookWithStore(() => useFeed({ kinds: [Kind.Note] }, []));
    act(() => {
      pool.emit(mkNote("newest", 500));
      pool.eose();
    });

    pool.querySyncResult = [mkNote("page-2", 300)];
    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.notes.map((n) => n.content)).toEqual(["newest", "page-2"]);

    // A second page with nothing new flips hasMore off.
    pool.querySyncResult = [];
    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.hasMore).toBe(false);
  });

  test("an EOSE with no events ends loading and clears hasMore", () => {
    const { result, pool } = renderHookWithStore(() => useFeed({ kinds: [Kind.Note] }, []));
    act(() => pool.eose());
    expect(result.current.loading).toBe(false);
    expect(result.current.hasMore).toBe(false);
  });
});

describe("useTimelineFeed", () => {
  test("plain notes become note rows", () => {
    const { result, pool } = renderHookWithStore(() => useTimelineFeed({ kinds: [Kind.Note, Kind.Repost] }, []));
    act(() => pool.emit(mkNote("hello", 100)));
    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0]?.type).toBe("note");
  });

  test("a repost embedding its source resolves to a repost row", () => {
    const { result, pool } = renderHookWithStore(() => useTimelineFeed({ kinds: [Kind.Note, Kind.Repost] }, []));
    const source = mkNote("reposted body", 100);
    act(() => pool.emit(mkRepost(source.id, 200, source)));

    const repost = result.current.items.find((i) => i.type === "repost");
    expect(repost?.note.content).toBe("reposted body");
    expect(repost?.type === "repost" && repost.repostedBy).toBe(me);
  });

  test("a repost of an already-seen note resolves without a fetch", () => {
    const { result, pool } = renderHookWithStore(() => useTimelineFeed({ kinds: [Kind.Note, Kind.Repost] }, []));
    const source = mkNote("seen note", 100);
    act(() => {
      pool.emit(source);
      pool.emit(mkRepost(source.id, 200));
    });
    expect(result.current.items.filter((i) => i.type === "repost")).toHaveLength(1);
    expect(result.current.items.filter((i) => i.type === "note")).toHaveLength(1);
  });

  test("a repost of an unknown note fetches it, then resolves", async () => {
    const source = mkNote("fetched later", 100);
    const { client, pool } = clientWithFakePool();
    pool.getResolver = (filter) => (filter.ids?.includes(source.id) ? source : null);

    const { result } = renderHookWithStore(() => useTimelineFeed({ kinds: [Kind.Note, Kind.Repost] }, []), {
      client,
      pool,
    });
    act(() => pool.emit(mkRepost(source.id, 200)));

    await waitFor(() => {
      expect(result.current.items.find((i) => i.type === "repost")?.note.content).toBe("fetched later");
    });
  });

  test("loadMore pages older timeline items via a one-shot query", async () => {
    const { result, pool } = renderHookWithStore(() => useTimelineFeed({ kinds: [Kind.Note, Kind.Repost] }, []));
    act(() => {
      pool.emit(mkNote("newest", 500));
      pool.eose();
    });

    pool.querySyncResult = [mkNote("older-page", 300)];
    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.items.map((i) => i.note.content)).toContain("older-page");

    pool.querySyncResult = [];
    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.hasMore).toBe(false);
  });
});

describe("useEngagement", () => {
  test("tallies likes/reposts/replies and marks my own like and repost", async () => {
    const note = mkNote("engageable", 100);
    const ids = [note.id]; // stable reference across re-renders (callers memoize this)
    const other = generateSecretKey();
    const myLike = finalizeEvent({ kind: Kind.Reaction, created_at: 1, tags: [["e", note.id]], content: "+" }, sk);
    const myRepost = mkRepost(note.id, 50);
    const theirReply = finalizeEvent({ kind: Kind.Note, created_at: 1, tags: [["e", note.id]], content: "nice" }, other);

    const { client, pool } = clientWithFakePool();
    pool.queryResolver = (filter) =>
      filter.kinds?.includes(Kind.Deletion) ? [] : [myLike, myRepost, theirReply];

    const { result } = renderHookWithStore(() => useEngagement(ids), { client, pool, identity: myIdentity });

    await waitFor(() => expect(result.current.get(note.id)?.likes).toBe(1));
    const e = result.current.get(note.id);
    expect(e).toMatchObject({ likes: 1, reposts: 1, replies: 1, liked: true, reposted: true });
  });

  test("excludes events deleted by their author", async () => {
    const note = mkNote("with-deletion", 100);
    const ids = [note.id];
    const myLike = finalizeEvent({ kind: Kind.Reaction, created_at: 1, tags: [["e", note.id]], content: "+" }, sk);
    const deletion = finalizeEvent({ kind: Kind.Deletion, created_at: 2, tags: [["e", myLike.id]], content: "" }, sk);

    const { client, pool } = clientWithFakePool();
    pool.queryResolver = (filter) => (filter.kinds?.includes(Kind.Deletion) ? [deletion] : [myLike]);

    const { result } = renderHookWithStore(() => useEngagement(ids), { client, pool, identity: myIdentity });

    await waitFor(() => expect(result.current.get(note.id)).toBeDefined());
    expect(result.current.get(note.id)?.likes).toBe(0);
  });

  test("applies optimistic overrides without a refetch", async () => {
    const note = mkNote("optimistic", 100);
    const ids = [note.id];
    const optimistic = { [note.id]: { liked: true, likes: 7 } };
    const { client, pool } = clientWithFakePool();
    pool.queryResolver = () => [];

    const { result } = renderHookWithStore(() => useEngagement(ids, optimistic), {
      client,
      pool,
      identity: myIdentity,
    });

    await waitFor(() => expect(result.current.get(note.id)?.likes).toBe(7));
    expect(result.current.get(note.id)?.liked).toBe(true);
  });
});
