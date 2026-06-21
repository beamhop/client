import { describe, expect, test } from "bun:test";
import {
  EMPTY_MUTE_SETTINGS,
  MAX_KEYWORD_LENGTH,
  MAX_REGEX_LENGTH,
  TTL_PRESETS,
  addRule,
  arrangeFeed,
  compileMutes,
  createRule,
  evaluateArticle,
  evaluateDm,
  evaluateNote,
  evaluateNotification,
  evaluateRepost,
  expiryFromTtl,
  isRuleActive,
  isRuleExpired,
  makeRuleId,
  mergeSettings,
  parseMuteSettings,
  removeRule,
  ruleKey,
  sanitizeFlags,
  serializeMuteSettings,
  updateRule,
  validateRegex,
  type MuteRule,
  type MuteSettings,
} from "../mute.ts";

// A fixed reference time so expiry assertions never depend on wall-clock timing.
const NOW = 1_700_000_000_000;

// 64-char hex pubkeys for account-rule tests.
const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);

// Only the (variant-independent) base fields may be overridden — typing `over`
// as Partial<MuteRule> would distribute over the union and widen `type`.
type RuleOverride = { id?: string; createdAt?: number; enabled?: boolean; expiresAt?: number };

const baseFields = (
  o: RuleOverride,
): { id: string; createdAt: number; enabled: boolean; expiresAt?: number } => ({
  id: o.id ?? makeRuleId(),
  createdAt: o.createdAt ?? NOW,
  enabled: o.enabled ?? true,
  expiresAt: o.expiresAt,
});

const keywordRule = (value: string, over: RuleOverride = {}): MuteRule => ({
  ...baseFields(over),
  type: "keyword",
  value,
});

const accountRule = (pubkey: string, over: RuleOverride = {}): MuteRule => ({
  ...baseFields(over),
  type: "account",
  pubkey,
});

const regexRule = (source: string, flags = "i", over: RuleOverride = {}): MuteRule => ({
  ...baseFields(over),
  type: "regex",
  source,
  flags,
});

describe("compileMutes — keyword whole-word matching", () => {
  const c = compileMutes([keywordRule("art")], NOW);

  test("hides standalone occurrences regardless of surrounding punctuation/hashtags", () => {
    expect(c.matchText("I love art")).toBeDefined();
    expect(c.matchText("check #art")).toBeDefined();
    expect(c.matchText("Art is everything.")).toBeDefined();
  });

  test("keeps words that merely contain the keyword as a substring", () => {
    expect(c.matchText("this article rocks")).toBeUndefined();
    expect(c.matchText("Bart Simpson")).toBeUndefined();
    expect(c.matchText("that was smart")).toBeUndefined();
  });

  test("is case-insensitive", () => {
    expect(c.matchText("ART")).toBeDefined();
    expect(c.matchText("aRt")).toBeDefined();
  });

  test("returns the matching rule, not just a boolean", () => {
    const rule = keywordRule("airdrop");
    const match = compileMutes([rule], NOW).matchText("free airdrop here");
    expect(match?.id).toBe(rule.id);
  });

  test("empty text never matches", () => {
    expect(c.matchText("")).toBeUndefined();
  });
});

describe("compileMutes — Unicode whole-word matching", () => {
  const c = compileMutes([keywordRule("мир")], NOW);

  test("matches a standalone Cyrillic word", () => {
    expect(c.matchText("привет мир")).toBeDefined();
  });

  test("does not match the keyword embedded in a larger Cyrillic word", () => {
    expect(c.matchText("кумир")).toBeUndefined();
  });
});

describe("compileMutes — account matching", () => {
  test("matchAccount is case-insensitive on hex and trims input", () => {
    const c = compileMutes([accountRule(HEX_A.toUpperCase())], NOW);
    expect(c.matchAccount(HEX_A)).toBeDefined();
    expect(c.matchAccount(HEX_A.toUpperCase())).toBeDefined();
    expect(c.matchAccount(`  ${HEX_A}  `)).toBeDefined();
    expect(c.matchAccount(HEX_B)).toBeUndefined();
  });

  test("mutedAccounts exposes the normalized lowercase set", () => {
    const c = compileMutes([accountRule(HEX_A.toUpperCase())], NOW);
    expect(c.mutedAccounts.has(HEX_A)).toBe(true);
    expect([...c.mutedAccounts]).toEqual([HEX_A]);
  });

  test("blank account pubkeys are dropped at compile time", () => {
    const c = compileMutes([accountRule("   ")], NOW);
    expect(c.isEmpty).toBe(true);
    expect(c.mutedAccounts.size).toBe(0);
  });
});

