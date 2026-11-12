# beamhop — Plan (rev 3)

beamhop connects AI agent harnesses (Claude Code, Copilot CLI, Codex, Gemini CLI, OpenCode, pi, and any harness that speaks ACP) to messaging channels. Nostr is the first channel; Discord, Slack and Telegram follow. A harness can run on the user's laptop or on one of five cloud providers, and it always runs inside a sandbox the user configures. beamhop is controlled from an installable PWA or entirely from a CLI.

## 1. Decisions

| Topic | Decision |
|---|---|
| Use cases | Controlling your own agent remotely; agents talking to each other in a mesh; team or community bots |
| Runtime | **Node.js 24 LTS + TypeScript**, in a pnpm monorepo |
| Sandbox | **Anthropic `@anthropic-ai/sandbox-runtime` (srt)** on every OS |
| Harness discovery | Automatic, through a catalog plus probes (§3.1) |
| UI | **PWA** (React + React Aria), mobile-first, touch and swipe, WCAG 2.2 AA (§9) |
| Clouds | Hetzner, DigitalOcean, Fly.io, Render, Railway |
| Harness integration | Headless/SDK modes, ACP, and an MCP server that beamhop provides |
| Channel auth | Allowlist plus roles |
| Nostr | NIP-17 DMs, NIP-29 groups, public notes (kind 1), NIP-90 jobs (**no zaps or payments**) |
| Agent identity | **Public**: NIP-05 handle plus a published kind 0 profile |
| Secrets | OS keychain plus a broker; the agent never sees the real secret |
| Remote control | Over Nostr: encrypted control events, no open ports |
| Testing | **Public Nostr relays** with throwaway test keys |
| License | Apache-2.0 |
| Release | One launch with the full scope. The internal build order is in §11. |
| Mounts | The user mounts any directories they choose, each read-only or read-write |
| Mesh | Agents from different owners can talk to each other, within the guardrails in §6A.6 |
| Hosting | beamhop hosts a public copy of the PWA. **NIP-05 handles use the user's own domain only**: beamhop generates the `.well-known/nostr.json` file for the user to host. |
| Parallel writes | Each session gets its own git worktree when the mount is a git repo; mounts that aren't git repos use a write lock |
| Onboarding | A guided first-run wizard (§9A) |
| Cloud | Users can move an existing local agent to the cloud, or create an agent directly in the cloud |
| Teams | Several npubs can be owner or admin of the same agent |
| Updates | The signed catalog updates automatically; the app updates only after the user confirms |
| Cloud harness auth | Chosen per agent: an API key through the broker, or the user's subscription login (with a terms-of-service warning) |
| Approval timeout | Deny after 15 minutes by default (configurable). The agent is told the request was denied. |
| Retention | Configurable. Defaults: transcripts 30 days, audit log 1 year. Everything is encrypted at rest and can be exported or purged. |
| Media | Files and images in and out, plus rich formatting adapted to each channel. Voice is not in the launch. |
| Cross-channel posting | Only along routes the owner allows, for example `nostr:dm → slack:#deploys`. The default is to reply only where the message came from. |
| Presets | Opinionated presets that users can edit: Personal assistant, Code reviewer (read-only), Team dev bot, Public Q&A bot |
| i18n | English at launch. All text is in translation files from day one so other languages can be added. |
| Plugins | Third-party plugins are allowed at launch, sandboxed in srt and pinned by integrity hash |
| Behavior | Defined by each harness's own config. beamhop adds only channel context (§6A) |

## 2. Architecture

```
   PWA (phone / desktop browser, installable)            CLI (beamhop ...)
        │  local: HTTPS+WS on localhost                       │ local socket
        │  remote: encrypted Nostr control events             │
   ┌────▼──────────────────────── beamhopd (Node) ─────────────▼───────────────┐
   │  API (zod-typed JSON-RPC, same contract over WS, socket, Nostr)            │
   │  Router / Sessions ── AuthZ (principals, roles, budgets) ── Audit (SQLite) │
   │  Channel plugins: nostr │ telegram │ slack │ discord                       │
   │  Harness plugins: acp (generic) │ claude │ codex │ pi │ ...  + Discovery   │
   │  Sandbox: srt (fs + network allowlist)  ── Secret broker / LLM key proxy   │
   │  MCP server (channel + mesh tools for the agent)                           │
   │  Deployers: hetzner │ digitalocean │ fly │ render │ railway                │
   └────────────────────────────────────────────────────────────────────────────┘
```

