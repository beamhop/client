import { describe, expect, test } from "bun:test";
import { finalizeEvent, generateSecretKey } from "nostr-tools";
import type { Event as NostrEvent } from "nostr-tools";
import {
  decodeEmbeddedRepostNote,
  decodeLongForm,
  decodeNote,
  decodeProfile,
  decodeReaction,
  decodeRepostPointer,
} from "../events.ts";
import { Kind } from "../types.ts";

const sk = generateSecretKey();
const pubkey = "f".repeat(64);

const event = (over: Partial<NostrEvent>): NostrEvent => ({
  id: "1".repeat(64),
  pubkey,
  created_at: 1,
  kind: Kind.Note,
  tags: [],
  content: "",
  sig: "",
  ...over,
});

describe("decodeProfile resilience", () => {
  test("falls back to an empty profile when content is not valid JSON", () => {
    const decoded = decodeProfile(event({ kind: Kind.Metadata, content: "not json{" }));
    expect(decoded).toEqual({ pubkey });
  });

  test("ignores non-string metadata fields", () => {
    const decoded = decodeProfile(event({ kind: Kind.Metadata, content: JSON.stringify({ name: 42, about: "ok" }) }));
    expect(decoded.name).toBeUndefined();
    expect(decoded.about).toBe("ok");
  });

  test("accepts either display_name or displayName", () => {
    expect(decodeProfile(event({ content: JSON.stringify({ display_name: "A" }) })).displayName).toBe("A");
    expect(decodeProfile(event({ content: JSON.stringify({ displayName: "B" }) })).displayName).toBe("B");
  });
});

describe("decodeNote reply resolution (NIP-10)", () => {
  test("prefers an explicit reply marker over the root", () => {
    const decoded = decodeNote(
      event({ tags: [["e", "root", "", "root"], ["e", "parent", "", "reply"]] }),
    );
    expect(decoded.rootId).toBe("root");
    expect(decoded.replyTo).toBe("parent");
  });

  test("a direct reply with only a root marker targets the root", () => {
    const decoded = decodeNote(event({ tags: [["e", "root", "", "root"]] }));
    expect(decoded.replyTo).toBe("root");
  });

  test("falls back to the last unmarked e-tag (legacy positional)", () => {
    const decoded = decodeNote(event({ tags: [["e", "first"], ["e", "last"]] }));
    expect(decoded.replyTo).toBe("last");
    expect(decoded.rootId).toBeUndefined();
  });

  test("a note with no e-tags has no reply target", () => {
    expect(decodeNote(event({ tags: [] })).replyTo).toBeUndefined();
  });
});

describe("decodeReaction guards", () => {
  test("returns null when there is no e-tag to react to", () => {
    expect(decodeReaction(event({ kind: Kind.Reaction, tags: [["p", pubkey]] }))).toBeNull();
  });

  test("targets the last e-tag", () => {
    const decoded = decodeReaction(event({ kind: Kind.Reaction, tags: [["e", "a"], ["e", "b"]], content: "🤙" }));
    expect(decoded?.targetId).toBe("b");
    expect(decoded?.content).toBe("🤙");
  });
});

describe("decodeRepostPointer guards", () => {
  test("returns null for a non-repost kind", () => {
    expect(decodeRepostPointer(event({ kind: Kind.Note, tags: [["e", "x"]] }))).toBeNull();
  });

  test("returns null when the repost has no e-tag", () => {
    expect(decodeRepostPointer(event({ kind: Kind.Repost, tags: [["p", pubkey]] }))).toBeNull();
  });

  test("pubkey is omitted when there is no p-tag", () => {
    expect(decodeRepostPointer(event({ kind: Kind.Repost, tags: [["e", "note1"]] }))).toEqual({
      noteId: "note1",
      pubkey: undefined,
    });
  });
});

describe("decodeEmbeddedRepostNote guards", () => {
  test("returns null for a non-repost event", () => {
    expect(decodeEmbeddedRepostNote(event({ kind: Kind.Note, content: "{}" }))).toBeNull();
  });

  test("returns null when the repost content is empty", () => {
    expect(decodeEmbeddedRepostNote(event({ kind: Kind.Repost, content: "   " }))).toBeNull();
  });

  test("returns null when the content is not valid JSON", () => {
    expect(decodeEmbeddedRepostNote(event({ kind: Kind.Repost, content: "{bad" }))).toBeNull();
  });

  test("returns null when the embedded event is not a note", () => {
    const embedded = JSON.stringify({ kind: Kind.Reaction, id: "x", pubkey, content: "+", created_at: 1, tags: [] });
    expect(decodeEmbeddedRepostNote(event({ kind: Kind.Repost, content: embedded }))).toBeNull();
  });

  test("returns null when required fields are missing or wrong-typed", () => {
    const embedded = JSON.stringify({ kind: Kind.Note, id: "x", pubkey, content: "hi", created_at: "nope", tags: [] });
    expect(decodeEmbeddedRepostNote(event({ kind: Kind.Repost, content: embedded }))).toBeNull();
  });

  test("decodes a well-formed embedded note", () => {
    const inner = finalizeEvent({ kind: Kind.Note, created_at: 5, tags: [], content: "embedded" }, sk);
    const decoded = decodeEmbeddedRepostNote(event({ kind: Kind.Repost, content: JSON.stringify(inner) }));
    expect(decoded?.content).toBe("embedded");
  });
});

describe("decodeLongForm defaults", () => {
  test("supplies fallbacks for a sparse event and defaults to article", () => {
    const decoded = decodeLongForm(event({ kind: Kind.LongForm, created_at: 99, content: "body" }));
    expect(decoded.identifier).toBe(decoded.id); // no d-tag → falls back to id
    expect(decoded.title).toBe("Untitled");
    expect(decoded.summary).toBe("");
    expect(decoded.kind).toBe("article");
    expect(decoded.publishedAt).toBe(99); // no published_at → created_at
    expect(decoded.image).toBeUndefined();
  });

  test("reads published_at and image tags when present", () => {
    const decoded = decodeLongForm(
      event({
        kind: Kind.LongForm,
        created_at: 200,
        tags: [["published_at", "100"], ["image", "https://x/y.png"]],
      }),
    );
    expect(decoded.publishedAt).toBe(100);
    expect(decoded.updatedAt).toBe(200);
    expect(decoded.image).toBe("https://x/y.png");
  });
});
