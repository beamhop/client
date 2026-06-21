import { describe, expect, test } from "bun:test";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { mentionedPubkeys, mentionsPubkey, tokenizeMentions } from "../mentions.ts";
import { npubOf } from "../keys.ts";

const newPubkey = (): string => getPublicKey(generateSecretKey());

describe("tokenizeMentions", () => {
  test("plain text with no mentions yields a single text token", () => {
    expect(tokenizeMentions("just shipping today")).toEqual([
      { type: "text", value: "just shipping today" },
    ]);
  });

  test("an @npub mention becomes a mention token carrying the hex pubkey", () => {
    const pubkey = newPubkey();
    const tokens = tokenizeMentions(`hey @${npubOf(pubkey)} welcome`);
    expect(tokens).toEqual([
      { type: "text", value: "hey " },
      { type: "mention", pubkey },
      { type: "text", value: " welcome" },
    ]);
  });

  test("the @ and nostr: prefixes are both consumed (no stray prefix text)", () => {
    const pubkey = newPubkey();
    expect(tokenizeMentions(`@${npubOf(pubkey)}`)).toEqual([{ type: "mention", pubkey }]);
    expect(tokenizeMentions(`nostr:${npubOf(pubkey)}`)).toEqual([{ type: "mention", pubkey }]);
    // A bare npub (no prefix) is still recognized.
    expect(tokenizeMentions(npubOf(pubkey))).toEqual([{ type: "mention", pubkey }]);
  });

  test("nprofile mentions resolve to their pubkey", () => {
    const pubkey = newPubkey();
    const nprofile = nip19.nprofileEncode({ pubkey, relays: ["wss://relay.example"] });
    expect(tokenizeMentions(`cc nostr:${nprofile}`)).toEqual([
      { type: "text", value: "cc " },
      { type: "mention", pubkey },
    ]);
  });

  test("multiple mentions in one note are each resolved", () => {
    const a = newPubkey();
    const b = newPubkey();
    const tokens = tokenizeMentions(`@${npubOf(a)} and @${npubOf(b)} shipped`);
    expect(tokens).toEqual([
      { type: "mention", pubkey: a },
      { type: "text", value: " and " },
      { type: "mention", pubkey: b },
      { type: "text", value: " shipped" },
    ]);
  });

  test("a malformed npub is left untouched as literal text", () => {
    const broken = "npub1notarealkeyzzzz";
    expect(tokenizeMentions(`see ${broken} ok`)).toEqual([
      { type: "text", value: `see ${broken} ok` },
    ]);
  });

  test("the goal's example npub resolves to its documented pubkey", () => {
    const npub = "npub13fce6s3x325jta439097ddj97mkg9mlxf6kfrkhexh7uenclpljs7atdfx";
    expect(tokenizeMentions(`@${npub}`)).toEqual([
      { type: "mention", pubkey: "8a719d42268aa925f6b12bcbe6b645f6ec82efe64eac91daf935fdcccf1f0fe5" },
    ]);
  });

  test("text segments round-trip exactly around a mention", () => {
    const pubkey = newPubkey();
    const tokens = tokenizeMentions(`line1\n  spaced @${npubOf(pubkey)}!`);
    const textBack = tokens.map((t) => (t.type === "text" ? t.value : `@${npubOf(t.pubkey)}`)).join("");
    expect(textBack).toBe(`line1\n  spaced @${npubOf(pubkey)}!`);
  });
});

describe("mentionedPubkeys", () => {
  test("returns the hex pubkey of each inline mention, de-duplicated in first-seen order", () => {
    const a = newPubkey();
    const b = newPubkey();
    const content = `@${npubOf(a)} ping nostr:${npubOf(b)} and again @${npubOf(a)}`;
    expect(mentionedPubkeys(content)).toEqual([a, b]);
  });

  test("ignores mention-shaped substrings that don't decode", () => {
    expect(mentionedPubkeys("see npub1notarealkeyzzzz here")).toEqual([]);
  });

  test("plain text yields no mentions", () => {
    expect(mentionedPubkeys("just shipping today")).toEqual([]);
  });
});

describe("mentionsPubkey", () => {
  test("true only when the content references that exact pubkey", () => {
    const a = newPubkey();
    const b = newPubkey();
    expect(mentionsPubkey(`hi @${npubOf(a)}`, a)).toBe(true);
    expect(mentionsPubkey(`hi @${npubOf(a)}`, b)).toBe(false);
  });
});
