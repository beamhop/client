# beamhop — Screen Specs

> Visual rules: [`DESIGN.md`](./DESIGN.md). Flows & gestures: [`JOURNEYS.md`](./JOURNEYS.md). Values: [`tokens.css`](./tokens.css).
> Wireframes: mobile drawn at 375px (~40 chars), desktop at ≥1024px. Wireframe glyph key:
> `●` live lamp · `○` stopped · `◐` needs you · `■` error · `▂▄▆█` hop meter · `▮▮▮▮▮▯▯▯▯▯` segmented meter · `──●──` beam line · `┄┄┄` perforation · `////` hatch · `[Button]` primary · `(Button)` secondary · `‹ ›` icon buttons · `micro` text in CAPS.

---

## 0. App shell

### 0.1 Routes (TanStack Router)
```
/                      Home
/inbox                 Inbox            /inbox/$approvalId
/sessions              Sessions list    /sessions/$sessionId
/agents                Agents list      /agents/$name  /agents/$name/$section  /agents/new
/channels              Channels         /channels/add  /channels/add/$provider/$step  /channels/$id
/harnesses             Harnesses
/policy                Policy (profiles + findings)   /policy/$profile
/deploy                Deploy           /deploy/new   /deploy/$deploymentId
/audit                 Audit            ?tab=usage|security|log
/settings              Settings         /settings/$section
/setup/$step           Onboarding
/pair                  Device pairing (hosted PWA)
/panic                 Panic sheet (deep-linkable; manifest shortcut)
```
Mobile "More" (`/more`) lists Channels, Harnesses, Policy, Deploy, Audit, Settings, plus `Stop everything`.

### 0.2 Mobile shell (compact <600)
```
┌──────────────────────────────────────┐ ← env(safe-area-inset-top)
│ Home                     ▂▄▆█ 3/4  ■ │ top bar 52px: title · connection pill · Stop
├──────────────────────────────────────┤
│ //// Everything is stopped · 10:42 › │ panic band (only when panicked)
│                                      │
│              (screen)                │ scroll root: data-scroll-root
│                                      │
├──────────────────────────────────────┤
│  ⌂      ▭³      ◫      ▣      ⋯     │ tab bar 56px + safe-area-bottom
│ Home  Inbox  Sessions Agents  More   │ active: bold icon, 2px flare bar above
└──────────────────────────────────────┘
```
- Top bar: large title (`type-title-1`) on top-level screens collapses into the 52px bar after 24px scroll. Secondary screens show `‹ Back` + `type-title-3` title.
- Tab bar bg: `bg` at 92% + 12px blur (the only blur); top hairline `line`.
- Toast region: bottom, 8px above tab bar. Sheets cover the tab bar.
- Offline banner sits under the top bar (caution-wash).

### 0.3 Desktop shell (expanded ≥1024)
```
┌────────────────┬───────────────────────────┬──────────────────────────────────────────┐
│ beamhop■       │ LIST PANE (360px)         │ DETAIL PANE (fluid, max 880 content)     │
│ ⌘K Search…     │                           │ Agents / reviewer / Sandbox              │
│                │                           │                                          │
│ OPERATE        │                           │                                          │
│ ⌂ Home         │                           │                                          │
│ ▭ Inbox     3  │                           │                                          │
│ ◫ Sessions     │                           │                                          │
│ CONFIGURE      │                           │                                          │
│ ▣ Agents       │                           │                                          │
│ ⇌ Channels     │                           │                                          │
│ ⚒ Harnesses    │                           │                                          │
│ ⛨ Policy    •  │                           │                                          │
│ RUN            │                           │                                          │
│ ☁ Deploy       │                           │                                          │
│ ∿ Audit        │                           │                                          │
│ ⚙ Settings     │                           │                                          │
│                │                           │                                          │
│ ▂▄▆█ 3/4 relays│                           │                                          │
│ (■ Stop all)   │                           │                                          │
└────────────────┴───────────────────────────┴──────────────────────────────────────────┘
 240px sidebar (collapsible to 64px rail, ⌘\)
```
- Wide (≥1440): a 360px **Inbox rail** docks on the right of every screen except Inbox itself; collapsible.
- Screens without a natural list (Home, Audit Usage, Settings sections) use a single detail pane (max content width 960px, left-aligned with 32px gutter).
- Keyboard: `g h` Home, `g i` Inbox, `g s` Sessions, `g a` Agents, `⌘K` palette, `⌘⇧.` panic, `?` shortcuts.

