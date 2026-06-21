import { describe, expect, test } from "bun:test";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { clientWithFakePool, fireEvent, renderWithStore, screen, waitFor } from "../../../test/render.tsx";
import { npubOf, shortNpub, Kind, type Identity } from "@beamhop/nostr";
import type { Note } from "@beamhop/nostr";
import { PostCard } from "../PostCard.tsx";

/**
 * A pubkey mention inside note text (`@npub1…`) is rendered as an interactive
 * profile chip — the same chip used in toasts/replies — while the surrounding
 * prose stays intact. Clicking the chip routes to that profile, not the post.
 */

const sk = generateSecretKey();
const author = getPublicKey(sk);
const identity: Identity = { kind: "local", secretKey: sk, pubkey: author };
const mentioned = getPublicKey(generateSecretKey());

const noteMentioning = (content: string): Note => ({
  id: "n".repeat(64),
  pubkey: author,
  content,
  createdAt: Math.floor(Date.now() / 1000) - 60,
  tags: [],
});

describe("PostCard mention chips", () => {
  test("renders a profile chip for an @npub mention and keeps surrounding text", async () => {
    const note = noteMentioning(`gm @${npubOf(mentioned)} 👋`);
    renderWithStore(<PostCard note={note} />, { identity });

    await waitFor(() => screen.getByTestId("feed-post"));
    // The chip's accessible name targets the mentioned key (profile not yet loaded).
    const chip = await waitFor(() => screen.getByLabelText(/Open .*'s profile/));
    expect(chip.getAttribute("aria-label")).toContain("Open");

    // Surrounding prose is preserved around the chip; the raw npub text is gone.
    const body = screen.getByTestId("feed-post").querySelector("p");
    expect(body?.textContent).toContain("gm ");
    expect(body?.textContent).toContain("👋");
    expect(body?.textContent).not.toContain(npubOf(mentioned));
  });

  test("clicking the mention chip navigates to that profile, not the post", async () => {
    const note = noteMentioning(`cc @${npubOf(mentioned)}`);
    renderWithStore(<PostCard note={note} />, { identity });
    await waitFor(() => screen.getByTestId("feed-post"));

    const chip = await waitFor(() => screen.getByLabelText(/Open .*'s profile/));
    fireEvent.click(chip);

    expect(window.location.hash).toContain(`/profile/${mentioned}`);
    window.location.hash = "";
  });

  test("a note with no mention renders plain text only", async () => {
    renderWithStore(<PostCard note={noteMentioning("no mentions here")} />, { identity });
    await waitFor(() => screen.getByTestId("feed-post"));
    expect(screen.getByText("no mentions here")).toBeDefined();
    expect(screen.queryByLabelText(/Open .*'s profile/)).toBeNull();
  });

  test("shows the mentioned user's profile name instead of their key", async () => {
    const msk = generateSecretKey();
    const mpub = getPublicKey(msk);
    const metadata = finalizeEvent(
      { kind: Kind.Metadata, created_at: Math.floor(Date.now() / 1000), tags: [], content: JSON.stringify({ name: "alice" }) },
      msk,
    );
    const { client, pool } = clientWithFakePool();
    pool.getResolver = (filter) =>
      filter.kinds?.includes(Kind.Metadata) && filter.authors?.includes(mpub) ? metadata : null;

    renderWithStore(<PostCard note={noteMentioning(`hi @${npubOf(mpub)}`)} />, { identity, client, pool });
    await waitFor(() => screen.getByTestId("feed-post"));

    // Chip resolves to the profile name; the raw key is gone from the body.
    await waitFor(() => expect(screen.getByText("alice")).toBeDefined());
    const body = screen.getByTestId("feed-post").querySelector("p");
    expect(body?.textContent).toContain("alice");
    expect(body?.textContent).not.toContain(shortNpub(mpub));
    // The accessible name uses the profile name too.
    expect(screen.getByLabelText("Open alice's profile")).toBeDefined();
  });
});
