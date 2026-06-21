import { describe, expect, test } from "bun:test";
import { timeAgo, fmtCount, initials, displayName, hashCode, avatarStyle } from "../format.ts";

describe("format helpers", () => {
  test("timeAgo buckets seconds into human spans", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(timeAgo(now)).toBe("now");
    expect(timeAgo(now - 120)).toBe("2m");
    expect(timeAgo(now - 7200)).toBe("2h");
    expect(timeAgo(now - 172800)).toBe("2d");
  });

  test("fmtCount abbreviates thousands", () => {
    expect(fmtCount(42)).toBe("42");
    expect(fmtCount(1500)).toBe("1.5k");
    expect(fmtCount(12000)).toBe("12k");
  });

  test("initials takes first letters of up to two names", () => {
    expect(initials("Maya Okonkwo")).toBe("MO");
    expect(initials("cher")).toBe("C");
  });

  test("displayName prefers display name, then name, then short pubkey", () => {
    expect(displayName({ displayName: "D", name: "N", pubkey: "abc" })).toBe("D");
    expect(displayName({ name: "N", pubkey: "abc" })).toBe("N");
    expect(displayName({ pubkey: "abcdef1234567890" })).toBe("abcdef12…");
  });

  test("hashCode is deterministic", () => {
    expect(hashCode("seed")).toBe(hashCode("seed"));
  });

  test("avatarStyle is deterministic for a seed and embeds a picture when given", () => {
    const a = avatarStyle("seed", 44);
    const b = avatarStyle("seed", 44);
    expect(a.background).toBe(b.background);
    const withPic = avatarStyle("seed", 44, "https://x/y.png");
    expect(String(withPic.backgroundImage)).toContain("https://x/y.png");
  });
});