### 0.4 Responsive & zoom rules
- At 200% zoom, desktop collapses to the compact shell automatically (breakpoints are in rem).
- No horizontal page scroll at 320 CSS px; tables become stacked rows; code/diff scroll inside their own region.
- Hit targets ≥ 44px on compact; ≥ 32px height allowed on `pointer: fine` for dense desktop lists, with ≥ 8px separation (passes 2.5.8).

---

## 1. Home

**Purpose**: what's running, what needs me, is anything wrong. Pull-to-refresh (+ Refresh in overflow).

### Mobile
```
┌──────────────────────────────────────┐
│ Home                     ▂▄▆█ 3/4  ■ │
│                                      │
│ NEEDS YOU · 3                     →  │ micro eyebrow, row → Inbox
│ ┌──────────────────────────────────┐ │
│ │◐ reviewer · git push origin b…  │ │ compact slip preview (1 line)
│ │  Auto-denies in 12:40  (Deny)[✓]│ │ inline Deny / Allow-once
│ └──────────────────────────────────┘ │
│ + 2 more                             │
│                                      │
│ AGENTS · 4                           │
│ ┌──────────────────────────────────┐ │
│ │ CC reviewer                ● live│ │ monogram · name · lamp+word
│ │ claude 2.1.4 · workspace · local │ │ slug line
│ │ tg:group/-100123 ──●── reviewer  │ │ beam line (pulse when in flight)
│ │ "running tests…"   thread 842 6m │ │ last activity (ink-2)
│ │ ▮▮▮▮▮▮▯▯▯▯ $3.20 / $5.00 today   │ │ segmented budget meter
│ └──────────────────────────────────┘ │
│ ┌──────────────────────────────────┐ │
│ │ CX ci-bot             ● ready    │ │
│ │ codex 0.9 · strict · fly-ams-1   │ │
│ │ slack:#deploys ──── ci-bot       │ │
│ │ idle 2 h          ▮▮▯▯▯▯▯▯▯▯ $1.1│ │
│ └──────────────────────────────────┘ │
│ ┌──────────────────────────────────┐ │
│ │ GM helpdesk           ◐ learning │ │
│ │ gemini 1.3 · custom · local      │ │
│ │ 14 blocked requests logged  →    │ │
│ └──────────────────────────────────┘ │
│                                      │
│ SIGNALS                              │
│ ■ 3 security events today          → │
│ ◐ Policy: 2 findings               → │
│ ○ Catalog updated · 6 harnesses      │
│                                      │
│ (+ New agent)                        │
└──────────────────────────────────────┘
```
- Agent card tap → agent's latest session (live) or Agent detail if none. Overflow `…` on card: Open detail, New session, Stop agent, Move to cloud.
- Card order: live → needs you → error → ready → stopped; ties by last activity.
- Medium: 2-column card grid. "Needs you" strip becomes a horizontal row of up to 3 compact slips.
- Empty (no agents): beam-line diagram `you ──── relays ──── (agent)` with "Create your first agent" + preset rows + CLI strip `beamhop agent add`.

### Desktop
```
┌ sidebar ┬──────────────────────────────────────────────────────────────────────────────┐
│         │ Home                                                         ▂▄▆█ 3/4 relays │
│         │                                                                               │
│         │ NEEDS YOU · 3                                   AGENTS · 4                   │
│         │ ┌───────────────────────────┐  ┌─────────────────────┐ ┌─────────────────────┐│
│         │ │◐ reviewer  git push …     │  │ CC reviewer  ● live │ │ CX ci-bot  ● ready  ││
│         │ │  12:40   (Deny) [Allow]   │  │ slug · beam · meter │ │ slug · beam · meter ││
│         │ │◐ ci-bot   fetch npm…      │  └─────────────────────┘ └─────────────────────┘│
│         │ │◐ helpdesk read ~/.npmrc   │  ┌─────────────────────┐ ┌─────────────────────┐│
│         │ └───────────────────────────┘  │ GM helpdesk ◐ learn │ │ OC scribe  ○ stopped││
│         │ SIGNALS                         └─────────────────────┘ └─────────────────────┘│
│         │ ■ 3 security events today                                                    │
│         │ ◐ 2 policy findings            THIS MONTH  $12.40  ▮▮▮▮▯▯▯▯▯▯ of $40 budgets │
└─────────┴──────────────────────────────────────────────────────────────────────────────┘
```
Left column 400px (Needs you + Signals), right fluid card grid (2–3 columns, min card 300px).

---

## 2. Inbox

