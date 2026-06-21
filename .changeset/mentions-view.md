---
"@beamhop/client": minor
---

feat: add a Mentions view showing the posts that mention you

A new **Mentions** destination (sidebar + mobile nav, `#/mentions`) lists the
actual posts that reference you, newest first, as full post cards you can reply
to, like, repost, bookmark, and open. It merges two sources:

- `#p`-tagged mentions from anyone — the NIP-27/-10 happy path, which our own
  composer now emits.
- Content-only mentions from people you follow: their notes are scanned for an
  inline `@npub` of you, recovering mentions whose author forgot the `p` tag.
  Relays can't match free-text, so this recovery is necessarily limited to notes
  we already pull (your network); the follow list scanned is capped to bound the
  `authors` filter.

Both sources are re-checked client-side with one `referencesMe` predicate, so the
list is correct regardless of how strictly a relay honored the filters, and your
own posts and muted authors/words are excluded.

Tag-based notifications (toasts/badges) are unchanged and remain the scalable
path for being alerted to mentions from anyone.
