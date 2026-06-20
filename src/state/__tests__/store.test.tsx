import { afterEach, describe, expect, test } from "bun:test";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { act, clientWithFakePool, renderHookWithStore, waitFor } from "../../../test/render.tsx";
import { useProfile, useStore } from "../store.tsx";
import { buildProfile } from "../../nostr/events.ts";
import { Kind } from "../../nostr/types.ts";
import type { Identity } from "../../nostr/keys.ts";

const sk = generateSecretKey();
const me = getPublicKey(sk);
const myIdentity: Identity = { kind: "local", secretKey: sk, pubkey: me };

afterEach(() => {
  window.location.hash = "";
});

describe("StoreProvider boot", () => {
  test("becomes ready and defaults to the home view", async () => {
    const { result } = renderHookWithStore(() => useStore());
    await waitFor(() => expect(result.current.state.ready).toBe(true));
    expect(result.current.state.nav.view).toBe("home");
    expect(result.current.readRelayUrls.length).toBeGreaterThan(0);
  });

  test("hydrates a persisted identity", async () => {
    const { result } = renderHookWithStore(() => useStore(), { identity: myIdentity });
    await waitFor(() => expect(result.current.state.identity?.pubkey).toBe(me));
  });
});

describe("navigation", () => {
  test("navigate updates the nav state and the location hash", async () => {
    const { result } = renderHookWithStore(() => useStore());
    await waitFor(() => expect(result.current.state.ready).toBe(true));

    act(() => result.current.navigate("explore"));
    expect(result.current.state.nav.view).toBe("explore");
    expect(window.location.hash).toBe("#/explore");
  });
});

describe("theme + palette", () => {
  test("toggleTheme flips and persists the mode", async () => {
    const { result } = renderHookWithStore(() => useStore());
    await waitFor(() => expect(result.current.state.ready).toBe(true));
    const before = result.current.state.theme;

    act(() => result.current.toggleTheme());
    expect(result.current.state.theme).not.toBe(before);
    expect(localStorage.getItem("beamhop.theme.v1")).toBe(result.current.state.theme);
  });

  test("setPalette updates state, persists, and toasts", async () => {
    const { result } = renderHookWithStore(() => useStore());
    await waitFor(() => expect(result.current.state.ready).toBe(true));

    act(() => result.current.setPalette("Pine"));
    expect(result.current.state.palette).toBe("Pine");
    expect(localStorage.getItem("beamhop.palette.v1")).toBe("Pine");
    expect(result.current.state.toasts.some((t) => t.text.includes("Pine"))).toBe(true);
  });
});

describe("bookmarks", () => {
  test("toggleBookmark adds then removes, persisting each time", async () => {
    const { result } = renderHookWithStore(() => useStore());
    await waitFor(() => expect(result.current.state.ready).toBe(true));

    act(() => result.current.toggleBookmark("note1"));
    expect(result.current.state.bookmarks).toContain("note1");
    expect(JSON.parse(localStorage.getItem("beamhop.bookmarks.v1") ?? "[]")).toContain("note1");

    act(() => result.current.toggleBookmark("note1"));
    expect(result.current.state.bookmarks).not.toContain("note1");
  });
});

describe("toasts", () => {
  test("toast pushes a message that can carry a profile action", async () => {
    const { result } = renderHookWithStore(() => useStore());
    await waitFor(() => expect(result.current.state.ready).toBe(true));

    act(() => result.current.toast("hi", "check", { type: "profile", pubkey: me }));
    const toast = result.current.state.toasts.at(-1);
    expect(toast?.text).toBe("hi");
    expect(toast?.action).toEqual({ type: "profile", pubkey: me });
  });
});

describe("follow", () => {
  test("toggleFollow optimistically adds a contact and publishes", async () => {
    const { result, pool } = renderHookWithStore(() => useStore(), { identity: myIdentity });
    await waitFor(() => expect(result.current.state.identity?.pubkey).toBe(me));

    const target = getPublicKey(generateSecretKey());
    await act(async () => {
      await result.current.toggleFollow(target);
    });
    expect(result.current.state.contacts).toContain(target);
    // a kind-3 contacts event was published through the client
    expect(pool.published.some((e) => e.kind === Kind.Contacts)).toBe(true);
  });

  test("toggleFollow without an identity warns instead of publishing", async () => {
    const { result, pool } = renderHookWithStore(() => useStore());
    await waitFor(() => expect(result.current.state.ready).toBe(true));

    await act(async () => {
      await result.current.toggleFollow("someone");
    });
    expect(result.current.state.contacts).toEqual([]);
    expect(pool.published).toHaveLength(0);
    expect(result.current.state.toasts.at(-1)?.tone).toBe("warn");
  });

  test("a failed publish rolls back the optimistic follow", async () => {
    const { result, pool } = renderHookWithStore(() => useStore(), { identity: myIdentity });
    await waitFor(() => expect(result.current.state.identity?.pubkey).toBe(me));
    pool.publishAccepts = false; // every relay rejects

    const target = getPublicKey(generateSecretKey());
    await act(async () => {
      await result.current.toggleFollow(target);
    });
    expect(result.current.state.contacts).not.toContain(target);
    expect(result.current.state.toasts.at(-1)?.text).toBe("Could not update follows");
  });
});