### Mobile — stack
```
┌──────────────────────────────────────┐
│ Inbox                    03 PENDING  │ Doto "03"
│ [All] (reviewer) (ci-bot) (High risk)│ filter chips (TagGroup, single select)
│                                      │
│ ┌──────────────────────────────────┐ │
│ │ APPROVAL · #a41f        HIGH     │ │
│ │ reviewer · tg:group/-100123      │ │
│ │ thread 842 · from Alice (user)   │ │
│ │                                  │ │
│ │ Run a shell command              │ │ type-title-3
│ │ ┌──────────────────────────────┐ │ │
│ │ │ git push origin beamhop/842  │ │ │ code, sunken
│ │ └──────────────────────────────┘ │ │
│ │ ▏The agent says: "pushing the    │ │ untrusted quote, ink-2
│ │ ▏fix so CI can run"              │ │
│ │ Requested after a message from   │ │ caution note (injection hint)
│ │ Alice (user)                     │ │
│ │                                  │ │
│ │ Auto-denies in  12:40            │ │ Doto countdown
│ │ ○ 0 of 1 owners                  │ │
│ ◖┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄◗ │ perforation + notches
│ │ (✕ Deny)   (Details)  [✓ Allow…] │ │ 48px buttons; HIGH → "Allow…"
│ └──────────────────────────────────┘ │
│  └────────────────────────────────┘  │ next slip peeking (scale .96)
│   └──────────────────────────────┘   │ (scale .92)
│                                      │
│ Swipe right to allow, left to deny.  │ hint, shown first 3 visits, ink-3
└──────────────────────────────────────┘
```
- Slip max-height: viewport − chrome; content scrolls inside the top zone if long (the decision zone never scrolls away).
- Allow scope sheet:
```
┌──────────────────────────────────────┐
│ ▬                                    │ grabber
│ Allow git push?                      │
│ ◉ Allow once                         │
│ ○ Allow for this session (thread 842)│
│ ○ Always allow for user on reviewer  │
│   ┌────────────────────────────────┐ │
│   │ + approvals.auto: bash:git push│ │ diff appears when selected
│   └────────────────────────────────┘ │
│                                      │
│ [✓ Allow once                      ] │ label tracks selection
│ (Cancel)                             │
└──────────────────────────────────────┘
```
- Undo toast: `Allowed once · git push        (↶ Undo)` with a 2px shrinking line along its top edge.
- Waiting-on-others section and "Decided recently (24 h)" collapsed list below the stack (for audit-at-a-glance).
- Empty: `Inbox clear.` + last decision line + `Notification settings` link.

### Desktop — list/detail
```
┌ sidebar ┬─────────────────────────────┬──────────────────────────────────────────────┐
│         │ Inbox            03 PENDING │ APPROVAL · #a41f · HIGH        Auto-denies in │
│         │ (All)(reviewer)(High risk)  │ reviewer · tg:group/-100123     12:40         │
│         │ ┌─────────────────────────┐ │                                              │
│         │ │◐ reviewer · git push   ●│ │ Run a shell command                          │
│         │ │  HIGH · 12:40           │ │ git push origin beamhop/842                  │
│         │ ├─────────────────────────┤ │                                              │
│         │ │◐ ci-bot · fetch registry│ │ CONTEXT                                       │
│         │ │  ELEVATED · 8:02        │ │ Alice: can you push the fix?   10:28          │
│         │ ├─────────────────────────┤ │ reviewer: tests pass, pushing… 10:29          │
│         │ │◐ helpdesk · read .npmrc │ │                                              │
│         │ │  LOW · 14:51            │ │ POLICY  user → bash:git push = ask            │
│         │ └─────────────────────────┘ │ ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ │
│         │ J/K move · A allow · D deny │ (✕ Deny  D)   (Details ↵)   [✓ Allow…  ⇧A]   │
└─────────┴─────────────────────────────┴──────────────────────────────────────────────┘
```

---

## 3. Session

