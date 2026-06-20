import { describe, expect, test } from "bun:test";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import type { ReactNode } from "react";
import { renderWithStore, waitFor } from "../../../test/render.tsx";
import type { Identity } from "../../nostr/keys.ts";
import { HomeView } from "../Home.tsx";
import { ExploreView } from "../Explore.tsx";
import { NotificationsView } from "../Notifications.tsx";
import { DocsView } from "../Docs.tsx";
import { MessagesView } from "../Messages.tsx";
import { AgentsView } from "../Agents.tsx";
import { ProfileView } from "../Profile.tsx";
import { SecurityView } from "../Security.tsx";
import { ArticleView } from "../Article.tsx";
import { PostDetailView } from "../PostDetail.tsx";

const sk = generateSecretKey();
const identity: Identity = { kind: "local", secretKey: sk, pubkey: getPublicKey(sk) };

/**
 * Smoke coverage: every top-level view must mount inside the real store (signed
 * in, no relay data) without throwing. This guards against import breakage, null
 * dereferences on empty state, and render-time crashes — the most common kind of
 * view regression — without asserting pixel-level output.
 */
const views: ReadonlyArray<readonly [string, () => ReactNode, string]> = [
  ["Home", HomeView, "#/"],
  ["Explore", ExploreView, "#/explore"],
  ["Notifications", NotificationsView, "#/notifications"],
  ["Docs", DocsView, "#/docs"],
  ["Messages", MessagesView, "#/messages"],
  ["Agents", AgentsView, "#/agents"],
  ["Profile", ProfileView, `#/profile/${identity.pubkey}`],
  ["Security", SecurityView, "#/settings"],
  ["Article", ArticleView, "#/articles/new"],
  ["PostDetail", PostDetailView, "#/posts/abc123"],
];

describe("view render smoke", () => {
  for (const [name, View, hash] of views) {
    test(`${name}View mounts without crashing`, async () => {
      window.location.hash = hash;
      const { container } = renderWithStore(<View />, { identity });
      await waitFor(() => expect(container.firstChild).not.toBeNull());
      window.location.hash = "";
    });
  }
});
