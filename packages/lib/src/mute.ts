/**
 * Client-only soft mute: pure matching + rule-management logic.
 *
 * Everything here is framework-free and side-effect-free so it can be unit
 * tested exhaustively and reused across every surface (feed, articles, DMs,
 * notifications). Persistence and React wiring live in the store; rendering
 * decisions (hide vs. summarize) live in the views — this module only decides
 * *whether* a piece of content matches a rule, and how to mutate a rule set.
 *
 * Scope (by design, see product decisions):
 *  - keyword / regex rules apply to feed + articles + notifications, NOT DMs.
 *  - account rules apply everywhere, including DMs.
 *  - keywords match whole words, case-insensitively, across Unicode scripts.
 *  - rules apply to everyone, including people you follow (no exemption).
 */

export type MuteDisplay = "hidden" | "summary";

export type MuteRuleType = "keyword" | "account" | "regex";

type BaseRule = {
  id: string;
  createdAt: number; // ms epoch
  enabled: boolean;
  /** ms epoch; undefined = permanent. Expired rules are ignored when compiled. */
  expiresAt?: number;
};

export type MuteRule =
  | (BaseRule & { type: "keyword"; value: string })
  | (BaseRule & { type: "account"; pubkey: string })
  | (BaseRule & { type: "regex"; source: string; flags: string });

/** Shape callers pass to add a rule; identity fields are filled in by `createRule`. */
export type MuteRuleInput =
  | { type: "keyword"; value: string; expiresAt?: number }
  | { type: "account"; pubkey: string; expiresAt?: number }
  | { type: "regex"; source: string; flags?: string; expiresAt?: number };

export type MuteSettings = { display: MuteDisplay; rules: MuteRule[] };

export const EMPTY_MUTE_SETTINGS: MuteSettings = { display: "hidden", rules: [] };

export const MAX_REGEX_LENGTH = 200;
export const MAX_KEYWORD_LENGTH = 200;

/** TTL presets for temporary mutes, in milliseconds. */
export const TTL_PRESETS = [
  { label: "24 hours", ms: 24 * 60 * 60 * 1000 },
  { label: "7 days", ms: 7 * 24 * 60 * 60 * 1000 },
  { label: "30 days", ms: 30 * 24 * 60 * 60 * 1000 },
] as const;

export const expiryFromTtl = (ttlMs: number, now: number = Date.now()): number => now + ttlMs;

// ---------- ids ----------

let idSeq = 0;
export const makeRuleId = (): string => {
  idSeq += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `r${Date.now().toString(36)}${idSeq.toString(36)}${rand}`;
};

// ---------- regex helpers ----------

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Unicode-aware "word" class so whole-word matching works across scripts. */
const WORD = "[\\p{L}\\p{N}_]";

/**
 * A keyword matches as a standalone word (so "art" hits "love art" and "#art"
 * but not "article"/"Bart"/"smart"). Boundaries use Unicode property escapes
 * rather than ASCII `\b`, so it behaves for non-Latin scripts too.
 */
const buildKeywordRegex = (value: string): RegExp =>
  new RegExp(`(?<!${WORD})${escapeRegExp(value)}(?!${WORD})`, "iu");

const ALLOWED_REGEX_FLAGS = new Set(["i", "m", "s", "u", "y"]);

/** Keep only valid, safe flags and always force case-insensitive. */
export const sanitizeFlags = (flags: string): string => {
  const set = new Set<string>();
  for (const ch of flags) if (ALLOWED_REGEX_FLAGS.has(ch)) set.add(ch);
  set.add("i");
  return [...set].join("");
};

/** Stateless flags for `.test()` reuse — strip `g`/`y` which carry `lastIndex`. */
const matchFlags = (flags: string): string => sanitizeFlags(flags).replace(/[gy]/g, "");

export type RegexValidation = { ok: true } | { ok: false; error: string };

export const validateRegex = (source: string, flags = "i"): RegexValidation => {
  if (source.length === 0) return { ok: false, error: "Pattern is empty" };
  if (source.length > MAX_REGEX_LENGTH) {
    return { ok: false, error: `Pattern too long (max ${MAX_REGEX_LENGTH} chars)` };
  }
  try {
    new RegExp(source, sanitizeFlags(flags));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Invalid pattern" };
  }
};

// ---------- rule construction / identity ----------

/** Stable key used to dedupe semantically-equal rules. */
export const ruleKey = (rule: MuteRule | MuteRuleInput): string => {
  switch (rule.type) {
    case "keyword":
      return `keyword:${rule.value.trim().toLowerCase()}`;
    case "account":
      return `account:${rule.pubkey.trim().toLowerCase()}`;
    case "regex":
      return `regex:${rule.source}:${sanitizeFlags(rule.flags ?? "")}`;
  }
};

