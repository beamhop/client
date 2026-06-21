import { describe, expect, test } from "bun:test";
import { finalizeEvent, generateSecretKey } from "nostr-tools";
import type { EventTemplate } from "nostr-tools";
import {
  buildNote,
  buildReaction,
  buildRepost,
  buildContacts,
  buildLongForm,
  buildProfile,
  decodeNote,
  decodeProfile,
  decodeReaction,
  decodeRepostPointer,
  decodeEmbeddedRepostNote,
  decodeLongForm,
  deletedEventIdsByAuthor,
} from "../events.ts";
import { Kind, DOC_MARKER, ARTICLE_MARKER, type Note } from "../types.ts";
import { getPublicKey } from "nostr-tools";
import { npubOf } from "../keys.ts";

const sk = generateSecretKey();
const sign = (t: EventTemplate) => finalizeEvent(t, sk);
const newPubkey = (): string => getPublicKey(generateSecretKey());

describe("note round-trip", () => {
  test("a built note decodes back to its content", () => {
    const decoded = decodeNote(sign(buildNote("hello world")));
    expect(decoded.content).toBe("hello world");
    expect(decoded.replyTo).toBeUndefined();
  });

  test("a built note carries deduped lowercase hashtag t-tags", () => {
    const tmpl = buildNote("Shipping #BeamHop, testing #search and #beamhop again");
    expect(tmpl.tags).toContainEqual(["t", "beamhop"]);
    expect(tmpl.tags).toContainEqual(["t", "search"]);
    expect(tmpl.tags.filter((t) => t[0] === "t" && t[1] === "beamhop")).toHaveLength(1);
  });

  test("hashtags are added alongside reply tags", () => {
    const root: Note = {
      id: "e".repeat(64),
      pubkey: "b".repeat(64),
      content: "root",
      createdAt: 1,
      tags: [],
    };
    const tmpl = buildNote("replying with #relay2", root);
    expect(tmpl.tags).toContainEqual(["e", root.id, "", "root"]);
    expect(tmpl.tags).toContainEqual(["p", root.pubkey]);
    expect(tmpl.tags).toContainEqual(["t", "relay2"]);
  });

  test("a reply carries root + reply e-tags and a p-tag", () => {
    const root: Note = {
      id: "f".repeat(64),
      pubkey: "a".repeat(64),
      content: "root",
      createdAt: 1,
      tags: [],
    };
    const tmpl = buildNote("a reply", root);
    expect(tmpl.tags).toContainEqual(["e", root.id, "", "root"]);
    expect(tmpl.tags).toContainEqual(["p", root.pubkey]);
    const decoded = decodeNote(sign(tmpl));
    expect(decoded.replyTo).toBe(root.id);
  });

  test("inline @npub / nostr: mentions become NIP-27 p-tags", () => {
    const a = newPubkey();
    const b = newPubkey();
    const tmpl = buildNote(`hi @${npubOf(a)} and nostr:${npubOf(b)}`);
    expect(tmpl.tags).toContainEqual(["p", a]);
    expect(tmpl.tags).toContainEqual(["p", b]);
  });

  test("a mention p-tag is not duplicated with the reply target's p-tag", () => {
    const author = newPubkey();
    const root: Note = {
      id: "c".repeat(64),
      pubkey: author,
      content: "root",
      createdAt: 1,
      tags: [],
    };
    // Replying to `author` while also @-mentioning them in the body.
    const tmpl = buildNote(`thanks @${npubOf(author)}`, root);
    expect(tmpl.tags.filter((t) => t[0] === "p" && t[1] === author)).toHaveLength(1);
  });

  test("a note without mentions carries no p-tags", () => {
    const tmpl = buildNote("just shipping today #beamhop");
    expect(tmpl.tags.some((t) => t[0] === "p")).toBe(false);
  });
});

