import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RELAYS,
  loadRelays,
  normalizeRelayUrl,
  readRelays,
  saveRelays,
  writeRelays,
} from "../relays.ts";
import type { RelayInfo } from "../types.ts";

const STORAGE_KEY = "verity.relays.v1";

const relay = (over: Partial<RelayInfo>): RelayInfo => ({
  url: "wss://example",
  enabled: true,
  read: true,
  write: true,
  status: "disconnected",
  ...over,
});

describe("loadRelays", () => {
  test("returns a copy of the defaults when nothing is stored", () => {
    const relays = loadRelays();
    expect(relays).toEqual(DEFAULT_RELAYS.map((r) => ({ ...r })));
    // Must be a fresh copy, not the frozen module constant.
    expect(relays[0]).not.toBe(DEFAULT_RELAYS[0]);
  });

  test("falls back to defaults when stored JSON is not an array", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ nope: true }));
    expect(loadRelays()).toEqual(DEFAULT_RELAYS.map((r) => ({ ...r })));
  });

  test("falls back to defaults when stored JSON is corrupt", () => {
    localStorage.setItem(STORAGE_KEY, "{not json");
    expect(loadRelays()).toHaveLength(DEFAULT_RELAYS.length);
  });

  test("falls back to defaults when every stored entry is invalid", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([null, 3, { url: "" }, { url: "   " }]));
    expect(loadRelays()).toEqual(DEFAULT_RELAYS.map((r) => ({ ...r })));
  });

  test("migrates legacy entries, defaulting missing flags to enabled/read/write", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([{ url: "wss://legacy.example", read: true, write: false }]));
    expect(loadRelays()).toEqual([
      relay({ url: "wss://legacy.example", enabled: true, read: true, write: false }),
    ]);
  });

  test("always resets status to disconnected on load", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([{ url: "wss://x", status: "connected" }]));
    expect(loadRelays()[0]?.status).toBe("disconnected");
  });
});

describe("saveRelays / round-trip", () => {
  test("saved relays reload to an equivalent set", () => {
    const relays = [relay({ url: "wss://a" }), relay({ url: "wss://b", write: false })];
    saveRelays(relays);
    expect(loadRelays()).toEqual(relays);
  });
});

describe("readRelays / writeRelays", () => {
  const relays: RelayInfo[] = [
    relay({ url: "wss://rw" }),
    relay({ url: "wss://read-only", write: false }),
    relay({ url: "wss://write-only", read: false }),
    relay({ url: "wss://disabled", enabled: false }),
  ];

  test("readRelays keeps enabled relays flagged for reading", () => {
    expect(readRelays(relays)).toEqual(["wss://rw", "wss://read-only"]);
  });

  test("writeRelays keeps enabled relays flagged for writing", () => {
    expect(writeRelays(relays)).toEqual(["wss://rw", "wss://write-only"]);
  });
});

describe("normalizeRelayUrl", () => {
  test("prefixes wss:// when no scheme is given", () => {
    expect(normalizeRelayUrl("relay.example")).toBe("wss://relay.example");
  });

  test("preserves an explicit ws:// or wss:// scheme", () => {
    expect(normalizeRelayUrl("ws://local.test")).toBe("ws://local.test");
    expect(normalizeRelayUrl("wss://relay.example")).toBe("wss://relay.example");
  });

  test("trims whitespace and strips trailing slashes", () => {
    expect(normalizeRelayUrl("  relay.example//  ")).toBe("wss://relay.example");
  });
});
