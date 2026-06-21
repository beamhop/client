import { describe, expect, test } from "bun:test";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import { fireEvent, renderWithStore, screen, waitFor, within } from "../../../test/render.tsx";
import { PostCard } from "../PostCard.tsx";
import type { Note } from "@beamhop/nostr";
import type { Engagement } from "@beamhop/state";
import type { Identity } from "@beamhop/nostr";

const sk = generateSecretKey();
const author = getPublicKey(sk);
const identity: Identity = { kind: "local", secretKey: sk, pubkey: author };

const note: Note = {
  id: "n".repeat(64),
  pubkey: author,
  content: "shipping it https://cdn.example/shot.png",
  createdAt: Math.floor(Date.now() / 1000) - 120,
  tags: [],
};

const engagement: Engagement = { likes: 1500, reposts: 2, replies: 3, liked: true, reposted: false };

describe("PostCard", () => {
  test("renders content, an abbreviated count, and an image embed", async () => {
    renderWithStore(<PostCard note={note} engagement={engagement} />, { identity });
    await waitFor(() => screen.getByTestId("feed-post"));

    expect(screen.getByText(/shipping it/)).toBeDefined();
    expect(screen.getByText("1.5k")).toBeDefined(); // fmtCount(1500)
    expect(screen.getByTestId("post-photo-single")).toBeDefined();
  });

  test("action buttons invoke their callbacks", async () => {
    const calls: string[] = [];
    renderWithStore(
      <PostCard
        note={note}
        engagement={engagement}
        onReply={() => void calls.push("reply")}
        onRepost={() => void calls.push("repost")}
        onLike={() => void calls.push("like")}
        onBookmark={() => void calls.push("bookmark")}
        onShare={() => void calls.push("share")}
        onDelete={() => void calls.push("delete")}
      />,
      { identity },
    );
    await waitFor(() => screen.getByTestId("feed-post"));

    const toolbar = screen.getByTitle("Bookmark").parentElement as HTMLElement;
    const buttons = within(toolbar).getAllByRole("button"); // reply, repost, like, bookmark, share, delete
    fireEvent.click(buttons[0]!);
    fireEvent.click(buttons[1]!);
    fireEvent.click(buttons[2]!);
    fireEvent.click(screen.getByTitle("Bookmark"));
    fireEvent.click(screen.getByTitle("Share"));

    expect(calls).toEqual(["reply", "repost", "like", "bookmark", "share"]);
  });

  test("deleting asks for confirmation, dissolves, then invokes onDelete", async () => {
    const calls: string[] = [];
    renderWithStore(<PostCard note={note} engagement={engagement} onDelete={() => void calls.push("delete")} />, {
      identity,
    });
    await waitFor(() => screen.getByTestId("feed-post"));

    // First click only opens the confirmation — nothing is deleted yet.
    fireEvent.click(screen.getByTestId("post-delete"));
    expect(screen.getByRole("dialog", { name: "Delete this post?" })).toBeDefined();
    expect(calls).toEqual([]);

    fireEvent.click(screen.getByTestId("post-delete-confirm"));
    // Confirming starts the dissolve immediately; onDelete fires only once it finishes.
    expect(screen.getByTestId("feed-post").getAttribute("data-exiting")).toBe("true");
    expect(calls).toEqual([]);
    await waitFor(() => expect(calls).toEqual(["delete"]));
  });

  test("cancelling the delete confirmation leaves the post untouched", async () => {
    const calls: string[] = [];
    renderWithStore(<PostCard note={note} engagement={engagement} onDelete={() => void calls.push("delete")} />, {
      identity,
    });
    await waitFor(() => screen.getByTestId("feed-post"));

    fireEvent.click(screen.getByTestId("post-delete"));
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("feed-post").getAttribute("data-exiting")).toBeNull();
    expect(calls).toEqual([]);
  });

  test("unreposting a repost row dissolves before invoking onRepost", async () => {
    const calls: string[] = [];
    renderWithStore(
      <PostCard
        note={note}
        engagement={{ ...engagement, reposted: true }}
        repostedBy={author}
        onRepost={() => void calls.push("unrepost")}
      />,
      { identity },
    );
    await waitFor(() => screen.getByTestId("feed-post"));

    const toolbar = screen.getByTitle("Bookmark").parentElement as HTMLElement;
    const repostButton = within(toolbar).getAllByRole("button")[1]!;
    fireEvent.click(repostButton);

    expect(screen.getByTestId("feed-post").getAttribute("data-exiting")).toBe("true");
    expect(calls).toEqual([]);
    await waitFor(() => expect(calls).toEqual(["unrepost"]));
  });

  test("clicking the card body navigates to the post detail by default", async () => {
    renderWithStore(<PostCard note={note} engagement={engagement} />, { identity });
    const card = await waitFor(() => screen.getByTestId("feed-post"));
    fireEvent.click(card);
    expect(window.location.hash).toContain(`/posts/${note.id}`);
    window.location.hash = "";
  });

  test("the delete action is hidden for notes I don't own", async () => {
    const otherIdentity: Identity = {
      kind: "local",
      secretKey: generateSecretKey(),
      pubkey: getPublicKey(generateSecretKey()),
    };
    renderWithStore(<PostCard note={note} engagement={engagement} onDelete={() => undefined} />, {
      identity: otherIdentity,
    });
    await waitFor(() => screen.getByTestId("feed-post"));
    expect(screen.queryByTestId("post-delete")).toBeNull();
  });
});