### Monorepo (pnpm + turborepo)

```
apps/daemon        beamhopd (Fastify + ws)
apps/cli           beamhop CLI (commander; every command takes --json)
apps/pwa           React PWA (Vite + vite-plugin-pwa)
packages/core      types, plugin SDK, zod API contract, event bus
packages/sandbox   srt wrapper + policy profiles
packages/broker    secret broker + LLM key-injecting proxy
packages/mcp       MCP server exposing channel/mesh tools
packages/authz     principals, roles, approvals, budgets
packages/channel-{nostr,telegram,slack,discord}
packages/harness-{acp,claude,codex,pi}  + packages/harness-catalog (data)
packages/deploy-{hetzner,digitalocean,fly,render,railway}
```

### Plugin model
Each channel, harness and deployer is an npm package that exports a typed plugin object from `@beamhop/core`. Official plugins are bundled. Third-party plugins are installed with `beamhop plugin add <npm-pkg>`, pinned by integrity hash, and run in a child process sandboxed by srt that talks to the daemon over JSON-RPC.

```ts
interface ChannelPlugin {
  id: 'telegram' | string;
  setup: SetupWizard;                    // steps rendered by PWA and CLI (§5)
  connect(cfg, secrets): Promise<ChannelConn>;
}
interface ChannelConn {
  inbound: AsyncIterable<InboundMsg>;    // normalized: principal, thread, text, attachments
  send(msg: OutboundMsg): Promise<void>;
  resolvePrincipal(raw): Principal;
}
interface HarnessPlugin {
  id: string; detect(): Promise<Detection | null>;   // §3.1
  start(spec: SessionSpec, sandbox: SandboxHandle): Promise<HarnessSession>;
}
interface Deployer { plan(spec); apply(spec); status(id); logs(id); destroy(id); }
```

### Distribution
- `npm i -g beamhop` is the main install path.
- **Standalone binaries** are built with Node SEA (single executable application) and esbuild, for people without Node installed. They are shipped through Homebrew, winget, Scoop and deb/rpm packages.
- A container image `ghcr.io/beamhop/agent` is published for cloud use.

## 3. Harnesses

### 3.1 Discovery
`beamhop harness scan` runs at daemon start and whenever the user refreshes it in the PWA.

1. **Catalog:** `harness-catalog` is a versioned JSON list of known harnesses. Each entry records:
   - binary names (`claude`, `codex`, `copilot`, `gemini`, `opencode`, `pi`, ...)
   - npm, Homebrew and winget package names
   - config directories (`~/.claude`, `~/.codex`, ...)
   - how to launch it in headless or ACP mode
   - supported version ranges

   The catalog is updated separately from releases, and its signature is checked.
2. **Probe:** beamhop looks in PATH, in npm/pnpm/bun global bins, and in common install locations on each OS. For each hit it runs `--version`, then tries an **ACP `initialize` handshake** inside the sandbox to read the harness's capabilities.
3. **Auth check:** each harness is checked for being logged in or having an API key configured. The PWA shows it as ready, needs login, or unsupported version.
4. **Unknown ACP agents:** the user can add any command as `beamhop harness add --acp "<cmd>"`. If the handshake succeeds, it is registered as a generic ACP harness.
5. **Cloud:** remote daemons report their scan results over the control channel. A deploy can also preinstall the harnesses the user picks.

### 3.2 Adapters

| Harness | Mode |
|---|---|
| Any ACP agent | `harness-acp` (stdio JSON-RPC). Covers Gemini CLI, Copilot CLI, OpenCode and other ACP agents. |
| Claude Code | `@anthropic-ai/claude-agent-sdk`, which is native TypeScript. Its permission callback is routed to beamhop approvals. |
| Codex | `codex app-server` (JSON-RPC), with `codex exec --json` as fallback |
| pi | RPC/JSON mode. Verify the protocol before building this adapter. |