describe("compileMutes — isEmpty and rule filtering", () => {
  test("isEmpty is true with no active rules", () => {
    expect(compileMutes([], NOW).isEmpty).toBe(true);
  });

  test("isEmpty is false when any matcher exists", () => {
    expect(compileMutes([keywordRule("x")], NOW).isEmpty).toBe(false);
    expect(compileMutes([accountRule(HEX_A)], NOW).isEmpty).toBe(false);
  });

  test("disabled rules are ignored", () => {
    const c = compileMutes([keywordRule("art", { enabled: false })], NOW);
    expect(c.isEmpty).toBe(true);
    expect(c.matchText("love art")).toBeUndefined();
  });

  test("expired rules are ignored, future-expiring rules are kept", () => {
    const expired = compileMutes([keywordRule("art", { expiresAt: NOW - 1 })], NOW);
    expect(expired.matchText("love art")).toBeUndefined();
    const active = compileMutes([keywordRule("art", { expiresAt: NOW + 1 })], NOW);
    expect(active.matchText("love art")).toBeDefined();
  });

  test("a blank keyword value produces no matcher", () => {
    expect(compileMutes([keywordRule("   ")], NOW).isEmpty).toBe(true);
  });
});

describe("compileMutes — regex rules", () => {
  test("matches by pattern, case-insensitively (forced 'i')", () => {
    const c = compileMutes([regexRule("gm\\b", "")], NOW);
    expect(c.matchText("good GM everyone")).toBeDefined();
    expect(c.matchText("nothing here")).toBeUndefined();
  });

  test("a persisted pattern that no longer compiles is skipped, not thrown", () => {
    const c = compileMutes([regexRule("(", "i")], NOW);
    expect(c.isEmpty).toBe(true);
    expect(c.matchText("anything (")).toBeUndefined();
  });

  test("global/sticky flags do not break reuse across calls (lastIndex reset)", () => {
    const c = compileMutes([regexRule("ab", "g")], NOW);
    expect(c.matchText("ab")).toBeDefined();
    expect(c.matchText("ab")).toBeDefined();
  });
});

describe("evaluateNote", () => {
  test("matches a muted author", () => {
    const c = compileMutes([accountRule(HEX_A)], NOW);
    expect(evaluateNote(c, { pubkey: HEX_A, content: "hi", tags: [] })).toBeDefined();
  });

  test("matches via a p-tag mention of a muted account", () => {
    const c = compileMutes([accountRule(HEX_B)], NOW);
    const match = evaluateNote(c, { pubkey: HEX_A, content: "hi", tags: [["p", HEX_B]] });
    expect(match).toBeDefined();
  });

  test("ignores non-p tags and p-tags without a value", () => {
    const c = compileMutes([accountRule(HEX_B)], NOW);
    const note = { pubkey: HEX_A, content: "hi", tags: [["e", HEX_B], ["p"]] as string[][] };
    expect(evaluateNote(c, note)).toBeUndefined();
  });

  test("matches on text content", () => {
    const c = compileMutes([keywordRule("art")], NOW);
    expect(evaluateNote(c, { pubkey: HEX_A, content: "love art", tags: [] })).toBeDefined();
  });

  test("returns undefined for an unrelated note", () => {
    const c = compileMutes([accountRule(HEX_A), keywordRule("art")], NOW);
    expect(evaluateNote(c, { pubkey: HEX_B, content: "hello", tags: [] })).toBeUndefined();
  });
});

describe("evaluateRepost", () => {
  test("matches when the reposter is muted", () => {
    const c = compileMutes([accountRule(HEX_A)], NOW);
    const match = evaluateRepost(c, {
      repostedBy: HEX_A,
      note: { pubkey: HEX_B, content: "hi", tags: [] },
    });
    expect(match).toBeDefined();
  });

  test("matches when the underlying note is muted", () => {
    const c = compileMutes([keywordRule("art")], NOW);
    const match = evaluateRepost(c, {
      repostedBy: HEX_A,
      note: { pubkey: HEX_B, content: "love art", tags: [] },
    });
    expect(match).toBeDefined();
  });

  test("returns undefined when neither reposter nor note matches", () => {
    const c = compileMutes([accountRule(HEX_A)], NOW);
    const match = evaluateRepost(c, {
      repostedBy: HEX_B,
      note: { pubkey: HEX_B, content: "hi", tags: [] },
    });
    expect(match).toBeUndefined();
  });
});

