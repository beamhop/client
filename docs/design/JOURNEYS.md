# beamhop — User Journeys

> Companion to [`DESIGN.md`](./DESIGN.md) (visual language, components, motion) and [`SCREENS.md`](./SCREENS.md) (layouts).
> Every gesture listed here has an accessible, single-pointer, non-path alternative on the same screen (WCAG 2.5.1, 2.5.7). Keyboard shortcuts apply when a hardware keyboard is present (`pointer: fine` or a `keydown` has been seen).
> "Daemon" = `beamhopd`. "RPC" = the zod-typed JSON-RPC API (§2), over local WS or Nostr control events.

Contents
1. First-run onboarding
2. Approvals inbox (triage)
3. Live session view
4. Add a channel (Telegram, Slack, Discord)
5. Policy & sandbox editor (incl. learning mode)
6. Monitoring: usage, security events, alerts
7. Cloud deploy (move to cloud / new cloud agent)
8. Kill switch: panic and resume
9. Device pairing and removal (incl. install + push)

---

## 1. First-run onboarding

**Goal**: in ~3 minutes (§9A), go from `npx beamhop` to a verified round-trip: the owner's phone receives a Nostr DM from their first agent, replies, and sees the agent answer. The user should finish *understanding* the chain: sandbox → agent → relay → phone.

**Entry points**
- `npx beamhop` with no config → TUI wizard, which prints: `Open the setup in your browser: http://localhost:7337/setup  (or continue here)`. Both drive the same daemon state machine (`onboarding.*` RPC), so a user can start in the terminal and finish in the browser, or vice versa.
- Opening the local PWA on a daemon with no owner identity → redirects to `/setup`.
- Opening the hosted PWA (app.beamhop.dev) on a phone without pairing → "Pair with your computer" (journey 9), not the full wizard.

**Layout**: desktop-first (this runs on the computer that hosts the daemon), but fully usable at 375px. A **stepper rail** (beam line with six nodes `01 DOCTOR · 02 HARNESSES · 03 IDENTITY · 04 PHONE · 05 AGENT · 06 HELLO`) sits at the left on expanded, at the top (compact, nodes only + current label) on mobile. Done nodes fill ink; current node is flare; the beam segment between them lights up as each step completes. Each step is a URL (`/setup/doctor` …) so reload/back work; state is resumable.

### Steps

**01 Doctor**
1. Auto-runs on entry. Each check is a row that resolves live: `srt runtime`, `bubblewrap`, `socat`, `ripgrep`, `user namespaces (AppArmor)`, or on macOS `Seatbelt`, on Windows `WSL2`. Row: lamp + name + version in mono + result.
2. Failing rows expand inline: what's missing, *why beamhop needs it* (one line: "bubblewrap isolates the agent's filesystem"), and the exact fix command in a copy field. If the daemon can fix it (`doctor --fix` with sudo prompt in the terminal), a `Fix in terminal` button triggers it and the row shows `Waiting for your password in the terminal…`.
3. AppArmor case gets a two-option explanation: "Allow for bwrap only (recommended)" with the profile snippet, or "Turn off restriction system-wide" (secondary, with the trade-off stated).
4. `Continue · Harnesses` is enabled when all *required* checks pass. Optional warnings (e.g., Windows alpha) don't block; they show a caution banner.
- Edge: running in a container without namespaces → explains "the container is the filesystem boundary; network allowlist and broker still apply" (§7 PaaS note) and continues with a caution lamp.

**02 Harnesses**
1. Scan runs (`harness.scan`); results stream in as rows: monogram tile, name, version, status lamp `ready` / `needs login` / `not installed` / `unsupported version`.
2. `needs login`: row shows the exact login command (`claude login`, `codex login`) with copy, plus `Check again`. We don't embed third-party login flows here.
3. `not installed`: `Install` opens a sheet with the package manager options detected (`npm i -g @openai/codex`, `brew install …`), copy buttons, and `Check again`.
4. `Add ACP agent…` (quiet button) → command field + `Test handshake`.
5. Continue requires ≥1 `ready` harness. If none: the primary becomes `Install Claude Code` (or the first catalog entry for the OS) — no dead end.

**03 Identity**
1. Two radio cards: **Create a new owner key** (default; "Stored in your OS keychain. You can export it later.") and **Use an existing Nostr key** → NIP-07 extension (if `window.nostr` is present, shown first) or NIP-46 bunker URL (`bunker://…` field with paste).
2. On create: shows the npub as a slug (middle-truncated, copy), a profile name field (prefilled from OS username), and a disclosure "What's this key for?" (signs role changes and control messages; agents get their *own* keys).
3. Backup prompt is *offered*, not forced: `Export backup now` / `Later` (a Settings reminder is scheduled; a caution dot appears on Settings until done).

**04 Phone**
1. Large QR (min 240px, quiet zone 4 modules, ink on surface) encoding `https://app.beamhop.dev/pair#<token>` (token in the fragment so it never reaches a server log). Under it: `Expires in 1:58` (Doto readout, counts down), `Show code instead` (8-char base32 code for manual entry), `Copy link`.
2. Phone scans → opens hosted PWA → phone shows device name field (prefilled "iPhone · Safari") and a **4-word safety phrase**. The computer simultaneously shows the same phrase with `Does your phone show: AMBER · RELAY · OTTER · NINE?` → `Yes, pair this phone` / `No, cancel`. (Defends against the QR-phishing that hijacked Signal linked devices; confirmation happens on the trusted device.)
3. On confirm: phone becomes a device key on the control allowlist; the phone flows into install + push (journey 9 steps 4–6). The computer shows `Paired · iPhone · Safari` and, if push was granted on the phone, `Notifications on`.
4. `Skip for now` is allowed (quiet button) — step 06 then uses "Reply from any Nostr client" with the agent's npub as the fallback.

**05 Agent**
1. Preset row (segmented cards): **Personal assistant**, **Code reviewer (read-only)**, Team dev bot, Public Q&A bot (§1 Presets). Choosing one pre-fills the rest.
2. Fields: Name (prefilled from preset, e.g. `reviewer`), Harness (only `ready` ones; default the first), Folder (path picker; **mode defaults to read-only**, segmented `Read-only | Read-write`; choosing RW on a git repo shows "Each session gets its own branch `beamhop/<thread>`"), Sandbox profile (`workspace` for owner; plain summary below: "Can read and write ~/code/app · Can reach 6 domains (Anthropic API, GitHub, npm) · Never ~/.ssh, ~/.aws, keychains").
3. A live **exposure summary** box under the form updates as fields change (same component as Policy, journey 5).
4. `Create reviewer` → daemon creates agent + keypair; the card shows its npub and the generated kind-0 profile preview ("reviewer · AI agent operated by {owner}").