### Mobile
```
┌──────────────────────────────────────┐
│ ‹  reviewer          ● live    ‹ › ⋯ │ prev/next session buttons
│ tg:group/-100123 ──●── reviewer      │
│ claude 2.1.4 · thread 842 · $0.38 6m │
├──────────────────────────────────────┤
│10:28┤ Alice · user · telegram        │ tick rail with times
│     │ can you fix the login redirect │
│     │ and push it?          ⓘ header │
│     │                                │
│10:28┤ reviewer                       │
│     │ Looking at the auth flow first.│ agent prose — never hidden
│     ├ ✓ Read src/auth.ts       0.1s  │ tool row
│     ├ ✓ Grep "redirect" 4 hits 0.2s  │
│     │ The redirect drops the `next`  │
│     │ param. Fixing it in two places.│
│     ├ ✓ Edit 2 files  +14 −3   ▸     │ tap → diff
│10:29├ ▂▄▆ Bash npm test        0:42  │ running: live tail below
│     │   ✓ auth.test.ts (12)          │ code, ink-3, last lines
│     │   … 214 passing                │
│     │ ◐ APPROVAL  git push origin …  │ inline mini-slip
│     │   (✕ Deny)          [✓ Allow…] │
│     │ ▍                              │ streaming caret
├──────────────────────────────────────┤
│ ▂▄▆ running tests… 0:42              │ progress strip
│ ┌──────────────────────────────────┐ │
│ │ +  Steer reviewer…            ■  │ │ composer; ■ = Stop while live
│ └──────────────────────────────────┘ │
└──────────────────────────────────────┘ (tab bar hidden in session on compact;
                                          back returns to previous tab)
```
- Diff sheet (full-height):
```
┌──────────────────────────────────────┐
│ ▬  Changes · 2 files · +14 −3   Wrap │
│ src/auth.ts                 +9 −2  ▾ │
│  41   const next = req.query.next    │
│  42 − res.redirect('/')              │ stop-wash
│  42 + res.redirect(safeNext(next))   │ go-wash
│ src/util/url.ts             +5 −1  ▸ │
│ [Open PR]  (Merge into main)         │ only for git mounts at session end
└──────────────────────────────────────┘
```
- Overflow `⋯`: Show tool details (`/details`), New session (`/new`), Mode (plan/auto/read-only), Model, Copy session link, Export transcript, Stop agent hard.

### Sessions list (mobile)
Rows grouped by agent (sticky `micro` headers): lamp · title (first user message, 1 line) · slug `tg:group · thread 842 · 6m · $0.38` · right: time. Filters: `Live · Needs you · Today · All`. Row partial swipe-left reveals `Stop` (no full-swipe); row `⋯` same.

### Desktop
Three regions: Sessions list (360) · Transcript (fluid, max 760 prose) · **Inspector** (320, collapsible, `⌘I`): session facts (harness, mode, model, worktree, mounts, budget meter), Files changed list, Approvals in this session, Usage this session.

---

## 4. Agents

### 4.1 Agents list
Mobile: same card as Home but denser (no beam line), plus `+ New agent` primary at top-right. Desktop: list pane rows (monogram · name · lamp · slug) + detail pane.

### 4.2 Agent detail (mobile)
```
┌──────────────────────────────────────┐
│ ‹  reviewer                       ⋯  │ ⋯: Clone, Move to cloud, Stop hard, Delete
│ CC  ● live · local                   │
│ AI agent operated by alice           │
│ npub1x7k…q9fz · reviewer@example.com │ slug (copy on long-press / copy icon)
│                                      │
│ BUDGET TODAY                         │
│ $1.80 left                           │ Doto readout
│ ▮▮▮▮▮▮▯▯▯▯ $3.20 / $5.00             │
│                                      │
│ [Overview][Setup][Sandbox][Channels]›│ scrollable tab list (RAC Tabs)
│ ──────────────────────────────────── │  [Schedules][Budgets][Identity]
│ (section content)                    │
└──────────────────────────────────────┘
```
Sections (each also a route `/agents/$name/$section`; desktop shows them as a left sub-nav inside the detail pane):

