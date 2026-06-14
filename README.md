# Verity

A fully functional, enterprise-flavored **Nostr client** with a modern, polished
UX — built from the `Verity` design prototype. Self-custodied identity,
verified profiles, a curated feed with full post interactions, and end-to-end
encrypted direct messages.

This is a Bun monorepo:

| Package | Description |
| --- | --- |
| [`@verity/core`](packages/core) | Framework-agnostic Nostr domain logic (keys, relays, events, profiles, contacts, posts, reactions, reposts, bookmarks, NIP-17 DMs). |
| [`@verity/web`](apps/web) | React + Vite web client implementing the Verity design. |

## Getting started

```sh
bun install
bun run dev          # start the web client at http://localhost:5173
```

On first load you can create a new identity, import an existing `nsec`, or
connect a NIP-07 browser extension.

## Scripts (run from the repo root)

```sh
bun run typecheck    # strict typecheck of every package
bun run build        # build core + web
bun run test:unit    # @verity/core unit tests (fast, offline)
bun run test:e2e     # Playwright E2E against real relays (posting, DMs, profile…)
```

Integration tests that hit real relays from the core package:

```sh
bun run --filter '@verity/core' test:integration
```

## What's implemented

Every feature in the UI prototype is wired to real Nostr:

- **Identity** — generate/import keys, NIP-07 signer support, reveal/copy keys, key rotation, accessible sign-out
- **Feed** — live notes from follows (global fallback), inline + modal composer
- **Interactions** — replies (NIP-10), mentions (NIP-27), likes (NIP-25), reposts (NIP-18), bookmarks (NIP-51), share
- **User profiles** — click any avatar/username to open their profile + feed; follow & message
- **Explore & search** — full-text people + post search (NIP-50), npub/hex lookup, follow/unfollow (NIP-02)
- **Messages** — end-to-end encrypted DMs (NIP-17 / NIP-44), live + history, cross-client verified, persistent unread state
- **Profile** — view/edit kind 0 metadata, counts, Posts/Replies/Media tabs
- **Keys & Security** — signer status, relay management, governance toggles, local audit trail + CSV export
- **Keyboard-first** — ⌘K command palette, `g`-navigation, `j/k` feed nav, single-key actions (see `apps/web/README.md`)
- **UX** — light/dark themes, responsive desktop + mobile layouts, micro-interactions, toasts

## Engineering notes

- TypeScript in maximum-strict mode (`strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `verbatimModuleSyntax`); no `any`, no non-null `!`.
- ESM-only, strict `exports`, Bun as runtime / package manager / test runner.
- Crypto is delegated to `nostr-tools` rather than hand-rolled — the one
  justified third-party dependency.
- Tests are real, not mocked: offline crypto/parsing unit tests plus
  integration and E2E suites that talk to live public relays.
```
