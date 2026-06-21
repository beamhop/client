import { beforeEach, describe, expect, test } from "bun:test";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { act, renderWithStore, screen, waitFor, within } from "../../../test/render.tsx";
import type { Identity } from "@beamhop/nostr";
import { buildDm, encryptDm } from "@beamhop/nostr";
import { createRule, serializeMuteSettings } from "@beamhop/lib";
import type { MuteSettings } from "@beamhop/lib";
import { MessagesView } from "../Messages.tsx";

/** A local keypair we can both encrypt with and sign DM events from. */
type Peer = { secretKey: Uint8Array; pubkey: string };

const makePeer = (): Peer => {
  const secretKey = generateSecretKey();
  return { secretKey, pubkey: getPublicKey(secretKey) };
};

/** The first-8-hex fallback the list renders for a peer with no profile. */
const peerLabel = (pubkey: string): string => `${pubkey.slice(0, 8)}…`;

/**
 * Build a genuine kind-4 DM event FROM `from` TO `to`, encrypted with NIP-04 so
 * the view's real `decodeDm` decrypts it (no mocking of the crypto seam).
 */
const dmEvent = async (from: Peer, to: Peer, body: string) => {
  const cipher = await encryptDm({ kind: "local", secretKey: from.secretKey, pubkey: from.pubkey }, to.pubkey, body);
  return finalizeEvent(buildDm(to.pubkey, cipher), from.secretKey);
};

/** Persist per-identity mute settings under the key the store boots from. */
const seedMutes = (pubkey: string, settings: MuteSettings): void => {
  localStorage.setItem(`beamhop.mutes.v1:${pubkey}`, serializeMuteSettings(settings));
};

describe("MessagesView client-only soft mute", () => {
  let me: Peer;
  let mutedPeer: Peer;
  let goodPeer: Peer;
  let identity: Identity;

  beforeEach(() => {
    me = makePeer();
    mutedPeer = makePeer();
    goodPeer = makePeer();
    identity = { kind: "local", secretKey: me.secretKey, pubkey: me.pubkey };
    // No active thread on mount, so nothing is force-opened past the list filter.
    window.location.hash = "#/messages";
  });

  test("an account-muted peer's conversation is hidden while an unmuted peer's is shown", async () => {
    seedMutes(me.pubkey, {
      display: "hidden",
      rules: [createRule({ type: "account", pubkey: mutedPeer.pubkey })],
    });

    const { pool } = renderWithStore(<MessagesView />, { identity });
    if (!pool) throw new Error("expected a fake pool");

    // Wait for the live DM subscriptions to open before delivering events.
    await waitFor(() => expect(pool.openSubscriptions).toBeGreaterThan(0));

    const fromMuted = await dmEvent(mutedPeer, me, "spam from the muted peer");
    const fromGood = await dmEvent(goodPeer, me, "hello from a real friend");
    // decodeDm resolves asynchronously, so settle the resulting state inside act.
    await act(async () => {
      pool.emit(fromMuted);
      pool.emit(fromGood);
      pool.eose();
    });

    // The unmuted peer must surface as a conversation row...
    await waitFor(() => expect(screen.getByText(peerLabel(goodPeer.pubkey))).toBeTruthy());

    // ...and the muted peer must never appear in the list, even after its DM decodes.
    const list = screen.getByTestId("message-list");
    expect(within(list).queryByText(peerLabel(mutedPeer.pubkey))).toBeNull();

    // Exactly one conversation row: the unmuted peer.
    const rows = screen.getAllByTestId("conversation-item");
    expect(rows.length).toBe(1);
    expect(within(rows[0] as HTMLElement).queryByText(peerLabel(goodPeer.pubkey))).toBeTruthy();
  });

  test("a muted peer's messages do not contribute to any unread aggregation", async () => {
    seedMutes(me.pubkey, {
      display: "hidden",
      rules: [createRule({ type: "account", pubkey: mutedPeer.pubkey })],
    });

    const { pool, container } = renderWithStore(<MessagesView />, { identity });
    if (!pool) throw new Error("expected a fake pool");

    await waitFor(() => expect(pool.openSubscriptions).toBeGreaterThan(0));

    // Several incoming DMs from the muted peer — the kind that would otherwise be "unread".
    const first = await dmEvent(mutedPeer, me, "one");
    const second = await dmEvent(mutedPeer, me, "two");
    const third = await dmEvent(goodPeer, me, "a genuine ping");
    await act(async () => {
      pool.emit(first);
      pool.emit(second);
      pool.emit(third);
      pool.eose();
    });

    // The unmuted conversation lands, proving events were ingested (not just dropped wholesale).
    await waitFor(() => expect(screen.getByText(peerLabel(goodPeer.pubkey))).toBeTruthy());

    // The muted peer never produces a row, so its messages cannot feed unread counts.
    const list = screen.getByTestId("message-list");
    expect(within(list).queryByText(peerLabel(mutedPeer.pubkey))).toBeNull();
    expect(screen.getAllByTestId("conversation-item").length).toBe(1);

    // The muted peer's text never reaches the conversation list at all.
    expect(container.textContent ?? "").not.toContain("one");
    expect(container.textContent ?? "").not.toContain("two");
  });

  test("with no mute rules, both peers' conversations appear", async () => {
    // Control: without the account rule, the same traffic yields two rows.
    const { pool } = renderWithStore(<MessagesView />, { identity });
    if (!pool) throw new Error("expected a fake pool");

    await waitFor(() => expect(pool.openSubscriptions).toBeGreaterThan(0));

    const a = await dmEvent(mutedPeer, me, "no longer muted");
    const b = await dmEvent(goodPeer, me, "friend");
    await act(async () => {
      pool.emit(a);
      pool.emit(b);
      pool.eose();
    });

    await waitFor(() => expect(screen.getAllByTestId("conversation-item").length).toBe(2));
    expect(screen.getByText(peerLabel(mutedPeer.pubkey))).toBeTruthy();
    expect(screen.getByText(peerLabel(goodPeer.pubkey))).toBeTruthy();
  });
});