- **beamhop MCP server**, injected into each session. Tools:
  - `channel.send`, `channel.history`, `channel.members`
  - `mesh.ask_agent`, `mesh.post_job`, `mesh.list_agents`
- **Approvals:** when a harness asks for permission, policy for the sender's role decides one of three outcomes. It is auto-allowed, sent to the owner (PWA push or Nostr DM), or denied.
  - **No answer:** the request is denied after `approval_timeout`, which defaults to 15 minutes. The agent gets a "denied: timed out" result, so it can try another approach or stop.
  - **Logging:** every decision is recorded in the audit log, including who decided, or that the timeout did.

### 3.3 Media and formatting
- **Inbound files and images** are saved to `<session>/inbox/` inside the sandbox, and the agent is given their path and MIME type.
  - Nostr fetches them from Blossom (BUD-01) or NIP-96 URLs.
  - Telegram, Slack and Discord use their own file APIs.
  - Size and type limits apply per role. Downloads go through the broker, never directly from the sandbox.
- **Outbound files:** the MCP tool `channel.send_file` sends generated files, screenshots and diffs.
  - On Nostr, beamhop uploads to the owner's Blossom servers.
  - On other channels, it uses the native upload.
- **Formatting:** the agent writes Markdown, and each channel plugin renders it in that channel's format:
  - **Telegram:** MarkdownV2 or HTML
  - **Slack:** mrkdwn and Block Kit
  - **Discord:** Markdown and embeds
  - **Nostr:** plain text, with code fences kept

  Buttons (approve, deny, `/details`) use the channel's own components, and fall back to text commands where there are none.

## 4. Nostr channel (first channel)

- **Library:** `nostr-tools`.
- **Message types:**
  - **NIP-17** gift-wrapped DMs for one-to-one control and chat.
  - **NIP-29** relay groups for team channels and agent meshes. Group roles are mapped onto beamhop roles.
  - **Kind 1** public notes and replies, opt-in for each agent and rate-limited.
  - **NIP-90** job requests and results between agents. Payments are disabled: the `amount` and `bid` tags are ignored.
- **Public identity:**
  - Each agent has its own keypair, stored in the OS keychain.
  - It publishes a kind 0 profile and an optional NIP-05 handle on the owner's own domain. `beamhop identity nip05 --domain example.com` writes the `nostr.json` file and the hosting snippets (static host, nginx, Cloudflare Pages), then checks that the handle resolves.
  - The owner signs an attestation event linking the agent to the owner's npub, so anyone can verify who runs the agent.
- **Control plane:** a custom encrypted event kind carries the JSON-RPC API. Only npubs on the allowlist are accepted, with replay protection (event id plus a timestamp window).
- **Relays:**
  - Agents keep relay lists under NIP-65.
  - Reconnect uses backoff, and events are deduplicated.
  - Public agents get NIP-13 proof-of-work and rate limits to guard against spam.

### Testing on public relays
- Use throwaway keys generated per CI run, with a `["t","beamhop-test"]` tag.
- Use short-lived events (NIP-40 expiration) and NIP-09 deletion after each run.
- **DM, notes and jobs:** test on `wss://relay.damus.io`, `wss://nos.lol` and `wss://relay.primal.net`, each of which must also pass a NIP-11 check.
- **NIP-29:** test on a public NIP-29 group relay (to be chosen and verified).
- Tests tolerate a flaky relay: an event counts as delivered if any one relay in the set returns it.
- A local relay is used only for fast unit tests, never as the integration oracle.

## 5. Adding other channels (Telegram, Slack, Discord)

### Common flow
Channels can be added in two ways, and both run the plugin's `SetupWizard`:
- **PWA:** Channels, then "+ Add", then pick a provider.
- **CLI:** `beamhop channel add <provider>` runs interactively, or non-interactively with flags or environment variables in headless setups.

Each wizard goes through the same steps:
1. **Create the bot/app.** beamhop deep-links to the provider page and prefills settings wherever the provider allows it.
2. **Paste the credentials.** They go straight into the OS keychain and are never written to config files.
3. **Validate.** beamhop makes a live API call and shows the bot's name and avatar.
4. **Connect.** beamhop uses connections that need no public URL (long-polling, Socket Mode, or the gateway), so it works behind NAT and on laptops.
5. **Pair the owner.** beamhop shows a one-time code. The user sends `/pair <code>` to the bot, which links their account on that provider to their beamhop principal, with the owner role.
6. **Join.** The user picks which agent joins which chats or channels and what role other members get, for example `beamhop join myagent telegram:group/-100123 --default-role viewer`.

