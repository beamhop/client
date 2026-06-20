import { afterEach, describe, expect, test } from "bun:test";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { act, renderHookWithStore, waitFor, clientWithFakePool } from "../../../test/render.tsx";
import { useStore } from "../store.tsx";
import { Kind } from "../../nostr/types.ts";
import type { Identity } from "../../nostr/keys.ts";
import {
  type MuteSettings,
  createRule,
  parseMuteSettings,
  serializeMuteSettings,
} from "../../lib/mute.ts";
import { buildMuteList } from "../../nostr/nip51.ts";

const sk = generateSecretKey();
const me = getPublicKey(sk);
const myIdentity: Identity = { kind: "local", secretKey: sk, pubkey: me };

const mutesKey = (pubkey: string): string => `beamhop.mutes.v1:${pubkey}`;

// Read a persisted mute blob straight back out of localStorage and parse it.
const persistedMutes = (pubkey: string): MuteSettings =>
  parseMuteSettings(JSON.parse(localStorage.getItem(mutesKey(pubkey)) ?? "null"));

// Seed a per-identity mute set before render so the provider boots with it.
const seedMutes = (pubkey: string, settings: MuteSettings): void =>
  localStorage.setItem(mutesKey(pubkey), serializeMuteSettings(settings));

afterEach(() => {
  window.location.hash = "";
});

describe("addMuteRule / removeMuteRule / updateMuteRule", () => {
  test("addMuteRule updates state and persists to the identity-scoped key", async () => {
    const { result } = renderHookWithStore(() => useStore(), { identity: myIdentity });
    await waitFor(() => expect(result.current.state.identity?.pubkey).toBe(me));

    act(() => result.current.addMuteRule({ type: "keyword", value: "airdrop" }));

    const rule = result.current.state.muteSettings.rules.find(
      (r) => r.type === "keyword" && r.value === "airdrop",
    );
    expect(rule).toBeDefined();

    const stored = persistedMutes(me);
    expect(stored.rules.some((r) => r.type === "keyword" && r.value === "airdrop")).toBe(true);
  });

  test("removeMuteRule drops the rule from state and storage", async () => {
    const { result } = renderHookWithStore(() => useStore(), { identity: myIdentity });
    await waitFor(() => expect(result.current.state.identity?.pubkey).toBe(me));

    act(() => result.current.addMuteRule({ type: "keyword", value: "airdrop" }));
    const id = result.current.state.muteSettings.rules[0]?.id;
    expect(id).toBeDefined();

    act(() => result.current.removeMuteRule(id ?? ""));
    expect(result.current.state.muteSettings.rules).toHaveLength(0);
    expect(persistedMutes(me).rules).toHaveLength(0);
  });

  test("updateMuteRule patches the rule in state and storage", async () => {
    const { result } = renderHookWithStore(() => useStore(), { identity: myIdentity });
    await waitFor(() => expect(result.current.state.identity?.pubkey).toBe(me));

    act(() => result.current.addMuteRule({ type: "keyword", value: "airdrop" }));
    const id = result.current.state.muteSettings.rules[0]?.id ?? "";

    act(() => result.current.updateMuteRule(id, { enabled: false }));
    expect(result.current.state.muteSettings.rules[0]?.enabled).toBe(false);
    expect(persistedMutes(me).rules[0]?.enabled).toBe(false);
  });
});

describe("toggleMuteAccount", () => {
  test("adds then removes an account rule on repeated calls", async () => {
    const { result } = renderHookWithStore(() => useStore(), { identity: myIdentity });
    await waitFor(() => expect(result.current.state.identity?.pubkey).toBe(me));

    const target = getPublicKey(generateSecretKey());

    act(() => result.current.toggleMuteAccount(target));
    expect(
      result.current.state.muteSettings.rules.some(
        (r) => r.type === "account" && r.pubkey === target,
      ),
    ).toBe(true);
    expect(persistedMutes(me).rules.some((r) => r.type === "account" && r.pubkey === target)).toBe(
      true,
    );

    act(() => result.current.toggleMuteAccount(target));
    expect(
      result.current.state.muteSettings.rules.some(
        (r) => r.type === "account" && r.pubkey === target,
      ),
    ).toBe(false);
    expect(persistedMutes(me).rules).toHaveLength(0);
  });

  test("refuses to mute your own pubkey", async () => {
    const { result } = renderHookWithStore(() => useStore(), { identity: myIdentity });
    await waitFor(() => expect(result.current.state.identity?.pubkey).toBe(me));

    act(() => result.current.toggleMuteAccount(me));
    expect(result.current.state.muteSettings.rules).toHaveLength(0);
    expect(result.current.state.toasts.at(-1)?.tone).toBe("warn");
  });
});