**06 Hello (round-trip)**
1. Big beam-line diagram: `reviewer ──● relay.damus.io ●── nos.lol ●── primal ──── your phone`.
2. beamhop sends a NIP-17 DM "Hi, I'm reviewer. Reply with anything to check the connection." Each relay node fills as it ACKs (`OK` from the relay), with ms latency in mono beneath. The pulse travels to the phone.
3. Status line: `Waiting for your reply… 0:14`. On the phone (if paired) the DM appears in the PWA session view and as a push.
4. When the reply arrives, the pulse travels back, the agent's answer streams in the transcript preview, and the screen resolves: **It works.** "Your phone → 3 relays → reviewer → back, in 4.2 s." Haptic `confirm` on the phone.
5. Edge: no relay ACK in 10 s → that node turns to a square error lamp with reason; if all three fail → error panel with "Check your network or add a relay" and a relay field. Reply not received in 2 min → `Still waiting. Did the message arrive on your phone?` with `Resend`, `Open in another Nostr client` (npub copy), and `Finish without testing`.

**07 Next steps** (summary screen): three rows, not cards: `Add Telegram, Slack or Discord` · `Set up a NIP-05 handle on your domain` · `Move reviewer to the cloud`. Primary: `Go to Home`.

**Success criteria**
- Median time to step 06 success ≤ 3 min with harness already logged in.
- 0 dead ends: every failing state has a fix, an alternative or a skip.
- User can answer afterwards "what can my agent read?" (tested in usability sessions).

**Research that informed it**
- Stepper with resumable URL-addressed steps and progress visible at all times: standard wizard practice; the beam-line rail makes progress also explain the architecture.
- Pairing confirmation on the trusted device + device naming, due to linked-device QR phishing campaigns: https://attack.mitre.org/techniques/T1676 , https://www.pcrisk.com/internet-threat-news/34624-ghostpairings-stealthy-abuse-of-whatsapps-device-linking
- Ask for permissions in context with purpose text first (push is asked on the phone after pairing, with a purpose screen): https://developer.apple.com/design/human-interface-guidelines/privacy , https://developer.apple.com/documentation/uikit/requesting-access-to-protected-resources
- WCAG 3.3.8 Accessible Authentication: QR/link instead of transcribing codes; paste allowed.

---

## 2. Approvals inbox (triage)

**Goal**: decide on agent permission requests (§3.2 Approvals) quickly, correctly and from anywhere, with a short undo window, without ever making a "wider than intended" decision by accident.

**Entry points**: Web Push notification tap (deep link `/inbox/<id>`), Inbox tab (badge count), Home "Needs you" strip, Session view inline approval, wide-desktop right rail, Nostr DM fallback (`/approve <id>` in any client — the PWA reflects decisions made elsewhere).

### Data on each slip (transmission slip, DESIGN §3.6)
Top zone:
- `micro` eyebrow: `APPROVAL · #a41f` + risk tier tag (`LOW` / `ELEVATED` / `HIGH`) — tier comes from policy (e.g. network to new domain = elevated; `git push`, write outside mount, deploy, spending > budget = high).
- Agent + session slug: `reviewer · telegram:group/-100123 · thread 842 · from Alice (user)`.
- **What**: plain-language sentence first, raw second. "Run a shell command" then a `code` block `git push origin beamhop/842`. For file writes: path + mini-diff (first 6 lines, `+3 −1`). For network: domain chip + "first time this agent asked".
- **Why** (if the harness supplied it): the agent's own justification, quoted, labelled "The agent says" (untrusted text styling: `ink-2`, left rule).
- Countdown: `Auto-denies in 12:40` (Doto on the focused slip only), caution under 2 min.
- N-of-M: `1 of 2 owners approved` with two tick boxes and names.
Perforation.
Bottom zone (decision):
- `Deny` (outlined stop) · `Details` (quiet) · `Allow once` (go fill). Buttons 48px tall, full width split 1:auto:1.
- For ELEVATED/HIGH: `Allow…` (opens the scope sheet) instead of `Allow once`.

