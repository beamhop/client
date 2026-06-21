import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import type { Event as NostrEvent } from "nostr-tools";
import { act, fireEvent, renderWithStore, screen, waitFor } from "../../../test/render.tsx";
import { HomeView } from "../Home.tsx";
import { Kind } from "@beamhop/nostr";
import type { Identity } from "@beamhop/nostr";

const sk = generateSecretKey();
const identity: Identity = { kind: "local", secretKey: sk, pubkey: getPublicKey(sk) };

/** A signed kind-1 note; a fresh author per call keeps the For you feed unfiltered. */
const mkNote = (content: string, createdAt: number, authorSk: Uint8Array = generateSecretKey()): NostrEvent =>
  finalizeEvent({ kind: Kind.Note, created_at: createdAt, tags: [], content }, authorSk);

beforeEach(() => {
  window.location.hash = "#/";
});

afterEach(() => {
  window.location.hash = "";
});

describe("HomeView — new posts pill (For you)", () => {
  test("buffers post-EOSE arrivals behind a pill, then reveals them on click", async () => {
    const { pool } = renderWithStore(<HomeView />, { identity });
    if (!pool) throw new Error("renderWithStore must provide a fake pool");

    // The initial page (up to EOSE) is shown immediately — no pill.
    act(() => {
      pool.emit(mkNote("an original post", 100));
      pool.eose();
    });
    await waitFor(() => expect(screen.getByText("an original post")).toBeDefined());
    expect(screen.queryByTestId("new-posts-pill")).toBeNull();

    // A live arrival after EOSE is held back: the pill appears, the post does not.
    act(() => pool.emit(mkNote("a brand new post", 200)));
    await waitFor(() => expect(screen.getByTestId("new-posts-pill")).toBeDefined());
    expect(screen.getByTestId("new-posts-pill").textContent).toContain("1 new post");
    expect(screen.queryByText("a brand new post")).toBeNull();

    // Further arrivals accumulate in the buffer and bump the count (pluralized).
    act(() => {
      pool.emit(mkNote("second new post", 300));
      pool.emit(mkNote("third new post", 400));
    });
    await waitFor(() => expect(screen.getByTestId("new-posts-pill").textContent).toContain("3 new posts"));
    expect(screen.queryByText("third new post")).toBeNull();

    // Clicking releases the buffer into the feed and dismisses the pill.
    act(() => fireEvent.click(screen.getByTestId("new-posts-pill")));
    await waitFor(() => expect(screen.getByText("a brand new post")).toBeDefined());
    expect(screen.getByText("third new post")).toBeDefined();
    expect(screen.queryByTestId("new-posts-pill")).toBeNull();
  });

  test("never shows the pill for the initial page (before EOSE)", async () => {
    const { pool } = renderWithStore(<HomeView />, { identity });
    if (!pool) throw new Error("renderWithStore must provide a fake pool");

    // Arrivals before EOSE are part of the initial load → shown, not buffered.
    act(() => {
      pool.emit(mkNote("loaded before eose", 100));
      pool.emit(mkNote("also before eose", 90));
    });
    await waitFor(() => expect(screen.getByText("loaded before eose")).toBeDefined());
    expect(screen.getByText("also before eose")).toBeDefined();
    expect(screen.queryByTestId("new-posts-pill")).toBeNull();
  });
});