describe("evaluateArticle", () => {
  const article = {
    pubkey: HEX_B,
    title: "A Title",
    summary: "A Summary",
    body: "A Body",
    hashtags: ["tagone"],
  } as const;

  test("matches a muted author", () => {
    const c = compileMutes([accountRule(HEX_B)], NOW);
    expect(evaluateArticle(c, article)).toBeDefined();
  });

  test("matches keyword in title, summary, body, or hashtags", () => {
    expect(evaluateArticle(compileMutes([keywordRule("title")], NOW), article)).toBeDefined();
    expect(evaluateArticle(compileMutes([keywordRule("summary")], NOW), article)).toBeDefined();
    expect(evaluateArticle(compileMutes([keywordRule("body")], NOW), article)).toBeDefined();
    expect(evaluateArticle(compileMutes([keywordRule("tagone")], NOW), article)).toBeDefined();
  });

  test("returns undefined for an unrelated article", () => {
    expect(evaluateArticle(compileMutes([keywordRule("absent")], NOW), article)).toBeUndefined();
  });
});

describe("evaluateDm", () => {
  test("matches an account rule", () => {
    const c = compileMutes([accountRule(HEX_A)], NOW);
    expect(evaluateDm(c, { pubkey: HEX_A })).toBeDefined();
  });

  test("never filters by keyword/regex (no text scope for DMs)", () => {
    const c = compileMutes([keywordRule("art"), regexRule("secret", "i")], NOW);
    expect(evaluateDm(c, { pubkey: HEX_A })).toBeUndefined();
  });
});

describe("evaluateNotification", () => {
  test("matches on account", () => {
    const c = compileMutes([accountRule(HEX_A)], NOW);
    expect(evaluateNotification(c, { pubkey: HEX_A, content: "" })).toBeDefined();
  });

  test("matches on text", () => {
    const c = compileMutes([keywordRule("art")], NOW);
    expect(evaluateNotification(c, { pubkey: HEX_A, content: "love art" })).toBeDefined();
  });

  test("returns undefined when neither matches", () => {
    const c = compileMutes([accountRule(HEX_A), keywordRule("art")], NOW);
    expect(evaluateNotification(c, { pubkey: HEX_B, content: "hello" })).toBeUndefined();
  });
});

describe("validateRegex", () => {
  test("accepts a valid pattern", () => {
    expect(validateRegex("foo", "i")).toEqual({ ok: true });
  });

  test("rejects an empty pattern", () => {
    expect(validateRegex("", "i")).toEqual({ ok: false, error: "Pattern is empty" });
  });

  test("rejects a pattern over MAX_REGEX_LENGTH", () => {
    const tooLong = "a".repeat(MAX_REGEX_LENGTH + 1);
    const result = validateRegex(tooLong, "i");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(String(MAX_REGEX_LENGTH));
  });

  test("accepts a pattern exactly at MAX_REGEX_LENGTH", () => {
    expect(validateRegex("a".repeat(MAX_REGEX_LENGTH), "i")).toEqual({ ok: true });
  });

  test("rejects an uncompilable pattern", () => {
    const result = validateRegex("(", "i");
    expect(result.ok).toBe(false);
  });

  test("defaults flags to 'i' when omitted", () => {
    expect(validateRegex("foo")).toEqual({ ok: true });
  });
});

describe("sanitizeFlags", () => {
  test("always forces case-insensitive 'i'", () => {
    expect(sanitizeFlags("")).toBe("i");
    expect(sanitizeFlags("m")).toContain("i");
  });

  test("keeps allowed flags and strips disallowed ones", () => {
    const out = sanitizeFlags("gimsuyx");
    expect(out).toContain("i");
    expect(out).toContain("m");
    expect(out).toContain("s");
    expect(out).toContain("u");
    expect(out).toContain("y");
    expect(out).not.toContain("g");
    expect(out).not.toContain("x");
  });

  test("dedupes repeated flags", () => {
    expect(sanitizeFlags("iii")).toBe("i");
  });
});

describe("ruleKey", () => {
  test("normalizes keyword by trim + lowercase", () => {
    expect(ruleKey(keywordRule("  Art  "))).toBe("keyword:art");
    expect(ruleKey({ type: "keyword", value: "ART" })).toBe("keyword:art");
  });

  test("normalizes account by trim + lowercase", () => {
    expect(ruleKey(accountRule(HEX_A.toUpperCase()))).toBe(`account:${HEX_A}`);
  });

  test("regex key includes source and sanitized flags", () => {
    // sanitizeFlags keeps input order then appends the forced 'i' last.
    expect(ruleKey({ type: "regex", source: "foo", flags: "gm" })).toBe("regex:foo:mi");
  });

  test("regex key tolerates missing flags via sanitize", () => {
    expect(ruleKey({ type: "regex", source: "foo" })).toBe("regex:foo:i");
  });
});

