# Desktop app UX audit (2026-11-13)

Walked in the PWA with demo data at the desktop window's default size (1280×840) and at 1440×900 and 1024×768.
Journeys tried: first-run setup, create an agent, connect a channel, handle an approval, follow a session,
change an agent's sandbox.

## Biggest opportunities

### 1. "Make an agent people can reach" is three separate journeys
- **New agent** (4 steps: preset → harness → folders → review) never asks where the agent listens. It ends on
  an agent marked **ready** whose only hint is a line halfway down Overview: "isn't in any channel yet, so
  nobody can reach it".
- **Add channel** is a separate 6-step wizard (Create → Credentials → Validate → Connect → Pair → Join),
  started from Channels, not from the agent.
- **Joining** the agent to the channel is a third place (Agent → Channels).
- The preset cards promise reach ("You and teammates who mention it") that the flow never sets up.

### 2. Two different "create agent" flows
- Setup step 05 is one page: preset, **name**, harness, folder, live "what it can reach".
- Agents → New agent is a 4-step wizard whose name field sits below the four preset cards, out of view at normal window sizes (prefilled as `reviewer-2`).

### 3. Navigation is organized by system part, and the parts overlap
Ten top-level items (Home, Inbox, Sessions, Agents, Channels, Harnesses, Policy, Deploy, Audit, Settings),
and several topics live in two or three of them:

| Topic | Where it appears |
| --- | --- |
| What an agent can reach | Agent → Sandbox, Policy (per-agent list + profiles), Setup review |
| Network allowlist | Agent → Sandbox ("Your allowlist") **and** Policy editor ("Domain allowlist … live in the Policy editor") |
| Spend | Home → Spend, Agent header ($ left today), Agent → Budgets, Audit → Usage (Audit opens on spend) |
| Harness login | Harnesses, Agent → Setup ("Codex needs attention… codex login"), New agent harness step |
| Channels | Channels (connections) and Agent → Channels (memberships) |
| Where an agent runs | Agents (local) and Deploy ("cloud agents", same names) |

### 4. Agent detail has 7 tabs
Overview, Setup, Sandbox, Channels, Schedules, Budgets, Identity. At 1280–1440 px the strip is cut after
"Budg…"; Identity is off-screen with no overflow cue.

### 5. The Inbox rail crowds the work area
At ≥1440 px a "Needs you" rail sits on every screen:
- On Home it repeats the "Needs you" column next to it.
- On Sessions the transcript shrinks to about a third of the window (list + transcript + rail).
- In the Telegram wizard the step content is about 250 px wide; "Open BotFather" is truncated.
- On wizards (New agent, Add channel) it competes with a task that needs focus.

### 6. First-run setup leads with machine checks
Setup is Doctor → Harnesses → Identity → Phone → Agent → Hello.
- Step 1 is a list of sandbox binaries (srt, bubblewrap, socat, ripgrep, AppArmor) and sudo snippets before
  the user has seen what beamhop does.
- There is no channel step: the first agent is reachable only by Nostr DM ("reply from any Nostr app").
- Phone pairing (step 4) interrupts the path to a first working agent.

## Smaller issues
- **Empty detail panes:** Agents, Channels, Deploy and Settings open with "Select an item to see its details."
  filling half the window.
- **Status words mean different things:**
  - "ready" can mean the agent is unreachable.
  - "needs you" / "4 need you" / "learning" / "stopped" / "1 finding" are mixed on one list.
- **Jargon in always-visible places:** the top strip ("BEAMHOPD 0.3.0 · UP 3 H · LINK UP · RELAYS 3/4"),
  plus "harness", "broker", "NIP-17", "npub", "ELEVATED" and "mesh".
- **Policy:** the profile comparison table scrolls sideways at 1440 px, so the "custom" column is hidden.
- **Wizard footer:** the primary button jumps between steps: sticky at the bottom on steps 1–2, inline
  mid-page on step 3.
- **Loading:** a cold start shows a blank dark screen for about 2 s, and route changes keep the old screen up
  for 1–2 s with no loading cue. Measured on the dev build; recheck on the packaged app.
- **Narrow windows:** at 1024 px the Home agents column is clipped on the right.

## What already works well
- Inbox approval detail: context, policy line, countdown, keyboard shortcuts, undo.
- Live "what it can reach" summaries before creating or switching profiles.
- Clear empty and error states on channels ("Token rejected (401) · Replace token").

## Decisions (interview, 2026-11-13)

| Topic | Decision |
| --- | --- |
| Primary user | Non-technical owner. Internal terms (harness, sandbox profile, relay, npub, broker) are hidden or explained. |
| Navigation | Agent-centric: Home, Inbox, Conversations, Agents, Settings. |
| Technical sections | Settings gets Connections (channels), AI providers (harnesses), People & roles, Security log. Deploy becomes "Where it runs" on each agent. Spend and history become an Activity view. |
| Create an agent | One single-page flow, used both in first-run setup and in Agents → New. It asks for a name and has a "Where it listens" section: pick a connected channel or connect a new one inline. The agent is reachable when the flow ends. |
| AI provider | Ask "Which AI account do you have?" (Claude, ChatGPT, Gemini…) and pick the harness automatically; install and sign-in sit behind one button. The harness name shows only in advanced details. |
| First run | Outcome first: what should your agent do → sign in to an AI provider → where it listens → say hello. The machine check runs silently and interrupts only when something needs fixing; the owner key is created quietly; phone pairing is offered after the first reply. |
| Inbox rail | No permanent rail. The sidebar badge and a toast for urgent approvals; a shortcut opens a slide-over list on any screen. |
| Agent page | One page in 4 sections: Overview · Who can reach it · What it can do · Advanced. |
| Approvals | Keep the exact command or host as the headline; add a one-line plain explanation under it. |
| In-app chat | Every agent can be chatted with in the app from the moment it's created; Conversations replaces Sessions and shows chats from every channel. |
| Delivery | Build directly, highest impact first. |

## Phases

1. **Agent creation + reachability.**
   - One create-agent page with name, AI provider, folders and "Where it listens".
   - Inline channel connect.
   - An in-app chat for every new agent.
   - "Not reachable yet" replaces a false "ready".
2. **Navigation.**
   - Agent-centric sidebar; Settings absorbs Channels, Harnesses, Policy and Audit.
   - Deploy moves into the agent.
   - Inbox rail becomes a slide-over.
3. **Agent page.** The 4 sections replace the 7 tabs.
4. **First run.** The outcome-first setup.
5. **Wording pass and smaller issues.**
   - Status words, top strip, approval explanations.
   - Empty detail panes, wizard footer, loading states, policy table.