| Provider | What the user does | Credentials | Transport |
|---|---|---|---|
| **Telegram** | Opens @BotFather, sends `/newbot`, copies the token. For groups: adds the bot to the group, and turns privacy mode off if the agent should read every message. | Bot token | Bot API long-polling (`getUpdates`) |
| **Slack** | Clicks a beamhop **"Create app from manifest"** link with the scopes, events and Socket Mode prefilled, installs the app to the workspace, then invites the bot to channels. | App token `xapp-` + bot token `xoxb-` | Socket Mode, through `@slack/bolt` |
| **Discord** | Creates an application in the Developer Portal, adds a bot, enables the **Message Content** intent, and copies the token. beamhop generates the OAuth2 invite URL with minimal permissions, which the user opens to add the bot to a server. | Bot token | Gateway websocket, through `discord.js` |

### Headless example
```bash
BEAMHOP_TELEGRAM_TOKEN=... beamhop channel add telegram --name mybot --token-env BEAMHOP_TELEGRAM_TOKEN
beamhop channel pair mybot           # prints code; send /pair <code> to the bot
beamhop join myagent mybot:dm --role owner
```

### Common mapping
- Every provider's messages are normalized into one shape: `Principal = provider:userId`, thread maps to session, attachments go into the sandbox workspace inbox.
- One person can link several accounts (an npub, a Telegram account and a Slack account) into a single identity, so a role granted once applies on every channel.

## 6. Authorization

- **Roles:** `owner`, `admin`, `user`, `viewer` and `agent` (a peer agent in the mesh), plus custom roles.
- **Teams:** several npubs can hold `owner` or `admin` on the same agent, with no accounts server.
  - **Approvals:** the first approval from any owner wins by default. A policy can require N of M owners instead.
  - **Role changes** are signed Nostr events, so every daemon and device can check who granted what.
  - **Owner list:** at least one owner must remain. Removing an owner means rotating the control-plane allowlist on every daemon.
- Each role sets:
  - the harness permission mode
  - the srt policy profile
  - which tools are allowed
  - which actions need approval
  - rate limits and budgets (tokens, dollars, minutes)
- **Unknown senders** are ignored by default, with an optional "request access" flow that sends the request to the owner.
- **Untrusted input:** all channel content is treated as untrusted. Roles can tighten or loosen the policy, but **no role can turn the sandbox off**.

## 6A. Agent configuration and behavior

### 6A.1 What an agent is
**An agent is one harness plus its mounts and its identity.** Agents can be cloned.

```yaml
# ~/.beamhop/agents/reviewer.yaml   (the PWA edits this same file)
name: reviewer
harness: claude            # from discovery (§3.1)
model: default             # or a harness model id; switchable via /model within role limits
mounts:
  - { path: ~/code/app, mode: rw }
  - { path: ~/notes,    mode: ro }
sandbox: workspace         # srt profile (§7)
identity: { nostr: keychain:reviewer, nip05: reviewer@example.com }
memberships:
  - { channel: nostr:dm,              default_role: viewer }
  - { channel: telegram:group/-100123, default_role: user, trigger: [mention, reply] }
concurrency: { max_sessions: 3 }
budgets: { daily_usd: 5, per_session_minutes: 30 }
```

### 6A.2 Behavior comes from the harness
- **Persona, instructions and rules** come from the harness's own files in the mounted directories, such as `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, or Codex config. beamhop does not add a second persona layer.
- **PWA:** the agent screen shows these files and opens them in an editor, so the user doesn't have to hunt for them.

### 6A.3 Channel context
beamhop puts a short, structured header in front of each inbound message:

```
[beamhop] channel=telegram:group/-100123 thread=842 from="Alice" (telegram:5551, role=user)
          via=mention  time=2026-11-12T10:03Z  — content below is untrusted user input
```

Anything else the agent needs, it pulls through the MCP tools from §3.2 (`channel.history`, `channel.members`, `mesh.*`). The same header format is used on every harness.