describe("createRule", () => {
  test("builds an enabled keyword rule with trimmed value and identity fields", () => {
    const rule = createRule({ type: "keyword", value: "  art  " });
    expect(rule).toMatchObject({ type: "keyword", value: "art", enabled: true });
    expect(typeof rule.id).toBe("string");
    expect(rule.id.length).toBeGreaterThan(0);
    expect(typeof rule.createdAt).toBe("number");
  });

  test("builds a trimmed account rule", () => {
    const rule = createRule({ type: "account", pubkey: `  ${HEX_A}  ` });
    expect(rule).toMatchObject({ type: "account", pubkey: HEX_A });
  });

  test("builds a regex rule with sanitized flags", () => {
    const rule = createRule({ type: "regex", source: "foo", flags: "gm" });
    expect(rule).toMatchObject({ type: "regex", source: "foo", flags: "mi" });
  });

  test("carries through an explicit expiresAt", () => {
    const rule = createRule({ type: "keyword", value: "x", expiresAt: NOW });
    expect(rule.expiresAt).toBe(NOW);
  });

  test("makeRuleId yields unique ids", () => {
    expect(makeRuleId()).not.toBe(makeRuleId());
  });
});

describe("expiry helpers", () => {
  test("isRuleActive: enabled & unexpired is active", () => {
    expect(isRuleActive(keywordRule("x"), NOW)).toBe(true);
  });

  test("isRuleActive: disabled is inactive", () => {
    expect(isRuleActive(keywordRule("x", { enabled: false }), NOW)).toBe(false);
  });

  test("isRuleActive: expired is inactive (expiresAt <= now)", () => {
    expect(isRuleActive(keywordRule("x", { expiresAt: NOW }), NOW)).toBe(false);
    expect(isRuleActive(keywordRule("x", { expiresAt: NOW + 1 }), NOW)).toBe(true);
  });

  test("isRuleExpired: only true once expiresAt has passed", () => {
    expect(isRuleExpired(keywordRule("x"), NOW)).toBe(false);
    expect(isRuleExpired(keywordRule("x", { expiresAt: NOW + 1 }), NOW)).toBe(false);
    expect(isRuleExpired(keywordRule("x", { expiresAt: NOW }), NOW)).toBe(true);
  });

  test("expiryFromTtl adds the ttl to the supplied now", () => {
    expect(expiryFromTtl(1000, NOW)).toBe(NOW + 1000);
  });

  test("TTL_PRESETS expose label/ms pairs", () => {
    expect(TTL_PRESETS.length).toBeGreaterThan(0);
    for (const p of TTL_PRESETS) {
      expect(typeof p.label).toBe("string");
      expect(p.ms).toBeGreaterThan(0);
    }
  });

  test("MAX_KEYWORD_LENGTH is a positive bound", () => {
    expect(MAX_KEYWORD_LENGTH).toBeGreaterThan(0);
  });
});

describe("arrangeFeed", () => {
  const mute = (n: number): boolean => n < 0;
  const evaluate = (n: number): MuteRule | undefined => (mute(n) ? keywordRule("x") : undefined);

  test("hidden mode drops muted items entirely", () => {
    const rows = arrangeFeed([1, -1, 2, -2, 3], evaluate, "hidden");
    expect(rows).toEqual([
      { kind: "item", item: 1 },
      { kind: "item", item: 2 },
      { kind: "item", item: 3 },
    ]);
  });

  test("summary mode collapses consecutive muted items into one group at the boundary", () => {
    // item, muted, muted, item -> [item, muted(2), item]
    const rows = arrangeFeed([1, -1, -2, 2], evaluate, "summary");
    expect(rows.length).toBe(3);
    expect(rows[0]).toEqual({ kind: "item", item: 1 });
    const group = rows[1];
    expect(group?.kind).toBe("muted");
    if (group?.kind === "muted") {
      expect(group.items).toEqual([-1, -2]);
      expect(group.rules.length).toBe(2);
    }
    expect(rows[2]).toEqual({ kind: "item", item: 2 });
  });

  test("summary mode starts a fresh group after an unmuted item breaks the run", () => {
    const rows = arrangeFeed([-1, 1, -2], evaluate, "summary");
    expect(rows.map((r) => r.kind)).toEqual(["muted", "item", "muted"]);
  });

  test("empty input yields no rows", () => {
    expect(arrangeFeed([], evaluate, "summary")).toEqual([]);
  });
});

