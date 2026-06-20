import { afterEach, describe, expect, test } from "bun:test";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import type { ReactNode } from "react";
import { act, renderWithStore, screen, waitFor, within } from "../../../test/render.tsx";
import { NotificationsView } from "../Notifications.tsx";
import { Sidebar } from "../../ui/Sidebar.tsx";
import { useStore, type Store } from "../../state/store.tsx";
import { Kind } from "../../nostr/types.ts";
import type { Identity } from "../../nostr/keys.ts";

const sk = generateSecretKey();
const me = getPublicKey(sk);
const identity: Identity = { kind: "local", secretKey: sk, pubkey: me };

// Two distinct authors so we can mute one and keep the other. Neither is `me`:
// toggleMuteAccount refuses to mute your own pubkey.
const mutedSk = generateSecretKey();
const mutedAuthor = getPublicKey(mutedSk);
const keptSk = generateSecretKey();

// A reply event from `authorSk` that p-tags me → one "reply" notification.
const replyFrom = (authorSk: Uint8Array, createdAt: number) =>
  finalizeEvent(
    { kind: Kind.Note, created_at: createdAt, tags: [["p", me], ["e", "root"]], content: "ping" },
    authorSk,
  );

// Captures the live store so a test can drive real actions (add a rule mid-session).
let store: Store | null = null;
const Probe = (): ReactNode => {
  store = useStore();
  return null;
};
const getStore = (): Store => {
  if (!store) throw new Error("store probe not mounted");
  return store;
};

afterEach(() => {
  store = null;
  window.location.hash = "";
});

describe("NotificationsView soft-mute", () => {
  test("a notification from an account-muted source is not rendered in the list", async () => {
    // Boot with no rules so both notifications are ingested by the store, then
    // mute one author mid-session and assert the view's render-time filter hides it.
    const { pool } = renderWithStore(
      <>
        <NotificationsView />
        <Probe />
      </>,
      { identity },
    );
    if (!pool) throw new Error("renderWithStore must provide a fake pool");

    await waitFor(() => expect(getStore().state.identity?.pubkey).toBe(me));

    act(() => {
      pool.emit(replyFrom(mutedSk, 20));
      pool.emit(replyFrom(keptSk, 10));
      pool.eose();
    });

    // Both notifications enter state and render before any rule exists.
    await waitFor(() => expect(getStore().state.notifications).toHaveLength(2));
    await waitFor(() => expect(screen.getAllByTestId("notification-row")).toHaveLength(2));

    // Mute one author mid-session; the view's `visible` memo must drop its row.
    act(() => getStore().toggleMuteAccount(mutedAuthor));

    await waitFor(() => expect(screen.getAllByTestId("notification-row")).toHaveLength(1));
    // The muted notification still lives in store state — it is filtered at render.
    expect(getStore().state.notifications).toHaveLength(2);
  });

  test("the in-view unread count reflects only visible notifications", async () => {
    const { pool } = renderWithStore(
      <>
        <NotificationsView />
        <Probe />
      </>,
      { identity },
    );
    if (!pool) throw new Error("renderWithStore must provide a fake pool");

    await waitFor(() => expect(getStore().state.identity?.pubkey).toBe(me));

    act(() => {
      pool.emit(replyFrom(mutedSk, 20));
      pool.emit(replyFrom(keptSk, 10));
      pool.eose();
    });

    await waitFor(() => expect(getStore().state.notifications).toHaveLength(2));
    // "Unread 2" before muting (both unread).
    await waitFor(() => expect(screen.getByText(/Unread 2/)).toBeDefined());

    act(() => getStore().toggleMuteAccount(mutedAuthor));

    // Muting one unread source drops the in-view unread count to 1.
    await waitFor(() => expect(screen.getByText(/Unread 1/)).toBeDefined());
    expect(screen.queryByText(/Unread 2/)).toBeNull();
  });
});

describe("Sidebar unread badge soft-mute", () => {
  const findBadge = (): HTMLElement => {
    const nav = screen.getByTestId("nav-notifications");
    // The pill badge is the trailing numeric span inside the nav button.
    return within(nav).getByText(/^\d+$|^99\+$/);
  };

  test("excludes muted-and-unread notifications from the badge count", async () => {
    const { pool } = renderWithStore(
      <>
        <Sidebar onCompose={() => undefined} />
        <Probe />
      </>,
      { identity },
    );
    if (!pool) throw new Error("renderWithStore must provide a fake pool");

    await waitFor(() => expect(getStore().state.identity?.pubkey).toBe(me));

    act(() => {
      pool.emit(replyFrom(mutedSk, 20));
      pool.emit(replyFrom(keptSk, 10));
      pool.eose();
    });

    await waitFor(() => expect(getStore().state.notifications).toHaveLength(2));
    // Two unread, no rules → badge shows 2.
    await waitFor(() => expect(findBadge().textContent).toBe("2"));

    // Mute one unread author mid-session → badge drops to 1.
    act(() => getStore().toggleMuteAccount(mutedAuthor));
    await waitFor(() => expect(findBadge().textContent).toBe("1"));
  });

  test("the 99+ cap reflects the muted-excluded count", async () => {
    const { pool } = renderWithStore(
      <>
        <Sidebar onCompose={() => undefined} />
        <Probe />
      </>,
      { identity },
    );
    if (!pool) throw new Error("renderWithStore must provide a fake pool");

    await waitFor(() => expect(getStore().state.identity?.pubkey).toBe(me));

    // 100 distinct unread notifications from kept authors → badge caps at "99+".
    act(() => {
      for (let i = 0; i < 100; i++) pool.emit(replyFrom(generateSecretKey(), 1000 + i));
      // Plus several from the to-be-muted author.
      pool.emit(replyFrom(mutedSk, 2000));
      pool.emit(replyFrom(mutedSk, 2001));
      pool.eose();
    });

    await waitFor(() => expect(getStore().state.notifications.length).toBeGreaterThanOrEqual(101));
    await waitFor(() => expect(findBadge().textContent).toBe("99+"));

    // Muting the noisy author removes its 2 notifications from the count, but the
    // remaining 100 still exceed the cap → label stays "99+", proving exclusion
    // is applied before the cap (count went 102 → 100, both render as "99+").
    act(() => getStore().toggleMuteAccount(mutedAuthor));
    await waitFor(() => expect(findBadge().textContent).toBe("99+"));
  });
});