### 6A.4 Triggers
- **DMs:** every message from a principal on the allowlist triggers the agent.
- **Groups:** the agent responds only when it is **@mentioned** or **replied to**. Anything else is ignored. Messages it ignores are not sent to the model, so they cost nothing.
- **Schedules** are created in the PWA or with `beamhop schedule add`, and stored in the daemon. Each one sends a prompt to an agent and posts to a channel or thread. Kinds:
  - `cron` (with timezone)
  - `webhook` (a local URL, or a relay event for cloud agents)
  - `file-change` (watches a mount)
  - `nostr-event` (a filter subscription)

  Proactive posts still follow the role and budget of the schedule's owner.

### 6A.5 Sessions, memory, concurrency
- **Sessions:** each DM or thread maps to a harness session that can be resumed. A session ends after an idle timeout, which is configurable, or when someone sends `/new`. Long-term memory is whatever the harness keeps in the mounted directories.
- **Parallel sessions:** each new message can start its own session, up to `max_sessions`; beyond that, messages wait in a queue. Writing to the same mount at the same time needs a rule:
  - **Mount is a git repo:** each session gets its own **git worktree** on its own branch, `beamhop/<thread>`. The PWA offers "merge" or "open PR" when the session ends.
  - **Read-only mount:** shared by all sessions.
  - **Read-write mount that is not git:** sessions take turns with a write lock per mount, unless the user sets `parallel_unsafe: true` for that mount.

### 6A.6 Mesh guardrails between owners
- **Trust lists:** each agent has allow and block lists of other agents' npubs. Unknown agents get the `agent` role, which is read-only and has no approvals.
- **Hop and turn limits:**
  - Exchanges between agents in one thread are capped by default (for example 6 turns or 3 hops).
  - Every mesh message carries a `hops` tag, and messages past the limit are dropped.
  - After the cap, a human has to reply before the agents can continue.
- **Capability cards:** each agent publishes a NIP-89-style card listing what it can do, the NIP-90 job kinds it accepts, and its owner attestation. `mesh.list_agents` discovers agents through these cards.
- **Per-peer budgets:** a token or minute allowance per external npub, reset daily. Any job from a peer agent stays inside the srt profile set by the receiving owner.

### 6A.7 In-channel commands
Which commands a user can run depends on their role.

| Command | Purpose |
|---|---|
| `/new` `/stop` `/status` `/resume` `/details` | Session control. `/details` shows the tool calls that are hidden by default. |
| `/approve <id>` `/deny <id>` | Approve or deny actions. Telegram, Slack and Discord also show native buttons; Nostr uses reply commands. |
| `/model` `/harness` `/mode plan\|auto\|read-only` | Change settings for this session, within the limits the role allows |
| `/usage` | Tokens, cost and minutes left in the budget |

### 6A.8 Output style
- **Live-edited reply** on Telegram, Slack and Discord, which beamhop updates as the agent streams. It is throttled to about one edit per second to stay under rate limits.
- **Nostr** has no message edits. beamhop sends a typing status, short progress notes, and then the final reply.
- **Progress lines** (for example "running tests…") and a typing indicator are shown while the agent works.
- **Tool calls** are hidden in the channel and available through `/details` or the PWA session view.

## 7. Sandboxing with srt

- Every harness process is wrapped in **srt**, used as a library (`SandboxManager`) by `packages/sandbox`, not only through its CLI. srt provides:
  - **Filesystem** rules (allowed and denied reads and writes). This uses Seatbelt on macOS and bubblewrap on Linux.
  - **Network**: deny by default, with host-side HTTP and SOCKS proxies that apply a domain allowlist and block loopback and metadata IPs.
  - **Windows**: alpha. It runs the harness as a dedicated sandbox user, with a firewall (WFP) egress fence. **Fallback:** WSL2 plus srt on Linux.
