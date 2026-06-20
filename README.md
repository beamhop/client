# Verity — a Nostr client with first-class Documentations

Verity is a fully client-side [Nostr](https://github.com/nostr-protocol/nostr) client
built from the **Verity Glass** design. Beyond the usual social surface (feed, profiles,
follows, reactions, reposts, encrypted DMs) it adds a headline feature: **Documentations** —
long-form, versioned, signed knowledge built on [NIP-23](https://github.com/nostr-protocol/nips/blob/master/23.md).

Keys live in your browser (or a NIP-07 signer). Nothing is sent to a backend — the app talks
directly to public relays.

## Stack

- **Bun** runtime, package manager, bundler, test runner
- **React 19** + **TypeScript** (`strict`, `noUncheckedIndexedAccess`, no `any`, no non-null `!`)
- **nostr-tools** for protocol primitives (signing, bech32/NIP-19, relays, NIP-04)
- Zero CSS framework — design tokens + inline styles, light/dark + 5 accent palettes

## Run it

```sh
bun install
bun dev            # http://localhost:3000  (Bun fullstack server + HMR)
```

First run drops you on an onboarding screen: **create a new identity**, **import an `nsec`**,
or **connect a NIP-07 signer**. A generated key is stored only in your browser — back up the
`nsec` from **Keys & Security**.

## Scripts

| Command | What it does |
| --- | --- |
| `bun dev` | Dev server with hot-module reload |
| `bun run build` | Production bundle into `dist/` |
| `bun start` | Serve the production build |
| `bun run typecheck` | `tsc --noEmit` (strict) |
| `bun test` | Unit + integration tests (`src/**/*.test.ts`) — no network |
| `bun run test:e2e` | Live relay round-trip test (`e2e/`) — needs internet |

Unit/integration and E2E are deliberately **separate commands**.

## Features

| View | Backed by |
| --- | --- |
| **Home** | kind-1 feed of your follows (+you), inline composer, like/repost/reply/bookmark |
| **Explore** | global & hashtag feeds, npub / NIP-05 lookup |
| **Docs** | **Documentations** — NIP-23 (kind 30023) list, reader with live TOC, markdown editor with preview |
| **Messages** | NIP-04 encrypted DMs (signer-side encryption when a NIP-07 signer is present) |
| **Agents** | locally-managed autonomous identities, each with its own keypair |
| **Profile** | kind-0 metadata, Posts/Replies/Media tabs, follow, edit-and-publish |
| **Keys & Security** | npub/nsec reveal & copy guards, signer status, relay manager |

## Architecture

```
src/
  nostr/        protocol layer — keys, relays, client (SimplePool), event encode/decode, DMs
  lib/          pure helpers — markdown renderer (+ TOC, sanitized), theme palettes, formatting
  state/        React store (identity, relays, theme, nav, contacts) + data hooks (useFeed, useEngagement)
  ui/           shared primitives, icons, onboarding, sidebar, compose, toasts, app shell
  views/        one file per screen, each building only on the shared contract
  styles/       design tokens (CSS variables, prose & editor styles)
```

Everything maps to standard Nostr: profiles = kind 0, feed = kind 1, follows = kind 3,
DMs = kind 4, reposts = kind 6, reactions = kind 7, long-form = kind 30023. Documentation
vs. blog articles (both kind 30023) are split by a `t` marker tag (`verity-doc` / `verity-article`).

## Documentations, end to end

Open **Docs → Write documentation**, write Markdown, hit **Preview**, then **Publish**. The
editor builds an addressable NIP-23 event (`d`-tag identifier, `title`, `summary`, `published_at`,
`t` tags) signed by your key and fanned out to your write relays. The reader renders the Markdown
with a live table of contents and an **Edit** button when the document is yours — editing reuses
the same identifier so the addressable event updates in place.
