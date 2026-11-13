# Screenshot review — fresh-eyes design pass (after-state)

Regenerated with the full Playwright run (`PW_PORT=<private> BH_SHOTS=1 pnpm test:e2e`). Mock mode, frozen
timers, 390×844 (mobile, touch) and 1280×800 (desktop) at 1×. This pass was a fresh-eyes review: the journeys
(first launch, triage, follow + steer a session, add Telegram, new agent, tighten a policy, panic & resume)
were walked by touch emulation and keyboard, then the 15 most impactful problems were fixed with shared
components first. Ranked list and status:

| #   | Problem (before)                                                                                                                                                   | Fix                                                                                                                                                    | Status                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| 1   | One number, four values: tab badge 7, Inbox readout 07, filter "All 5", Home "Needs you · 5", strip "7 pending"                                                    | `useNeedsYouCount()` (screens/inbox/needs.ts): every surface counts _decisions_ (grouped slips, minus voted/queued/optimistic)                         | fixed                                                          |
| 2   | Compact top bar crowded: full orange "New agent / New cloud agent / Add" + "Scan" next to pill, DEMO and Stop                                                      | `BarAction` (ui/Button): labelled button on desktop, one 44px icon action on compact; Harnesses' Scan now matches Home's refresh                       | fixed                                                          |
| 3   | Kill switch in the compact bar was an unlabelled red square that reads as a status light                                                                           | Labelled "■ Stop" control (accessible name unchanged)                                                                                                  | fixed                                                          |
| 4   | Chip/tab rails cut off hard with no affordance (Inbox, Sessions, agent tabs, Tabs)                                                                                 | `scroll-rail` utility + `useScrollEdges` + `FilterRail`: edge fades on the side that hides content, selected item scrolled into view                   | fixed                                                          |
| 5   | `-mx-gutter` was used for full-bleed banners/lists but never defined — everything meant to bleed sat inset                                                         | Defined the utility (compact/medium); session list hairlines, banners and rails now reach the edge as designed                                         | fixed                                                          |
| 6   | Session rows truncated titles at ~20 chars; `…` menu fought the timestamp                                                                                          | Two-line titles, menu tucked under the timestamp at the row's bottom-right                                                                             | fixed                                                          |
| 7   | Policy and Deploy lists were bare rows while Agents/Channels use cards                                                                                             | `ListGroup` + `listRowClass` (ui/Card); Policy rows gain carets and tiles, Deploy gets an eyebrow + card                                               | fixed                                                          |
| 8   | Deploy row title "ci-bot @ fly ams" + status squeezed the slug into "shared-cpu-1x · $5.70/mo · si…"                                                               | Status on the title line; `provider region · size` slug; cost · since on its own line                                                                  | fixed                                                          |
| 9   | Disabled primary = 45% flare: pink, reads broken                                                                                                                   | Filled variants disable to a dashed `sunken` slot in ink-3 ("not armed yet")                                                                           | fixed                                                          |
| 10  | Panic confirm: four Doto counters repeating the sentence above; "1 cloud daemons"; after the press the sheet still said "Stop everything?" with Close _and_ Cancel | One ledger (box · count · noun · verb) that ticks row by row after the press; ICU plurals; sheet retitles to "Everything is stopped." and drops Cancel | fixed                                                          |
| 11  | Two chip styles for the same job (Inbox square chips vs Sessions rounded chips with tiles)                                                                         | Both use `FilterRail`                                                                                                                                  | fixed                                                          |
| 12  | Appearance: three segmented controls with no preview                                                                                                               | Live specimen (slip with lamp, slug, Doto clock, Deny/Allow) built from tokens; caption states theme · contrast · motion                               | fixed                                                          |
| 13  | Wide Inbox rail listed 7 raw requests under "Needs you"                                                                                                            | Rail shows the same grouped slips (×N badge) and count                                                                                                 | fixed                                                          |
| 14  | "Continue · Step" labels render the middle dot almost without spacing in Instrument Sans (Pair, New agent)                                                         | —                                                                                                                                                      | open (font metrics; needs a thin-space or `· ` span treatment) |
| 15  | HC dark Allow (mint fill) is very bright next to everything else                                                                                                   | —                                                                                                                                                      | open (needs a design decision: HC is meant to be loud)         |

Honest notes per screen below: **+** works, **−** still weak.

## Shell (all screens)

- **+** Compact bar is now pill · one icon action · labelled Stop on every top-level screen. Counts agree
  everywhere (badge, sidebar, strip, Inbox readout, Home eyebrow, wide rail).
- **−** On touch devices RAC reveals the palette only after the on-screen keyboard settles (≤600 ms).
- **−** The DEMO badge still costs ~60px of the compact bar in mock mode.

## Home (`home`, `home-dark`, `home-hc-*`, `home-panic`)

- **+** Reads like an instrument: needs-you slips with countdown, live lamp, beam lines, budget meters;
  "Needs you · 5" now matches the Inbox badge.

## Inbox (`inbox*`, `inbox_apr_a41f`)

- **+** Readout counts decisions (05) like "All 5" and "1 of 5"; agent chips fade at the edge and bleed to the
  screen edge. **−** "×3" collapsing is explained only by the badge; a first-timer may not know three
  requests are decided at once (the scope sheet says so).

## Sessions (`sessions*`, `sessions_ses_842*`, `sessions_ses_836*`)

- **+** Full-bleed list, two-line titles, quieter row menu; agent rail shares the Inbox chip style.
- **−** Two stacked filter rows (status segmented + agent chips) still take ~110px above the list.

## Agents (`agents*`, `agents_new*`, `agents_reviewer_*`)

- **+** Detail section tabs fade at the edge. **−** New agent keeps the tab bar while Deploy/Channel wizards
  hide it (intentional per SCREENS, inconsistent to the eye).

## Channels (`channels*`, `channels_tg*`, `channels_add*`)

- **+** Disabled "Check token" is now a dashed slot instead of a washed-out orange.

## Harnesses (`harnesses*`)

- **+** Scan is a top-bar icon like Home's refresh (pull-to-refresh still works).

## Policy (`policy*`, `policy_reviewer*`, `policy_roles`, `policy_workspace`)

- **+** Agents, profiles and roles are three card groups with the Channels rhythm; every row has a tile and
  a caret. Reach table with hatched "Never" row unchanged.

## Deploy (`deploy*`, `deploy_new*`, `deploy_detail-dark`)

- **+** Eyebrow + card list; status no longer crushes the slug. **−** Destroyed rows are hatched inside the
  card; with many of them the hatch gets busy.

## Audit (`audit*`)

- **−** Three Doto-ish numerals still compete on Usage when the panic band is also present (not touched).

## Settings (`settings*`)

- **+** Appearance has a live preview. **−** Retention "Purge" still sits close to Export.

## Onboarding (`setup_*`)

- **+** Doctor step shows "checking 2 of 5…"; disabled Continue reads as "not yet" instead of broken.

## Pair (`pair*`, `setup_phone-confirm`)

- **−** The QR panel is visually heavy next to the small Doto expiry readout (not touched).

## Panic (`panic*`, `home-panic`, `panic-resume`)

- **+** One ledger before and after the press; one Doto readout (the band's time on Home) per screen again.

## High contrast (`*-hc-light`, `*-hc-dark`)

- **+** Pure grounds, solid hairlines, chips gain borders. **−** HC dark Allow is very bright (see #15).

## Icon

- **−** At 16px favicon size the hop bars merge into a block (not touched).