- **Policy profiles** are defined by beamhop and compiled to srt settings: `strict` (default for non-owners), `workspace` (default for the owner), and `custom`. The PWA editor shows them as toggles and lists.
- **Learning mode:** beamhop runs in permissive mode and logs srt violations. The PWA then proposes "allow these 3 domains?" as swipeable cards.
- **Secrets:**
  - **LLM keys:** beamhop points the harness's base URL at a local broker, for example `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` or `OPENAI_BASE_URL`. The broker adds the real key and forwards the request over TLS. No TLS interception is needed, and the sandbox only ever holds a placeholder.
  - **Other tokens** (GitHub and similar) are short-lived, scoped tokens minted per session where the provider supports it. Otherwise they are passed through explicitly per role.
  - **Never readable** inside the sandbox: `~/.ssh`, `~/.aws`, `~/.config/gh`, keychains, and browser profiles. Environment variables are passed only from an allowlist.
- **Prerequisites:** on Linux, srt needs `bubblewrap`, `socat` and `ripgrep`. `beamhop doctor` checks for these, plus Ubuntu's AppArmor setting that restricts unprivileged user namespaces, and prints the fix for each problem.
- **Cloud PaaS** (Render, Railway): containers there may not allow user namespaces, so bubblewrap may fail. `doctor` detects this. In that case the platform's container is the filesystem boundary, and srt's network proxy and the broker still apply. Verify this per provider. Fly machines are Firecracker VMs, where srt is expected to run normally.

### Harness auth on cloud agents (per agent)
- **API key** (default): the key stays on the owner's machine, or in the remote vault, and the broker injects it. The sandbox never holds it.
- **Subscription login:** device-code or OAuth login for the harness, run on the server through the PWA. A warning is shown, with a link to that provider's terms, because some subscription plans don't allow use on servers or by other people. The tokens are kept in the remote vault, and the harness reads them from a mount the broker controls.

## 7A. Threat model

**Assumption:** any agent may be **fully prompt-injected** through any channel. These four outcomes must still be prevented.

| Threat | Controls |
|---|---|
| **Data exfiltration** | srt egress allowlist; the broker holds all secrets; deny-read paths; downloads only through the broker; **an outbound DLP check** (below); cross-channel posting only on owner-set routes |
| **Host compromise** | srt on every harness and plugin; mounts read-only by default; no role can turn the sandbox off; optional microVM tier later |
| **Impersonation** | Each agent has its own identity and never holds owner keys; agents cannot post as the owner; owner attestation is public; route allowlists |
| **Spend abuse** | Budgets per agent, role, peer agent and session; the broker counts tokens itself; `max_sessions`; hop limits; caps on cloud deploys that need owner approval |

### Outbound DLP check
Before any message or file goes to a principal who is not an owner, beamhop scans it:
- **Patterns:** gitleaks-style secret patterns, plus the exact values of every secret the broker holds.
- **On a match:** the secret is redacted, or the message is blocked, depending on the role. The event is logged and owners are alerted.
- **Messages to owners:** scanned too, but only warned about, not blocked.

### Revocation: the simple model
- **Revoking an agent's access to a channel** is done the platform-native way: the owner kicks or removes the agent from the Slack channel, Telegram group, Discord server or NIP-29 group, just like removing a human.
  - beamhop treats that as "this membership is gone".
  - It does not rejoin automatically; the owner has to re-add it explicitly.
  - There is no key rotation.
- **Lost phone:** the PWA's paired-device list has a plain **Remove** button, which deletes that device from the daemon's allowlist. This is not key rotation.

### Emergency stop
- **Global:** `beamhop panic` or the PWA's stop button:
  - kills every session
  - pauses all schedules
  - disconnects all channels
  - sends the same command to cloud daemons over Nostr
- **Per agent:** `beamhop agent stop <a> --hard`.
- **Recovery:** `beamhop resume` brings things back. beamhop never resumes on its own after a panic.

## 8. Secrets storage

**Retention:**
- **Defaults:** transcripts 30 days, audit log 1 year, both configurable per agent.
- **Encryption at rest:** SQLite with a key held in the keychain.
- **Commands:** `beamhop data export` and `beamhop data purge --agent <a> [--before <date>]`.
- **Cloud daemons** apply the same retention policy.

- **Laptops:** the OS keychain, through `@napi-rs/keyring`: macOS Keychain, Windows Credential Manager, or libsecret on Linux.
- **Headless Linux:** an age-encrypted vault, unlocked by a passphrase or a systemd credential.
- **Cloud:** secrets are sent over the encrypted Nostr control channel and stored in the remote host's vault. Provider API tokens never leave the user's machine.