describe("reactions and reposts", () => {
  const target: Note = {
    id: "1".repeat(64),
    pubkey: "2".repeat(64),
    content: "x",
    createdAt: 1,
    tags: [],
  };

  test("reaction defaults to + and targets the note", () => {
    const tmpl = buildReaction(target);
    expect(tmpl.kind).toBe(Kind.Reaction);
    expect(tmpl.content).toBe("+");
    const decoded = decodeReaction(sign(tmpl));
    expect(decoded?.targetId).toBe(target.id);
  });

  test("repost references the note id", () => {
    const tmpl = buildRepost(target);
    expect(tmpl.kind).toBe(Kind.Repost);
    expect(tmpl.tags).toContainEqual(["e", target.id]);
  });

  test("repost pointers resolve the target note id and author", () => {
    const decoded = decodeRepostPointer(sign(buildRepost(target)));
    expect(decoded).toEqual({ noteId: target.id, pubkey: target.pubkey });
  });

  test("embedded repost content can decode the original note", () => {
    const original = sign(buildNote("embedded repost source"));
    const repost = sign({
      kind: Kind.Repost,
      created_at: original.created_at + 1,
      tags: [
        ["e", original.id],
        ["p", original.pubkey],
      ],
      content: JSON.stringify(original),
    });

    expect(decodeEmbeddedRepostNote(repost)).toEqual(decodeNote(original));
  });

  test("deletion events only remove events by the same author", () => {
    const repost = sign(buildRepost(target));
    const deletion = sign({
      kind: Kind.Deletion,
      created_at: repost.created_at + 1,
      tags: [["e", repost.id]],
      content: "",
    });
    const foreignDeletion = finalizeEvent(
      {
        kind: Kind.Deletion,
        created_at: repost.created_at + 2,
        tags: [["e", "a".repeat(64)]],
        content: "",
      },
      generateSecretKey(),
    );

    const deleted = deletedEventIdsByAuthor(
      [deletion, foreignDeletion],
      new Map([
        [repost.id, repost.pubkey],
        ["a".repeat(64), repost.pubkey],
      ]),
    );

    expect(deleted).toEqual(new Set([repost.id]));
  });
});

describe("contacts", () => {
  test("builds a kind-3 list of p-tags", () => {
    const tmpl = buildContacts(["a".repeat(64), "b".repeat(64)]);
    expect(tmpl.kind).toBe(Kind.Contacts);
    expect(tmpl.tags).toHaveLength(2);
    expect(tmpl.tags[0]?.[0]).toBe("p");
  });
});

describe("profile round-trip", () => {
  test("builds metadata and decodes it, dropping empty fields", () => {
    const tmpl = buildProfile({ name: "Maya", about: "hi", nip05: "maya@x.co", website: "" });
    const decoded = decodeProfile(sign(tmpl));
    expect(decoded.name).toBe("Maya");
    expect(decoded.nip05).toBe("maya@x.co");
    expect(decoded.website).toBeUndefined();
  });
});

describe("long-form (NIP-23)", () => {
  test("a doc carries the DOC_MARKER and decodes as kind 'doc'", () => {
    const tmpl = buildLongForm({
      identifier: "getting-started",
      title: "Getting started",
      summary: "intro",
      body: "# Hello",
      hashtags: ["onboarding"],
      kind: "doc",
    });
    expect(tmpl.tags).toContainEqual(["t", DOC_MARKER]);
    const decoded = decodeLongForm(sign(tmpl));
    expect(decoded.kind).toBe("doc");
    expect(decoded.identifier).toBe("getting-started");
    expect(decoded.title).toBe("Getting started");
    expect(decoded.hashtags).toEqual(["onboarding"]);
    expect(decoded.body).toBe("# Hello");
  });

  test("an article carries the ARTICLE_MARKER and decodes as kind 'article'", () => {
    const tmpl = buildLongForm({
      identifier: "keys-are-boring",
      title: "Keys",
      summary: "s",
      body: "b",
      hashtags: [],
      kind: "article",
    });
    expect(tmpl.tags).toContainEqual(["t", ARTICLE_MARKER]);
    expect(decodeLongForm(sign(tmpl)).kind).toBe("article");
  });
});
