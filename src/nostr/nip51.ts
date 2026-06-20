/**
 * NIP-51 event builders and parsers.
 *
 * Bridges domain types (FollowSet, BookmarkSet, MuteSettings) ↔ Nostr events.
 * All builder functions are async because private lists require NIP-44 encryption,
 * and the NIP-07 path for encryption is inherently async.
 *
 * Kind numbers from NIP-51; also defined in types.ts Kind.MuteList/FollowSet/BookmarkSet.
 */

import type { EventTemplate, Event as NostrEvent } from "nostr-tools";
import { nowSeconds } from "./client.ts";
import type { Identity } from "./keys.ts";
import type { MuteRule, MuteSettings } from "../lib/mute.ts";
import {
  EMPTY_MUTE_SETTINGS,
  makeRuleId,
  sanitizeFlags,
  validateRegex,
} from "../lib/mute.ts";
import type { FollowSet, BookmarkSet } from "../lib/lists.ts";
import { encrypt, decrypt } from "./nip44.ts";

// ---------- kind constants ----------

// kind numbers from NIP-51; also defined in types.ts Kind.MuteList/FollowSet/BookmarkSet
const KIND_MUTE_LIST = 10000;
const KIND_FOLLOW_SET = 30000;
const KIND_BOOKMARK_SET = 30003;

// ---------- internal helpers ----------

/**
 * Safely parse a JSON string; returns null on failure rather than throwing.
 * Used so that tolerate-bad-data paths don't need try/catch at every call site.
 */
const tryParseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/**
 * Assert that a value is a string[][]; narrows unknown → string[][] | null.
 * We accept any array whose elements are themselves arrays of strings.
 */
const asTagArray = (value: unknown): string[][] | null => {
  if (!Array.isArray(value)) return null;
  const out: string[][] = [];
  for (const item of value) {
    if (!Array.isArray(item)) return null;
    const row: string[] = [];
    for (const cell of item) {
      if (typeof cell !== "string") return null;
      row.push(cell);
    }
    out.push(row);
  }
  return out;
};

// ---------- mute list (kind:10000) ----------

/**
 * All entries are kept private — the entire tag array is JSON-encoded and
 * encrypted in `content`. The `tags` array is left empty.
 *
 * Tag shape:
 *   account  → ["p",     "<pubkey>"]
 *   keyword  → ["word",  "<value>"]
 *   regex    → ["regex", "<source>", "<flags>"]
 *
 * Optional trailing field on any tag: unix-second expiry timestamp.
 *   e.g. ["p", "<pubkey>", "1750000000"]
 *
 * Expired rules are stripped before publishing — no point syncing them.
 */
export const buildMuteList = async (
  settings: MuteSettings,
  identity: Identity,
): Promise<EventTemplate> => {
  const nowSec = nowSeconds();
  const tagRows: string[][] = settings.rules.flatMap((rule: MuteRule): string[][] => {
    // Drop already-expired rules — they're useless on any device.
    if (rule.expiresAt !== undefined && rule.expiresAt / 1000 <= nowSec) return [];
    const expiry = rule.expiresAt !== undefined ? [String(Math.floor(rule.expiresAt / 1000))] : [];
    switch (rule.type) {
      case "account":
        return [["p", rule.pubkey, ...expiry]];
      case "keyword":
        return [["word", rule.value, ...expiry]];
      case "regex":
        return [["regex", rule.source, rule.flags, ...expiry]];
    }
  });

  const plaintext = JSON.stringify(tagRows);
  const content = await encrypt(plaintext, identity);

  return {
    kind: KIND_MUTE_LIST,
    created_at: nowSeconds(),
    tags: [],
    content,
  };
};

/**
 * Parse a kind:10000 event back into MuteSettings.
 *
 * Tolerant: returns EMPTY_MUTE_SETTINGS if:
 *   - content is empty (no rules saved yet)
 *   - decryption fails (e.g. key rotation)
 *   - JSON is malformed
 */
export const parseMuteList = async (
  event: NostrEvent,
  identity: Identity,
): Promise<MuteSettings> => {
  if (!event.content) return { ...EMPTY_MUTE_SETTINGS };

  let plaintext: string;
  try {
    plaintext = await decrypt(event.content, identity);
  } catch {
    // Key rotation or wrong identity — silently degrade rather than crashing.
    return { ...EMPTY_MUTE_SETTINGS };
  }

  const parsed = tryParseJson(plaintext);
  const tags = asTagArray(parsed);
  if (!tags) return { ...EMPTY_MUTE_SETTINGS };

  const createdAtMs = event.created_at * 1000;
  const rules: MuteRule[] = [];

  const parseExpiry = (raw: string | undefined): number | undefined => {
    if (!raw) return undefined;
    const sec = Number(raw);
    return Number.isFinite(sec) && sec > 0 ? sec * 1000 : undefined;
  };

  for (const tag of tags) {
    const [type, ...rest] = tag;
    if (type === "p" && rest[0]) {
      rules.push({
        type: "account",
        pubkey: rest[0],
        id: makeRuleId(),
        createdAt: createdAtMs,
        enabled: true,
        expiresAt: parseExpiry(rest[1]),
      });
    } else if (type === "word" && rest[0]) {
      rules.push({
        type: "keyword",
        value: rest[0],
        id: makeRuleId(),
        createdAt: createdAtMs,
        enabled: true,
        expiresAt: parseExpiry(rest[1]),
      });
    } else if (type === "regex" && rest[0]) {
      const source = rest[0];
      const rawFlags = rest[1] ?? "i";
      const flags = sanitizeFlags(rawFlags);
      const validation = validateRegex(source, flags);
      if (!validation.ok) continue; // skip patterns that no longer compile
      rules.push({
        type: "regex",
        source,
        flags,
        id: makeRuleId(),
        createdAt: createdAtMs,
        enabled: true,
        expiresAt: parseExpiry(rest[2]),
      });
    }
    // Unknown tag types are silently skipped.
  }

  return { display: "hidden", rules };
};

