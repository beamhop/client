import { describe, expect, test } from "bun:test";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import { act, fireEvent, renderWithStore, screen, waitFor } from "../../../test/render.tsx";
import { PostCard } from "../PostCard.tsx";
import { parseMuteSettings } from "../../lib/mute.ts";
import type { MuteRule, MuteSettings } from "../../lib/mute.ts";
import type { Note } from "../../nostr/types.ts";
import type { Identity } from "../../nostr/keys.ts";

// Signed-in viewer.
const sk = generateSecretKey();
const me = getPublicKey(sk);
const identity: Identity = { kind: "local", secretKey: sk, pubkey: me };

// A *different* author so the post is not "mine" — that is what reveals the
// "Mute author" affordance (own posts hide it, like delete does).
const author = getPublicKey(generateSecretKey());

const note: Note = {
  id: "n".repeat(64),
  pubkey: author,
  content: "gm friends, the airdrop megathread is live now",
  createdAt: Math.floor(Date.now() / 1000) - 120,
  tags: [],
};

// Read the per-identity mute settings the store persists to localStorage.
const storedSettings = (pubkey: string): MuteSettings =>
  parseMuteSettings(JSON.parse(localStorage.getItem(`beamhop.mutes.v1:${pubkey}`) ?? "null"));
const storedRules = (pubkey: string): readonly MuteRule[] => storedSettings(pubkey).rules;

describe("PostCard soft-mute affordances", () => {
  test("opening the overflow menu offers 'Mute author' for someone else's post", async () => {
    renderWithStore(<PostCard note={note} />, { identity });
    await waitFor(() => screen.getByTestId("feed-post"));

    // The menu is collapsed initially.
    expect(screen.queryByTestId("post-mute-author")).toBeNull();

    fireEvent.click(screen.getByTestId("post-more"));
    const muteAuthor = screen.getByTestId("post-mute-author");
    expect(muteAuthor.textContent).toBe("Mute author");
  });

  test("'Mute author' adds an account rule and flips to 'Unmute author' on reopen", async () => {
    renderWithStore(<PostCard note={note} />, { identity });
    await waitFor(() => screen.getByTestId("feed-post"));

    fireEvent.click(screen.getByTestId("post-more"));
    fireEvent.click(screen.getByTestId("post-mute-author"));

    // The store persisted exactly one account rule for this author...
    await waitFor(() => {
      const rules = storedRules(me);
      expect(rules.length).toBe(1);
    });
    const rule = storedRules(me)[0];
    expect(rule?.type).toBe("account");
    if (rule?.type === "account") expect(rule.pubkey).toBe(author);

    // ...and the menu closed when the item was chosen.
    expect(screen.queryByTestId("post-mute-author")).toBeNull();

    // Reopening shows the inverse affordance now that the author is muted.
    fireEvent.click(screen.getByTestId("post-more"));
    expect(screen.getByTestId("post-mute-author").textContent).toBe("Unmute author");
  });

  test("'Mute author' is hidden on my own posts", async () => {
    const mine: Note = { ...note, pubkey: me };
    renderWithStore(<PostCard note={mine} />, { identity });
    await waitFor(() => screen.getByTestId("feed-post"));

    fireEvent.click(screen.getByTestId("post-more"));
    expect(screen.queryByTestId("post-mute-author")).toBeNull();
    // The word affordance is still present in the menu.
    expect(screen.getByTestId("post-mute-word")).toBeDefined();
  });

  test("'Mute a word…' captures a keyword and adds a keyword rule", async () => {
    renderWithStore(<PostCard note={note} />, { identity });
    await waitFor(() => screen.getByTestId("feed-post"));

    fireEvent.click(screen.getByTestId("post-more"));
    fireEvent.click(screen.getByTestId("post-mute-word"));

    const input = screen.getByTestId("post-mute-word-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "airdrop" } });
    fireEvent.click(screen.getByTestId("post-mute-word-submit"));

    await waitFor(() => expect(storedRules(me).length).toBe(1));
    const rule = storedRules(me)[0];
    expect(rule?.type).toBe("keyword");
    if (rule?.type === "keyword") expect(rule.value).toBe("airdrop");

    // Submitting collapses the menu.
    expect(screen.queryByTestId("post-mute-word-input")).toBeNull();
  });

  test("submitting an empty word is a no-op", async () => {
    renderWithStore(<PostCard note={note} />, { identity });
    await waitFor(() => screen.getByTestId("feed-post"));

    fireEvent.click(screen.getByTestId("post-more"));
    fireEvent.click(screen.getByTestId("post-mute-word"));

    const input = screen.getByTestId("post-mute-word-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.click(screen.getByTestId("post-mute-word-submit"));

    // Whitespace-only input adds nothing; the input stays open for correction.
    expect(storedRules(me).length).toBe(0);
    expect(screen.getByTestId("post-mute-word-input")).toBeDefined();
  });

  test("Enter inside the word input submits the keyword rule", async () => {
    renderWithStore(<PostCard note={note} />, { identity });
    await waitFor(() => screen.getByTestId("feed-post"));

    fireEvent.click(screen.getByTestId("post-more"));
    fireEvent.click(screen.getByTestId("post-mute-word"));

    const input = screen.getByTestId("post-mute-word-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "megathread" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(storedRules(me).length).toBe(1));
    const rule = storedRules(me)[0];
    if (rule?.type === "keyword") expect(rule.value).toBe("megathread");
  });

  // The floating "Mute this phrase" button is driven by the browser selection
  // APIs. happy-dom implements getSelection/Range, so we can simulate a real
  // selection inside the card's content and fire `selectionchange` (which
  // happy-dom does not emit automatically).
  test("selecting text in the post reveals 'Mute this phrase' and mutes it", async () => {
    renderWithStore(<PostCard note={note} />, { identity });
    await waitFor(() => screen.getByTestId("feed-post"));

    // No selection yet, so the affordance is absent.
    expect(screen.queryByTestId("post-mute-phrase")).toBeNull();

    const paragraph = screen.getByText(/gm friends/);
    const textNode = paragraph.firstChild;
    expect(textNode).not.toBeNull();
    if (!textNode) return;

    // Select the leading "gm friends" run within the content node.
    act(() => {
      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, "gm friends".length);
      const selection = window.getSelection();
      expect(selection).not.toBeNull();
      if (!selection) return;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });

    const phraseButton = await waitFor(() => screen.getByTestId("post-mute-phrase"));
    expect(phraseButton.textContent).toBe("Mute this phrase");

    fireEvent.click(phraseButton);

    await waitFor(() => expect(storedRules(me).length).toBe(1));
    const rule = storedRules(me)[0];
    expect(rule?.type).toBe("keyword");
    if (rule?.type === "keyword") expect(rule.value).toBe("gm friends");

    // Muting clears the selection and hides the floating button.
    await waitFor(() => expect(screen.queryByTestId("post-mute-phrase")).toBeNull());
  });

  test("a selection outside the card does not reveal 'Mute this phrase'", async () => {
    renderWithStore(<PostCard note={note} />, { identity });
    await waitFor(() => screen.getByTestId("feed-post"));

    // A node that lives outside the PostCard's content element.
    const outside = document.createElement("p");
    outside.textContent = "unrelated text elsewhere";
    document.body.appendChild(outside);

    act(() => {
      const range = document.createRange();
      const node = outside.firstChild;
      if (!node) return;
      range.setStart(node, 0);
      range.setEnd(node, "unrelated".length);
      const selection = window.getSelection();
      if (!selection) return;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect(screen.queryByTestId("post-mute-phrase")).toBeNull();
    outside.remove();
  });
});