**Overview**: live sessions (rows), last 5 sessions, behaviour files found in mounts (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`) with `Open in editor` (§6A.2 — opens a full-screen Markdown editor with save diff), memberships summary, CLI strip `beamhop agent show reviewer`.

**Setup** (harness, model, mounts, concurrency):
```
HARNESS
┌──────────────────────────────────────┐
│ CC Claude Code 2.1.4      ● ready  ▾ │ Select (only ready/needs-login listed)
└──────────────────────────────────────┘
Model   (default ▾)   switchable via /model within role limits

MOUNTS
┌──────────────────────────────────────┐
│ ⎇ ~/code/app          [RO|■RW]   ⋯  │ git badge; segmented mode
│   Each session gets branch beamhop/… │
├──────────────────────────────────────┤
│ ▢ ~/notes             [■RO|RW]   ⋯  │
└──────────────────────────────────────┘
(+ Add folder)                          path picker sheet

CONCURRENCY   Max sessions  [ − 3 + ]   Idle timeout [ − 30 min + ]
```
Mount `⋯`: Move up/down, `parallel_unsafe` (with warning), Remove.

**Sandbox** (& roles): embeds the Policy editor scoped to this agent (§7 below): reach summary, findings, profile, files, network, env, roles matrix, routes, learning mode toggle.

**Channels** (memberships & triggers):
```
┌──────────────────────────────────────┐
│ NS nostr:dm               default: viewer ▾ │
│    Triggers: every allowlisted DM    │
├──────────────────────────────────────┤
│ TG telegram:group/-100123  user ▾    │
│    Triggers [✓ mention] [✓ reply]    │ checkbox chips (§6A.4)
│    Public: off                       │
└──────────────────────────────────────┘
(+ Join a channel)
ROUTES   nostr:dm ──→ slack:#deploys  ⋯
MESH     Trust list: 2 allowed · 1 blocked ›   Hop limit [6 turns] [3 hops]
         Per-peer budget [ 20k tokens/day ]
PUBLIC   [ ] Answer unknown senders as viewer (strict sandbox, rate limits, DLP)
```

**Schedules**: rows `cron · 0 9 * * 1-5 · Europe/Berlin → slack:#standup` with next run time in mono; `+ Add schedule` sheet: kind segmented `Cron | Webhook | File change | Nostr event`; cron gets a human preview ("Every weekday at 09:00 Berlin time") and next 3 runs; prompt textarea; target channel select; owner (whose role/budget applies §6A.4).

**Budgets**: NumberFields: daily USD, per-session minutes, tokens/day, per-role overrides table (stacked rows on mobile), alert thresholds (80/100 chips). Usage mini-chart (7 d).

**Identity**: npub (copy), kind-0 profile fields (name, about — prefilled "AI agent operated by alice"; AI label is fixed and not removable), NIP-05 handle (link to Settings → Identity for domain setup), owner attestation status `Signed by alice · 12 Nov`, relay list (NIP-65) with hop meter and reorder buttons, capability card (NIP-89) preview.

### 4.3 New agent
Same form as onboarding step 05 (JOURNEYS §1) as a full-screen route; presets row first; `Create reviewer` primary; exposure summary live.

### Desktop
List pane (agents) + detail pane with a 200px section sub-nav on the left of the detail; forms max 640px wide; the reach summary pins to the right on ≥1280 while editing Sandbox.

---

## 5. Channels (+ wizards)

### List (mobile)
```
┌──────────────────────────────────────┐
│ Channels                     [+ Add] │
│ ┌──────────────────────────────────┐ │
│ │ NS Nostr            ● 3/4 relays │ │
│ │ DMs (NIP-17) · 2 groups (NIP-29) │ │
│ ├──────────────────────────────────┤ │
│ │ TG @reviewer_alice_bot  ● ready  │ │
│ │ long-poll · 1 DM · 2 groups      │ │
│ ├──────────────────────────────────┤ │
│ │ SL acme · beamhop      ■ error   │ │
│ │ Token rejected (401) · Replace › │ │
│ └──────────────────────────────────┘ │
│ CLI ▸                                │
└──────────────────────────────────────┘
```
Channel detail: status + transport + last event time, memberships (which agents, chats), owner pairings, `Replace token`, `Disconnect`, `Remove channel` (destructive confirm). Nostr detail: relay list with per-relay latency + NIP-11 check status, `+ Add relay`, Blossom servers.

### Add — provider picker
```
┌──────────────────────────────────────┐
│ ‹  Add a channel                     │
│ TG Telegram                        › │
│    Bot token · 2 min                 │
│ SL Slack                           › │
│    App from manifest · 4 min         │
│ DC Discord                         › │
│    Developer Portal · 4 min          │
│ NS Nostr group (NIP-29)            › │
│ ⧉  Plugin channel…                 › │ third-party plugins (§2)
└──────────────────────────────────────┘
```

### Wizard step (mobile) — Telegram step 05 Pair
```
┌──────────────────────────────────────┐
│ ✕  Add Telegram               5 / 6  │
│ ●──●──●──●──◉──○                     │ stepper rail (beam line)
│ PAIR                                 │
│ Link your Telegram account as owner  │ type-title-2
│                                      │
│ [ Open @reviewer_alice_bot  ↗      ] │ deep link ?start=pair-7KQ29XHD
│                                      │
│ Or send this to the bot:             │
│ ┌──────────────────────────────────┐ │
│ │ /pair 7KQ2-9XHD             ⧉    │ │ copy field; code Doto-styled
│ └──────────────────────────────────┘ │
│ Code expires in 9:41                 │
│                                      │
│ ▂▄▆ Waiting for you in Telegram…     │ polite live region
│                                      │
│ CLI ▸ beamhop channel pair mybot     │
└──────────────────────────────────────┘
```
- Steps 03 Validate / 04 Connect resolve in place on the Credentials screen ("✓ Valid · @reviewer_alice_bot", "✓ Connected · long-polling"), then advance after 600 ms. Auto-advance only happens if focus is still on the field or the Continue button the user last touched; otherwise a visible `Continue · Pair` waits. When the step changes, focus moves to the new step heading and the polite region announces "Step 5 of 6: Pair" (no unexpected context change, WCAG 3.2.2).
- Desktop: wizard is a 720px centered pane over the Channels list; the stepper rail is vertical on the left (labels visible).

---

## 6. Harnesses

```
┌──────────────────────────────────────┐
│ Harnesses               (⟳ Scan)     │
│ Catalog v2026.11.12 · signed ✓       │ slug
│ ┌──────────────────────────────────┐ │
│ │ CC Claude Code   2.1.4   ● ready │ │
│ │    ACP ✓ · API key via broker    │ │
│ ├──────────────────────────────────┤ │
│ │ CX Codex         0.9.1 ◐ login   │ │
│ │    Run: codex login  ⧉ (Check)   │ │
│ ├──────────────────────────────────┤ │
│ │ GM Gemini CLI    —   ○ not inst. │ │
│ │    (Install…)                    │ │
│ ├──────────────────────────────────┤ │
│ │ pi pi            0.4  ■ unsupp.  │ │
│ │    Needs ≥0.5 · Update…          │ │
│ └──────────────────────────────────┘ │
│ REMOTE · fly-ams-1                   │ cloud daemons' scans (§3.1.5)
│ │ CX Codex 0.9.1 ● ready           │ │
│ (+ Add ACP agent)                    │
└──────────────────────────────────────┘
```
Row tap → detail: binary path, version range supported, launch mode, capabilities from ACP `initialize` (as chips), config dir, agents using it. `Install…` sheet: detected package managers with commands + copy; `Run in terminal` when the daemon can spawn it. Pull-to-refresh = scan.
Desktop: table-like list (columns: harness, version, mode, status, used by) in the list pane; detail on right.

---

## 7. Policy

### Mobile
```
┌──────────────────────────────────────┐
│ Policy · reviewer          ▾ agent   │ agent switcher (or "All profiles")
│                                      │
│ REACH                                │
│ Reads    ~/code/app  ~/notes         │ path chips (mono)
│ Writes   ~/code/app (branch/session) │
│ Talks to api.anthropic.com github.com│
│          *.githubusercontent.com +3 ›│
│ Never    //// ~/.ssh ~/.aws ~/.config│ hatched, lock icons
│          /gh keychains browsers ///  │
│ Secrets  placeholders · broker adds  │
│          Anthropic API key           │
│                                      │
│ FINDINGS · 2                         │
│ ◐ Wildcard *.githubusercontent.com   │
│   allows any repo's raw files        │
│   (Narrow to raw.githubusercontent…) │
│ ◐ viewer can run Bash without asking │
│   (Require approval)                 │
│                                      │
│ PROFILE                              │
│ ○ strict   ◉ workspace   ○ custom    │ radio cards (stacked on compact)
│                                      │
│ FILES ›  NETWORK ›  ENV ›  ROLES ›   │ section rows → sub-screens
│ ROUTES ›  LEARNING MODE  [ off ]     │
├──────────────────────────────────────┤
│ 2 changes            [Review & save] │ sticky save bar when dirty
└──────────────────────────────────────┘
```
Network sub-screen:
```
│ ALLOWED                              │
│ [✓ api.anthropic.com ✕] [✓ github.com ✕]│ chips: go-wash, remove button inside
│ [✓ registry.npmjs.org ✕]             │
│ ┌──────────────────────────────────┐ │
│ │ Add host, *.domain or URL     [+]│ │
│ └──────────────────────────────────┘ │
│ SUGGESTED (learning)                 │
│ [? pypi.org  14× · Review]           │ dashed caution chips → triage
│ ALWAYS BLOCKED  //// 127.0.0.0/8     │
│ 169.254.169.254 (cloud metadata) ////│
```
Roles (compact): accordion per role; inside, each action row has a segmented `Auto | Ask | Deny`.
Review sheet: plain-language diff list + `YAML` tab with code diff; primary `Widen access` or `Save`.

### Desktop
Detail pane two columns: left 560px editor sections stacked (Files, Network, Env, Roles matrix as a real table with role columns, Routes), right 360px sticky **Reach summary + Findings**. Roles matrix uses a RAC `Table` with segmented cells; arrow keys move between cells.

---

## 8. Deploy

### List
Rows: monogram (`HZ` `DO` `FL` `RN` `RW`) · `reviewer @ hetzner fsn1` · lamp (heartbeat `● 12 s ago`) · slug `cx22 · €4.51/mo · beamhopd 1.4.2`. Primary `+ New cloud agent`; empty state explains both entry points (§10).

### New / Move wizard (mobile)
Steps rail: `01 Provider · 02 Size · 03 Harness & auth · 04 Mounts · 05 Plan · 06 Apply`.
Plan screen:
```
┌──────────────────────────────────────┐
│ ‹  Move reviewer to Hetzner    5 / 6 │
│ PLAN                                 │
│ + create  server cx22 · fsn1   €4.51 │ go-text symbol + word
│ + create  firewall · outbound only   │
│ + install beamhopd srt claude 2.1.4  │
│ ~ move    identity → remote vault    │ caution-text
│ ~ keep    ANTHROPIC_API_KEY local    │
│ → clone   ~/code/app (git)           │
│ → copy    ~/notes · 1.2 GB once      │
│ - stop    local reviewer             │ stop-text
│ ──────────────────────────────────── │ tick ruler
│ Estimated            €4.51/mo        │ type-title-2, mono numerals
│ + bandwidth · billed by Hetzner      │
│                                      │
│ [ Deploy · €4.51/mo               ]  │
│ (Copy plan as CLI)                   │
└──────────────────────────────────────┘
```
Apply screen: phase list on tick rail with lamps and durations; `Logs ▾` disclosure (code, autoscroll, `Pause`); `You can leave this screen` note.

### Deployment detail
Topology beam line (`you ── relays ── reviewer@fsn1`), heartbeat, versions (beamhopd, harnesses; `Update to 1.4.3…` confirm per §12), cost this month, logs, `Stop`, `Destroy…` (plan of deletions + type-to-confirm).

### Desktop
Wizard as a two-column page: left steps form (640), right sticky **Plan preview** that updates live as choices change, with cost readout at the top.

---

## 9. Audit / Monitoring

Segmented at top: `Usage · Security · Log` (URL `?tab=`).

### Usage (mobile)
```
┌──────────────────────────────────────┐
│ Audit            [Usage|Security|Log]│
│ THIS MONTH                           │
│ $12.40                               │ Doto
│ ▮▮▮▯▯▯▯▯▯▯ of $40 budgets · ▲ $3.10  │
│ (Today)(7 d)[30 d](Custom)           │
│ By [Agent|Channel|Peer|Day]          │
│ ┌──────────────────────────────────┐ │
│ │   ▆                         ▆    │ │ stacked bars, chart-1..5
│ │ ▄ █ ▂ ▄ ▆ ▂ ...           ▄ █ ▂  │ │
│ └──────────────────────────────────┘ │
│ 1 Nov                        30 Nov  │
│ ■ reviewer   $7.80  1.2M tok  62%    │ legend = data rows
│ ■ ci-bot     $3.10  0.6M tok  25%    │
│ ■ helpdesk   $1.50  0.2M tok  12%    │
│ (View as table)                      │
└──────────────────────────────────────┘
```
Tooltip card docks above the chart on tap. 

### Security
Category chips, spike sparkline row per category (24 h), event rows with lamp + sentence + slug + action buttons (JOURNEYS §6). Alerts settings link at top-right (`Alert rules ›`).

### Log
Search + filter sheet (agent, actor, type, date range), virtualized rows: time (mono) · actor · verb · object; tap → event detail (JSON in code block, related session link, signature status for signed role changes). `Export` (JSONL/CSV) and `Purge…` in overflow.

### Desktop
Usage: chart full width (height 280), breakdown table below with sortable columns. Security: list/detail. Log: full-width table with column filters; detail in right inspector.

---

## 10. Settings

Sections (list on mobile; sub-nav on desktop): **Devices · Identity & NIP-05 · Notifications · Retention & data · Appearance · Updates · Plugins · Stop everything · About**.

**Devices**
```
│ THIS DEVICE                          │
│ ▯ iPhone · Safari      push on       │
│   paired 13 Nov · now                │
│ OTHER DEVICES                        │
│ ▭ MacBook · Firefox    ⋯             │
│   paired 12 Nov · last seen 4 min    │
│ ▯ Pixel · Chrome  ◐ inactive 94 d ⋯  │
│ (+ Pair a device)                    │
```
`⋯`: Rename, Remove (confirm sheet).

**Identity & NIP-05**: owner npub (copy, `Export backup`, backup status), co-owners/admins list per agent (signed role changes, `Add owner` with npub field; at least one owner remains — last owner's remove button is disabled with explanation), NIP-05 setup: domain field → generated `nostr.json` (code block + copy + download) → hosting tabs `Static host · nginx · Cloudflare Pages` with snippets → `Check handle` (resolves live: `✓ reviewer@example.com resolves to npub1x7k…`).

**Notifications**: push status for this device + test; per-alert-type toggles; quiet hours; Nostr DM fallback toggle.

**Retention & data**: transcripts (default 30 days) and audit log (1 year) NumberField+unit per agent; "Encrypted at rest · key in keychain" note; `Export all data`; `Purge…` (agent select + before date + type agent name).

**Appearance**: Theme `System | Paper | Night shift`; Contrast `System | More`; Motion `System | Reduced`; Haptics on/off; Text size follows system (note).

**Updates**: beamhop version + `Update available 1.4.3 · Install…` (explicit confirm §12); catalog auto-update status; cloud daemons version list with update/rollback status.

**Plugins**: installed third-party plugins with integrity hash (mono), permissions list, `Remove`.

**Stop everything**: explanation + `Stop everything` destructive button + last panic history.

---

## 11. Onboarding

### Mobile (375)
```
┌──────────────────────────────────────┐
│ beamhop■                    3 of 6   │
│ ●───●───◉───○───○───○                │ stepper rail
│ IDENTITY                             │
│ Who owns these agents?               │ type-title-1
│ Your owner key signs every change    │ body-sm ink-2
│ you make. Agents get their own keys. │
│                                      │
│ ┌──────────────────────────────────┐ │
│ │ ◉ Create a new owner key         │ │ radio card
│ │   Stored in your OS keychain.    │ │
│ ├──────────────────────────────────┤ │
│ │ ○ Use my Nostr extension (NIP-07)│ │
│ ├──────────────────────────────────┤ │
│ │ ○ Connect a bunker (NIP-46)      │ │
│ └──────────────────────────────────┘ │
│ Profile name  [ alice            ]   │
│                                      │
│ CLI ▸                                │
│ [ Continue · Phone                 ] │ sticky bottom, safe-area
│ (Back)                               │
└──────────────────────────────────────┘
```
Step 06 Hello:
```
┌──────────────────────────────────────┐
│ ●───●───●───●───●───◉   HELLO        │
│ Say hello from your phone            │
│                                      │
│  reviewer                            │
│     │                                │
│     ●─ relay.damus.io   ✓ 82 ms      │ vertical beam line on compact
│     ●─ nos.lol          ✓ 64 ms      │
│     ●─ relay.primal.net ✓ 91 ms      │
│     │                                │
│  your phone        ◐ waiting 0:14    │
│                                      │
│ Reply to reviewer's message on your  │
│ phone. Any text works.               │
│ (Resend)  (Open in another client)   │
└──────────────────────────────────────┘
```
Success state replaces the bottom copy: **It works.** `Phone → 3 relays → reviewer → back · 4.2 s` + `[Go to Home]` + Next-steps rows.

### Desktop
```
┌───────────────────────┬──────────────────────────────────────────────────┐
│ beamhop■              │ 04  PHONE                                        │
│                       │ Pair your phone                                  │
│ ●  01 Doctor          │                                                  │
│ │                     │ ┌──────────────┐   1  Scan with your phone camera │
│ ●  02 Harnesses       │ │  ▓▓ ▓ ▓▓ ▓▓  │   2  Check the 4 words match     │
│ │                     │ │  ▓ ▓▓▓  ▓ ▓  │   3  Allow notifications         │
│ ●  03 Identity        │ │  ▓▓ ▓ ▓▓▓ ▓  │                                  │
│ │                     │ └──────────────┘   Expires in 1:58                │
│ ◉  04 Phone           │ (Show code instead) (Copy link)                  │
│ ┆                     │                                                  │
│ ○  05 Agent           │                                    (Skip for now)│
│ ┆                     │                                                  │
│ ○  06 Hello           │                                                  │
└───────────────────────┴──────────────────────────────────────────────────┘
 Vertical stepper rail 280px; content max 640px, left-aligned.
```

---

## 12. Cross-cutting screen states (implement for every screen)

| State | Treatment |
|---|---|
| Loading > 300ms | Hairline skeleton of that screen's layout + beam sweep |
| Empty | DESIGN §10 pattern: glyph/beam diagram + headline + one sentence + one action + CLI strip |
| Error (load failed) | Error panel in place of content, `Retry`, `Copy details`; cached data stays visible above if present (`Showing data from 10:31`) |
| Offline | Caution banner under top bar; mutating actions either queue (approvals, stop) or disable with reason |
| Remote (hosted PWA via Nostr) | Connection pill shows relays; slower actions show pending `·` until ACK |
| Read-only (non-owner role) | Editors render as read views with "Only owners can …" line; no disabled-button soup |
| Panicked | Panic band; agent lamps hatched; start/resume actions route to Review & resume |
| Standalone (installed) | Hide install hints; `display-mode: standalone` variant; status bar colour from `--bh-theme-color` |
