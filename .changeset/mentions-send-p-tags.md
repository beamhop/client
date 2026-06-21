---
"@beamhop/nostr": minor
---

feat: emit NIP-27 `p` tags for inline mentions when composing notes

`buildNote` now derives a `p` tag for every `@npub` / `nostr:npub` / `nprofile`
mention it finds in the content, so the people you name are actually notified.
Previously the mention lived only in the free-text body; relays index and route
mentions by the `#p` tag, so a tagless note never reached the mentioned user's
notifications.

- New `mentionedPubkeys(content)` returns the deduplicated hex pubkeys referenced
  inline (built on `tokenizeMentions`), and `mentionsPubkey(content, pubkey)` is a
  membership convenience.
- `buildNote` appends those `p` tags, de-duplicating against a reply target's
  `p` tag so replying to someone you also `@`-mention isn't tagged twice.
