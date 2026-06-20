import { describe, expect, test } from "bun:test";
import { getPublicKey } from "nostr-tools";
import {
  createLocalIdentity,
  importSecret,
  npubOf,
  nsecOf,
  shortNpub,
} from "../keys.ts";

describe("key handling", () => {
  test("a generated local identity exposes a matching pubkey", () => {
    const id = createLocalIdentity();
    expect(id.kind).toBe("local");
    if (id.kind === "local") {
      expect(getPublicKey(id.secretKey)).toBe(id.pubkey);
      expect(id.pubkey).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("an nsec round-trips through encode then import", () => {
    const id = createLocalIdentity();
    if (id.kind !== "local") throw new Error("expected local");
    const nsec = nsecOf(id.secretKey);
    expect(nsec).toMatch(/^nsec1/);
    const reimported = importSecret(nsec);
    expect(reimported.pubkey).toBe(id.pubkey);
  });

  test("importing a 64-char hex secret works", () => {
    const id = createLocalIdentity();
    if (id.kind !== "local") throw new Error("expected local");
    const hex = Array.from(id.secretKey, (b) => b.toString(16).padStart(2, "0")).join("");
    expect(importSecret(hex).pubkey).toBe(id.pubkey);
  });

  test("importing garbage throws", () => {
    expect(() => importSecret("not-a-key")).toThrow();
  });

  test("npub encoding and short display", () => {
    const id = createLocalIdentity();
    const npub = npubOf(id.pubkey);
    expect(npub).toMatch(/^npub1/);
    const short = shortNpub(id.pubkey);
    expect(short).toContain("…");
    expect(short.startsWith("npub1")).toBe(true);
  });
});