describe("setMuteDisplay", () => {
  test("updates and persists the display mode", async () => {
    const { result } = renderHookWithStore(() => useStore(), { identity: myIdentity });
    await waitFor(() => expect(result.current.state.identity?.pubkey).toBe(me));
    expect(result.current.state.muteSettings.display).toBe("hidden");

    act(() => result.current.setMuteDisplay("summary"));
    expect(result.current.state.muteSettings.display).toBe("summary");
    expect(persistedMutes(me).display).toBe("summary");
  });
});

describe("export / import", () => {
  test("exportMuteSettings returns JSON containing a seeded rule", async () => {
    seedMutes(me, { display: "hidden", rules: [createRule({ type: "keyword", value: "airdrop" })] });
    const { result } = renderHookWithStore(() => useStore(), { identity: myIdentity });
    await waitFor(() =>
      expect(result.current.state.muteSettings.rules.length).toBeGreaterThan(0),
    );

    const json = result.current.exportMuteSettings();
    expect(json).toContain("airdrop");
    // Round-trips back into a parseable settings object.
    expect(parseMuteSettings(JSON.parse(json)).rules.some((r) => r.type === "keyword")).toBe(true);
  });

  test("importMuteSettings merges valid JSON and rejects malformed input", async () => {
    seedMutes(me, { display: "hidden", rules: [createRule({ type: "keyword", value: "airdrop" })] });
    const { result } = renderHookWithStore(() => useStore(), { identity: myIdentity });
    await waitFor(() =>
      expect(result.current.state.muteSettings.rules.length).toBeGreaterThan(0),
    );

    const incoming = serializeMuteSettings({
      display: "summary",
      rules: [createRule({ type: "keyword", value: "casino" })],
    });

    let ok = false;
    act(() => {
      ok = result.current.importMuteSettings(incoming);
    });
    expect(ok).toBe(true);
    // Existing + imported rules both present after the merge.
    expect(
      result.current.state.muteSettings.rules.some((r) => r.type === "keyword" && r.value === "airdrop"),
    ).toBe(true);
    expect(
      result.current.state.muteSettings.rules.some((r) => r.type === "keyword" && r.value === "casino"),
    ).toBe(true);

    let bad = true;
    act(() => {
      bad = result.current.importMuteSettings("}{ not json");
    });
    expect(bad).toBe(false);
  });
});

describe("per-identity load", () => {
  test("boots with the active identity's seeded rules, not another pubkey's", async () => {
    const otherSk = generateSecretKey();
    const other = getPublicKey(otherSk);

    seedMutes(me, { display: "hidden", rules: [createRule({ type: "keyword", value: "mine" })] });
    seedMutes(other, { display: "hidden", rules: [createRule({ type: "keyword", value: "theirs" })] });

    const { result } = renderHookWithStore(() => useStore(), { identity: myIdentity });
    await waitFor(() =>
      expect(result.current.state.muteSettings.rules.length).toBeGreaterThan(0),
    );

    expect(
      result.current.state.muteSettings.rules.some((r) => r.type === "keyword" && r.value === "mine"),
    ).toBe(true);
    expect(
      result.current.state.muteSettings.rules.some((r) => r.type === "keyword" && r.value === "theirs"),
    ).toBe(false);
  });
});

describe("ingestion filter", () => {
  test("an account-muted author's notification is dropped; an unmuted author's is kept", async () => {
    const mutedSk = generateSecretKey();
    const mutedAuthor = getPublicKey(mutedSk);
    const allowedSk = generateSecretKey();
    const allowedAuthor = getPublicKey(allowedSk);

    // Seed the account mute before render so muteRef compiles with it on boot.
    seedMutes(me, {
      display: "hidden",
      rules: [createRule({ type: "account", pubkey: mutedAuthor })],
    });

    const { result, pool } = renderHookWithStore(() => useStore(), { identity: myIdentity });
    await waitFor(() => expect(result.current.state.identity?.pubkey).toBe(me));
    // Wait until the seeded account rule is in state (and thus compiled into muteRef).
    await waitFor(() =>
      expect(
        result.current.state.muteSettings.rules.some(
          (r) => r.type === "account" && r.pubkey === mutedAuthor,
        ),
      ).toBe(true),
    );

    // A reply (kind 1 tagging me) from the muted author and one from an allowed author.
    const mutedReply = finalizeEvent(
      { kind: Kind.Note, created_at: 20, tags: [["p", me], ["e", "n1"]], content: "from muted" },
      mutedSk,
    );
    const allowedReply = finalizeEvent(
      { kind: Kind.Note, created_at: 21, tags: [["p", me], ["e", "n1"]], content: "from allowed" },
      allowedSk,
    );

    act(() => {
      pool.emit(mutedReply);
      pool.emit(allowedReply);
    });
    act(() => pool.eose());

    await waitFor(() =>
      expect(result.current.state.notifications.some((n) => n.pubkey === allowedAuthor)).toBe(true),
    );
    expect(result.current.state.notifications.some((n) => n.pubkey === mutedAuthor)).toBe(false);
  });
});

