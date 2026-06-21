import { nip19 } from "nostr-tools";

/** A decoded run of note content: either literal text or a pubkey mention. */
export type ContentToken =
  | { type: "text"; value: string }
  | { type: "mention"; pubkey: string };

// Mentions appear as `@npub1…`, NIP-27 `nostr:npub1…`, or `nostr:nprofile1…`.
// The bech32 body is validated by `nip19.decode`, so a permissive character
// class is safe here: anything that fails to decode is emitted as literal text.
const MENTION_RE = /(?:nostr:)?@?((?:npub|nprofile)1[023456789acdefghjklmnpqrstuvwxyz]+)/g;

/** Hex pubkey for an `npub`/`nprofile` entity, or null if it doesn't decode. */
const pubkeyOf = (entity: string): string | null => {
  try {
    const decoded = nip19.decode(entity);
    if (decoded.type === "npub") return decoded.data;
    if (decoded.type === "nprofile") return decoded.data.pubkey;
    return null;
  } catch {
    return null;
  }
};

/**
 * Split note content into literal text and resolved pubkey mentions. Adjacent
 * literal runs (including any mention-shaped substring that fails to decode) are
 * coalesced, so concatenating every text token plus each mention's source span
 * reproduces the input exactly — no characters are dropped or reordered.
 */
export const tokenizeMentions = (content: string): ContentToken[] => {
  const tokens: ContentToken[] = [];
  let last = 0;
  const pushText = (value: string): void => {
    if (!value) return;
    const prev = tokens[tokens.length - 1];
    if (prev?.type === "text") prev.value += value;
    else tokens.push({ type: "text", value });
  };
  for (const match of content.matchAll(MENTION_RE)) {
    const entity = match[1];
    const pubkey = entity ? pubkeyOf(entity) : null;
    // A non-decoding match stays part of the surrounding text: skip without
    // advancing `last`, and the next `pushText` reclaims it verbatim.
    if (pubkey === null) continue;
    const start = match.index ?? 0;
    pushText(content.slice(last, start));
    tokens.push({ type: "mention", pubkey });
    last = start + match[0].length;
  }
  pushText(content.slice(last));
  return tokens;
};

/**
 * Hex pubkeys referenced by inline mentions in `content`, in first-seen order
 * and de-duplicated. This is the source of truth for the NIP-27 `p` tags a
 * mentioning note must carry so the mentioned user's client — which filters by
 * `#p` — is actually notified.
 */
export const mentionedPubkeys = (content: string): string[] => {
  const seen = new Set<string>();
  for (const token of tokenizeMentions(content)) {
    if (token.type === "mention") seen.add(token.pubkey);
  }
  return [...seen];
};

/** Whether `content` inline-mentions `pubkey` (decoded `@npub`/`nostr:` form). */
export const mentionsPubkey = (content: string, pubkey: string): boolean =>
  mentionedPubkeys(content).includes(pubkey);