export const createRule = (input: MuteRuleInput): MuteRule => {
  const base = { id: makeRuleId(), createdAt: Date.now(), enabled: true, expiresAt: input.expiresAt };
  switch (input.type) {
    case "keyword":
      return { ...base, type: "keyword", value: input.value.trim() };
    case "account":
      return { ...base, type: "account", pubkey: input.pubkey.trim() };
    case "regex":
      return { ...base, type: "regex", source: input.source, flags: sanitizeFlags(input.flags ?? "i") };
  }
};

export const isRuleActive = (rule: MuteRule, now: number): boolean =>
  rule.enabled && (rule.expiresAt === undefined || rule.expiresAt > now);

export const isRuleExpired = (rule: MuteRule, now: number): boolean =>
  rule.expiresAt !== undefined && rule.expiresAt <= now;

// ---------- compiled matcher ----------

export type CompiledMutes = {
  isEmpty: boolean;
  mutedAccounts: ReadonlySet<string>;
  matchAccount: (pubkey: string) => MuteRule | undefined;
  matchText: (text: string) => MuteRule | undefined;
};

export const compileMutes = (rules: readonly MuteRule[], now: number = Date.now()): CompiledMutes => {
  const accounts = new Map<string, MuteRule>();
  const textMatchers: Array<{ re: RegExp; rule: MuteRule }> = [];

  for (const rule of rules) {
    if (!isRuleActive(rule, now)) continue;
    switch (rule.type) {
      case "account": {
        const pk = rule.pubkey.trim().toLowerCase();
        if (pk) accounts.set(pk, rule);
        break;
      }
      case "keyword": {
        const value = rule.value.trim();
        if (value) textMatchers.push({ re: buildKeywordRegex(value), rule });
        break;
      }
      case "regex": {
        try {
          textMatchers.push({ re: new RegExp(rule.source, matchFlags(rule.flags)), rule });
        } catch {
          // Skip a persisted pattern that no longer compiles rather than throwing.
        }
        break;
      }
    }
  }

  const matchAccount = (pubkey: string): MuteRule | undefined => accounts.get(pubkey.trim().toLowerCase());

  const matchText = (text: string): MuteRule | undefined => {
    if (!text) return undefined;
    for (const { re, rule } of textMatchers) {
      re.lastIndex = 0;
      if (re.test(text)) return rule;
    }
    return undefined;
  };

  return {
    isEmpty: accounts.size === 0 && textMatchers.length === 0,
    mutedAccounts: new Set(accounts.keys()),
    matchAccount,
    matchText,
  };
};

// ---------- per-surface evaluation ----------

export type MuteNote = {
  pubkey: string;
  content: string;
  tags: readonly (readonly string[])[];
};

const taggedPubkeys = (tags: readonly (readonly string[])[]): string[] =>
  tags.flatMap((t) => (t[0] === "p" && t[1] ? [t[1]] : []));

/** Feed/thread note: muted if its author, anyone it tags, or its text matches. */
export const evaluateNote = (c: CompiledMutes, note: MuteNote): MuteRule | undefined => {
  const author = c.matchAccount(note.pubkey);
  if (author) return author;
  for (const pk of taggedPubkeys(note.tags)) {
    const tagged = c.matchAccount(pk);
    if (tagged) return tagged;
  }
  return c.matchText(note.content);
};

export type MuteRepost = { repostedBy: string; note: MuteNote };

/** Repost: muted if the reposter is muted, or the underlying note is muted. */
export const evaluateRepost = (c: CompiledMutes, repost: MuteRepost): MuteRule | undefined =>
  c.matchAccount(repost.repostedBy) ?? evaluateNote(c, repost.note);

export type MuteArticle = {
  pubkey: string;
  title: string;
  summary: string;
  body: string;
  hashtags: readonly string[];
};

export const evaluateArticle = (c: CompiledMutes, a: MuteArticle): MuteRule | undefined => {
  const author = c.matchAccount(a.pubkey);
  if (author) return author;
  return c.matchText([a.title, a.summary, a.body, a.hashtags.join(" ")].join("\n"));
};

export type MuteDmTarget = { pubkey: string };

/** DMs: account rules only — your messages are never keyword/regex filtered. */
export const evaluateDm = (c: CompiledMutes, dm: MuteDmTarget): MuteRule | undefined =>
  c.matchAccount(dm.pubkey);

export type MuteNotificationTarget = { pubkey: string; content: string };

export const evaluateNotification = (
  c: CompiledMutes,
  n: MuteNotificationTarget,
): MuteRule | undefined => c.matchAccount(n.pubkey) ?? c.matchText(n.content);

// ---------- display arrangement ----------

export type FeedRow<T> =
  | { kind: "item"; item: T }
  | { kind: "muted"; items: T[]; rules: MuteRule[] };

/**
 * Turn a list into renderable rows given the display mode.
 *  - "hidden": muted items are dropped entirely.
 *  - "summary": consecutive muted items collapse into one expandable group.
 */
