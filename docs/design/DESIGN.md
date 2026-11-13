# beamhop — Design Direction: **CARRIER**

> Status: v1, binding for the PWA (`apps/pwa`). Builders implement this exactly; deviations go through a design review.
> Companion files: [`tokens.css`](./tokens.css) (source of truth for values), [`JOURNEYS.md`](./JOURNEYS.md), [`SCREENS.md`](./SCREENS.md).
> Spec references are to `PLAN.md` sections (§).

---

## 1. Concept

**CARRIER** is beamhop as an *instrument*: a field transmitter's control panel printed on warm log paper. A carrier wave is the steady signal a radio emits so that a message can ride on it. beamhop is exactly that for agents: a quiet, reliable carrier that lets an agent's words hop from a sandbox on a laptop to a relay, to a Telegram group, to a phone in a pocket.

The product is about **what crossed which boundary, and who allowed it**. So the interface is built from the vocabulary of transmission:

| Product reality | Visual expression |
|---|---|
| Messages hop between sandbox → beamhop → relay → channel | **Beam lines**: 1px routes with nodes; a flare-coloured pulse travels along them when something is in flight |
| Relays, connections, budgets, hop limits | **Hop meters**: stepped bars, like signal strength, always with a number beside them |
| An agent actively streaming / acting | **On-air lamp**: the only saturated hot colour on screen (`flare`) |
| Every object has a precise identity (npub, channel id, harness version, path) | **Slug lines**: one line of monospace metadata under every title, like a logbook entry |
| The owner decides what passes | **Transmission slips**: approval cards with a perforated tear line between *what is asked* and *your decision* |
| Countdown to auto-deny, pairing codes, budget remaining | **Dot-matrix readouts** (Doto), one per screen, maximum |

### Why this direction (and not another)
1. **It is honest to the domain.** beamhop literally routes signals over relays. The motifs are diagrams of the real architecture (§2), not decoration. A user who learns the beam line on Home can read the route editor, the session header and the audit log without new vocabulary.
2. **It makes security legible.** Instruments are designed so an operator can read state at a glance under stress. Panic, approvals and policy (§7, §7A) need exactly that: shape-coded status, numbers next to every meter, and one alarm colour that means "live".
3. **It fits a developer audience without cosplaying a terminal.** Monospace is used *as data* (ids, paths, costs, timestamps), never as a "hacker" mood. No green-on-black, no CRT scanlines.
4. **It is distinct from AI-product defaults.** Warm paper neutrals and a single signal-orange (in the lineage of Teenage Engineering and Braun dials, not of SaaS gradients) cannot be mistaken for a shadcn template or a purple LLM landing page.

