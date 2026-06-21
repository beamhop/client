---
"@beamhop/nostr": minor
"@beamhop/client": minor
---

feat: render an inline profile chip for pubkey mentions in posts

Post bodies now turn `@npub1…`, `nostr:npub1…`, and `nostr:nprofile1…` mentions
into the same interactive profile chip used elsewhere (avatar + handle, links to
the profile) instead of showing a raw key string.

- `@beamhop/nostr` gains `tokenizeMentions(content)`, which splits note text into
  literal-text and resolved-pubkey-mention tokens. The bech32 body is validated
  via `nip19.decode`, so a mention-shaped substring that doesn't decode is left
  verbatim as text; concatenating the tokens reproduces the input exactly.
- `@beamhop/client` renders those tokens in `PostCard` via a new `PostContent`
  component, with `white-space: pre-wrap` preserving the author's spacing.
- The chip prefers the mentioned user's profile name (display name / name), then
  a NIP-05 handle, and only falls back to the short npub (in monospace) when the
  profile has neither — so a named user shows as their name, not a raw key.