## 9. PWA and UX

### Stack
- **React 19 + TypeScript + Vite.**
- **React Aria Components** (Adobe) for accessible primitives: keyboard navigation, screen readers, focus management, and touch "press" handling that is consistent across pointer types.
- **Tailwind v4** with design tokens. The theme has light and dark modes and a high-contrast option.
- **Motion** for gestures, swipe and spring animations. It respects `prefers-reduced-motion`.
- **TanStack Router + Query**, with an IndexedDB cache so the app opens offline.
- **vite-plugin-pwa (Workbox):** the app is installable, works offline, gets background sync, and receives **Web Push** for approvals. Push needs iOS 16.4 or later, with the PWA installed.

### Hosting
The PWA is static. It is served by the local daemon and also hosted publicly, at app.beamhop.dev or GitHub Pages.
- The **hosted** copy reaches daemons over **Nostr**. The user signs in with a NIP-46 bunker, a NIP-07 browser extension, or a device key paired by QR code from `beamhop pair-device`. A phone can then control a laptop or cloud agents from anywhere, with no open ports.
- The **local** copy uses the daemon's localhost WebSocket.

### Screens (mobile-first, bottom tab bar, one-handed reach)
1. **Home:** agent cards showing status, channel, last activity and budget meters. Pull to refresh.
2. **Inbox (approvals):** a card stack. Swipe right to approve, swipe left to deny, long-press for details. Large Approve and Deny buttons are always visible as the accessible alternative. Approved actions can be undone for a short time.
3. **Session view:** a live stream of the agent's chat and tool calls, with collapsible tool output and a composer for steering the agent. Swipe between sessions.
4. **Channels:** list of channels and the add-channel wizard (§5), showing step progress, a QR code or deep link, and live validation.
5. **Harnesses:** discovery results with a ready, needs login, or install status, and an "Install" helper.
6. **Policy:** profile toggles, domain chips, path pickers, and learning-mode suggestions.
7. **Deploy:** pick a provider, pick a size, then confirm a diff before deploying. Shows live logs.
8. **Audit:** a log that can be filtered and exported.

### Accessibility
- Meets WCAG 2.2 AA.
- Touch targets are at least 44 px.
- Focus is always visible, and every gesture has a button alternative.
- Updates are announced to screen readers through ARIA live regions.
- Pages zoom to 200% without breaking.
- The PWA is tested with axe and Playwright on desktop and mobile viewports, and manually with VoiceOver and TalkBack.

### Desktop
Installing the PWA from the browser is the desktop app. A small tray helper (Node `systray`) is optional and does two things: it starts the daemon at login and opens the PWA.

## 9A. Onboarding (first run)

`npx beamhop` (or the installed binary) starts a wizard. It runs as a terminal UI, or in the PWA if the user opens it. Target: about 3 minutes.

1. **Doctor:** checks srt and its prerequisites (bwrap, socat and ripgrep on Linux; WSL2 on Windows). It offers to fix what is missing, or explains what the user needs to do.
2. **Harness discovery:** lists what was found, marked ready, needs login, or not installed. The user can log in or install a harness from this screen.
3. **Identity:** creates the owner npub, or imports one through NIP-07 or a NIP-46 bunker, and stores it in the keychain.
4. **Pair a phone:** scan a QR code to open the hosted PWA. It becomes a device key on the control allowlist and turns on push notifications.
5. **First agent:** pick a harness, mount a folder (read-only by default), and pick a sandbox profile. beamhop creates the agent's identity.
6. **First channel:** the agent joins a Nostr DM with the owner. beamhop sends a hello message, and the user replies from their phone. This round trip confirms the whole chain works.
7. **Next steps:** add Telegram, Slack or Discord; set up a NIP-05 handle; move the agent to the cloud.

## 9B. Monitoring and alerts

- **Live session view:** streamed messages, tool calls and file diffs, in the PWA.
- **Cost and usage charts:** broken down by agent, channel, peer agent and day. Data comes from the harness's usage events and from the LLM key broker, which counts tokens itself.
- **Security events:**
  - srt violations (blocked paths and hosts)
  - blocked or rate-limited peer agents
  - failed pairings
  - unknown senders
  - hop-limit trips