// ---------- follow set (kind:30000) ----------

/**
 * Public sets encode pubkeys as ["p", pk] tags with an empty content.
 * Private sets put the same tag array as encrypted JSON in content, with only
 * the ["d", name] tag left public so the set is addressable.
 */
export const buildFollowSet = async (
  set: FollowSet,
  identity: Identity,
): Promise<EventTemplate> => {
  const pTags: string[][] = set.pubkeys.map((pk) => ["p", pk]);

  if (set.isPrivate) {
    const content = await encrypt(JSON.stringify(pTags), identity);
    return {
      kind: KIND_FOLLOW_SET,
      created_at: set.createdAt ?? nowSeconds(),
      tags: [["d", set.name]],
      content,
    };
  }

  return {
    kind: KIND_FOLLOW_SET,
    created_at: set.createdAt ?? nowSeconds(),
    tags: [["d", set.name], ...pTags],
    content: "",
  };
};

/**
 * Parse a kind:30000 event into a FollowSet.
 *
 * Returns null if:
 *   - the "d" tag is missing (un-addressable event, not a valid set)
 *   - decryption fails for a private set
 */
export const parseFollowSet = async (
  event: NostrEvent,
  identity: Identity,
): Promise<FollowSet | null> => {
  const dTag = event.tags.find((t) => t[0] === "d")?.[1];
  if (!dTag) return null;

  const isPrivate = event.content !== "";

  let pubkeys: string[];
  if (!isPrivate) {
    pubkeys = event.tags.flatMap((t) => (t[0] === "p" && t[1] ? [t[1]] : []));
  } else {
    let plaintext: string;
    try {
      plaintext = await decrypt(event.content, identity);
    } catch {
      return null;
    }
    const parsed = tryParseJson(plaintext);
    const tags = asTagArray(parsed);
    if (!tags) return null;
    pubkeys = tags.flatMap((t) => (t[0] === "p" && t[1] ? [t[1]] : []));
  }

  return {
    id: event.id.slice(0, 8),
    name: dTag,
    pubkeys,
    isPrivate,
    createdAt: event.created_at,
    eventId: event.id,
  };
};

// ---------- bookmark set (kind:30003) ----------

/**
 * Same structure as follow sets, but ["e", eventId] tags instead of ["p", pk].
 *
 * Public sets encode event IDs as ["e", id] tags with an empty content.
 * Private sets put the tag array as encrypted JSON in content.
 */
export const buildBookmarkSet = async (
  set: BookmarkSet,
  identity: Identity,
): Promise<EventTemplate> => {
  const eTags: string[][] = set.eventIds.map((id) => ["e", id]);

  if (set.isPrivate) {
    const content = await encrypt(JSON.stringify(eTags), identity);
    return {
      kind: KIND_BOOKMARK_SET,
      created_at: set.createdAt ?? nowSeconds(),
      tags: [["d", set.name]],
      content,
    };
  }

  return {
    kind: KIND_BOOKMARK_SET,
    created_at: set.createdAt ?? nowSeconds(),
    tags: [["d", set.name], ...eTags],
    content: "",
  };
};

/**
 * Parse a kind:30003 event into a BookmarkSet.
 *
 * Returns null if:
 *   - the "d" tag is missing
 *   - decryption fails for a private set
 */
export const parseBookmarkSet = async (
  event: NostrEvent,
  identity: Identity,
): Promise<BookmarkSet | null> => {
  const dTag = event.tags.find((t) => t[0] === "d")?.[1];
  if (!dTag) return null;

  const isPrivate = event.content !== "";

  let eventIds: string[];
  if (!isPrivate) {
    eventIds = event.tags.flatMap((t) => (t[0] === "e" && t[1] ? [t[1]] : []));
  } else {
    let plaintext: string;
    try {
      plaintext = await decrypt(event.content, identity);
    } catch {
      return null;
    }
    const parsed = tryParseJson(plaintext);
    const tags = asTagArray(parsed);
    if (!tags) return null;
    eventIds = tags.flatMap((t) => (t[0] === "e" && t[1] ? [t[1]] : []));
  }

  return {
    id: event.id.slice(0, 8),
    name: dTag,
    eventIds,
    isPrivate,
    createdAt: event.created_at,
    eventId: event.id,
  };
};
