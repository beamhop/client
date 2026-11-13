# @beamhop/pwa

The beamhop control panel. Design direction **CARRIER** (`docs/design/DESIGN.md`) is binding;
layouts in `docs/design/SCREENS.md`, flows in `docs/design/JOURNEYS.md`.

Stack: React 19 · TypeScript · Vite 7 · React Aria Components · Tailwind v4 · Motion · TanStack Router (code-based) +
Query · vite-plugin-pwa (Workbox) · Fontsource (Instrument Sans, Martian Mono, Doto) · Phosphor icons.

```bash
pnpm --filter @beamhop/pwa dev          # http://127.0.0.1:5173/?mock=1
pnpm --filter @beamhop/pwa build        # → apps/pwa/dist (served by beamhopd)
pnpm --filter @beamhop/pwa typecheck
pnpm --filter @beamhop/pwa test         # vitest (jsdom)
pnpm --filter @beamhop/pwa test:e2e     # build first; Playwright: smoke + axe on every route, mobile + desktop
pnpm --filter @beamhop/pwa test:e2e:real # Playwright against a REAL beamhopd (see below)
pnpm --filter @beamhop/pwa screenshots  # every route → screenshots/{mobile,desktop}/*.png
pnpm --filter @beamhop/pwa icons        # regenerate public/icons from scripts/gen-icons.mjs
node apps/pwa/scripts/bundle-report.mjs apps/pwa/dist   # boot-path JS (entry + static imports), fails over 350 kB gz
```

Boot path budget: **< 350 kB gzip** of JS before first render (`scripts/bundle-report.mjs`). The demo daemon
(`api/mock`, seed data, zod schemas) is a separate chunk loaded only in mock mode (`loadMock` in main.tsx);
screens are route-level lazy chunks; the palette/shortcut overlays load after first paint. `e2e/perf.spec.ts`
keeps LCP < 2.5 s and CLS < 0.1 on Home, Inbox and a session (mobile at 4× CPU).

## Structure

```
src/
  main.tsx            fonts, QueryClient, runtime, router, MotionConfig
  Root.tsx            RAC RouterProvider + ToastProvider + PanicProvider + AppShell
  router.tsx          every route in SCREENS §0.1 (lazy screens). Add routes here + e2e/paths.ts
  api/                data layer (see below)
  shell/              AppShell, TabBar, Sidebar, StatusStrip, Screen/SplitView, panic, connection, banners
  screens/<name>/     ONE DIRECTORY PER OWNER (placeholders with a TODO header)
  ui/                 design system (barrel: ui/index.ts) + glyphs/
  lib/                appearance (theme), haptics, format, live regions, media queries, useNow
  i18n/               en.json + t() with ICU plurals
  styles/tokens.css   VERBATIM copy of docs/design/tokens.css — keep in sync (cp after design changes)
public/boot.js        sets data-theme/contrast/motion before paint (external: daemon CSP forbids inline JS)
```

## Data layer (`src/api`)

- **Transport choice** (`connection.ts`): `#token=…` in the URL → saved to localStorage, stripped from the URL →
  WebSocket to the local daemon (`location.origin`, or `?daemon=<url>`). `?mock=1` (sticky per tab) or no token →
  in-browser **mock daemon**. `?still=1` freezes the mock's timers. `?mockFail=channel.list,agent.get` makes those
  methods fail (error states). `?mock=0` forgets the sticky mock. A saved daemon → hosted mode (below). Nothing at
  all → mock in dev builds, `kind: 'none'` (pair prompt, `useConnection().needsPairing`) in production builds.
- **Hooks** (`hooks.ts`) — the only way screens talk to the daemon:

  ```ts
  const { data, isPending, error } = useApi('agent.list');
  const q = useApi('session.events', { id, afterSeq: 0 });
  const stop = useMutationApi('agent.stop');           // stop.mutate({ name: 'reviewer' })
  const call = useCall();                              // imperative: await call('approval.undo', { id })
  useServerEvent((e) => { if (e.type === 'session.event') … });
  ```

  Keys are `['bh', method, params]`. Mutations invalidate related reads (`keys.ts INVALIDATES`).
  Pushed `ServerEvent`s patch caches **before** your listener runs (`events.ts`): agent/session/approval/channel
  upserts, audit prepends, `panic` refetches everything. **Same `seq` on `session.event` = replace** (streaming text).
- ⚠ If a component may unmount when its own mutation's event lands (a slip that disappears once decided), use
  `mutateAsync().then(...)` — per-call `mutate(..., { onSuccess })` callbacks never fire after unmount.
