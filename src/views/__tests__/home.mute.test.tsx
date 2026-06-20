import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import type { Event as NostrEvent } from "nostr-tools";
import {
  act,
  clientWithFakePool,
  fireEvent,
  renderWithStore,
  screen,
  waitFor,
} from "../../../test/render.tsx";
import { HomeView } from "../Home.tsx";
import { Kind, ARTICLE_MARKER } from "../../nostr/types.ts";
import { createRule, serializeMuteSettings, type MuteDisplay, type MuteRule } from "../../lib/mute.ts";
import type { Identity } from "../../nostr/keys.ts";

const sk = generateSecretKey();
const identity: Identity = { kind: "local", secretKey: sk, pubkey: getPublicKey(sk) };

/** Seed identity-scoped soft-mute settings the store reads on boot. */
const seedMutes = (display: MuteDisplay, rules: MuteRule[]): void => {
  localStorage.setItem(`verity.mutes.v1:${identity.pubkey}`, serializeMuteSettings({ display, rules }));
};

/** A signed kind-1 note. A fresh secret key per call gives each note its own author. */
const mkNote = (
  content: string,
  createdAt: number,
  authorSk: Uint8Array = generateSecretKey(),
  tags: string[][] = [],
): NostrEvent => finalizeEvent({ kind: Kind.Note, created_at: createdAt, tags, content }, authorSk);

/** A signed NIP-23 article event (kind 30023) carrying the verity-article marker. */
const mkArticle = (
  fields: { title: string; summary?: string; body?: string },
  createdAt: number,
  authorSk: Uint8Array = generateSecretKey(),
): NostrEvent =>
  finalizeEvent(
    {
      kind: Kind.LongForm,
      created_at: createdAt,
      tags: [
        ["d", `art-${createdAt}`],
        ["t", ARTICLE_MARKER],
        ["title", fields.title],
        ["summary", fields.summary ?? ""],
        ["published_at", String(createdAt)],
      ],
      content: fields.body ?? "",
    },
    authorSk,
  );

beforeEach(() => {
  window.location.hash = "#/";
});

afterEach(() => {
  window.location.hash = "";
});