describe("addRule", () => {
  const base: MuteSettings = { display: "hidden", rules: [] };

  test("prepends a new rule", () => {
    const next = addRule(base, { type: "keyword", value: "art" });
    expect(next.rules.length).toBe(1);
    expect(next.rules[0]).toMatchObject({ type: "keyword", value: "art" });
  });

  test("dedupes by ruleKey and refreshes enabled + expiry on re-add", () => {
    const disabled = keywordRule("art", { enabled: false, expiresAt: NOW });
    const settings: MuteSettings = { display: "hidden", rules: [disabled] };
    const next = addRule(settings, { type: "keyword", value: "ART", expiresAt: NOW + 5000 });
    expect(next.rules.length).toBe(1);
    const refreshed = next.rules[0];
    expect(refreshed?.id).toBe(disabled.id); // same rule, mutated in place
    expect(refreshed?.enabled).toBe(true);
    expect(refreshed?.expiresAt).toBe(NOW + 5000);
  });

  test("re-add without expiry clears the expiry to permanent", () => {
    const temp = keywordRule("art", { expiresAt: NOW });
    const settings: MuteSettings = { display: "hidden", rules: [temp] };
    const next = addRule(settings, { type: "keyword", value: "art" });
    expect(next.rules[0]?.expiresAt).toBeUndefined();
  });
});

describe("removeRule", () => {
  test("removes by id and leaves others intact", () => {
    const a = keywordRule("a");
    const b = keywordRule("b");
    const settings: MuteSettings = { display: "hidden", rules: [a, b] };
    const next = removeRule(settings, a.id);
    expect(next.rules.map((r) => r.id)).toEqual([b.id]);
  });

  test("is a no-op for an unknown id", () => {
    const a = keywordRule("a");
    const settings: MuteSettings = { display: "hidden", rules: [a] };
    expect(removeRule(settings, "nope").rules.length).toBe(1);
  });
});

describe("updateRule", () => {
  test("toggles enabled", () => {
    const a = keywordRule("a");
    const next = updateRule({ display: "hidden", rules: [a] }, a.id, { enabled: false });
    expect(next.rules[0]?.enabled).toBe(false);
  });

  test("sets an expiry", () => {
    const a = keywordRule("a");
    const next = updateRule({ display: "hidden", rules: [a] }, a.id, { expiresAt: NOW });
    expect(next.rules[0]?.expiresAt).toBe(NOW);
  });

  test("expiresAt:null clears the expiry; undefined leaves it as-is", () => {
    const a = keywordRule("a", { expiresAt: NOW });
    const cleared = updateRule({ display: "hidden", rules: [a] }, a.id, { expiresAt: null });
    expect(cleared.rules[0]?.expiresAt).toBeUndefined();
    const kept = updateRule({ display: "hidden", rules: [a] }, a.id, { enabled: true });
    expect(kept.rules[0]?.expiresAt).toBe(NOW);
  });

  test("edits a keyword value (trimmed)", () => {
    const a = keywordRule("a");
    const next = updateRule({ display: "hidden", rules: [a] }, a.id, { value: "  new  " });
    const updated = next.rules[0];
    expect(updated?.type).toBe("keyword");
    if (updated?.type === "keyword") expect(updated.value).toBe("new");
  });

  test("edits regex source and flags (flags sanitized)", () => {
    const r = regexRule("foo", "i");
    const next = updateRule({ display: "hidden", rules: [r] }, r.id, { source: "bar", flags: "gm" });
    const updated = next.rules[0];
    expect(updated?.type).toBe("regex");
    if (updated?.type === "regex") {
      expect(updated.source).toBe("bar");
      expect(updated.flags).toBe("mi");
    }
  });

  test("leaves account pubkey unchanged (patch carries no pubkey field)", () => {
    const a = accountRule(HEX_A);
    const next = updateRule({ display: "hidden", rules: [a] }, a.id, { enabled: false });
    const updated = next.rules[0];
    expect(updated?.type).toBe("account");
    if (updated?.type === "account") expect(updated.pubkey).toBe(HEX_A);
  });

  test("is a no-op for an unknown id", () => {
    const a = keywordRule("a");
    const next = updateRule({ display: "hidden", rules: [a] }, "nope", { enabled: false });
    expect(next.rules[0]?.enabled).toBe(true);
  });
});

