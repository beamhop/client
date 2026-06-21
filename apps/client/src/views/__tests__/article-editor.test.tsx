import { describe, expect, test } from "bun:test";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { clientWithFakePool, fireEvent, renderWithStore, waitFor } from "../../../test/render.tsx";
import type { Identity } from "@beamhop/nostr";
import { buildLongForm } from "@beamhop/nostr";
import { Kind } from "@beamhop/nostr";
import { ArticleView } from "../Article.tsx";

/**
 * Regression: opening the editor on an existing article must hydrate the live
 * (contentEditable) editor with the article's current content.
 *
 * The DOM-load effect that fills the uncontrolled editor reads `body`, but used
 * to key only on `[mode, existing]`. On the reader→edit path the article comes
 * straight from the module cache, so `existing` is stable across renders: the
 * effect never re-ran after the prefill set `body`, and the stale empty-body
 * timeout it scheduled on mount won — blanking the editor (and, on publish,
 * wiping the article). Keying on `body` re-runs the effect and cancels the
 * stale timeout. This drives the real reader→edit click so `existing` resolves
 * from cache exactly as in production.
 */
describe("article editor prefill", () => {
  test("Edit hydrates the live editor with the article body", async () => {
    const sk = generateSecretKey();
    const identity: Identity = { kind: "local", secretKey: sk, pubkey: getPublicKey(sk) };

    const identifier = `regression-${getPublicKey(sk).slice(0, 8)}`;
    const body = "# Original Heading\n\nThis body must survive opening the editor.";
    const event = finalizeEvent(
      buildLongForm({
        identifier,
        title: "Cached Article",
        summary: "summary",
        body,
        hashtags: [],
        kind: "article",
      }),
      sk,
    );

    // Pre-wire the resolver and hash before render: the provider parses the
    // initial nav from the hash at construction, and the resolve effect fires
    // on mount. Resolve only the long-form lookup; profile/contacts get nothing.
    const { client, pool } = clientWithFakePool();
    pool.getResolver = (filter) => (filter.kinds?.includes(Kind.LongForm) ? event : null);
    window.location.hash = `#/articles/${identity.pubkey}/${identifier}`;

    renderWithStore(<ArticleView />, { identity, client, pool });

    // Reader resolves + caches the article.
    const editBtn = await waitFor(() => {
      const btn = document.querySelector('[data-testid="reader-edit"]');
      if (!btn) throw new Error("reader not ready");
      return btn as HTMLElement;
    });

    fireEvent.click(editBtn);

    // Editor reads the now-cached article; the live editor must show its body.
    await waitFor(() => {
      const live = document.querySelector('[data-testid="editor-live"]');
      if (!live) throw new Error("editor not mounted");
      expect(live.textContent ?? "").toContain("This body must survive opening the editor.");
      expect(live.textContent ?? "").toContain("Original Heading");
    });

    window.location.hash = "";
  });
});