describe("HomeView soft-mute — feed", () => {
  test("hidden mode: a keyword-matching post is removed; a clean post stays", async () => {
    seedMutes("hidden", [createRule({ type: "keyword", value: "airdrop" })]);
    const { pool } = renderWithStore(<HomeView />, { identity });
    if (!pool) throw new Error("renderWithStore must provide a fake pool");

    act(() => {
      pool.emit(mkNote("Free airdrop tokens, claim now", 200));
      pool.emit(mkNote("Hello from the workspace", 100));
      pool.eose();
    });

    await waitFor(() => expect(screen.getByText("Hello from the workspace")).toBeDefined());
    expect(screen.queryByText("Free airdrop tokens, claim now")).toBeNull();
    // Hidden mode never surfaces a summary affordance.
    expect(screen.queryByTestId("muted-row-toggle")).toBeNull();
  });

  test("hidden mode: when every loaded post is muted, show the muted notice, not the empty state", async () => {
    seedMutes("hidden", [createRule({ type: "keyword", value: "airdrop" })]);
    const { pool } = renderWithStore(<HomeView />, { identity });
    if (!pool) throw new Error("renderWithStore must provide a fake pool");

    act(() => {
      pool.emit(mkNote("first airdrop spam", 200));
      pool.emit(mkNote("second airdrop spam", 100));
      pool.eose();
    });

    // Items exist but all are muted: the feed must not claim it is "quiet".
    await waitFor(() => expect(screen.getByText("Everything here is muted")).toBeDefined());
    expect(screen.queryByText(/feed is quiet/i)).toBeNull();
    expect(screen.getByText(/2 posts are hidden by your mute rules/)).toBeDefined();
  });

  test("hidden mode: a post from an account-muted author is removed", async () => {
    const villainSk = generateSecretKey();
    const villain = getPublicKey(villainSk);
    seedMutes("hidden", [createRule({ type: "account", pubkey: villain })]);
    const { pool } = renderWithStore(<HomeView />, { identity });
    if (!pool) throw new Error("renderWithStore must provide a fake pool");

    act(() => {
      pool.emit(mkNote("a post by the muted account", 200, villainSk));
      pool.emit(mkNote("a post by someone else", 100));
      pool.eose();
    });

    await waitFor(() => expect(screen.getByText("a post by someone else")).toBeDefined());
    expect(screen.queryByText("a post by the muted account")).toBeNull();
  });

  test("summary mode: consecutive muted posts collapse, expand on click, then re-collapse", async () => {
    seedMutes("summary", [createRule({ type: "keyword", value: "airdrop" })]);
    const { pool } = renderWithStore(<HomeView />, { identity });
    if (!pool) throw new Error("renderWithStore must provide a fake pool");

    // Newest-first ordering: the two muted posts sit adjacent (created_at 300 & 200),
    // so arrangeFeed groups them into a single summary row above the clean post (100).
    act(() => {
      pool.emit(mkNote("first airdrop spam", 300));
      pool.emit(mkNote("second airdrop spam", 200));
      pool.emit(mkNote("a perfectly clean post", 100));
      pool.eose();
    });

    // Clean post is always visible; muted posts are collapsed behind the toggle.
    await waitFor(() => expect(screen.getByText("a perfectly clean post")).toBeDefined());
    const toggle = screen.getByTestId("muted-row-toggle");
    expect(toggle.textContent).toBe("Show 2 muted");
    expect(screen.queryByText("first airdrop spam")).toBeNull();
    expect(screen.queryByText("second airdrop spam")).toBeNull();

    // Expanding reveals the muted posts and swaps the copy to the hide affordance.
    act(() => fireEvent.click(toggle));
    await waitFor(() => expect(screen.getByText("first airdrop spam")).toBeDefined());
    expect(screen.getByText("second airdrop spam")).toBeDefined();
    expect(screen.getByTestId("muted-row-expanded")).toBeDefined();
    expect(screen.getByTestId("muted-row-toggle").textContent).toBe("Hide 2 muted");

    // Collapsing hides them again.
    act(() => fireEvent.click(screen.getByTestId("muted-row-toggle")));
    await waitFor(() => expect(screen.queryByText("first airdrop spam")).toBeNull());
    expect(screen.getByTestId("muted-row-toggle").textContent).toBe("Show 2 muted");
  });
});

describe("HomeView soft-mute — articles strip", () => {
  test("an article whose title matches a keyword is dropped; a clean one stays", async () => {
    seedMutes("hidden", [createRule({ type: "keyword", value: "airdrop" })]);

    const muted = mkArticle({ title: "The big airdrop guide", summary: "how to farm", body: "tokens" }, 300);
    const clean = mkArticle({ title: "Notes on distributed systems", summary: "consensus", body: "raft" }, 200);

    const { client, pool } = clientWithFakePool();
    // Articles arrive via client.list -> querySync; only answer the long-form query.
    pool.queryResolver = (filter) =>
      filter.kinds?.includes(Kind.LongForm) ? [muted, clean] : [];

    renderWithStore(<HomeView />, { identity, client, pool });

    await waitFor(() => expect(screen.getByText("Notes on distributed systems")).toBeDefined());
    expect(screen.queryByText("The big airdrop guide")).toBeNull();
  });

  test("an article whose summary or body matches a keyword is dropped", async () => {
    seedMutes("hidden", [createRule({ type: "keyword", value: "airdrop" })]);

    const bySummary = mkArticle({ title: "Clean title A", summary: "a sneaky airdrop", body: "x" }, 300);
    const byBody = mkArticle({ title: "Clean title B", summary: "ok", body: "the airdrop is here" }, 250);
    const clean = mkArticle({ title: "Totally fine article", summary: "ok", body: "ok" }, 200);

    const { client, pool } = clientWithFakePool();
    pool.queryResolver = (filter) =>
      filter.kinds?.includes(Kind.LongForm) ? [bySummary, byBody, clean] : [];

    renderWithStore(<HomeView />, { identity, client, pool });

    await waitFor(() => expect(screen.getByText("Totally fine article")).toBeDefined());
    expect(screen.queryByText("Clean title A")).toBeNull();
    expect(screen.queryByText("Clean title B")).toBeNull();
  });
});
