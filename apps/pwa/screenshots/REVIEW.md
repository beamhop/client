# Screenshot review — integration & polish pass

Regenerated with the full Playwright run (`pnpm test:e2e`, plus `BH_SHOTS=1` for the agents / channels /
harnesses sets). Mock mode, frozen timers, 390×844 (mobile) and 1280×800 (desktop) at 1×. New in this pass:
`*-hc-light|dark` (high contrast), `palette*`, `shortcuts*`, `connection*`, `home-unpaired`.
Honest notes, one block per screen: **+** what works, **−** what is still weak.

## Shell (all screens)

- **+** One connection model (`link`) behind pill, sheet, status strip and banners; hosted mode finally shows
  its own relays, daemon key, "Pair again" and a real "Disconnect this browser". A never-paired browser gets a
  landing (`home-unpaired`) instead of skeletons that never resolve.
- **+** ⌘K palette (`palette`) is instant, mirrors CLI verbs, reaches agents/sessions/channels/settings and runs
  actions; `?` opens one shortcut sheet for every screen (`shortcuts`), current screen first.
- **+** Desktop sidebar now carries "Search… ⌘K", the strip shows ⌘K / ? instead of a lone `g i` hint.
- **−** On touch devices RAC reveals the palette only after the on-screen keyboard settles (≤600 ms) — not quite
  "instant" on phones. **−** The compact top bar is crowded on narrow phones (pill + DEMO + primary + Stop).

## Home (`home`, `home-dark`, `home-hc-*`, `home-panic`)

- **+** Reads like an instrument: needs-you slips with countdown, live lamp, beam lines, budget meters.
- **−** Inbox badge (7) vs "Needs you · 5" (grouped ×3 slips) still looks like a mismatch to a first-time user.

## Inbox (`inbox*`, `inbox_apr_a41f`)

- **+** Transmission slips with perforation; Allow/Deny differ in shape; Doto pending count; keyboard row.
- **−** Agent filter chips overflow horizontally on mobile with no fade/edge affordance.

## Sessions (`sessions*`, `sessions_ses_842*`, `sessions_ses_836*`)

- **+** Tick rail, tool rows, inline approval slip and "waiting for you" bar above the composer are strong.
- **−** Session list rows truncate titles aggressively at 390px; the `…` row menu competes with the timestamp.

## Agents (`agents*`, `agents_new*`, `agents_reviewer_*`)

- **+** Cards with one-tap Stop; preset-first New agent with a live "will reach" summary on desktop.
- **−** Detail tabs (Overview…Identity) scroll off-screen on mobile without an edge fade. New agent keeps the
  tab bar while Deploy/Channel wizards hide it — intentional per SCREENS, but inconsistent to the eye.

## Channels (`channels*`, `channels_tg*`, `channels_add*`)

- **+** Provider monograms, wizard stepper rail, CLI strip on every step; the route beam no longer draws over
  the "Telegram" label (pulse clipped, labels truncate).
- **−** Disabled primary ("Check token") at 45% flare reads a little washed out on Paper.

## Harnesses (`harnesses*`)

- **+** Needs-you first with the exact command; catalog signature in the slug line.
- **−** "Scan" sits in the top bar as a secondary button — the only screen doing that.

## Policy (`policy*`, `policy_reviewer*`, `policy_roles`, `policy_workspace`)

- **+** Reach table with hatched "Never" row is the clearest security surface in the app.
- **−** Policy list rows are bare (no card) while Agents/Channels use cards on mobile — a rhythm break.

## Deploy (`deploy*`, `deploy_new*`, `deploy_detail-dark`)

- **+** Plan diff before anything is created; cost estimate in the button; now has its CLI strip and i18n.
- **−** List rows are bare on mobile (no card) and the empty-state/list rhythm differs from Agents.

## Audit (`audit*`)

- **+** Usage readout + per-budget meters; security categories with sparklines; log with tick rail.
- **−** Three Doto-ish numerals compete on Usage when the panic band is also present.

## Settings (`settings*`)

- **+** Live slugs on every row ("3 devices · 1 inactive", "push off on this device"); Notifications now
  registers real Web Push (device.pushKey → PushManager → device.pushSubscribe) and per-device categories.
- **−** Appearance is three segmented controls with no preview swatch; Retention "Purge" sits close to Export.

## Onboarding (`setup_*`)

- **+** Left-aligned instrument flow, stepper rail, CLI strip per step; the phone step footer now fits Back +
  Skip + Continue at 390px.
- **−** Harness step shows skeleton rows while scanning with no progress line ("checking 2 of 5").

## Pair (`pair*`, `setup_phone-confirm`)

- **+** Safety phrase is a match check, code entry allows paste; install + push asked in context afterwards.
- **−** The QR panel is visually heavy next to the small Doto expiry readout.

## Panic (`panic*`, `home-panic`, `panic-resume`)

- **+** One confirm, hatched band everywhere, review-before-resume checklist.
- **−** The four small Doto counters on the confirm violate "one readout per screen".

## High contrast (`*-hc-light`, `*-hc-dark`)

- **+** Pure grounds, solid hairlines, chips gain borders; Allow/Deny still distinguishable by shape.
- **−** HC dark Allow (mint fill) is very bright next to everything else.

## Icon

- **+** New mark: notched slip with a hop meter and the carrier square, beam passing behind; real monochrome
  silhouette for themed icons. **−** At 16px favicon size the hop bars merge into a block.