References studied: Teenage Engineering product UIs (single orange accent, exposed function, mono labels); Nothing OS (dot-matrix used deliberately "where it defines character rather than hurting readability" — https://nothing.community/d/61774/10); Linear (LCH-derived theme from few inputs, density, keyboard-first — https://linear.app/blog/how-we-redesigned-the-linear-ui); Things 3 (calm hierarchy, generous targets); Rauno Freiberg's *Invisible Details of Interaction Design* (interruptibility, momentum, commit-on-release for destructive gestures, no animation for frequent actions — https://rauno.me/craft/interaction-design); Swiss/International typographic grid; radio operator logbooks.

### Personality (five words)
**Precise · Warm · Candid · Quick · Unflappable**

- *Precise*: exact numbers, exact paths, exact times. "3 domains", never "a few".
- *Warm*: paper tones, human sentences, the owner is addressed as "you".
- *Candid*: we say what an agent can reach, in plain words, including the scary parts.
- *Quick*: frequent actions are instant; nothing makes you wait for an animation.
- *Unflappable*: errors and panic are calm, specific and recoverable. No red walls, no exclamation marks.

---

## 2. Anti-slop rules (non-negotiable)

### Never
- Purple, violet or blue→pink gradients. **No gradients at all** except the 2-stop flare halo of the on-air lamp.
- Glassmorphism, `backdrop-filter: blur` on cards, frosted panels. (Only exception: the mobile tab bar may use `blur(12px)` over a 92%-opaque `--bh-bg`, so it is effectively solid.)
- The default shadcn/Radix look: `rounded-lg border bg-card shadow-sm` cards, zinc palette, Lucide icons, Inter.
- Inter, Geist, Roboto, SF as the UI face. Our faces are fixed (§5).
- Emoji as icons or status. No ✨🚀🤖 anywhere in UI chrome. (User/agent message *content* may contain emoji; we render them.)
- Sparkle "AI" icons, robot mascots, glowing orbs, avatar blobs, 3D illustrations, isometric stock scenes.
- Centered hero + three feature cards. Onboarding is a left-aligned instrument flow, not a marketing page.
- Drop shadows on resting cards. Elevation is tone + hairline (§6.3).
- Fully rounded pill buttons for primary actions. Pills are reserved for the session composer and count badges.
- Colour as the only carrier of meaning (WCAG 1.4.1). Every status has a **shape** and a **word**.
- Spinners in the middle of empty screens. Use the beam sweep skeleton (§9.2) or a concrete progress line.
- Toasts that steal focus or pile up. One toast region, max one visible, newest replaces.
- "Oops!", "Uh-oh", "Something went wrong", "Magic", "Seamless", "Supercharge", "AI-powered".
- Animating frequent actions (tab switch, list filter, command palette open). Frequent = instant.
- Hiding the agent's own words inside a collapsed tool chip (a known failure in mobile agent apps; see JOURNEYS §3).

### Always
- One hot colour (`flare`) per screen region, used for *live/primary* only.
- A slug line (mono metadata) under every object title.
- A number beside every meter, bar and lamp.
- A visible button for every gesture (WCAG 2.5.1 / 2.5.7).
- The CLI equivalent of every configuration screen, in a collapsible "CLI" strip (`beamhop channel add telegram …`). It teaches, and it proves the PWA and CLI edit the same file (§6A.1).
- Hairline (1px) structure; rules and ticks over boxes.
- Left-aligned text; tabular numerals everywhere numbers change.
- Asymmetric friction: **stopping is one tap; widening access is deliberate**.

---

## 3. Signature motifs (with exact specs)

### 3.1 Beam line
A route between nodes. Drawn as inline SVG, `stroke: var(--bh-line-strong)`, `stroke-width: 1`, `shape-rendering: geometricPrecision`.

```
 nostr:dm ──────●────── reviewer ──────●────── slack:#deploys
   (node)     relay      (agent)      relay       (node)
```

- Nodes: 8px squares (channels), 10px circles (agents), 6px circles (relays/hops).
- **In-flight pulse**: a 16px segment in `--bh-flare` travelling along the path, `transition: visualDuration 0.6s, ease linear`, one pulse per message, max 2 concurrent. Under `prefers-reduced-motion`, the destination node fills for 400ms instead.
- **Broken route**: dashed `4 3` in `--bh-stop-text`, with a ✕-shaped node (Phosphor `X` 10px) at the failure point and the reason as text below.
- **Blocked by policy**: the line ends in a 6px vertical bar (a "gate") in `--bh-caution-text`.
- Used on: Home agent cards (compact, single line), Session header, Route editor (cross-channel routes, §1 "Cross-channel posting"), Onboarding progress rail, Audit event detail, Deploy topology.

### 3.2 Hop meter
Stepped bars, ascending heights 4/7/10/13/16px, width 3px, gap 2px, `radius 1px`. Filled bars `--bh-ink`; empty bars `--bh-line-strong`. Always followed by a mono number: `▂▄▆█ 3/4 relays`.
- Relay health (connected / configured relays).
- Hop count on mesh messages (`2/3 hops`), turns to `--bh-caution-text` at the limit.
- Never used for budgets (budgets use the segmented meter, 3.5).

### 3.3 On-air lamp (status glyph)
Status is encoded by **shape + colour + word**. 10px glyphs, Phosphor-compatible geometry:

| State | Shape | Colour | Word | Motion |
|---|---|---|---|---|
| Live (streaming/acting) | filled circle + halo ring | `--bh-flare` (light mode: `--bh-flare-text` for the dot) | `live` | halo breathes 1.6s, opacity .35→0; reduced motion: static ring |
| Ready/connected | filled circle | `--bh-go` | `ready` | none |
| Waiting on you | filled circle with notch (half-moon) | `--bh-caution-text` | `needs you` | none |
| Paused/queued | two vertical bars | `--bh-ink-2` | `paused` | none |
| Stopped/off | hollow ring 1.5px | `--bh-ink-3` | `stopped` | none |
| Error/offline | filled square | `--bh-stop` | `error` / `offline` | none |
| Panic-stopped | square with diagonal hatch | `--bh-stop` | `stopped by panic` | none |

The word is always rendered (visually or as `sr-only` text when space is tight, never omitted from the accessibility tree).

### 3.4 Slug line
One line of `meta` type (Martian Mono 12/16, `--bh-ink-2`) under every title. Fields separated by ` · ` (U+00B7 with spaces). Truncate the *middle* of long values (`npub1x7k…q9fz`, `~/code/…/app`) with a CSS/JS middle-ellipsis helper; the full value is in the `title` attribute and a long-press/hover "copy" affordance.

```
reviewer
claude 2.1.4 · workspace · ~/code/app rw · ~/notes ro
```

### 3.5 Segmented meter (budgets)
10 segments (like a VU meter), each `flex:1`, height 6px, gap 2px, radius 1px.
- 0–79%: filled `--bh-ink`; 80–99%: filled segments switch to `--bh-caution`; ≥100%: `--bh-stop` and the label reads `over by $0.42`.
- Always paired with a mono readout: `$3.20 / $5.00 today`.
- `role="meter"` with `aria-valuenow/min/max` and `aria-valuetext="$3.20 of $5.00 used today"`.

### 3.6 Transmission slip (approval card)
The Inbox card (JOURNEYS §2). Two zones divided by a **perforation**: a dashed 1px line (`2 3` dash) with 6px half-circle notches cut into both card edges (CSS `mask` with two radial gradients). Top zone: what is asked. Bottom zone: decision buttons. The notch is the single most recognisable beamhop shape; it also appears in the app icon.

### 3.7 Dot-matrix readout
`Doto` 700, `ROND 0`, ≥28px, tabular. One per screen at most. Uses: Inbox pending count, auto-deny countdown on the focused slip, pairing code, panic "stopped at" time, budget remaining on Agent detail. Always real text (screen readers read it), with `font-variant-numeric: tabular-nums`.

### 3.8 Tick rail
A vertical 1px rule with 4px ticks every message, 8px ticks every minute, used as the timeline gutter in Session view and Audit. Timestamps sit on the rail in `micro` type. Horizontal tick rulers (like a tuning dial) are used as section dividers on Policy and Deploy.

### 3.9 Hatch
45° 1px hatching (`repeating-linear-gradient(45deg, currentColor 0 1px, transparent 1px 6px)`) at 14% opacity marks *locked / not allowed / stopped* areas: always-denied paths (`~/.ssh`), panic band, disabled plan rows. It is the only texture.

### 3.10 App icon & wordmark
- Icon: a flare-orange square (maskable safe zone respected) with an ink transmission-slip notch shape and a single beam line crossing it diagonally. Monochrome variant for iOS 18 tinted icons.
- Wordmark: `beamhop` in Instrument Sans 600, wdth 75, lowercase, letter-spacing -0.02em, followed by a 0.25em flare square (the "carrier" mark) sitting on the baseline: `beamhop■`. The square is `flare-text` in light mode so it passes 3:1.

---

## 4. Colour system

All values live in [`tokens.css`](./tokens.css). Authoring space is **OKLCH**; the hex is the in-gamut sRGB result (all values below were gamut-fitted so browsers render them exactly). Contrast ratios are WCAG 2.x relative-luminance ratios, computed from the hex.

### 4.1 Roles
| Token | Role |
|---|---|
| `bg` | App background (paper / night) |
| `surface` | Cards, sheets, inputs (raised by tone, not shadow) |
| `sunken` | Code blocks, tool output, wells, the tab bar track |
| `line` | Hairlines, dividers (decorative, no contrast requirement) |
| `line-strong` | Input borders, meter tracks, beam lines (≥3:1 non-text, WCAG 1.4.11) |
| `ink` / `ink-2` / `ink-3` | Primary / secondary / tertiary text. **All three pass 4.5:1** on bg, surface and sunken — there is no "too-light grey" text in this system |
| `flare` | The hot signal colour. Primary buttons (fill), live lamp, in-flight pulse, focus in dark |
| `on-flare` | Text/icons on flare fill |
| `flare-text` | Flare used *as text or a thin stroke* on bg/surface (darker in light mode) |
| `flare-wash` | Selected row / current step tint |
| `go`, `on-go`, `go-text`, `go-wash` | Allowed / connected / success |
| `stop`, `on-stop`, `stop-text`, `stop-wash` | Deny / error / panic / destructive |
| `caution`, `on-caution`, `caution-text`, `caution-wash` | Waiting on you / 80% budget / learning-mode suggestion |
| `focus` | Focus ring colour |
| `chart-1…5` | Categorical series (agents, channels) |

**Rule:** in light mode, `flare` (#f6641b) is a *fill-only* colour (2.87:1 on bg). Any flare-coloured text, icon, stroke or small dot uses `flare-text` (#b83b07, 5.27:1). In dark mode both pass.

**Rule:** `go`/`stop` are for decisions and states. They are never used decoratively or for categories.

### 4.2 Light — "Paper"
| Token | OKLCH | Hex | Contrast |
|---|---|---|---|
| bg | `oklch(0.972 0.007 85)` | `#f8f5f1` | — |
| surface | `oklch(0.993 0.004 85)` | `#fefdfa` | — |
| sunken | `oklch(0.945 0.009 85)` | `#efece6` | — |
| line | `oklch(0.885 0.010 80)` | `#ddd8d2` | decorative |
| line-strong | `oklch(0.560 0.012 70)` | `#79736d` | 4.30 bg · 4.57 surface (≥3 ✓) |
| ink | `oklch(0.205 0.012 60)` | `#1b1612` | 16.55 bg · 17.58 surface · 15.27 sunken |
| ink-2 | `oklch(0.430 0.012 60)` | `#554e49` | 7.50 bg · 7.97 surface · 6.92 sunken |
| ink-3 | `oklch(0.520 0.012 65)` | `#6e6862` | 5.09 bg · 5.41 surface · 4.70 sunken |
| flare | `oklch(0.680 0.195 42)` | `#f6641b` | fill only |
| on-flare | `oklch(0.180 0.030 40)` | `#1d0d07` | 6.07 on flare |
| flare-text | `oklch(0.530 0.170 38)` | `#b83b07` | 5.27 bg · 5.60 surface |
| flare-wash | `oklch(0.945 0.030 50)` | `#fee8db` | ink 15.17 · flare-text 4.83 |
| go | `oklch(0.500 0.125 152)` | `#12773d` | 5.21 bg |
| on-go | `oklch(0.990 0.010 150)` | `#f7fef8` | 5.51 on go |
| go-text | `oklch(0.470 0.120 152)` | `#0a6d37` | 5.94 bg · 6.32 surface |
| go-wash | `oklch(0.950 0.035 152)` | `#def6e3` | go-text 5.64 |
| stop | `oklch(0.530 0.195 24)` | `#c3212e` | 5.39 bg |
| on-stop | `oklch(0.990 0 0)` | `#fcfcfc` | 5.68 on stop |
| stop-text | `oklch(0.500 0.190 24)` | `#b71727` | 6.12 bg · 6.50 surface |
| stop-wash | `oklch(0.945 0.025 24)` | `#fde7e5` | stop-text 5.60 |
| caution | `oklch(0.830 0.150 82)` | `#f8bd40` | fill only |
| on-caution | `oklch(0.220 0.030 70)` | `#24180a` | 10.16 on caution |
| caution-text | `oklch(0.500 0.105 70)` | `#895709` | 5.67 bg · 6.02 surface |
| caution-wash | `oklch(0.955 0.045 85)` | `#feefcf` | caution-text 5.39 |
| focus | = flare-text | `#b83b07` | 5.27 bg (≥3 ✓) |

### 4.3 Dark — "Night shift"
Warm near-black (never pure #000 outside high contrast), ink is warm off-white.

| Token | OKLCH | Hex | Contrast |
|---|---|---|---|
| bg | `oklch(0.165 0.008 60)` | `#110e0b` | — |
| surface | `oklch(0.205 0.009 60)` | `#1a1613` | — |
| sunken | `oklch(0.135 0.007 60)` | `#0a0806` | — |
| line | `oklch(0.290 0.010 60)` | `#2f2a26` | decorative |
| line-strong | `oklch(0.580 0.012 70)` | `#7f7973` | 4.49 bg · 4.18 surface (≥3 ✓) |
| ink | `oklch(0.945 0.010 85)` | `#f0ece5` | 16.42 bg · 15.27 surface · 17.05 sunken |
| ink-2 | `oklch(0.760 0.010 80)` | `#b4b0aa` | 8.98 bg · 8.35 surface |
| ink-3 | `oklch(0.660 0.010 75)` | `#96918c` | 6.19 bg · 5.76 surface |
| flare | `oklch(0.720 0.180 45)` | `#fd7933` | 7.29 bg |
| on-flare | `oklch(0.170 0.030 40)` | `#1a0b06` | 7.26 on flare |
| flare-text | `oklch(0.760 0.155 48)` | `#ff8f51` | 8.54 bg · 7.95 surface |
| flare-wash | `oklch(0.255 0.045 45)` | `#351b10` | flare-text 7.07 · ink 13.59 |
| go | `oklch(0.720 0.150 152)` | `#4dbf74` | 8.26 bg |
| on-go | `oklch(0.170 0.030 150)` | `#061308` | 8.15 on go |
| go-text | `oklch(0.760 0.140 152)` | `#63ca84` | 9.49 bg |
| go-wash | `oklch(0.250 0.040 152)` | `#122718` | go-text 7.77 |
| stop | `oklch(0.660 0.190 25)` | `#f05653` | 5.67 bg |
| on-stop | `oklch(0.150 0.030 25)` | `#160605` | 5.81 on stop |
| stop-text | `oklch(0.720 0.170 25)` | `#fd736d` | 7.22 bg |
| stop-wash | `oklch(0.250 0.050 25)` | `#361715` | stop-text 6.09 |
| caution | `oklch(0.830 0.150 82)` | `#f8bd40` | fill |
| on-caution | `oklch(0.200 0.030 70)` | `#1f1306` | 10.62 on caution |
| caution-text | `oklch(0.850 0.140 85)` | `#f8c655` | 12.11 bg |
| caution-wash | `oklch(0.260 0.045 82)` | `#2f2207` | caution-text 9.79 |
| focus | = flare-text | `#ff8f51` | 8.54 bg |

### 4.4 High contrast (light and dark)
Activated by `@media (prefers-contrast: more)` **or** the in-app setting (`data-contrast="more"` on `<html>`). Pure black/white grounds, hairlines become solid ≥7:1, all washes keep ≥7:1 for their text, focus ring becomes ink, 3px.

| Token | HC light | HC dark |
|---|---|---|
| bg / surface | `#ffffff` / `#ffffff` | `#000000` / `#030303` |
| line / line-strong | `#484848` / `#161616` | `#9e9e9e` / `#dedede` |
| ink / ink-2 / ink-3 | `#000000` 21 / `#25211d` 16.0 / `#37322e` 12.7 | `#ffffff` 21 / `#dbd7d0` 14.6 / `#c7c3bd` 12.0 |
| flare (fill) + on-flare | `#942d03` + `#ffffff` (7.96) | `#fda670` + `#000000` (10.86) |
| flare-text | `#892504` (9.04) | `#feb07a` (11.69) |
| go / go-text | `#005126` (9.56) / `#074a24` (10.43) | `#70e093` (12.72) / `#7ee59d` (13.54) |
| stop / stop-text | `#8a0314` (10.0) / `#800613` (10.79) | `#fd968f` (9.98) / `#fda19a` (10.76) |
| caution / caution-text | `#663c08` (9.42 w/ white) / `#613700` (10.24) | `#fed25f` (14.57 w/ black) / same |
| focus | `#000000` | `#ffffff` |

Also under high contrast: hatch opacity 30%, beam-line pulse replaced by node fill, all chips get a 1px `line-strong` border, `ink-3` is never used for anything other than disabled-state text.

### 4.5 Chart palette
Categorical series (agents, channels, peers). Equal lightness so no series dominates; all ≥3:1 against bg/surface (WCAG 1.4.11 graphical objects). Max 5 series; the 6th+ is grouped as "other" in `ink-3`.

| Token | Light | Dark |
|---|---|---|
| chart-1 (ember) | `oklch(0.56 0.130 45)` `#b1582b` 4.52 | `oklch(0.74 0.120 45)` `#e99169` 8.03 |
| chart-2 (cobalt) | `oklch(0.56 0.130 250)` `#2d78bd` 4.28 | `oklch(0.74 0.120 250)` `#6db0f4` 8.41 |
| chart-3 (teal) | `oklch(0.56 0.095 185)` `#12867c` 4.09 | `oklch(0.74 0.120 185)` `#31c3b5` 8.82 |
| chart-4 (plum) | `oklch(0.56 0.130 330)` `#9e5598` 4.60 | `oklch(0.74 0.120 330)` `#d58ecf` 7.92 |
| chart-5 (olive) | `oklch(0.56 0.120 110)` `#797a08` 4.22 | `oklch(0.74 0.120 110)` `#afb151` 8.51 |

Charts never rely on colour alone: series are direct-labelled at line ends / in the bar tooltip, and stacked bars carry a 1px `surface` separator between segments.

### 4.6 Theme switching
- `<html data-theme="light|dark">` set from `prefers-color-scheme` unless the user picks one in Settings → Appearance (System / Paper / Night shift).
- `<html data-contrast="more">` from `prefers-contrast: more` or Settings.
- `<meta name="theme-color">` is updated to `--bh-bg` on theme change (two static metas with `media` for first paint).
- `color-scheme: light dark` on `:root` so form controls and scrollbars match.

---

## 5. Typography

Self-hosted via Fontsource variable packages (no Google CDN; the PWA must work offline and from `localhost`):

```bash
pnpm add @fontsource-variable/instrument-sans @fontsource-variable/martian-mono @fontsource/doto
```
```ts
// apps/pwa/src/main.tsx
import '@fontsource-variable/instrument-sans/wdth.css';   // wght 400–700, wdth 75–100
import '@fontsource-variable/martian-mono/wdth.css';      // wght 100–800, wdth 75–112.5
import '@fontsource/doto/700.css';                        // display numerals only
```

| Family | Why |
|---|---|
| **Instrument Sans Variable** (UI) | A precise grotesk with a *width* axis. Condensed widths (75–90) give instrument-label headings that fit on 375px without wrapping; normal width (100) gives very readable body text. Not overused in AI products. |
| **Martian Mono Variable** (data) | Mono with a width axis: wdth 75 fits ~42 characters of code/diff in a 343px column at 13px; wdth 87.5 for metadata. Its squared, engineered forms carry the instrument character. |
| **Doto** (readouts) | Open-source dot-matrix display face. Used only for the 3.7 readouts — our nod to transmitter displays, used sparingly per Nothing's own lesson. |

Fallback stacks: `"Instrument Sans Variable", ui-sans-serif, system-ui, sans-serif` · `"Martian Mono Variable", ui-monospace, "SFMono-Regular", Menlo, monospace` · `"Doto", "Martian Mono Variable", monospace`.

### 5.1 Scale (rem-based, 1rem = 16px; respects user font size)

| Style | Family | Weight | wdth | Size / Line | Tracking | Use |
|---|---|---|---|---|---|---|
| `readout` | Doto | 700 | — | 48/48 (mobile) 56/56 (desktop) | 0 | Dot-matrix numerals |
| `title-1` | Instrument Sans | 600 | 80 | 28/32 | -0.015em | Screen titles |
| `title-2` | Instrument Sans | 600 | 85 | 22/28 | -0.01em | Section titles, sheet titles |
| `title-3` | Instrument Sans | 600 | 90 | 17/24 | 0 | Card titles, list item titles |
| `body` | Instrument Sans | 400 | 100 | 16/24 | 0 | Body, messages, inputs (**never <16px in inputs** — avoids iOS zoom) |
| `body-strong` | Instrument Sans | 600 | 100 | 16/24 | 0 | Emphasis |
| `body-sm` | Instrument Sans | 400 | 100 | 14/20 | 0 | Secondary descriptions |
| `label` | Instrument Sans | 500 | 95 | 14/20 | 0.005em | Buttons, tabs, form labels |
| `meta` | Martian Mono | 400 | 87.5 | 12/16 | 0 | Slug lines, timestamps, ids, costs |
| `micro` | Martian Mono | 500 | 87.5 | 11/16 | 0.06em, UPPERCASE | Section eyebrows (`PENDING · 3`), tab-bar labels on desktop sidebar |
| `code` | Martian Mono | 400 | 75 | 13/20 | 0 | Code blocks, diffs, logs, tool output |
| `code-inline` | Martian Mono | 400 | 87.5 | 0.875em | 0 | Inline code in messages |

- All numerals: `font-variant-numeric: tabular-nums` on `meta`, `code`, `readout`, meters, tables.
- Message prose (agent output) max measure 68ch on desktop.
- Headings never use all-caps; only `micro` is uppercase.
- At 200% zoom the scale is unchanged (rem); layouts reflow (SCREENS §0).

---

## 6. Space, shape, elevation, layout

### 6.1 Spacing (4px base)
`0, 2, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80` → tokens `--bh-space-0 … --bh-space-12`. Tailwind uses its default `--spacing: 0.25rem`, so `p-4` = 16px matches.

- Screen gutter: **16px** (≤599px), 24px (600–1023), 32px (≥1024).
- List row: min-height 56px (two-line) / 48px (one-line), vertical padding 12px.
- Gap between a title and its slug line: 2px. Between cards: 12px. Between sections: 32px.

### 6.2 Radius
Small radii; this is an instrument, not a toy.

| Token | Value | Use |
|---|---|---|
| `--radius-xs` | 2px | Meter segments, hop bars, chips' inner marks |
| `--radius-sm` | 4px | Chips, badges, inline code, focus ring offset corners |
| `--radius-md` | 8px | Buttons, inputs, segmented controls |
| `--radius-lg` | 12px | Cards, transmission slips, popovers |
| `--radius-xl` | 20px | Bottom sheets (top corners only), the composer pill |
| `--radius-full` | 9999px | Composer, count badges, lamps |

### 6.3 Elevation (tone first, shadow last)
| Level | Treatment | Use |
|---|---|---|
| 0 | `bg` | Page |
| 1 | `surface` + 1px `line` | Cards, list groups, inputs |
| 2 | `surface` + 1px `line` + `--shadow-pop` | Popovers, menus, toasts |
| 3 | `surface` + `--shadow-sheet` + scrim `--bh-scrim` | Bottom sheets, dialogs |
| Dragged | `surface` + `--shadow-lift` + scale 1.02 | Card under the finger |

Shadows are warm (tinted with ink hue 60), never pure black blur. Dark mode shadows are replaced by a 1px `line-strong` top highlight on sheets.

### 6.4 Layout & breakpoints
| Name | Min width | Layout |
|---|---|---|
| `compact` | 0 | Single column, bottom tab bar (5), sheets from bottom |
| `medium` | 600px | Single column, wider gutters, 2-col card grid on Home |
| `expanded` | 1024px | Left sidebar (240px, collapsible to 64px) + list/detail split |
| `wide` | 1440px | Sidebar + list + detail + right Inbox rail (360px) |

- Safe areas: `viewport-fit=cover`; top bar padding-top `env(safe-area-inset-top)`, tab bar padding-bottom `max(8px, env(safe-area-inset-bottom))`, side gutters `max(16px, env(safe-area-inset-left/right))`.
- Viewport meta: `width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content`. On iOS (which ignores `interactive-widget`), the composer uses `visualViewport` resize events to stay above the keyboard (SCREENS §3).
- Use `100dvh` for full-height screens; `100svh` for the onboarding stage so the keyboard never shifts it.

---

## 7. Iconography

**Phosphor Icons** (`@phosphor-icons/react` 2.x), **Regular** weight at 20px (≈1.5px optical stroke), **Bold** for the active tab and destructive confirmations, **Fill** only inside status lamps/badges. Not Lucide (the shadcn default — part of the generic look we're avoiding). Phosphor's slightly geometric, even stroke matches Martian Mono.

- Sizes: 16 (inline with meta), 20 (default), 24 (tab bar), 32 (empty states). Icon-only buttons have a 44×44 hit area regardless of glyph size.
- Icons never stand alone for meaning in lists: icon + label, or icon + `aria-label` + tooltip on desktop.
- Colour: inherits `currentColor`. Only lamps and decision buttons are coloured.

Core mapping (Phosphor names):
| Concept | Icon |
|---|---|
| Home | `Broadcast` |
| Inbox / approvals | `Tray` (badge with count) |
| Sessions | `ChatsTeardrop` |
| Agents | `Cpu` |
| More | `DotsNine` |
| Channels | `Plugs` |
| Harnesses | `Toolbox` |
| Policy / sandbox | `ShieldCheck` (`ShieldWarning` when findings exist) |
| Deploy | `CloudArrowUp` |
| Audit / monitoring | `Pulse` |
| Settings | `SlidersHorizontal` |
| Approve / allow | `Check` |
| Deny | `X` |
| Panic / stop all | `Stop` (square) — never a skull, never a siren |
| Read-only mount | `Eye` / Read-write mount `PencilSimple` |
| Locked/never-readable | `LockSimple` |
| Domain | `Globe` / Path `FolderSimple` |
| Relay | `CellTower` |
| Device | `DeviceMobile` / `Laptop` |
| Undo | `ArrowCounterClockwise` |
| Copy | `Copy` |
| CLI strip | `TerminalWindow` |

**Custom glyphs** (SVG components in `apps/pwa/src/ui/glyphs/`, 20px grid, 1.5px stroke, square caps): `BeamLine`, `HopMeter`, `Lamp`, `Perforation`, `Gate`, `Hatch`.

**Harness and channel marks**: no third-party logos in the UI (trademark and visual-noise reasons). Each harness/channel gets a **mono monogram tile**: 28×28, `radius-sm`, `sunken` bg, Martian Mono 600 wdth 75 11px: `CC` Claude Code · `CX` Codex · `GH` Copilot CLI · `GM` Gemini CLI · `OC` OpenCode · `pi` pi · `AC` generic ACP · `NS` Nostr · `TG` Telegram · `SL` Slack · `DC` Discord. The provider name is always next to it in text.

---

## 8. Motion & gesture

### 8.1 Principles
1. **Direct manipulation is 1:1.** A dragged card follows the finger with no lag or easing; only release animates (Rauno: "apply the gesture's effect immediately").
2. **Interruptible always.** Every animation is a Motion spring that retargets from current velocity; a card can be caught mid-flight.
3. **Commit on release.** Swipe actions that send a decision commit only when the finger lifts past threshold; moving back below threshold cancels.
4. **Frequent = instant.** Tab switches, filters, palette, list selection: no motion (≤80ms opacity at most).
5. **Motion explains space.** Sheets rise from the bottom; detail panes push from the right; a pulse travels the beam line in the direction of the message.
6. **One thing moves at a time** in a given region.

### 8.2 Tokens
Tween durations: `--dur-instant 0ms`, `--dur-fast 120ms`, `--dur-base 200ms`, `--dur-slow 320ms`, `--dur-beam 600ms`.
Easings: `--ease-out cubic-bezier(0.2, 0, 0, 1)`, `--ease-in-out cubic-bezier(0.4, 0, 0.2, 1)`, `--ease-in cubic-bezier(0.4, 0, 1, 1)` (exits only).

Motion springs (`apps/pwa/src/ui/motion.ts`):
```ts
import type { Transition } from 'motion/react';

export const spring = {
  snap:   { type: 'spring', visualDuration: 0.18, bounce: 0 },     // toggles, segmented control thumb, chip select
  settle: { type: 'spring', visualDuration: 0.32, bounce: 0.12 },  // card snapping back, list reorder
  sheet:  { type: 'spring', visualDuration: 0.36, bounce: 0.06 },  // bottom sheet open/close, drawer
  throw:  { type: 'spring', visualDuration: 0.42, bounce: 0.18 },  // swipe card fly-out (velocity-inherited)
  push:   { type: 'spring', visualDuration: 0.28, bounce: 0 },     // detail pane push/pop
} satisfies Record<string, Transition>;

export const reduced: Transition = { type: 'tween', duration: 0.12, ease: [0.2, 0, 0, 1] };
```
Always pass the drag's `velocity` into the fly-out so a card leaves at the angle and speed it was thrown.

### 8.3 Choreography table
| Moment | Motion | Reduced motion |
|---|---|---|
| Sheet open | translateY 100%→0, `sheet`; scrim 0→1 `--dur-base` | opacity 0→1 `reduced`, no translate |
| Detail push (mobile) | x 24px→0 + opacity, `push` | opacity only |
| Swipe card drag | x follows finger; rotate = x/width × 6° (max 6°); stamp opacity = |x|/threshold | follows finger, **no rotation** |
| Swipe commit | fly to ±(width+80) with drag velocity, `throw`; next card scales 0.96→1, `settle` | card fades 120ms; next appears |
| Swipe cancel | back to 0, `settle` | back to 0, `reduced` |
| Undo | the card returns from the edge it left, `settle` | fade in |
| Toast | y 16→0 + opacity, `snap`; exit opacity `--dur-fast` | opacity |
| Beam pulse | segment travels path, `--dur-beam` linear | destination node fills 400ms |
| Live lamp halo | scale 1→2.2, opacity .35→0, 1.6s loop | static ring |
| Streaming text | new tokens appear without animation; caret block `▍` blinks 1s steps(2) | caret static |
| Tool call expand | height auto via `layout`, `snap` | instant |
| Panic armed band | slides down 0→100% height, `snap`; hatch static | instant |
| Skeleton beam sweep | 1px flare-wash line sweeps top→bottom 1.4s | static outlines |
| Number changes (cost, counts) | none — tabular numerals just change | none |

Implementation: wrap the app in `<MotionConfig reducedMotion="user">`; components that use transforms for meaning (swipe rotation, fly-out) also read `useReducedMotion()` and switch to the reduced variant explicitly.

### 8.4 Gestures (all have button equivalents — see JOURNEYS for each)
| Gesture | Where | Threshold | Equivalent |
|---|---|---|---|
| Swipe right / left | Inbox slip, learning-mode suggestion | commit at 35% of card width **or** velocity ≥ 600 px/s with ≥ 15% travel; horizontal intent locked after 10px if |dx| > |dy|×1.5 | Allow / Deny buttons (always visible), keys `A` / `D` |
| Swipe row (partial) | Session list, device list | reveal at 64px, full-swipe disabled for destructive actions (iOS `allowsFullSwipe: false` pattern) | Row `…` menu |
| Horizontal swipe | Session view, between sessions of same agent | 30% or 500 px/s; edge 24px reserved for browser back | Prev/next arrows in header, `[` / `]` |
| Pull to refresh | Home, Harnesses | 72px with rubber-band (resistance 0.5) | Refresh button in header overflow; auto-refresh on focus |
| Long-press (500ms) | Inbox slip → details; slug value → copy | — | "Details" button; copy icon |
| Drag to dismiss | Bottom sheets | 25% height or 800 px/s down | Close button (top-right, 44px), `Esc` |
| Drag reorder | Relay priority, route order | — | Up/Down buttons per row + "Move to…" (WCAG 2.5.7) |

Vertical scroll always wins: horizontal swipe engages only after intent lock. Gestures use `touch-action: pan-y` on swipeable cards so native scroll keeps working.

### 8.5 Haptics
A `haptic(kind)` helper:
- **Android/Chromium**: `navigator.vibrate(pattern)` when available and the user setting "Haptics" (default on) is enabled.
- **iOS Safari 18+**: the `<input type="checkbox" switch>` toggle side-effect technique (a visually hidden switch inside a `<label>` clicked programmatically within the user gesture). Feature-detect; treat as best effort; respects the system haptics setting. iOS ignores `navigator.vibrate` (https://github.com/mdn/browser-compat-data/issues/29166, https://swmansion.com/blog/haptic-feedback-on-the-web-why-the-web-deliberately-refuses-to-be-as-tactile-as-native-apps).
- Never haptic on scroll, on streaming, or more than once per 120ms.

| Kind | Pattern (ms) | Fired when |
|---|---|---|
| `tick` | `8` | Swipe crosses commit threshold (each direction, once) |
| `confirm` | `12` | Allow committed; pairing success; round-trip success |
| `reject` | `[6, 40, 6]` | Deny committed |
| `warn` | `[20, 60, 20]` | Panic armed/executed; budget hit 100% while app open |
| `error` | `[30, 50, 30]` | Validation failed on submit |

---

## 9. Component inventory

All built on **React Aria Components** (RAC). Styling via Tailwind v4 utilities against the tokens, using RAC's render-prop/data-attribute states (`data-hovered`, `data-pressed`, `data-focus-visible`, `data-selected`, `data-disabled`, `data-invalid`). **Required states for every interactive component:** default, hovered (pointer only), pressed, focus-visible, disabled, and where relevant selected, invalid, pending (busy).

**Focus ring (global):** 2px `--bh-focus` outline, 2px offset, radius follows component; HC: 3px. Never removed. Focus is never obscured by the sticky tab bar or top bar (WCAG 2.4.11): scroll containers use `scroll-padding-top/bottom` = bar heights.

### 9.1 Actions
| Component | RAC | Spec |
|---|---|---|
| **Button / primary** | `Button` | h-48 (mobile) / h-40 (desktop pointer: fine), px-20, `radius-md`, `label`, bg `flare`, text `on-flare`. Pressed: bg mixes 12% ink, scale .98 (`snap`). Pending: label replaced by 3 hop bars animating in sequence + `aria-busy`, width locked. One primary per view. |
| **Button / secondary** | `Button` | bg `surface`, 1px `line-strong`, text `ink`. |
| **Button / quiet** | `Button` | no bg, text `ink`, underline on hover. For tertiary actions. |
| **Button / allow** | `Button` | bg `go`, text `on-go`, icon `Check` bold. Only in decision contexts. |
| **Button / deny** | `Button` | bg `surface`, 1.5px `stop-text` border, text `stop-text`, icon `X` bold. (Deny is outlined so Allow and Deny differ in shape, not just hue.) |
| **Button / destructive** | `Button` | bg `stop`, text `on-stop`. Delete agent, destroy deploy, stop all. |
| **Icon button** | `Button` | 44×44 hit area, 20px glyph, `aria-label` mandatory, desktop tooltip (`TooltipTrigger`, 600ms delay). |
| **Hold button** | custom on `Button` | *Not used.* Hold-to-confirm is a timing gesture; we use explicit confirm steps instead. |
| **Link** | `Link` | `ink`, underline 1px offset 3px; external links append `ArrowUpRight` 14px and open in a new tab with `rel="noopener"`. Deep links to provider portals (BotFather, Slack, Discord) use this. |
| **Copy field** | `TextField` readOnly + `Button` | mono value, middle-truncate, copy button → label morphs to "Copied" for 1.5s, live region polite. |

### 9.2 Containers & feedback
| Component | Spec |
|---|---|
| **Card** | `surface`, 1px `line`, `radius-lg`, padding 16. Pressable cards use RAC `GridList` items or a full-card `Link` with nested interactive elements excluded. |
| **Transmission slip** | §3.6. 343×auto on mobile; desktop max 560px. States: resting, dragging (lift shadow), committing (stamp visible), committed (gone), undo-restoring, expired (hatched, "Auto-denied at 10:14"), decided-elsewhere ("Allowed by alice on laptop", fades after 2s). |
| **Bottom sheet** | RAC `Modal` + `Dialog`, `radius-xl` top, grabber 36×4 `line-strong`, max-height 92dvh, `sheet` spring. Desktop ≥1024 renders as centered dialog 560px or as a right-side pane, per screen spec. Focus trapped; Esc closes; scrim click closes non-destructive sheets only. |
| **Popover / Menu** | RAC `Popover` + `Menu`, level 2 elevation, items 44px min, section headers in `micro`. |
| **Toast** | One region (`UNSTABLE_ToastRegion` or custom `role="status"` region) at bottom above tab bar; 343px; `surface` + level 2; icon + text + optional action (Undo). Undo toasts show a 2px beam line that shrinks over the undo window. Auto-dismiss 5s (undo) / 4s (info); errors persist until dismissed. Never steals focus; `F6`/`⌘.` moves focus to toast on desktop. |
| **Banner (inline)** | Full-width strip, `*-wash` bg, 1px top/bottom `line`, icon + one sentence + action. Used for offline, panic, catalog update, ToS warnings. |
| **Panic band** | Sticky at top of every screen while panicked: `stop-wash` with hatch, Stop glyph, "Everything is stopped · since 10:42" (Doto time on Home only), "Review & resume" button. |
| **Connection pill** | In top bar: hop meter + `3/4 relays` or `local`. Tap → Connection sheet. |
| **Empty state** | Left-aligned. 32px custom glyph or a mini beam-line diagram, `title-3` headline, one sentence `body-sm ink-2`, one primary or secondary action, and the CLI strip. No illustration art. |
| **Skeleton** | Hairline outlines (1px `line`) of the expected layout + one flare-wash sweep line. Shown only if loading exceeds 300ms; min display 400ms to avoid flicker. |
| **Error panel** | `stop-wash` left rule 3px `stop-text`, title "Couldn't reach relay.damus.io", cause, next action buttons, `Copy details` (copies error code + JSON). |
| **CLI strip** | Collapsible `Disclosure`: header `TerminalWindow` + "CLI" `micro`; body `sunken` with `code` text and copy button. Default collapsed; remembers state per user. |

### 9.3 Inputs
| Component | Spec |
|---|---|
| **TextField** | Label above (`label`), input h-48, `surface`, 1px `line-strong`, `radius-md`, body 16px. Description below (`body-sm ink-2`). Invalid: border `stop-text` 1.5px + icon + message (`stop-text`), `aria-invalid`, message linked via `aria-describedby`. Validation runs on blur and on paste; secrets show "Saved to keychain" `go-text` with `LockSimple` after save, never the value again. |
| **Secret field** | TextField `type=password`, `autocomplete="off"`, `spellcheck=false`, show/hide toggle, paste button (Clipboard API where allowed). Live format check (e.g. Telegram token regex) shows a hop-meter-style "format ✓" before the network check. |
| **Search** | RAC `SearchField`, leading `MagnifyingGlass`, clear button 44px. |
| **Switch** | RAC `Switch`, track 44×26, thumb 22, `snap`. Off: `sunken` + `line-strong` border; on: `ink` track (not flare — flare is reserved for live). Label left, switch right; whole row pressable. |
| **Segmented control** | RAC `ToggleButtonGroup` (single). h-40, `sunken` track, selected thumb `surface` + 1px `line-strong`, `snap`. Used for ro/rw, Allow scope, chart breakdown. |
| **Chip (domain/path)** | RAC `TagGroup` + `Tag`. h-32 (hit area 44 via padding), `radius-sm`, mono `meta`, 1px `line-strong`. Variants: allowed (`go-wash` + `go-text` `Check` 12px), blocked (`stop-wash`), suggested (`caution-wash` dashed border), locked (`hatch`, `LockSimple`, not removable). Remove button inside chip, `aria-label="Remove registry.npmjs.org"`. |
| **Select / ComboBox** | RAC `Select` / `ComboBox`; on compact renders the list in a bottom sheet. |
| **Path picker** | ComboBox with server-side directory completion from the daemon (`fs.list` RPC, only under `$HOME`), recent paths, and a "Browse" sheet (breadcrumb + folder list). Shows git badge (`GitBranch`) for git repos (worktree behaviour §6A.5). |
| **Slider/stepper** | Budgets use a **NumberField** with stepper buttons (not a slider; precise values, no drag dependency). |
| **Checkbox / Radio** | RAC, 24px box inside 44px row. Radio cards for profile choice (strict/workspace/custom). |
| **Code/diff viewer** | `sunken`, `code` type, line numbers `ink-3`, added lines `go-wash` with `+` gutter in `go-text`, removed `stop-wash` with `−`; horizontal scroll within block only (`overflow-x:auto`, `tabindex=0`, `role="region"` + label); wrap toggle. |
| **Composer** | Pill `radius-full`, `surface`, 1px `line-strong`, min-h 48, auto-grows to 6 lines; leading `+` (attach) 44px, trailing send (flare circle 40px). While the agent streams, send becomes **Stop** (square, `ink`) and a secondary "Steer" mode label appears. Slash commands (§6A.7) autocomplete in a popover above. |

### 9.4 Navigation
| Component | Spec |
|---|---|
| **Tab bar (compact)** | 5 items: Home, Inbox, Sessions, Agents, More. h-56 + safe area. Icons 24, labels 11px `label`. Active: Phosphor Bold + ink + 2px flare bar above the icon (width 20). Inbox badge: `flare` fill, `on-flare` text, mono 11, min 18px. `role="tablist"` is *not* used (it is navigation): `nav` + links with `aria-current="page"`. |
| **Top bar** | h-52 + safe area. Left: back (44) or screen title (`title-2`, truncated); right: connection pill + 1–2 icon buttons. Large title (`title-1`) collapses into the bar on scroll for top-level screens. |
| **Sidebar (expanded)** | 240px, `bg`, right hairline. Wordmark, agent quick-switch, nav groups with `micro` headers (OPERATE: Home, Inbox, Sessions · CONFIGURE: Agents, Channels, Harnesses, Policy · RUN: Deploy, Audit · Settings), connection + panic at bottom. Collapses to 64px icon rail. |
| **Command palette** | `⌘K`/`Ctrl K`, RAC `Autocomplete` in a `Modal`; instant (no motion). Commands mirror CLI verbs ("agent stop reviewer", "channel add telegram", "panic"). |
| **Breadcrumb** | Desktop detail panes: `Agents / reviewer / Policy`. |
| **Stepper rail** | Wizards and onboarding: a beam line with numbered nodes (`01 … 06`), current node flare, done nodes ink filled + `Check`, future hollow. `aria-label="Step 3 of 6: Identity"`; announced on change. |

### 9.5 Data display
Agent card, session row, harness row, channel row, device row, audit event row, usage chart (stacked bars, line), security event list, plan diff table, log stream. Each specified in SCREENS.md. Shared rules: title (`title-3`) + slug line (`meta`) + right-aligned state lamp; rows are RAC `GridList` items (keyboard-navigable, row actions reachable).

---

## 10. State voices: empty, loading, error, offline

| Situation | Pattern | Example copy |
|---|---|---|
| Empty (first time) | What this is + one action + CLI | **No channels yet.** Connect Telegram, Slack or Discord so people can reach your agents there. Nostr DMs already work. `[Add channel]` · CLI `beamhop channel add telegram` |
| Empty (cleared) | Calm acknowledgement, no celebration | **Inbox clear.** Nothing is waiting on you. New requests arrive here and as notifications. |
| Empty (filtered) | Say the filter | **No security events in the last 24 h** for reviewer. `[Show 7 days]` |
| Loading <300ms | Nothing | — |
| Loading >300ms | Skeleton with beam sweep | — |
| Long operation | Concrete progress line | `Installing bubblewrap… 2 of 3` / `cloud-init: installing harnesses (claude, codex) · 1m 12s` |
| Error, recoverable | What happened · why · what now | **Couldn't validate the token.** Telegram said the token is not valid (401). Copy it again from @BotFather — it looks like `123456:ABC…`. `[Paste again]` |
| Error, not ours | Name the party | **Slack is not responding.** Socket Mode connection dropped 3 times in 2 min. beamhop will keep retrying every 30 s. `[Retry now]` `[Status page]` |
| Offline | Banner, cached data stays usable | **Offline.** Showing what was cached at 10:31. Approvals you make now are sent when you're back online — or you can approve from any Nostr client. |
| Reconnecting | Connection pill only, no banner for <10s | `▂▄·· 2/4 relays` |
| Permission denied (role) | Who can do it | **Only owners can change the sandbox.** You're an admin on reviewer. Ask alice or bob. |

---

## 11. Microcopy: voice & tone

**Voice**: a calm, competent radio operator. Short sentences. Verbs first on buttons. Exact nouns from the spec (agent, harness, channel, sandbox, mount, relay, approval, session) — never synonyms like "bot", "assistant", "workspace AI", except "bot" when talking about a provider's bot account (Telegram bot).

**Rules**
1. Buttons say the outcome: `Allow once`, `Deny`, `Stop everything`, `Add Telegram`, not `OK`, `Submit`, `Continue` (except "Continue" in multi-step flows where the next step name is shown beside it: `Continue · Identity`).
2. Numbers are exact and unit-ful: `$0.42`, `3 sessions`, `14 min left`, `2/3 hops`. Times are local `10:42` with the date when not today; relative only under 1 hour (`4 min ago`).
3. Security copy states the reach, then the risk, then the choice: "reviewer wants to reach **registry.npmjs.org**. It's not in the sandbox allowlist. Allowing lets this session download packages from npm."
4. The agent is named; the app is not a person. "reviewer is waiting for you", never "I need your approval" from the app.
5. No exclamation marks. No "please" in errors (it reads as pleading). "Please" is fine in a request to the user to act in a third-party UI ("In @BotFather, send /newbot").
6. Never blame: "The token didn't work" not "You entered an invalid token".
7. Always label AI: agent profiles and previews say "AI agent operated by {owner}" (§1 AI disclosure).
8. Destructive confirms name the thing and the consequence: **Delete reviewer?** Its config and identity are removed from this daemon. Transcripts are kept until retention ends (30 days). `[Delete reviewer]` `[Cancel]`.

**Examples**
| Context | Copy |
|---|---|
| Push notification (approval) | **reviewer · needs approval** — Run `git push origin beamhop/842`? Auto-denies at 10:57. |
| Push (budget) | **reviewer hit 80% of today's budget** — $4.00 of $5.00. |
| Push (crash) | **ci-bot stopped unexpectedly** — Exit code 137 on fly-ams-1. Tap to see logs. |
| Slip countdown | `Auto-denies in 12:40` → under 2 min: `Auto-denies in 1:52` (caution) |
| Undo toast | `Allowed · git push` `[Undo]` (bar shrinks 5s) |
| Decided elsewhere | `Already allowed by bob on Laptop` |
| Learning mode | **3 hosts were blocked this week.** reviewer tried them during 5 sessions. Review them one by one. |
| Panic confirm title | **Stop everything?** |
| Panic body | Kills 5 sessions, pauses 3 schedules, disconnects 4 channels, and tells 2 cloud daemons to do the same. Nothing restarts until you resume. |
| Panic done | **Everything is stopped.** 2 of 2 cloud daemons confirmed. |
| Resume | **Resume after review** — Check what was running before you bring it back. |
| Doctor fix | `socat` is missing. Run `sudo apt install socat` or let beamhop run it for you. |
| Harness needs login | **Codex needs a login.** Run `codex login` in a terminal, then check again. |
| Subscription auth warning | Some subscription plans don't allow use on servers or by other people. Read Anthropic's terms before you continue. `[Read terms ↗]` |
| DLP block | **Message blocked.** reviewer's reply to alice contained something that looks like an AWS key. It was not sent. `[See redacted message]` |
| Unknown sender | **npub1qz…8k4 asked to talk to helpdesk.** They're not on the allowlist. `[Allow as viewer]` `[Ignore]` |
| Hop limit | **reviewer and summarizer hit the 6-turn limit** in thread 842. A person needs to reply before they continue. |
| Install prompt (iOS) | **Install beamhop for notifications.** iPhone only sends approval alerts to installed apps. Tap Share, then *Add to Home Screen*. |
| Push permission pre-prompt | **Get approvals on this phone?** You'll be notified when an agent needs a decision, a budget runs out, or an agent stops. Nothing else. `[Turn on notifications]` `[Not now]` |

i18n: all strings in `apps/pwa/src/i18n/en.json` with ICU plurals (`{count, plural, one {# session} other {# sessions}}`); no string concatenation; mono values are interpolated, never translated.

---

## 12. Accessibility commitments (design-level)

- WCAG 2.2 AA throughout; contrast tables in §4 are the proof for colour.
- **2.5.1 Pointer Gestures / 2.5.7 Dragging**: every swipe, long-press, pull and drag has a single-pointer, non-path alternative visible on the same screen (Allow/Deny buttons, Details button, Refresh, Up/Down reorder, Close). (https://www.w3.org/WAI/WCAG22/Understanding/pointer-gestures, https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements)
- **2.5.8 Target Size**: our floor is 44×44 (AA requires 24×24 or spacing). Inline links in prose are the only exception (inline exception). (https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum)
- **2.4.11 Focus Not Obscured**: scroll-padding for sticky bars; sheets move focus into themselves.
- **3.3.7 Redundant Entry**: wizards never ask twice (bot name from validation is reused; agent name prefilled from preset).
- **3.3.8 Accessible Authentication**: pairing never requires transcribing a code if a QR/deep link is possible; manual code entry allows paste; the safety-phrase comparison is a *match* check, not recall.
- Live regions: one polite (`#bh-live-polite`) for streaming status summaries, toasts, copy confirmations; one assertive (`#bh-live-assertive`) only for panic and approval auto-deny in under 60s. Streaming tokens are **not** announced token by token: the session announces "reviewer is responding" then the complete message when it finishes, or every 10s a "still working: running tests" progress line.
- Motion: §8.3 reduced variants; nothing flashes >3/s.
- Zoom: 200% and 400% (reflow at 320 CSS px) without horizontal scroll except inside code blocks.
- Language: `lang="en"` and per-message `lang` when the harness reports it.
