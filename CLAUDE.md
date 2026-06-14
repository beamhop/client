# Verity — project notes for coding agents

Enterprise Nostr client. Bun monorepo: `@beamhop/core` (framework-agnostic Nostr
logic) + `@beamhop/web` (React/Vite UI). See `README.md` for the full overview.

## Architecture constraint: client-side only (hard rule)

This app is a **fully static SPA with no backend** — and must stay that way.
Don't add a server, API routes, serverless functions, DB, or any first-party
backend infrastructure. It builds to static assets (`dist/`) and deploys to any
static host (GitHub Pages, etc.).

- All logic runs in the browser: relays over WebSocket, signing via `nostr-tools`
  (local key) or NIP-07, state in `localStorage`. No session/token server.
- Features that seem to need a backend should use **third-party Nostr-native
  services** instead (e.g. media uploads via Blossom / NIP-96 hosts), never a
  server we run.
- If something genuinely can't be done client-side (e.g. OpenGraph link-preview
  cards, web push), flag it and ask before adding any backend — don't introduce
  one to make a feature work.

## Commands

```sh
bun run typecheck      # strict typecheck, both packages
bun run test:unit      # core + web unit tests (offline, fast)
bun run test:e2e       # Playwright E2E against REAL relays (from apps/web)
bun run --filter '@beamhop/core' test:integration   # core real-relay tests
bun run build          # build core + web
bun run dev            # web dev server on :5173
```

- Unit tests: `*.test.ts`. E2E: `e2e/*.spec.ts` (Playwright). Integration: `*.itest.ts`. Keep them in separate commands.
- Max-strict TS (no `any`, no non-null `!`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`). Crypto via `nostr-tools` only.

## Notifications via ntfy.sh

When a long task finishes, notify the user's topic with a simple HTTP POST (no
auth, no SDK needed). The topic is **`tolga-7509-agent`**.

```sh
# minimal
curl -d "Task done ✅" ntfy.sh/tolga-7509-agent

# with title, priority (1=min..5=urgent) and emoji tags
curl \
  -H "Title: Verity build" \
  -H "Priority: default" \
  -H "Tags: white_check_mark" \
  -d "All 25 E2E + 48 unit tests passing" \
  ntfy.sh/tolga-7509-agent
```

Notes:
- URL format: `https://ntfy.sh/<topic>`. POST is the default for `-d`.
- `Tags` are comma-separated emoji shortcodes (e.g. `white_check_mark`, `warning`, `rocket`, `tada`).
- Keep the body short; put status in the `Title`. Send on completion (success or failure), summarizing what passed/failed.