- **Mock** (`mock/`): `seed.ts` (4 agents on Claude Code / Codex / Gemini / OpenCode, Nostr+Telegram+Slack+Discord,
  8 sessions, 4 pending approvals of every risk, 14 days of usage/audit, devices, schedules, deployments),
  `daemon.ts` implements **every** method in `@beamhop/core` `methods` (params validated with the real zod schemas,
  real error codes, 5 s undo window), `sim.ts` streams sessions, adds approvals, expires them, flickers relays.
  Console: `__beamhop.mock.daemon.state`, `__beamhop.runtime.client.call('system.panic')`.

## Real-backend e2e (`e2e-real/`, `pnpm run test:e2e:real`)

The mock is not the contract — the daemon is. `e2e-real/` runs the production build served by a real
beamhopd (`apps/daemon/test/test-daemon.ts`, started by `global-setup.ts` on ports 4600/4601, never
reused) with a fake channel plugin (`fake`, token `good…`) and a scripted fake harness (`ASK <cmd>`,
`STREAM <n>`, `HANG`, else echo). Each test gets a fresh daemon home seeded with channel `fk`, agent
`bot` and owner `fake:alice`, opens `/<route>#token=<api token>` (real WebSocket transport) and
drives the fakes through `bh.inject` / `bh.snapshot` / `bh.advance` / `bh.violate` (`fixtures.ts`).
Verify on the daemon with `bh.rpc(method, params)` or the files in `bh.home`. Journeys that need API
methods not on the daemon yet are `test.fixme` in `pending-api.spec.ts`.

## Hosted mode (`src/api/hosted.ts`)

The hosted copy (app.beamhop.dev) reaches daemons over the encrypted Nostr control plane (PLAN §4, §9 Hosting).
Boot order (`connection.ts`): `?mock=1` > `#token=` > **active saved daemon → Nostr** > stored token > dev mock / `none`.

- **Transport** (`nostr.ts`): `@beamhop/client` Transport over `createControlClient` (device key) or a signer
  client (`signer-client.ts`, NIP-07). Reconnect with backoff (RelayPool) + immediate retry on the `online` event;
  requests wait in a bounded queue while offline / no relay is up / the response subscription is not live yet
  (control events are ephemeral) and are never re-sent once published. Transport failures reject with
  `RpcError(-32000, { code: 'timeout' | 'unavailable' | 'offline' | 'closed' | 'signer_unavailable' })`.
  `useConnection().hosted` = `{ relays[{url,connected}], up, total, daemon: 'unknown'|'reachable'|'unreachable'|'unpaired', queued, identity, daemonNpub }`
  for the connection pill/sheet. Loaded lazily (`hosted-lazy.ts`) so nostr-tools stays out of the main chunk —
  import hosted APIs from `api/hosted.ts`, not `api/index.ts`.
- **Pairing** (`pairing.ts`): `usePairing()` reads `/pair#<payload>` (then strips it from the URL; kept in
  sessionStorage for reloads), creates the device key, exposes the 4-word safety phrase, runs `completePairing`,
  polls `device.list` until paired / rejected / expired, and saves `{ daemonNpub, relays }` as the active daemon.
  `?mock=1` or `DEMO_PAIRING_PAYLOAD` runs a simulated flow (`?mockPair=rejected|expired`). The phone cannot see a
  "No" pressed on the computer after it answered — that ends as `expired` when the 5-minute confirm window closes.
- **Saved daemons** (`daemons.ts`, localStorage `bh.daemons`, public data only): `useDaemons()` →
  `{ daemons, active, switchTo(id), remove(id), rename(id, name) }`; switching reloads the app into that daemon.
  `remove` only forgets locally — call `device.remove` on the daemon first.
- **Device key** (`device-key.ts`): generated on first use, stored in IndexedDB (`beamhop` / `keys` / `device`).
  ⚠ WebCrypto has no secp256k1, so the key cannot be a non-extractable CryptoKey. We encrypt it with a
  non-extractable AES-GCM key kept in the same record (protects profile backups / disk dumps), but any script on
  this origin can still use it: keep the strict CSP and no third-party scripts, and remove lost devices in
  Settings → Devices (§7A). The key is never logged or sent anywhere.
- **Signers** (`signer.ts`): device key (default), NIP-07 (`hasNip07()`, needs `window.nostr.nip44`), NIP-46 bunker
  (`parseBunkerUrl` works; `nip46Signer` is a TODO stub).

## Shell services

- **Command palette** (`shell/Overlays.tsx`, lazy): `⌘K` / `Ctrl K`, the sidebar Search button, More → Search,
  the status strip. Actions (allow the next low-risk approval with undo / review the next one, stop everything,
  new agent, add channel, pair a device, new cloud agent, scan, theme), agents (+ stop), sessions, channels,
  screens and settings sections. Open it from code with `openOverlay('palette')` (`shell/overlays.ts`).
