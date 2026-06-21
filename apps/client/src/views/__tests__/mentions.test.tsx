import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import type { Event as NostrEvent } from "nostr-tools";
import { act, renderWithStore, screen, waitFor } from "../../../test/render.tsx";
import { MentionsView } from "../Mentions.tsx";
import { Kind, npubOf } from "@beamhop/nostr";
import type { Identity } from "@beamhop/nostr";

const sk = generateSecretKey();
const me = getPublicKey(sk);
const identity: Identity = { kind: "local", secretKey: sk, pubkey: me };

const mkNote = (
  content: string,
  createdAt: number,
  tags: string[][] = [],
  authorSk: Uint8Array = generateSecretKey(),
): NostrEvent => finalizeEvent({ kind: Kind.Note, created_at: createdAt, tags, content }, authorSk);

beforeEach(() => {
  window.location.hash = "#/mentions";
});

afterEach(() => {
  window.location.hash = "";
});

describe("MentionsView", () => {
  test("shows posts that carry my p-tag", async () => {
    const { pool } = renderWithStore(<MentionsView />, { identity });
    if (!pool) throw new Error("renderWithStore must provide a fake pool");

    act(() => {
      pool.emit(mkNote("tagged-marker hello there", 200, [["p", me]]));
      pool.eose();
    });

    await waitFor(() => expect(screen.getByText(/tagged-marker/)).toBeDefined());
    expect(screen.queryAllByTestId("feed-post")).toHaveLength(1);
  });

  test("recovers content-only mentions whose author omitted the p-tag", async () => {
    const { pool } = renderWithStore(<MentionsView />, { identity });
    if (!pool) throw new Error("renderWithStore must provide a fake pool");

    // Exactly the bug we set out to fix: an inline @npub of me, but tags: [].
    act(() => {
      pool.emit(mkNote(`recovered-marker @${npubOf(me)} sup?`, 100));
      pool.eose();
    });

    await waitFor(() => expect(screen.getByText(/recovered-marker/)).toBeDefined());
    expect(screen.queryAllByTestId("feed-post")).toHaveLength(1);
  });

  test("ignores posts that neither tag nor name me", async () => {
    const { pool } = renderWithStore(<MentionsView />, { identity });
    if (!pool) throw new Error("renderWithStore must provide a fake pool");

    act(() => {
      pool.emit(mkNote("just shipping today, nobody tagged", 100));
      pool.eose();
    });

    await waitFor(() => expect(screen.getByText("No mentions yet")).toBeDefined());
    expect(screen.queryAllByTestId("feed-post")).toHaveLength(0);
  });

  test("excludes my own posts even when they mention me", async () => {
    const { pool } = renderWithStore(<MentionsView />, { identity });
    if (!pool) throw new Error("renderWithStore must provide a fake pool");

    act(() => {
      pool.emit(mkNote(`note-to-self @${npubOf(me)}`, 100, [["p", me]], sk));
      pool.eose();
    });

    await waitFor(() => expect(screen.getByText("No mentions yet")).toBeDefined());
    expect(screen.queryAllByTestId("feed-post")).toHaveLength(0);
  });

  test("shows an empty state before anything mentions me", async () => {
    const { pool } = renderWithStore(<MentionsView />, { identity });
    if (!pool) throw new Error("renderWithStore must provide a fake pool");

    act(() => pool.eose());
    await waitFor(() => expect(screen.getByText("No mentions yet")).toBeDefined());
  });
});