### Flow (mobile)
1. Inbox shows a **stack**: the top slip fully visible, the next two peeking 8px/16px below (scaled .96/.92), count readout in the header `03 PENDING` (Doto numerals). Filter chips: `All · reviewer · ci-bot · High risk`.
2. **Swipe right = allow once** (LOW tier only). **Swipe left = deny once** (all tiers). As the card moves, a stamp label fades in on the card corner (`ALLOW ONCE` in go / `DENY` in stop, mono 600, 2px border, rotated -8°), background behind the card tints `go-wash` / `stop-wash`, and a `tick` haptic fires when crossing the threshold (35% width or 600 px/s fling with ≥15%).
3. **Swipe right on ELEVATED/HIGH** does not commit: the card springs back and the **scope sheet** opens (the gesture becomes "I want to allow → choose how"). Rationale: reversible/lightweight actions may complete on gesture, consequential ones need an explicit choice (Rauno's commit-on-release principle; iOS `allowsFullSwipe:false` for destructive actions).
4. **Scope sheet** (Allow): radio list mirroring iOS "Allow Once / While Using" and Little Snitch's lifetime + scope:
   - `Allow once` (default)
   - `Allow for this session` (until session ends)
   - `Always allow for {role} on {agent}` → shows the exact policy rule that will be added as a diff (`+ network.allow: registry.npmjs.org`) and the scope choice `this host` / `*.npmjs.org` (domain vs host, like Little Snitch).
   - Primary button text tracks the choice: `Allow once` / `Allow for session` / `Add rule & allow`.
5. **Deny** can optionally carry a reason back to the agent: after a deny commits, the undo toast includes `Add reason` → quick chips (`Not now`, `Use a read-only approach`, `Ask me in the thread`) or free text; sent as part of the "denied" result so the harness can adapt (§3.2 "the agent is told").
6. **Undo**: every decision is held by the daemon in a 5 s *commit window* before it is released to the harness. Toast: `Allowed once · git push [Undo]` with a shrinking 2px beam line. Undo returns the slip to the top of the stack from the edge it left. After the window, Undo is gone; the decision is in Audit.
7. **Long-press (500 ms) or `Details`** → full-height sheet: complete command/diff, files touched, the session transcript excerpt around the request (last 3 messages), policy rule that caused "ask", who else can decide, and the same decision buttons pinned at the bottom.
8. When the stack is empty: "Inbox clear." + last decision summary `Last: allowed git push · 10:41 · undo expired`.

### Desktop / keyboard
- List + detail: left list of slips (compact rows), right detail with full content and decision bar. `J/K` move, `A` allow once, `Shift+A` scope sheet, `D` deny, `Enter` details, `Z` or `⌘Z` undo, `R` add reason. Shortcut hints appear in button tooltips and in a `?` sheet.
- Wide (≥1440): Inbox lives in a persistent right rail while you browse sessions.

### Accessible alternatives
- Buttons are always visible; swipe is an accelerator only (WCAG 2.5.1).
- Screen readers: each slip is a `group` labelled "Approval from reviewer: Run a shell command, git push origin beamhop/842, high risk, auto-denies in 12 minutes". Buttons are in DOM order Deny, Details, Allow. The countdown is not announced continuously; at 60 s left an assertive "Approval a41f auto-denies in 1 minute" fires once.
- Decision results announce politely: "Allowed once. Undo available for 5 seconds." Undo is reachable by Tab (the toast is in the tab order right after the stack) and by `Z`.
- Reduced motion: no rotation, no fly-out; slip fades, next slip appears.

### Edge cases
- **Decided elsewhere** (another owner, a Nostr `/approve`, or the laptop): slip shows `Allowed by bob on Laptop · 10:42` for 2 s, then leaves; no undo for decisions you didn't make.
- **Expired**: hatched slip `Auto-denied at 10:14 — the agent was told.` with `Allow if asked again` (adds a session-scoped pre-approval) and `Dismiss`.
- **Offline**: decisions queue locally (IndexedDB + Background Sync); slip shows `Queued · sends when online`; if the request expires before sync, the queued decision is dropped and the user is told.
- **N-of-M**: after your approval, slip stays with `Waiting for 1 more owner` and moves to a "Waiting on others" section; Undo still works within 5 s.
- **Burst** (>20 pending from one agent): a group header `ci-bot · 23 requests · Pause ci-bot` offers stopping the agent instead of triaging.
- **Identical requests**: slips with identical (agent, action, target) collapse into one with `×4`; one decision applies to all, and the scope sheet suggests `Allow for this session`.
- **Prompt-injection hint**: if the request arrives right after untrusted input from a non-owner, a caution note "Requested after a message from Alice (user)" appears in the Why area.

**Success criteria**: median decision time < 4 s for LOW; 0 accidental "always" rules (they require the sheet); undo used without errors; all actions possible with VoiceOver/TalkBack and keyboard only.

**Research that informed it**
- Superhuman mobile swipe + triage bar, customizable swipes: https://help.superhuman.com/hc/en-us/articles/38458431506067-Customizing-Swipes-and-Triage-Bar
- Linear: undo for almost every operation, ⌘Z, returns you to the context: https://linear.app/changelog/undo-actions
- iOS Mail full vs partial swipe; SwiftUI `allowsFullSwipe` opt-out for destructive edges: https://developer.apple.com/tutorials/data/documentation/swiftui/view/swipeactions(edge:allowsfullswipe:content:).md , https://iphonelife.com/blog/5/tip-day-save-time-using-swipe-gestures-mark-or-flag-email-ios-8
- Distance + velocity thresholds and non-swipe alternatives: https://designsystemproblems.pages.dev/cross-platform-consistency/swipe-interactions
- Destructive gestures commit on release; momentum preserved: https://rauno.me/craft/interaction-design
- iOS permission alert options (Allow Once / While Using / Don't Allow): https://developer.apple.com/documentation/uikit/requesting-access-to-protected-resources
- Little Snitch rule scope (domain vs host) and lifetime: https://help.obdev.at/littlesnitch6/alert-overview ; LuLu scope (process vs destination) and duration: https://objective-see.org/products/lulu.html
- WCAG 2.5.1 / 2.5.7: https://www.w3.org/WAI/WCAG22/Understanding/pointer-gestures , https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements

---

## 3. Live session view

**Goal**: watch an agent work in real time, understand what it did (messages, tool calls, diffs) without drowning in output, and steer or stop it.

**Entry points**: Home agent card (tap = latest session), Sessions tab list, push notification ("reviewer finished"), Inbox Details "Open session", Audit event "View in session".

### Anatomy (mobile)
- **Header** (sticky, 2 rows): back · agent name (`title-3`) · lamp + `live` · overflow (`/details`, `/new`, mode, copy link, stop hard). Row 2 = compact beam line `telegram:group/-100123 ──● reviewer` + slug `claude 2.1.4 · thread 842 · worktree beamhop/842 · $0.38 · 6m`.
- **Transcript** on a tick rail (DESIGN §3.8), newest at bottom, auto-scroll *only* when the user is already at the bottom; otherwise a `↓ 3 new` pill appears.
  - **Inbound message**: sender name + role chip + channel mono; content in `body`; the channel-context header (§6A.3) available behind a `ⓘ header` toggle (mono, sunken) — reinforces "content is untrusted".
  - **Agent message**: full prose, Markdown rendered (code fences in `code`, tables scroll horizontally in a region). Streaming shows a block caret `▍`.
  - **Tool call row**: one line — status glyph (running: hop-bars animating / ok: check / failed: square / denied: gate) + verb + target in mono (`Read src/auth.ts`, `Bash npm test`, `Edit 2 files +14 −3`, `Fetch api.github.com`) + duration. Tap to expand: input (args), output (first 40 lines, `Show all 312 lines`), and for edits the **diff viewer**.
  - **Consecutive tool calls** group into a *tool run* row: `7 tool calls · 2 edits · 1m 04s ▸`. Expanding shows each row. **Agent prose between tool calls is never folded into the group** — each text segment stays visible in the transcript (mobile agent apps that hide assistant text inside collapsed tool chips frustrate users: https://claudeissues.com/issue/82087-mobile-mid-turn-assistant-messages-collapse-into-the-tool-activity-chip-so-the-f).
  - **Long-running Bash streams output live** inside the expanded row (last 6 lines shown collapsed as a mini tail in `code` ink-3), so a running `npm test` is visibly alive (cf. https://claudeissues.com/issue/38260-bug-mobile-ios-no-streaming-output-visibility-for-long-running-bash-commands).
  - **Inline approval**: a compact slip (same component) appears in the transcript where the request happened, with Deny/Allow; it mirrors the Inbox state.
  - **Progress line** (§6A.8) as a sticky strip above the composer: `running tests… · 0:42` with a hop-bar pulse.
  - **Files changed** summary at turn end: `3 files · +42 −7 · View diff` → full-screen diff sheet with file list, per-file collapse, `Wrap` toggle, and for git mounts `Merge into main` / `Open PR` when the session ends (§6A.5).
- **Composer**: pill input, `+` attach (files go to `<session>/inbox/` §3.3), slash-command autocomplete (`/new /stop /status /details /model /mode /usage`), send. While streaming: Send becomes **Stop** (square). Typing while streaming = **steer** (message queued as next user turn, label `Steer` above input); the user may `Send now` to interrupt.
- Composer stays above the keyboard: `interactive-widget=resizes-content` on Chromium; on iOS track `visualViewport.height` and translate the composer.

### Gestures & alternatives
| Gesture | Action | Alternative |
|---|---|---|
| Swipe horizontally on the transcript header/edge zone (not the code blocks) | Previous/next session of the same agent | `‹ ›` buttons in header; `[` / `]` |
| Tap tool row | Expand/collapse | Enter/Space on focused row |
| Long-press a message | Copy / quote in composer / open in Audit | Overflow `…` on each message (visible on focus/hover; on touch, a tap on the timestamp opens the same menu) |
| Pull down at top | Load earlier messages | `Load earlier` button at top |

Code blocks and diffs capture horizontal scroll inside themselves only; the session swipe ignores touches that start inside a scrollable region.

### Screen reader
- Transcript is a `log` region (`role="log"`, `aria-live="off"`) so the full stream isn't read; a separate polite live region announces: "reviewer is responding", progress lines every ≥10 s, "reviewer finished: 3 files changed", approvals.
- Each message has a heading level 3 with sender + time for quick navigation (rotor/headings).

### Edge cases
- **Session queued** (max_sessions reached): header shows `queued · 2 ahead`, composer still accepts a message.
- **Write lock** (non-git RW mount): `waiting for ~/notes lock (held by thread 839)`.
- **Harness crashed**: error panel inline with exit code and last 20 log lines, `Restart session` / `Open logs`.
- **Budget hit**: session pauses, inline banner `Stopped at $5.00 daily budget. Raise for today` (owner) — opens NumberField sheet.
- **Hop limit** (mesh): inline system row `Mesh limit reached: 6 turns with summarizer. Reply to continue.`
- **DLP redaction** on outbound: the message renders with `[redacted: aws-key]` tokens highlighted in stop-wash and a note "This was redacted before sending to Alice".
- **Remote/Nostr latency**: messages show a small `·` pending marker until the relay ACK; Nostr channel replies arrive as final messages (no edits) — progress notes appear as separate rows.
- **Offline**: cached transcript viewable; composer disabled with reason.

**Success criteria**: a user can answer "what did the agent change?" within 2 taps from a finished session; streaming never janks scroll (virtualized list, 60fps on mid-range Android); Stop reachable in 1 tap at all times.

**Research**: Claude mobile session view single-line tool rows (https://claudeissues.com/issue/76487-feature-request-collapsed-by-default-tool-blocks-in-the-interactive-cli-like-the); streaming-state design beyond "streaming/done" (https://www.setproduct.com/blog/ai-chat-interface-ui-design); GitHub mobile diff review (file list + per-file collapse); Warp blocks (command + output as one unit — our tool row); Rauno on scroll targeting (gesture goes to the region under the finger).

---

## 4. Add a channel

**Goal**: connect Telegram, Slack or Discord with zero config-file editing, credentials going straight to the keychain, and a verified owner pairing (§5). Target: ≤ 2 min for Telegram, ≤ 4 min for Slack/Discord.

**Entry points**: Channels → `+ Add`; Onboarding "Next steps"; Agent detail → Memberships → `Join a channel` → "Not connected yet? Add channel"; command palette "channel add".

### Common wizard frame
- Full-screen route on mobile (`/channels/add/telegram/2`), dialog-sized pane (720px) on desktop.
- Stepper rail with the 6 common steps (§5): `01 Create · 02 Credentials · 03 Validate · 04 Connect · 05 Pair · 06 Join`. Validate and Connect are usually automatic and pass in < 2 s; they appear as nodes that fill on their own (the user sees them happen rather than clicking through them).
- **Deep links** to provider pages open in a new tab/app (`target="_blank"`); on return (`visibilitychange` → visible), the wizard re-focuses the next field and, where the clipboard API is allowed, offers `Paste from clipboard` as a one-tap button (never reads the clipboard silently).
- Each step has a CLI strip with the headless equivalent (§5 Headless example).
- Secrets field: live **format check** before any network call (shape only), then **live validation** with the provider (shows bot avatar + name). Credentials never render again after save: `Saved to keychain · xoxb-…a91f`.

### Telegram
1. **Create**: "Open @BotFather and create a bot." `Open BotFather ↗` (`https://t.me/BotFather`). Below, a numbered script with copy buttons for each thing to send: `/newbot` → name (suggested: `{agent} (beamhop)`) → username (suggested `{agent}_{owner}_bot`; rule shown: must end in `bot`, 5–32 chars, can't be changed later).
2. **Credentials**: token field. Format check regex `^\d{6,12}:[A-Za-z0-9_-]{30,}$` → `Looks like a bot token`.
3. **Validate**: `getMe` → shows bot name, `@username`, avatar. Error 401 → "Telegram didn't accept this token. In @BotFather, send /token to get a new one."
4. **Connect**: long-polling started (`getUpdates`); lamp goes ready.
5. **Pair**: instead of asking the user to type `/pair <code>`, a single button **`Open @{bot} in Telegram ↗`** with the deep link `https://t.me/{bot}?start=pair-{code}` (Telegram passes `/start pair-{code}` to the bot; code limited to `[A-Za-z0-9_-]` ≤ 64). The manual fallback shows the code in Doto and `Send /pair 7KQ2-9XHD` with copy. The wizard waits (`Waiting for /start from Telegram…`) and resolves to `Paired with @alice (Telegram 5551) as owner`.
6. **Join**: choose agent(s) and where: `DMs` (default on), `Add to a group` → `Open group picker ↗` (`https://t.me/{bot}?startgroup=join-{code}`); after the bot joins, the group appears with its name; set default role (viewer default) and triggers (mention, reply — §6A.4). **Privacy mode** note in a caution box when the agent should read all messages: "Send /setprivacy to @BotFather → Disable. Then remove and re-add the bot to the group — Telegram only applies it on re-join."
- Future option (behind a flag): Telegram **Managed Bots** creation link `https://t.me/newbot/{manager}/{username}?name=…` prefills username/name — requires a beamhop manager bot, so not in the launch default (no hosted server).

### Slack
1. **Create**: `Create the Slack app ↗` opens `https://api.slack.com/apps?new_app=1&manifest_json=<url-encoded manifest>` with name, bot scopes, events, Socket Mode on and the `/pair` slash command prefilled. A `View manifest` disclosure shows the JSON (trust through transparency). Instruction: "Pick your workspace, review, then Create."
2. **Credentials** (two fields, each with a mini how-to and a screenshot-free text path):
   - **App token** `xapp-…`: "Basic Information → App-Level Tokens → Generate, scope `connections:write`."
   - **Bot token** `xoxb-…`: "Install App → Install to Workspace → copy Bot User OAuth Token."
   - Pasting a token into the wrong field is detected by prefix and offered: `This is the bot token — move it?`
3. **Validate**: `auth.test` (bot) + `apps.connections.open` (app token) → workspace name + bot name + icon.
4. **Connect**: Socket Mode connection established (lamp).
5. **Pair**: "In Slack, DM @{bot}: `/pair 7KQ2-9XHD`" with copy + `Open Slack ↗` (`slack://open` fallback to web). Resolves to `Paired with Alice (acme.slack.com) as owner`.
6. **Join**: list of channels the bot is in (refreshing); `How to invite`: `/invite @{bot}` in the channel, copy button; per channel: role + triggers + cross-posting routes (journey 5 Routes).

### Discord
1. **Create**: `Open Developer Portal ↗` (`https://discord.com/developers/applications`). Checklist with checkboxes the user ticks (these are *their* reminders, not validation): `New Application` → `Bot` tab → `Reset Token` and copy → toggle **Message Content Intent** on ("needed so the agent can read messages that mention it").
2. **Credentials**: token field; format check (three dot-separated base64url segments).
3. **Validate**: `GET /users/@me` + `GET /applications/@me` → bot name/avatar, application id; check `flags` for the Message Content intent and show a caution with the exact toggle location if missing (validation fails gently: "Message Content intent is off. The agent will only see slash commands and mentions without text.").
4. **Connect**: gateway connected.
5. **Join (invite) before Pair** — Discord needs the bot in a server first: `Add to a server ↗` opens `https://discord.com/oauth2/authorize?client_id={id}&scope=bot+applications.commands&permissions=117760` (View Channels, Send Messages, Embed Links, Attach Files, Read Message History — minimal). Permissions listed in plain words under the button. A `Threads` toggle adds Send Messages in Threads.
6. **Pair**: `/pair 7KQ2-9XHD` in any channel the bot sees or in a DM; resolves with the Discord username.

### Edge cases (all providers)
- Token revoked later → channel row shows error lamp `Token rejected (401)` + `Replace token` (re-runs from step 2, keeps everything else).
- Pair code expires after 10 min → `Get a new code`; codes are single-use and rate-limited; wrong-code attempts appear in Security events ("failed pairings" §9B).
- Someone else sends `/pair` with the code first → the wizard shows who paired (`Paired with @mallory`) and requires the owner to confirm `This is me` / `Not me — unpair`.
- Network blocked (corporate proxy) → validation error names the host that failed (`api.telegram.org`).
- Bot removed from a group (platform-native revocation §7A) → membership row disappears with an Audit entry; beamhop never rejoins automatically.

**Success criteria**: no user ever opens a config file; ≥90% of Telegram setups complete pairing via the deep link without typing; every failure names the provider step to revisit.

**Research**: Telegram deep links (`?start=`, `?startgroup=`, parameter charset/length), BotFather commands, privacy mode re-add requirement, Managed Bots link format: https://core.telegram.org/bots/features ; Slack manifest prefill URL and manifest docs: https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests , https://api.slack.com/reference/manifests ; Discord OAuth2 scopes/permissions integer: https://docs.discord.com/developers/topics/oauth2 , https://docs.discord.com/developers/platform/oauth2-and-permissions .

---

## 5. Policy & sandbox editor (incl. learning mode)

**Goal**: make the sandbox (§7) and roles (§6) understandable as *reach* — "what can this agent read, write and talk to, for whom" — and let users tighten or widen it safely, with learning-mode suggestions instead of guesswork.

**Entry points**: Agent detail → `Sandbox & roles`; Policy tab (all profiles); approval scope sheet "Always allow" (preview of the rule); learning-mode notification "3 hosts were blocked this week"; exposure findings on Home.

### Structure
1. **Reach summary** (top, always visible) — the single most important element. Plain sentences grouped by verb, generated from the compiled srt config:
   - **Reads** `~/code/app` · `~/notes`
   - **Writes** `~/code/app` (each session on its own branch)
   - **Talks to** 6 hosts: `api.anthropic.com` `github.com` `*.githubusercontent.com` `registry.npmjs.org` +2
   - **Never** (locked, hatched): `~/.ssh` `~/.aws` `~/.config/gh` keychains browser profiles — "beamhop always blocks these. No role can change it."
   - **Secrets**: "The agent sees placeholders. The broker adds real keys for: Anthropic API."
2. **Findings** (Watchtower-style, but *a list of specific findings, not a score*): severity lamp + one line + fix button. Examples: `Wildcard host *.githubusercontent.com allows any repo's raw files — Narrow to raw.githubusercontent.com` · `~/notes is read-write and not a git repo; parallel sessions will wait for a lock — Make read-only` · `viewer role can trigger Bash — Require approval`. Findings are computed by the daemon (`policy.audit` RPC). Empty: "No findings."
3. **Profile picker**: three radio cards `strict` · `workspace` · `custom`, each with a 2-line reach preview. Switching shows the diff before applying.
4. **Files**: list of mounts (path, `Read-only | Read-write` segmented, git badge, `parallel_unsafe` advanced toggle with warning), `+ Add folder` (path picker). Deny list: locked rows (hatch, lock icon) + user-added deny paths (removable).
5. **Network**: domain chips (TagGroup). Add field accepts host, `*.domain`, or a URL (we extract the host and say so: "Added github.com (from https://github.com/acme/app)"). Each chip has a menu: `Narrow to host`, `Remove`, `See requests (Audit)`. Blocked-always ranges (loopback, metadata IP 169.254.169.254) shown locked.
6. **Environment**: env var allowlist chips (names only).
7. **Roles matrix**: rows = actions (Read files, Edit files, Bash, Network to new host, git push, Spend > $1, Mesh jobs), columns = roles (owner, admin, user, viewer, agent); cells = `Auto | Ask | Deny` segmented. On compact, rendered as one accordion per role with the action list inside (no horizontal table scrolling). Plus per-role budgets and rate limits (NumberFields) and harness permission mode.
8. **Routes** (cross-channel posting §1): beam-line editor `nostr:dm → slack:#deploys`; add route = two selects (from, to) + agent; no drag needed.
9. **Save bar** (sticky bottom when dirty): `2 changes · Review` → sheet with YAML diff (the PWA edits `~/.beamhop/agents/<name>.yaml`, §6A.1) and plain-language diff ("reviewer will also be able to reach registry.npmjs.org"). Widening changes require the owner role and show the primary as `Widen access`; tightening is `Save`. Changes apply to *new* sessions; running sessions are listed with `Restart them now` option.

### Learning mode
1. Toggle per agent: `Learning mode — log blocked requests for 24h / 7 days instead of failing silently` (srt permissive + logging §7). While on, the agent card shows a caution lamp `learning` and a top banner counts `14 blocked requests logged`.
2. Suggestions are **cards in the same triage component as the Inbox** (swipe right = allow, left = keep blocked; buttons always visible), aggregated: "reviewer tried **registry.npmjs.org** 14 times in 3 sessions (npm install)". Shows first/last time, the commands that triggered it, and a scope segmented control `registry.npmjs.org | *.npmjs.org`.
3. Paths too: "Tried to read `~/.npmrc` 3 times" → options `Allow read` / `Keep blocked` / `Provide via broker` (if it's a credential file — suggests secret broker instead of mounting the file).
4. Never suggest unlocking locked paths; those requests are listed as "Blocked by design" with no allow button.
5. After triage: summary diff → `Apply 2 rules` → turns learning mode off (or keep on).

**Accessible alternatives**: chip removal via button inside chip (not drag); matrix via segmented controls (keyboard arrows); learning cards have buttons; route editor uses selects; path picker supports typing.

**Edge cases**: invalid domain (`htp:/x`) → inline error with example; adding a domain that's always blocked (metadata IP) → explanation; YAML on disk changed externally while editing → "reviewer.yaml changed on disk 10:44. Review their changes" merge sheet; non-owner viewing → read-only with "Only owners can widen access".

**Success criteria**: in tests, users correctly answer "can this agent read ~/.ssh?" and "which hosts can it reach?" in < 10 s; zero accidental wildcard additions (wildcards always require explicit choice).

**Research**: Little Snitch rule anatomy, domain vs host, deny-wins precedence: https://help.obdev.at/littlesnitch5/ref-rule-properties , https://help.obdev.at/littlesnitch4/ref-rule-precedence ; LuLu rule scope/duration: https://objective-see.org/products/lulu.html ; 1Password Watchtower categorised findings with per-item fixes: https://support.1password.com/watchtower/ ; Apple purpose strings — say specifically why access is needed: https://developer.apple.com/help/app-review/guideline-reference/5-1-1-purpose-strings ; iOS privacy prompt scopes (Allow Once / While Using).

---

## 6. Monitoring: usage, security events, alerts

**Goal**: know at a glance whether spending is on track and whether anything suspicious happened; get alerted for the few things that matter (§9B), not for noise.

**Entry points**: Audit tab (segmented `Usage · Security · Log`), Home budget meters, push alerts (budget 80/100%, crash, cloud offline, security spike), Agent detail → Usage.

### Usage
1. Header readout: `$12.40` (Doto) "this month · all agents" + segmented meter vs sum of budgets + `▲ $3.10 vs last month` mono.
2. Range: `Today · 7 d · 30 d · Custom`. Breakdown segmented: `Agent · Channel · Peer agent · Day` (§9B).
3. Chart: stacked bars by day. 30 days fit a 343px column at 7px bars + 4px gaps, so the chart never scrolls horizontally. Series colours chart-1…5, direct labels in the legend list *below* the chart (legend rows double as the data table: name, $, tokens, minutes, % — tap row to isolate series).
4. Tap/hover a bar: tooltip card pinned above the chart (not floating under the finger — the finger hides it), with that day's breakdown. Keyboard: chart is a focusable group, `←/→` move between days, values announced. A `View as table` toggle renders an accessible table (always available).
5. Source line: "Counted by beamhop's key broker; harness-reported usage shown where the broker can't see (subscription logins)." (Honesty about measurement.)

### Security events
1. Filter chips: `All · Blocked hosts · Blocked paths · Peer agents · Pairing · Unknown senders · Hop limits · DLP`.
2. Spike strip: 24 h sparkline per category (tiny bar chart), with spikes marked caution.
3. Event rows: lamp (shape by severity) + sentence ("reviewer was blocked from 169.254.169.254 (cloud metadata)") + slug (`10:42 · session 842 · srt`) + actions: `Open session`, `Allow…` (where policy allows widening; routes into journey 5 with the rule pre-filled), `Block sender`.
4. Unknown sender "request access" items have direct `Allow as viewer / Ignore` (§6).

### Alerts
- Alerts settings per agent: thresholds (budget % list `80, 100`), crash, cloud heartbeat missed (`after 3 min`), security spike (`> 10 events / 10 min`). Delivery: `Push to my devices` (per device toggles) and/or `Nostr DM to owners`.
- Quiet hours with "except panic-level" override.
- Push content is specific (DESIGN §11 examples) and deep-links to the exact screen.

### Log (audit)
- Virtualized list of every event (decisions, role changes, config edits, deploys), filter by agent/actor/type/date, search. `Export` → JSONL or CSV (§1 retention) via a file download; `Purge…` (owners) with date picker and typed confirmation of agent name.

**Edge cases**: no data yet → empty state with "Usage appears after the first session"; broker can't see subscription usage → series hatched "estimated"; clock skew between daemons → times shown in local time with daemon label.

**Research**: dataviz principles — direct labelling, legends as tables, tooltips not under the finger, accessible table alternative; Vercel/Railway/Fly usage dashboards (usage-based billing needs a running-total readout and a forecast): https://blog.railway.com/p/usage-based-vs-fixed-pricing-2026 , https://fly.io/learn/paas-pricing-compared/ .

---

## 7. Cloud deploy

**Goal**: move an existing agent to (or create a new agent on) Hetzner, DigitalOcean, Fly.io, Render or Railway, knowing the monthly cost and exactly what will change *before* anything is applied (§10).

**Entry points**: Agent detail → `Move to cloud`; Deploy tab → `New cloud agent`; Onboarding next steps.

### Flow
1. **Provider**: list rows (not logo cards): monogram + name + one-line fit ("VPS · full srt sandbox · from €4/mo", "Container · srt network only, filesystem = container (§7 PaaS note)"). If the user has no API token for that provider: inline `Add Hetzner API token` (secret field → keychain; the token never leaves this machine §8).
2. **Size & region**: radio rows with vCPU/RAM/disk in mono and **est. monthly cost** right-aligned (`€4.51/mo est.`), fetched from the provider's pricing API when available, otherwise catalog prices with "price as of 2026-11-01". Region select with latency hint to the owner's relays.
3. **Harnesses & auth**: checkboxes of harnesses to preinstall; per agent auth radio: `API key via broker (recommended)` / `Subscription login` → caution box with the ToS warning and `Read terms ↗` link, then a device-code login run on the server during apply (§7 Harness auth).
4. **Mounts** (move only): each mount row shows its plan: git repo → `clone on server`; other → `copy once (rsync, 1.2 GB)` with `Keep in sync (Mutagen)` opt-in; RW non-git warnings.
5. **Local copy**: radio `Stop local agent` (default) / `Keep as standby`.
6. **Plan** (the key screen): a terraform-plan–style diff with symbols and colour *and* words:
   ```
   + create   server   hetzner cx22 · fsn1 · 2 vCPU 4 GB      €4.51/mo
   + create   firewall outbound only, 0 inbound ports
   + install  beamhopd 1.4.2, srt, bubblewrap, claude 2.1.4
   ~ move     identity reviewer (npub1x7k…q9fz) → remote vault
   ~ move     secrets  ANTHROPIC_API_KEY → stays local, brokered
   → clone    ~/code/app  (git, github.com/acme/app)
   → copy     ~/notes     1.2 GB once
   - stop     local agent reviewer
   ───────────────────────────────────────────────
   Estimated  €4.51/mo  + bandwidth  · cap: needs owner approval above €20/mo
   ```
   Rows are grouped, each expandable for details. `+` go-text, `~` caution-text, `-` stop-text, `→` ink-2; the word (`create`, `move`) is always present.
   Primary: `Deploy · €4.51/mo`. Secondary: `Copy plan` (as CLI `beamhop deploy plan --json`).
7. **Apply**: phase timeline on a tick rail: `Provision → cloud-init → beamhopd → doctor → harnesses → identity → first heartbeat`, each with live status + duration; a collapsible live log (mono, autoscroll with pause on scroll-up). Leaving the screen is safe ("Runs on the daemon; you'll get a push when it's done").
8. **Done**: beam line `you ── relays ── reviewer@fsn1` with heartbeat lamp; `Send a test message` (re-uses journey 1 round-trip); cost readout appears on the agent card.

### Edge cases
- **Over cap** → plan shows `Needs approval from another owner` (N-of-M) and becomes an Inbox item for them.
- **srt can't use namespaces** (Render/Railway) → plan row `! sandbox  filesystem isolation = container only` with explanation; user must tick "I understand" (checkbox, not a gesture).
- **Partial failure** → timeline marks failing phase with error panel, `Retry from this step`, `Roll back` (destroys created resources, shown as its own mini-plan), logs link.
- **Destroy**: Deploy detail → `Destroy…` → plan of deletions + type the agent name to confirm (typing is the accessible, deliberate friction for an irreversible, costly action).
- **Second device**: deployment state mirrored over Nostr (§10) — a phone can view status/logs and stop, but provisioning requires the device holding the provider token; the UI says so.

**Research**: Terraform/OpenTofu plan symbols (+ ~ -) as a familiar diff vocabulary; Fly per-second billing and stopped-machine storage costs → show "while stopped: €0.30/mo storage" line where relevant: https://www.costbench.com/software/developer-tools/flyio/hidden-costs/ ; Railway usage-based on top of plan fee: https://fly.io/learn/paas-pricing-compared/ ; Vercel/Railway deployment timelines with phase-level logs.

---

## 8. Kill switch: panic and resume

**Goal**: stop *everything* (§7A Emergency stop) in ≤ 2 taps from any screen, with certainty about what stopped, and resume only after a deliberate review.

**Principle**: **asymmetric friction.** Stopping is safe and reversible, so it is fast (one confirm). Resuming re-opens risk, so it is deliberate (review checklist). No hold-to-confirm (timing gestures are hard for many users), no slide-to-stop (drag).

**Entry points**
- Mobile: Home top bar `Stop` icon button (square, 44px) — always present on Home; More tab top row `Stop everything`; Android/desktop app shortcut (Web App Manifest `shortcuts`: "Stop everything" → `/panic`); command palette `panic`.
- Desktop: sidebar bottom `Stop everything` (destructive secondary style) + `⌘⇧.` shortcut.
- Notification action (where supported by the platform): on security-spike alerts, an action button `Stop everything`.
- CLI `beamhop panic` and Nostr control from any paired device.

### Flow
1. Tap `Stop` → **confirm sheet** (opens instantly, no spring delay): title **Stop everything?**; a live count list: `5 sessions · 3 schedules · 4 channels · 2 cloud daemons`; one big destructive button `Stop everything` (full width, 56px) and `Cancel`. Initial focus goes to the sheet title (`tabindex=-1`), so screen-reader users hear the consequences first; `Stop everything` is the next tab stop, `Cancel` after it.
2. On press: haptic `warn`; button enters pending state "Stopping…"; within ~1 s the sheet turns into a **status board**: each item ticks to done (`Sessions killed 5/5`, `Schedules paused 3/3`, `Channels disconnected 4/4`, `fly-ams-1 acknowledged 0.8 s`, `hetzner-fsn1 acknowledged 1.4 s`). Unacknowledged cloud daemons keep retrying with a visible counter and the option `Destroy server` (links to deploy destroy) after 60 s.
3. **Panic band** appears on every screen (hatched stop-wash): `Everything is stopped · since 10:42 · Review & resume`. Home shows the stop time as a Doto readout. All agent lamps become hatched squares "stopped by panic". Inbox pending requests are auto-denied (agents are told).
4. **Resume** (`Review & resume`): a review screen: what was running before (list with checkboxes, all *unchecked by default*): agents, schedules, channels, cloud daemons; recent security events since 1 h before panic (so the user can see why they panicked); a free-text note for the audit log. Primary `Resume 3 selected`. Partial resume is allowed. beamhop never resumes on its own (§7A).
5. Per-agent stop (`agent stop --hard`) is available on agent detail/card overflow with the same sheet pattern scoped to one agent.

**Accessible alternatives**: all buttons; assertive live announcement "Everything is stopped. 2 of 2 cloud daemons confirmed."; the band is a `region` landmark with heading, reachable via landmarks.

**Edge cases**: offline phone → panic goes out over Nostr relays when possible; if no relay reachable: `Couldn't reach any relay. Stop on the computer: run beamhop panic` with copy; partial (one cloud daemon down) → shown as pending with retry; panic while onboarding/deploying → in-flight deploy is paused at the current phase.

**Success criteria**: from Home, stop in 2 taps < 3 s; usability test participants can state what stopped and how to resume without help.

**Research**: emergency-stop conventions in industrial UI (single, unmistakable, always in the same place, reset is a separate deliberate act); Rauno on Fitts's law — stable top-bar position; WCAG 2.5.7/2.5.1 (no slide/hold).

---

## 9. Device pairing and removal (incl. install + push)

**Goal**: make a phone (or another browser) a trusted control device for the daemon, get the PWA installed, and enable push — then make removing a lost device trivial (§7A Lost phone).

**Entry points**: onboarding step 04; Settings → Devices → `Pair a device`; hosted PWA first open on a new device → "Pair with your computer"; CLI `beamhop pair-device` (prints the QR in the terminal).

### Flow
1. **On the computer** (trusted side): QR + expiry countdown (2 min) + `Show code instead`. QR encodes `https://app.beamhop.dev/pair#<one-time token>`.
2. **On the phone**: camera opens the link → hosted PWA "Pair with **Alice's MacBook** (beamhopd 1.4.2)". Device name field (prefilled from UA: "iPhone · Safari"), and the 4-word **safety phrase**.
   - Alternative sign-ins (§9 Hosting): `Use a NIP-46 bunker` / `Use a browser extension (NIP-07)` for users who prefer their own signer.
   - No camera / desktop browser: `Enter code` field (accepts paste; 8 chars, auto-uppercase, dash optional).
3. **Confirm on the computer**: "Does your phone show **AMBER · RELAY · OTTER · NINE**?" → `Yes, pair iPhone · Safari`. The phone is now on the control allowlist with a device key generated *on the phone* (private key in IndexedDB as a non-extractable WebCrypto key where possible).
4. **Install** (phone): if not standalone:
   - Android/Chromium: capture `beforeinstallprompt`, show our sheet "Install beamhop" with `Install` (calls `prompt()`), `Not now`.
   - iOS: no install prompt API exists, so an instruction sheet with the actual Share glyph drawn inline: "Tap **Share** ⎋ then **Add to Home Screen**", plus why: "iPhone only sends approval alerts to installed apps." Dismissible; reappears once after the next approval-related visit, then only in Settings.
   - Detect installed via `matchMedia('(display-mode: standalone)')` / `navigator.standalone`.
5. **Push** (in standalone on iOS ≥ 16.4; any time on Android/desktop): purpose pre-prompt (DESIGN §11) → `Turn on notifications` triggers `Notification.requestPermission()` *inside the tap* (iOS requires a user gesture) → subscription sent to the daemon. Shows a test push `Send a test notification`.
   - Denied → explains how to re-enable in system settings; offers Nostr DM alerts as the fallback.
   - iOS < 16.4 or not installed → "Notifications need iOS 16.4+ and the installed app" with fallback to Nostr DM.
6. **Done**: device appears in Settings → Devices.

### Devices list (Settings)
Rows: device glyph + name + slug (`iPhone · Safari · paired 13 Nov · last seen 4 min ago · push on`); this-device tag; `Rename`, `Remove`. **Remove** = one confirm sheet ("iPhone · Safari won't be able to control your agents. This doesn't sign it out of other apps.") → removes from every daemon's allowlist (§7A — no key rotation); Audit entry. Devices unseen for 90 days get a caution tag `inactive` with a suggestion to remove. Row swipe-left reveals `Remove` (no full-swipe commit) — the row's `…` menu has the same.

**Edge cases**: QR expired → `Get a new code`; safety phrase mismatch → `No, cancel` invalidates the token and logs a failed pairing (security event); pairing from an unexpected network location shows a caution line on the computer ("This request came via relay, not your local network"); the same device re-paired → replaces the old key, keeps the name.

**Success criteria**: pairing ≤ 30 s; zero pairings without a trusted-side confirmation; removal ≤ 3 taps.

**Research**: Signal/WhatsApp linked-device QR flows and the 2025 QR-phishing attacks (confirm on trusted side, name the device, list devices prominently, remove easily): https://attack.mitre.org/techniques/T1676 , https://www.privacyguides.org/news/2026/09/30/german-police-are-using-linked-devices-to-read-signal-messages-without-cracking-the-encryption.md ; iOS web push needs 16.4+, home-screen install, permission only after a user gesture: https://documentation.onesignal.com/docs/web-push-for-ios , https://pushpad.xyz/blog/ios-special-requirements-for-web-push-notifications ; no `beforeinstallprompt` on iOS — use instructions: https://developer.mozilla.org/en-US/docs/Web/Progressive_Web_Apps/Add_to_home_screen , https://developer.apple.com/forums/thread/807603 ; EU iOS web-app status should be re-verified before launch (reports conflict).