- **Shortcut sheet**: `?` anywhere. Every key lives in `shell/shortcut-list.ts` — when a screen adds a key,
  list it there (the current screen's section is shown first). Global keys: `shell/shortcuts.ts`.
- **Connection** (`shell/Connection.tsx`): one `useConnectionSummary()` → `link`
  (`reachable | connecting | no-answer | unpaired | not-paired | offline`) drives the pill, the sheet, the
  status strip and the banners. Hosted mode shows this browser's relays, daemon key, signer, queued requests,
  "Pair again" and "Disconnect this browser" (`device.remove`, then `removeDaemon`).
- **Push** (`screens/pair/push.tsx` over `api/push.ts`): `turnOnPush(client, deviceId)` (permission →
  `device.pushKey` → PushManager → `device.pushSubscribe`), `usePushDeviceId()`, `usePushPrefs(id)` for the
  per-device `device.pushPrefs` categories. A fresh hosted pairing asks inside the tap and `<PushResume/>`
  registers the subscription after the app boots into the daemon.
- **Install** (`lib/install.ts`): captures `beforeinstallprompt` at boot; Home shows a once-only install banner on
  phones (real daemons only); `useInstall()` for your own button.

## Adding / building a screen

1. Own your directory under `src/screens/<name>/`. Keep the exported component names (router imports them lazily).
2. Render into `<Screen title=… back=… actions=… slug=… crumbs=… pane=…>` (top bar, large title, banners, panes).
   List/detail screens: `<SplitView list={…} hasDetail={useHasDetail('/route')}><Outlet/></SplitView>`.
3. Use only `ui/` components and token utilities (`bg-surface`, `text-ink-2`, `type-meta`, `hatch`, …). No raw colours,
   no shadows on resting cards, no new fonts. Exactly one primary button per view. Every gesture needs a visible button.
4. States: `useDelayedLoading` + `Skeleton`, `EmptyState` (with `cli`), `ErrorState` (`details`, `onRetry`).
5. Delete the `ScreenStub` once the real UI is in. Add new strings to `i18n/en.json`.
6. Run `test:e2e` — axe (serious/critical) and the no-horizontal-scroll check run on every route.
   New concrete routes go into `e2e/paths.ts`.

Route `staticData`: `{ chrome: 'bare' }` (no shell), `{ hideTabBar: true }`, `{ hideInboxRail: true }`.

## Components (`src/ui`, all shown at `/_kitchen`)

Button (primary, secondary, quiet, allow, deny, destructive, destructive-outline; pending = hop bars), IconButton
(44px + tooltip), LinkButton, TextLink · TextField, SecretField (show/hide, paste, format check, saved state),
NumberField, SearchField · Select (popover desktop / sheet compact), Switch, Checkbox, RadioGroup/Radio (list or
cards), SegmentedControl, Tabs · Sheet (bottom sheet with drag-to-dismiss + Close + Esc; dialog/pane ≥1024),
ConfirmDialog · ToastProvider/useToast (one visible, undo with shrinking beam line, F6 focuses) · Card, TicketCard
(transmission slip with perforation + notches), UntrustedQuote, SwipeAction (thresholds, haptics, A/D keys,
`commit(dir)` for buttons) · StatusDot (shape+colour+word), SignalBars, SegmentedMeter, RouteLine (pulse, broken,
blocked) · LetterTile, MetaLine (middle truncation), Readout (Doto), Eyebrow, Badge, CountBadge, RiskTag, Kbd ·
EmptyState, Skeleton/SkeletonBlock, ErrorState, Banner · CodeBlock, DiffView, CliStrip, CopyButton · ChipGroup,
ChipInput (host/wildcard/URL parsing) · PathPicker (ComboBox + Browse sheet) · Stepper (horizontal/vertical) ·
QrCode (SVG) · Sparkline, BarChart (stacked, keyboard, legend-as-table, table view) · glyphs: Lamp, HopMeter, Gate,
Perforation, Hatch, CarrierMark, BeamGlyph, SlipGlyph · `motion.ts` springs + `useReduced()`.

Theme: `lib/appearance.ts` (System/Paper/Night shift, contrast, motion, haptics; persisted `bh.appearance`),
UI in Settings → Appearance and the kitchen toolbar. `prefers-reduced-motion` and the in-app setting are honoured
by CSS (`data-motion`), `MotionConfig` and components that animate meaning (SwipeAction, RouteLine, Sheet).