export const arrangeFeed = <T>(
  items: readonly T[],
  evaluate: (item: T) => MuteRule | undefined,
  display: MuteDisplay,
): FeedRow<T>[] => {
  const rows: FeedRow<T>[] = [];
  for (const item of items) {
    const rule = evaluate(item);
    if (!rule) {
      rows.push({ kind: "item", item });
      continue;
    }
    if (display === "hidden") continue;
    const last = rows[rows.length - 1];
    if (last && last.kind === "muted") {
      last.items.push(item);
      last.rules.push(rule);
    } else {
      rows.push({ kind: "muted", items: [item], rules: [rule] });
    }
  }
  return rows;
};

// ---------- rule-set mutations (pure) ----------

export const addRule = (settings: MuteSettings, input: MuteRuleInput): MuteSettings => {
  const key = ruleKey(input);
  const existing = settings.rules.find((r) => ruleKey(r) === key);
  if (existing) {
    // Re-adding an equal rule refreshes it: re-enable and reset its expiry.
    return {
      ...settings,
      rules: settings.rules.map((r) =>
        r.id === existing.id ? { ...r, enabled: true, expiresAt: input.expiresAt } : r,
      ),
    };
  }
  return { ...settings, rules: [createRule(input), ...settings.rules] };
};

export const removeRule = (settings: MuteSettings, id: string): MuteSettings => ({
  ...settings,
  rules: settings.rules.filter((r) => r.id !== id),
});

export type MuteRulePatch = {
  enabled?: boolean;
  /** number sets an expiry; null clears it (permanent); undefined leaves as-is. */
  expiresAt?: number | null;
  value?: string;
  source?: string;
  flags?: string;
};

const applyPatch = (rule: MuteRule, patch: MuteRulePatch): MuteRule => {
  const enabled = patch.enabled ?? rule.enabled;
  const expiresAt =
    patch.expiresAt === undefined ? rule.expiresAt : patch.expiresAt === null ? undefined : patch.expiresAt;
  const base = { id: rule.id, createdAt: rule.createdAt, enabled, expiresAt };
  switch (rule.type) {
    case "keyword":
      return { ...base, type: "keyword", value: (patch.value ?? rule.value).trim() };
    case "account":
      return { ...base, type: "account", pubkey: rule.pubkey };
    case "regex":
      return {
        ...base,
        type: "regex",
        source: patch.source ?? rule.source,
        flags: patch.flags !== undefined ? sanitizeFlags(patch.flags) : rule.flags,
      };
  }
};

export const updateRule = (settings: MuteSettings, id: string, patch: MuteRulePatch): MuteSettings => ({
  ...settings,
  rules: settings.rules.map((r) => (r.id === id ? applyPatch(r, patch) : r)),
});

/** Merge imported rules into the current set (dedup by key); adopt imported display. */
export const mergeSettings = (current: MuteSettings, incoming: MuteSettings): MuteSettings => {
  const seen = new Set(current.rules.map(ruleKey));
  const merged = [...current.rules];
  for (const rule of incoming.rules) {
    const key = ruleKey(rule);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(rule);
  }
  return { display: incoming.display, rules: merged };
};

// ---------- (de)serialization for persistence + export/import ----------

const isMuteDisplay = (v: unknown): v is MuteDisplay => v === "hidden" || v === "summary";

const parseRule = (raw: unknown): MuteRule | null => {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" && r.id ? r.id : makeRuleId();
  const createdAt = typeof r.createdAt === "number" ? r.createdAt : Date.now();
  const enabled = typeof r.enabled === "boolean" ? r.enabled : true;
  const expiresAt = typeof r.expiresAt === "number" ? r.expiresAt : undefined;
  const base = { id, createdAt, enabled, expiresAt };

  if (r.type === "keyword" && typeof r.value === "string" && r.value.trim()) {
    return { ...base, type: "keyword", value: r.value.trim() };
  }
  if (r.type === "account" && typeof r.pubkey === "string" && r.pubkey.trim()) {
    return { ...base, type: "account", pubkey: r.pubkey.trim() };
  }
  if (r.type === "regex" && typeof r.source === "string" && r.source) {
    const flags = sanitizeFlags(typeof r.flags === "string" ? r.flags : "i");
    if (!validateRegex(r.source, flags).ok) return null;
    return { ...base, type: "regex", source: r.source, flags };
  }
  return null;
};

/** Tolerant parser: drops malformed/duplicate rules instead of throwing. */
export const parseMuteSettings = (raw: unknown): MuteSettings => {
  if (typeof raw !== "object" || raw === null) return { ...EMPTY_MUTE_SETTINGS };
  const r = raw as Record<string, unknown>;
  const display = isMuteDisplay(r.display) ? r.display : "hidden";
  const rawRules = Array.isArray(r.rules) ? r.rules : [];
  const rules: MuteRule[] = [];
  const seen = new Set<string>();
  for (const rr of rawRules) {
    const parsed = parseRule(rr);
    if (!parsed) continue;
    const key = ruleKey(parsed);
    if (seen.has(key)) continue;
    seen.add(key);
    rules.push(parsed);
  }
  return { display, rules };
};

export const serializeMuteSettings = (s: MuteSettings): string =>
  JSON.stringify({ version: 1, display: s.display, rules: s.rules }, null, 2);