describe("NIP-51 relay sync — union merge on login", () => {
  test("merges remote rules with local rules so neither side loses entries added offline", async () => {
    // Local has "local-rule"; relay has "remote-rule". After login both should be present.
    seedMutes(me, {
      display: "hidden",
      rules: [createRule({ type: "keyword", value: "local-rule" })],
    });

    const remoteSettings: MuteSettings = {
      display: "hidden",
      rules: [createRule({ type: "keyword", value: "remote-rule" })],
    };
    const template = await buildMuteList(remoteSettings, myIdentity);
    // created_at must be > 0 (the default lastMergedRelayAt) so the merge triggers.
    const remoteEvent = finalizeEvent({ ...template, created_at: 1 }, sk);

    // Configure the pool BEFORE rendering so the resolver is in place when the
    // login fetch fires immediately on mount.
    const { client, pool } = clientWithFakePool();
    pool.getResolver = (filter) => (filter.kinds?.includes(10000) ? remoteEvent : null);
    const { result } = renderHookWithStore(() => useStore(), { identity: myIdentity, client });

    await waitFor(() =>
      expect(
        result.current.state.muteSettings.rules.some(
          (r) => r.type === "keyword" && r.value === "local-rule",
        ),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(
        result.current.state.muteSettings.rules.some(
          (r) => r.type === "keyword" && r.value === "remote-rule",
        ),
      ).toBe(true),
    );
  });

  test("skips relay event when its created_at is not newer than the last merged timestamp", async () => {
    // Seed the relay-at marker so it looks like we've already merged this event.
    localStorage.setItem(`beamhop.mutes.relayAt.v1:${me}`, "999");

    seedMutes(me, {
      display: "hidden",
      rules: [createRule({ type: "keyword", value: "existing" })],
    });

    const remoteSettings: MuteSettings = {
      display: "hidden",
      rules: [createRule({ type: "keyword", value: "should-not-appear" })],
    };
    // created_at = 500, which is < lastMergedRelayAt (999) → should be skipped.
    const template = await buildMuteList(remoteSettings, myIdentity);
    const staleEvent = finalizeEvent({ ...template, created_at: 500 }, sk);

    const { client, pool } = clientWithFakePool();
    pool.getResolver = (filter) => (filter.kinds?.includes(10000) ? staleEvent : null);
    const { result } = renderHookWithStore(() => useStore(), { identity: myIdentity, client });

    await waitFor(() => expect(result.current.state.identity?.pubkey).toBe(me));
    // Give the fetch time to complete, then assert the stale event was ignored.
    await waitFor(() =>
      expect(
        result.current.state.muteSettings.rules.some(
          (r) => r.type === "keyword" && r.value === "existing",
        ),
      ).toBe(true),
    );
    expect(
      result.current.state.muteSettings.rules.some(
        (r) => r.type === "keyword" && r.value === "should-not-appear",
      ),
    ).toBe(false);
  });

  test("expiresAt is preserved through the relay round-trip", async () => {
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000; // 24h from now
    const remoteSettings: MuteSettings = {
      display: "hidden",
      rules: [createRule({ type: "keyword", value: "temp-mute", expiresAt })],
    };
    const template = await buildMuteList(remoteSettings, myIdentity);
    const remoteEvent = finalizeEvent({ ...template, created_at: 1 }, sk);

    const { client, pool } = clientWithFakePool();
    pool.getResolver = (filter) => (filter.kinds?.includes(10000) ? remoteEvent : null);
    const { result } = renderHookWithStore(() => useStore(), { identity: myIdentity, client });

    await waitFor(() =>
      expect(
        result.current.state.muteSettings.rules.some(
          (r) => r.type === "keyword" && r.value === "temp-mute" && r.expiresAt !== undefined,
        ),
      ).toBe(true),
    );

    const rule = result.current.state.muteSettings.rules.find(
      (r) => r.type === "keyword" && r.value === "temp-mute",
    );
    // Round-tripped through unix seconds, so within 1000ms of original.
    expect(Math.abs((rule?.expiresAt ?? 0) - expiresAt)).toBeLessThan(1000);
  });
});

describe("NIP-51 relay sync — publish failure toast", () => {
  test("shows a warn toast when the relay publish fails", async () => {
    const { result, pool } = renderHookWithStore(() => useStore(), { identity: myIdentity });
    await waitFor(() => expect(result.current.state.identity?.pubkey).toBe(me));

    pool.publishAccepts = false;
    act(() => result.current.addMuteRule({ type: "keyword", value: "relay-fail-test" }));

    // Wait for the 1500ms debounce to fire and the toast to appear.
    await waitFor(
      () =>
        expect(
          result.current.state.toasts.some((t) => t.tone === "warn" && t.text.includes("Mute list")),
        ).toBe(true),
      { timeout: 4000 },
    );
  });
});