describe("relays + me", () => {
  test("setRelays persists and updates derived read/write URL lists", async () => {
    const { result } = renderHookWithStore(() => useStore());
    await waitFor(() => expect(result.current.state.ready).toBe(true));

    act(() =>
      result.current.setRelays([
        { url: "wss://only-read", enabled: true, read: true, write: false, status: "disconnected" },
        { url: "wss://only-write", enabled: true, read: false, write: true, status: "disconnected" },
      ]),
    );
    expect(result.current.readRelayUrls).toEqual(["wss://only-read"]);
    expect(result.current.writeRelayUrls).toEqual(["wss://only-write"]);
    expect(JSON.parse(localStorage.getItem("beamhop.relays.v1") ?? "[]")).toHaveLength(2);
  });

  test("setMe updates the profile in state", async () => {
    const { result } = renderHookWithStore(() => useStore(), { identity: myIdentity });
    await waitFor(() => expect(result.current.state.ready).toBe(true));
    act(() => result.current.setMe({ pubkey: me, name: "Me" }));
    expect(result.current.state.me).toEqual({ pubkey: me, name: "Me" });
  });
});

describe("notifications", () => {
  test("incoming reply is recorded and can be marked read", async () => {
    const { result, pool } = renderHookWithStore(() => useStore(), { identity: myIdentity });
    await waitFor(() => expect(result.current.state.identity?.pubkey).toBe(me));

    const other = generateSecretKey();
    const reply = finalizeEvent(
      { kind: Kind.Note, created_at: 10, tags: [["p", me], ["e", "note1"]], content: "ping" },
      other,
    );
    act(() => pool.emit(reply));

    await waitFor(() => expect(result.current.state.notifications).toHaveLength(1));
    const notification = result.current.state.notifications[0];
    expect(notification?.type).toBe("reply");

    act(() => result.current.markNotificationRead(notification!.eventId));
    expect(result.current.state.notificationReadIds).toContain(notification!.eventId);

    act(() => result.current.markAllNotificationsRead());
    expect(result.current.state.notificationReadIds).toContain(notification!.eventId);
  });

  test("reaction, zap and dm events become typed notifications and toast once live", async () => {
    const { result, pool } = renderHookWithStore(() => useStore(), { identity: myIdentity });
    await waitFor(() => expect(result.current.state.identity?.pubkey).toBe(me));
    const other = generateSecretKey();

    act(() => pool.eose()); // EOSE → live: subsequent events toast (+ ping)

    act(() =>
      pool.emit(
        finalizeEvent({ kind: Kind.Reaction, created_at: 11, tags: [["p", me], ["e", "n1"]], content: "🤙" }, other),
      ),
    );
    await waitFor(() => expect(result.current.state.notifications.some((n) => n.type === "reaction")).toBe(true));
    expect(result.current.state.toasts.length).toBeGreaterThan(0);

    act(() =>
      pool.emit(
        finalizeEvent(
          { kind: Kind.ZapReceipt, created_at: 12, tags: [["p", me], ["e", "n1"], ["amount", "2100"]], content: "" },
          other,
        ),
      ),
    );
    await waitFor(() => expect(result.current.state.notifications.some((n) => n.type === "zap")).toBe(true));

    act(() =>
      pool.emit(finalizeEvent({ kind: Kind.EncryptedDM, created_at: 13, tags: [["p", me]], content: "ct" }, other)),
    );
    await waitFor(() => expect(result.current.state.notifications.some((n) => n.type === "dm")).toBe(true));
  });

  test("a reply event authored by me is not a notification", async () => {
    const { result, pool } = renderHookWithStore(() => useStore(), { identity: myIdentity });
    await waitFor(() => expect(result.current.state.identity?.pubkey).toBe(me));

    const mine = finalizeEvent({ kind: Kind.Note, created_at: 10, tags: [["p", me]], content: "self" }, sk);
    act(() => pool.emit(mine));
    // give the subscription a tick; should remain empty
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.state.notifications).toHaveLength(0);
  });
});

describe("publish + signOut", () => {
  test("publish throws without an identity", async () => {
    const { result } = renderHookWithStore(() => useStore());
    await waitFor(() => expect(result.current.state.ready).toBe(true));
    expect(result.current.publish({ kind: 1, created_at: 1, tags: [], content: "x" })).rejects.toThrow(
      "Sign in first",
    );
  });

  test("signOut clears identity, contacts, and storage", async () => {
    const { result } = renderHookWithStore(() => useStore(), { identity: myIdentity });
    await waitFor(() => expect(result.current.state.identity?.pubkey).toBe(me));

    act(() => result.current.signOut());
    expect(result.current.state.identity).toBeNull();
    expect(result.current.state.contacts).toEqual([]);
    expect(localStorage.getItem("beamhop.identity.v1")).toBeNull();
  });
});

describe("fetchProfile + useProfile", () => {
  test("fetchProfile resolves and decodes a profile once relays are ready", async () => {
    const peerSk = generateSecretKey();
    const peer = getPublicKey(peerSk);
    const event = finalizeEvent(buildProfile({ name: "Peer" }), peerSk);

    const { client, pool } = clientWithFakePool();
    pool.getResolver = (filter) =>
      filter.kinds?.includes(Kind.Metadata) && filter.authors?.includes(peer) ? event : null;

    const { result } = renderHookWithStore(() => useStore(), { client, pool });
    await waitFor(() => expect(result.current.state.ready).toBe(true));

    const profile = await result.current.fetchProfile(peer);
    expect(profile).toMatchObject({ pubkey: peer, name: "Peer" });
    // a second call is served from the shared cache (same promise identity)
    expect(result.current.fetchProfile(peer)).toBe(result.current.fetchProfile(peer));
  });

  test("useProfile resolves to null when there is no profile and never crashes", async () => {
    const { client, pool } = clientWithFakePool();
    pool.getResolver = () => null;
    const { result } = renderHookWithStore(() => useProfile("a".repeat(64)), { client, pool });
    await waitFor(() => expect(result.current).toBeNull());
  });
});