- **Alerts:** Web Push or a Nostr DM to owners when a budget passes 80% or 100%, an agent crashes, a cloud agent goes offline (heartbeat over Nostr), or a security event spikes. Thresholds can be set per agent.

## 10. Cloud deployment

There are two entry points:
- **"Move to cloud"** on an existing agent. Its config and identity move with it; the local copy stops, or stays as a standby.
  - **Git mounts** are cloned on the server.
  - **Other mounts** are copied once with rsync over SSH (VPS) or a volume upload (PaaS). Ongoing sync with Mutagen is opt-in per mount.
- **"New cloud agent":** the agent is created directly on the server. Its mounts are git repos or empty volumes.

Both entry points show the estimated monthly cost and the plan before anything is applied.

| Provider | How |
|---|---|
| Hetzner, DigitalOcean | Create a VPS through the provider API, then cloud-init installs Node, beamhopd, srt and its prerequisites, and the selected harnesses. The firewall allows outbound traffic only. |
| Fly.io, Render, Railway | Deploy the `ghcr.io/beamhop/agent` image as a worker with no inbound ports. |

- **Commands:** `beamhop deploy plan|apply|status|logs|destroy --provider <p> --agent <a>`.
- **State** is kept locally and mirrored to an encrypted Nostr event, so a second device can manage the deployment.
- **Control** of a remote daemon happens only over Nostr.

## 11. Build order (internal; one public launch)

1. **Monorepo and core:** plugin SDK, API contract, the daemon, the CLI, SQLite audit log, keychain storage.
2. **Harness layer:** discovery and catalog, then the ACP, Claude, Codex and pi adapters, then the MCP server and approvals.
3. **Sandbox:** srt integration, policy profiles, the broker, learning mode, `doctor`.
4. **Nostr:** NIP-17, then NIP-29, then kind 1, then NIP-90, plus public identity and the control plane. Integration tests run on public relays.
5. **Authorization:** principals, identity linking, roles, budgets.
6. **PWA:** all screens, push notifications, device pairing, accessibility pass.
7. **Channels:** Telegram, then Slack, then Discord, with setup wizards.
8. **Cloud:** Hetzner and DigitalOcean, then Fly, Render and Railway.
9. **Hardening:** external security review, fuzzing of the parsers, and prompt-injection red-team tests.
10. **Launch:** binaries, signing and notarization, docs. Private dogfooding runs from step 4 onward.

## 12. Quality and ops

- **Tests:**
  - Vitest unit tests.
  - Contract tests against each harness version.
  - Sandbox escape tests on each OS: read `~/.ssh`, reach a blocked host, reach the metadata IP.
  - Playwright tests for the PWA.
- **CI:** GitHub Actions runs on Linux, macOS and Windows.
- **Releases:** npm packages are published with provenance. Binaries are signed and notarized, and the container image is signed with cosign.
- **Telemetry:** off by default. Logs are local and in OpenTelemetry format.
- **Updates:**
  - **Harness catalog:** signed, fetched every day, and applied automatically.
  - **beamhop itself:** the CLI or PWA shows a prompt, and the update installs only after the user confirms.
  - **Cloud daemons:** follow the owner's local version. They update only after the user confirms, and roll back automatically if the post-update health check fails.

## 13. Risks and open questions

- **Windows:** srt on Windows is still alpha, so WSL2 is the fallback. Track srt releases.
- **srt on PaaS:** whether user namespaces work on Render and Railway needs verifying.
- **Harness churn:** CLI flags and protocols change often. Mitigations: prefer ACP, ship the catalog updates separately from releases, and run contract tests nightly.
- **Prompt injection:** the sandbox limits the damage, and roles, budgets and approvals are the other defences.
- **Public relays:** test runs are rate-limited and the tests are written to tolerate flaky relays.
- **Parallel sessions on mounts that are not git repos:** the write lock makes sessions take turns, which partly defeats running them in parallel. Watch how people actually use this.
- **Cross-owner mesh:** spam and abuse. Mitigations: trust lists, hop limits, per-peer budgets, and proof of work for unknown peers.
- **Third-party plugins:** a supply-chain risk. Mitigations: srt sandbox, integrity pinning, and a permission prompt at install that lists what the plugin can access.
