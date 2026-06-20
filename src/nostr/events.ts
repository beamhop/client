import type { Event as NostrEvent, EventTemplate } from "nostr-tools";
import {
  Kind,
  DOC_MARKER,
  ARTICLE_MARKER,
  type Profile,
  type Note,
  type LongForm,
  type Reaction,
} from "./types.ts";
import { nowSeconds } from "./client.ts";

// ---------- decoders: NostrEvent -> domain ----------

export const decodeProfile = (event: NostrEvent): Profile => {
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(event.content) as Record<string, unknown>;
  } catch {
    meta = {};
  }
  const str = (k: string): string | undefined =>
    typeof meta[k] === "string" ? (meta[k] as string) : undefined;
  return {
    pubkey: event.pubkey,
    name: str("name"),
    displayName: str("display_name") ?? str("displayName"),
    about: str("about"),
    picture: str("picture"),
    banner: str("banner"),
    nip05: str("nip05"),
    lud16: str("lud16"),
    website: str("website"),
    role: str("role"),
  };
};

export const decodeNote = (event: NostrEvent): Note => {
  const eTags = event.tags.filter((t) => t[0] === "e");
  const root = eTags.find((t) => t[3] === "root");
  // NIP-10: prefer an explicit reply marker; else a direct reply targets the root;
  // else fall back to the last unmarked e-tag (legacy positional convention).
  const reply =
    eTags.find((t) => t[3] === "reply") ??
    root ??
    [...eTags].reverse().find((t) => t[3] === undefined);
  return {
    id: event.id,
    pubkey: event.pubkey,
    content: event.content,
    createdAt: event.created_at,
    tags: event.tags,
    replyTo: reply?.[1],
    rootId: root?.[1],
  };
};

export const decodeReaction = (event: NostrEvent): Reaction | null => {
  const target = [...event.tags].reverse().find((t) => t[0] === "e");
  if (!target?.[1]) return null;
  return { id: event.id, pubkey: event.pubkey, targetId: target[1], content: event.content };
};

export type RepostPointer = {
  noteId: string;
  pubkey?: string;
};

export const decodeRepostPointer = (event: NostrEvent): RepostPointer | null => {
  if (event.kind !== Kind.Repost) return null;
  const noteId = event.tags.find((t) => t[0] === "e" && t[1])?.[1];
  if (!noteId) return null;
  const pubkey = event.tags.find((t) => t[0] === "p" && t[1])?.[1];
  return { noteId, pubkey };
};

export const decodeEmbeddedRepostNote = (event: NostrEvent): Note | null => {
  if (event.kind !== Kind.Repost || event.content.trim() === "") return null;
  try {
    const embedded = JSON.parse(event.content) as Partial<NostrEvent>;
    if (
      embedded.kind !== Kind.Note ||
      typeof embedded.id !== "string" ||
      typeof embedded.pubkey !== "string" ||
      typeof embedded.content !== "string" ||
      typeof embedded.created_at !== "number" ||
      !Array.isArray(embedded.tags)
    ) {
      return null;
    }
    return decodeNote(embedded as NostrEvent);
  } catch {
    return null;
  }
};

export const deletedEventIdsByAuthor = (
  deletions: Iterable<NostrEvent>,
  eventAuthorById: ReadonlyMap<string, string>,
): Set<string> => {
  const deleted = new Set<string>();
  for (const deletion of deletions) {
    if (deletion.kind !== Kind.Deletion) continue;
    for (const tag of deletion.tags) {
      if (tag[0] !== "e" || !tag[1]) continue;
      if (eventAuthorById.get(tag[1]) === deletion.pubkey) deleted.add(tag[1]);
    }
  }
  return deleted;
};

const tagValue = (event: NostrEvent, key: string): string | undefined =>
  event.tags.find((t) => t[0] === key)?.[1];

export const decodeLongForm = (event: NostrEvent): LongForm => {
  const markers = event.tags.flatMap((t) => (t[0] === "t" && t[1] ? [t[1]] : []));
  const kind: LongForm["kind"] = markers.includes(DOC_MARKER) ? "doc" : "article";
  const published = Number(tagValue(event, "published_at") ?? event.created_at);
  return {
    id: event.id,
    pubkey: event.pubkey,
    identifier: tagValue(event, "d") ?? event.id,
    title: tagValue(event, "title") ?? "Untitled",
    summary: tagValue(event, "summary") ?? "",
    image: tagValue(event, "image"),
    body: event.content,
    publishedAt: published,
    updatedAt: event.created_at,
    hashtags: markers.filter((m) => m !== DOC_MARKER && m !== ARTICLE_MARKER),
    kind,
  };
};

// ---------- builders: domain -> EventTemplate ----------

export const buildProfile = (profile: Omit<Profile, "pubkey">): EventTemplate => ({
  kind: Kind.Metadata,
  created_at: nowSeconds(),
  tags: [],
  content: JSON.stringify(stripUndefined(profile)),
});

const extractHashtags = (content: string): string[] => {
  const tags = new Set<string>();
  for (const match of content.matchAll(/(^|[^A-Za-z0-9_])#([A-Za-z0-9_][A-Za-z0-9_-]{0,63})/g)) {
    const tag = match[2]?.toLowerCase();
    if (tag) tags.add(tag);
  }
  return [...tags];
};

export const buildNote = (content: string, replyTo?: Note): EventTemplate => {
  const tags: string[][] = [];
  if (replyTo) {
    const root = replyTo.rootId ?? replyTo.id;
    tags.push(["e", root, "", "root"]);
    if (replyTo.rootId) tags.push(["e", replyTo.id, "", "reply"]);
    tags.push(["p", replyTo.pubkey]);
  }
  for (const tag of extractHashtags(content)) tags.push(["t", tag]);
  return { kind: Kind.Note, created_at: nowSeconds(), tags, content };
};

export const buildReaction = (target: Note, content = "+"): EventTemplate => ({
  kind: Kind.Reaction,
  created_at: nowSeconds(),
  tags: [
    ["e", target.id],
    ["p", target.pubkey],
  ],
  content,
});

export const buildRepost = (target: Note): EventTemplate => ({
  kind: Kind.Repost,
  created_at: nowSeconds(),
  tags: [
    ["e", target.id],
    ["p", target.pubkey],
  ],
  content: "",
});

export const buildContacts = (pubkeys: string[]): EventTemplate => ({
  kind: Kind.Contacts,
  created_at: nowSeconds(),
  tags: pubkeys.map((pk) => ["p", pk]),
  content: "",
});

export type LongFormInput = {
  identifier: string;
  title: string;
  summary: string;
  body: string;
  image?: string;
  hashtags: string[];
  kind: "doc" | "article";
  publishedAt?: number;
};

export const buildLongForm = (input: LongFormInput): EventTemplate => {
  const marker = input.kind === "doc" ? DOC_MARKER : ARTICLE_MARKER;
  const tags: string[][] = [
    ["d", input.identifier],
    ["title", input.title],
    ["summary", input.summary],
    ["published_at", String(input.publishedAt ?? nowSeconds())],
    ["t", marker],
    ...input.hashtags.map((h) => ["t", h]),
  ];
  if (input.image) tags.push(["image", input.image]);
  return { kind: Kind.LongForm, created_at: nowSeconds(), tags, content: input.body };
};

const stripUndefined = <T extends Record<string, unknown>>(obj: T): Partial<T> => {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== "") out[k as keyof T] = v as T[keyof T];
  return out;
};
