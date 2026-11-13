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
pnpm --filter @beamhop/pwa screenshots  # every route → screenshots/{mobile,desktop}/*.png
pnpm --filter @beamhop/pwa icons        # regenerate public/icons from scripts/gen-icons.mjs
```

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
  methods fail (error states). `?mock=0` forgets the sticky mock. Hosted/Nostr: interface only (`nostr.ts`).
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