describe("mergeSettings", () => {
  test("unions rules, dedupes by key, and adopts the incoming display", () => {
    const current: MuteSettings = { display: "hidden", rules: [keywordRule("art")] };
    const incoming: MuteSettings = {
      display: "summary",
      rules: [keywordRule("ART"), keywordRule("news")],
    };
    const merged = mergeSettings(current, incoming);
    expect(merged.display).toBe("summary");
    const keys = merged.rules.map(ruleKey).sort();
    expect(keys).toEqual(["keyword:art", "keyword:news"]);
  });

  test("keeps the current rule when an incoming duplicate collides", () => {
    const keep = keywordRule("art");
    const dup = keywordRule("art");
    const merged = mergeSettings(
      { display: "hidden", rules: [keep] },
      { display: "hidden", rules: [dup] },
    );
    expect(merged.rules.map((r) => r.id)).toEqual([keep.id]);
  });
});

describe("parseMuteSettings / serializeMuteSettings", () => {
  test("EMPTY_MUTE_SETTINGS is hidden with no rules", () => {
    expect(EMPTY_MUTE_SETTINGS).toEqual({ display: "hidden", rules: [] });
  });

  test("non-object input yields empty defaults", () => {
    expect(parseMuteSettings(null)).toEqual({ display: "hidden", rules: [] });
    expect(parseMuteSettings(42)).toEqual({ display: "hidden", rules: [] });
  });

  test("defaults display to hidden when missing/invalid", () => {
    expect(parseMuteSettings({ display: "bogus", rules: [] }).display).toBe("hidden");
    expect(parseMuteSettings({ rules: [] }).display).toBe("hidden");
  });

  test("preserves a valid display", () => {
    expect(parseMuteSettings({ display: "summary", rules: [] }).display).toBe("summary");
  });

  test("drops malformed rules", () => {
    const parsed = parseMuteSettings({
      display: "hidden",
      rules: [
        { type: "keyword", value: "art" },
        { type: "keyword", value: "   " }, // blank -> dropped
        { type: "account", pubkey: "" }, // blank -> dropped
        { type: "regex", source: "(" }, // uncompilable -> dropped
        { type: "mystery" }, // unknown type -> dropped
        "garbage", // non-object -> dropped
        null,
      ],
    });
    expect(parsed.rules.length).toBe(1);
    expect(parsed.rules[0]).toMatchObject({ type: "keyword", value: "art" });
  });

  test("drops duplicate rules by key", () => {
    const parsed = parseMuteSettings({
      display: "hidden",
      rules: [
        { type: "keyword", value: "art" },
        { type: "keyword", value: "ART" },
      ],
    });
    expect(parsed.rules.length).toBe(1);
  });

  test("fills in identity fields when absent and preserves them when present", () => {
    const withFields = parseMuteSettings({
      rules: [{ type: "keyword", value: "art", id: "fixed", createdAt: 123, enabled: false }],
    });
    expect(withFields.rules[0]).toMatchObject({ id: "fixed", createdAt: 123, enabled: false });

    const withoutFields = parseMuteSettings({ rules: [{ type: "keyword", value: "art" }] });
    const r = withoutFields.rules[0];
    expect(typeof r?.id).toBe("string");
    expect(r?.enabled).toBe(true);
  });

  test("accepts a valid regex rule and sanitizes its flags", () => {
    const parsed = parseMuteSettings({
      rules: [{ type: "regex", source: "foo", flags: "gm" }],
    });
    const r = parsed.rules[0];
    expect(r?.type).toBe("regex");
    if (r?.type === "regex") expect(r.flags).toBe("mi");
  });

  test("round-trips through serialize -> parse", () => {
    const settings: MuteSettings = {
      display: "summary",
      rules: [keywordRule("art"), accountRule(HEX_A), regexRule("foo", "im", { expiresAt: NOW })],
    };
    const json = serializeMuteSettings(settings);
    const parsed = parseMuteSettings(JSON.parse(json));
    expect(parsed.display).toBe("summary");
    expect(parsed.rules.map(ruleKey).sort()).toEqual(
      settings.rules.map(ruleKey).sort(),
    );
  });

  test("serializeMuteSettings emits a versioned envelope", () => {
    const json = serializeMuteSettings({ display: "hidden", rules: [] });
    expect(JSON.parse(json)).toMatchObject({ version: 1, display: "hidden", rules: [] });
  });
});
