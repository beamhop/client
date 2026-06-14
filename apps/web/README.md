# @beamhop/web

The Verity web client — a modern, enterprise-flavored Nostr app built with React
+ Vite + TypeScript, implementing the `Verity.dc.html` design. All Nostr logic
lives in [`@beamhop/core`](../../packages/core); this package is the UI and the
real-time state engine that binds it.

## Features

- **Onboarding** — create a new identity, import an `nsec`, or connect a NIP-07 signer; sign out from the sidebar profile, Keys & Security, or the command palette
- **Home feed** — live feed from the people you follow (global fallback when empty),
  inline composer, optimistic posting
- **Post interactions** — reply (NIP-10), like (NIP-25), repost (NIP-18),
  bookmark (NIP-51), share, and `nostr:` mentions (NIP-27)
- **User profiles** — click any avatar or username (anywhere) to open that person's profile + feed; follow/unfollow and message them
- **Explore & search** — full-text people **and** post search over NIP-50 relays, plus npub/hex lookup, follow/unfollow, start conversations
- **Messages** — end-to-end encrypted DMs (NIP-17 over NIP-44), live + history, with **persistent read state** (unread badges survive reloads)
- **Profile** — view/edit kind 0 metadata, follower/following/post counts, tabs
- **Keys & Security** — reveal/copy keys, signer status, key rotation, **relay management** (add/remove/reset), governance toggles, a local audit trail with CSV export
- **Keyboard-first** — `⌘K` / `Ctrl+K` command palette (commands + live people search), `g`-then-`h/e/m/p/s` navigation, `n` new post, `/` search, `t` theme, `j/k` feed navigation with `l`/`r`/`b`/`Enter` actions, `Esc` to close
- **Theming** — light/dark, fully responsive (desktop sidebar + mobile bottom nav)

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `⌘K` / `Ctrl+K` | Open the command palette |
| `/` or `?` | Open the command palette |
| `g` then `h`/`e`/`m`/`p`/`s` | Go to Home / Explore / Messages / Profile / Security |
| `n` | New post |
| `t` | Toggle theme |
| `j` / `k` | Move feed selection down / up |
| `l` / `r` / `b` / `Enter` | Like / reply / bookmark / open author (focused post) |
| `Esc` | Close palette or modal |

## Run it

```sh
bun install
bun run dev          # http://localhost:5173
```

```sh
bun run build        # typecheck + production build
bun run preview      # preview the build
```

## Architecture

```
src/
  engine/VerityEngine.ts  # owns NostrClient + subscriptions, exposes an
                          # immutable snapshot via useSyncExternalStore
  store/AppContext.tsx    # UI state (routing, modals, toasts) + engine wiring
  components/             # Sidebar, Header, RightRail, PostCard, Modal, …
  views/                  # Home, Explore, Messages, Profile, Security, Login
  modals/                 # Compose, EditProfile, RotateKey
  lib/                    # session/key persistence, audit log, content rendering
```

The engine is the single place Nostr side effects happen; views are pure
functions of the snapshot, which keeps the app modular and easy to extend —
adding a feature is typically a new engine action + a view that renders it.

## End-to-end tests

Playwright drives the real UI against **real public relays** — posting, replying,
mentioning, liking/reposting/bookmarking, profile management, follow, and a
cross-client encrypted DM round-trip (Alice ↔ Bob in two browser contexts).

```sh
bun run test:e2e         # headless
bun run test:e2e:ui      # interactive
```
