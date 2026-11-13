# beamhop

**Your coding agents, on the channels you already live in — and inside a box they can't climb out of.**

beamhop joins AI agent harnesses (Claude Code, Codex, Gemini CLI, Copilot CLI, OpenCode, pi, and anything
that speaks [ACP](https://agentclientprotocol.com)) to **Nostr, Telegram, Slack and Discord**. Message your
agent from your phone, let a team ping a code-review bot in a channel, or let agents from different owners
talk to each other in a mesh. Every harness runs in a sandbox you configure, holds no real secrets, and
asks you before it does anything risky.

It runs on your laptop or on one of five clouds, and you drive it from an installable PWA or entirely
from the CLI.

> Status: pre-1.0. The core loop (channel → sandboxed harness → reply) works end to end on public Nostr
> relays; see [CHANGELOG.md](CHANGELOG.md) for what is in this build and what is still landing.

## 60-second quickstart

You need Node.js 22.12+ (or a [standalone binary](docs/quickstart.md#standalone-binaries)), and on Linux
`bubblewrap`, `socat` and `ripgrep` for the sandbox (`beamhop doctor` tells you exactly what's missing).

```bash
npx beamhop daemon          # terminal 1: the daemon (keep it running)
npx beamhop init            # terminal 2: first-run wizard, about 3 minutes
```

`init` walks seven skippable steps: **doctor** → **harness discovery** → **owner identity** (a Nostr key,
or bring your own npub) → **pair your phone** (QR) → **first agent** (pick a harness, mount a folder
read-only) → **hello** (the agent DMs you over Nostr; reply from your phone to prove the whole chain) →
**next steps**. Then:

```bash
beamhop status                                   # daemon, agents, approvals at a glance
beamhop ui                                       # open the local web UI (URL carries your token)
BEAMHOP_TELEGRAM_TOKEN=... beamhop channel add telegram --name mybot --token-env BEAMHOP_TELEGRAM_TOKEN
beamhop channel pair mybot                       # send /pair <code> to the bot → you are its owner
beamhop join myagent mybot:dm --role owner
```

Prefer a permanent install: `npm i -g beamhop`, or grab a binary from the
[releases page](https://github.com/beamhop/beamhop/releases) (Homebrew, Scoop and winget manifests are
generated with every release).

## How it fits together

```
  phone / browser (PWA)                         terminal (beamhop CLI)
        │ localhost WS  ·  remote: encrypted Nostr control events │ localhost HTTP + token
  ┌─────▼──────────────────────────── beamhopd ───────────────────▼──────────────────────┐
  │  JSON-RPC API (one zod contract for WS, HTTP, socket and Nostr)                      │
  │  Router ── Sessions ── AuthZ (owners, roles, budgets, approvals) ── Audit (SQLite)   │
  │  Channels:  nostr · telegram · slack · discord         Deployers: hetzner · do ·     │
  │  Harnesses: acp · claude · codex · pi  + discovery                fly · render · railway
  │  Secret broker + LLM key proxy  ·  outbound DLP  ·  MCP bridge (channel/mesh tools)   │
  └───────────────┬───────────────────────────────────────────────┬──────────────────────┘
                  │ spawns, per session                            │ placeholder key only
        ┌─────────▼─────────── srt sandbox ─────────────┐   ┌──────▼──────────┐
        │ harness (claude / codex / gemini / …)         │──▶│ broker adds the │──▶ LLM API
        │  + beamhop-mcp (stdio)    mounts: ro / rw     │   │ real key (TLS)  │
        │  fs allow/deny · egress allowlist · no ~/.ssh │   └─────────────────┘
        └───────────────────────────────────────────────┘
```

Messages from a channel are normalized (`principal = provider:userId`, thread → session), prefixed with a
short `[beamhop] channel=… from=… role=…` header that marks them as untrusted, and routed to the agent's
harness. Replies stream back with the channel's native formatting; tool calls stay hidden unless you ask
for `/details`.

## Security model in one screen

beamhop assumes **any agent may be fully prompt-injected through any channel** and tries to make that
boring:

- **Sandbox, always.** Each harness process runs under Anthropic's
  [sandbox-runtime (srt)](https://github.com/anthropics/sandbox-runtime): bubblewrap on Linux,
  Seatbelt on macOS. Filesystem allow/deny rules, deny-by-default network with a domain allowlist, and
  `~/.ssh`, `~/.aws`, `~/.config/gh`, keychains and browser profiles are never readable. No role can turn
  the sandbox off.
- **No real secrets inside.** LLM keys stay in the OS keychain; the harness gets a placeholder and a local
  base URL, and the broker injects the key upstream. Requests that ask the provider to fetch URLs for the
  agent (server-side web/MCP tools) are refused by default.
- **beamhop is the only approval gate.** Every harness runs in a mode that forwards permission requests;
  policy per role auto-allows, asks an owner (push / DM / channel buttons) or denies. No answer in 15
  minutes means denied.
- **Roles, budgets, routes.** `owner` / `admin` / `user` / `viewer` / `agent`; per-agent, per-role,
  per-peer and per-session budgets; cross-channel posting only along routes you allow; strangers are
  ignored unless an agent is explicitly `public`.
- **Outbound DLP.** Messages to non-owners are scanned for secret patterns and the exact values the broker
  holds, including obfuscated and encoded forms.
- **Big red button.** `beamhop panic` kills every session, pauses schedules and disconnects channels
  (cloud daemons too). Nothing resumes until you say `beamhop resume`.

What it does **not** protect against is written down too: see [docs/sandbox.md](docs/sandbox.md#what-is-not-protected)
and the security reviews in [docs/security](docs/security/). Report vulnerabilities via [SECURITY.md](SECURITY.md).

## What's supported

| Harnesses (auto-discovered)                                                                      | Protocol                                 |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| Claude Code                                                                                      | Claude Agent SDK (in-process)            |
| Codex CLI                                                                                        | `codex app-server` (JSON-RPC)            |
| pi                                                                                               | `--mode rpc` + approval extension        |
| Gemini CLI, GitHub Copilot CLI, OpenCode, Cursor CLI, goose, Qwen Code, Auggie, Kimi Code, Cline | ACP                                      |
| Any other ACP agent                                                                              | `beamhop harness add <id> --acp "<cmd>"` |

| Channels     | Transport (no public URL needed)                             | You provide                                     |
| ------------ | ------------------------------------------------------------ | ----------------------------------------------- |
| **Nostr**    | relays; NIP-17 DMs, NIP-29 groups, kind 1 notes, NIP-90 jobs | nothing: each agent gets its own key            |
| **Telegram** | Bot API long polling                                         | bot token from @BotFather                       |
| **Slack**    | Socket Mode                                                  | app token + bot token (manifest link prefilled) |
| **Discord**  | Gateway websocket                                            | bot token (Message Content intent)              |

| Clouds       | How                                                     |
| ------------ | ------------------------------------------------------- |
| Hetzner      | VPS via API + cloud-init, outbound-only firewall        |
| DigitalOcean | Droplet via API + cloud-init, outbound-only firewall    |
| Fly.io       | `ghcr.io/beamhop/agent` machine, no inbound ports       |
| Render       | `ghcr.io/beamhop/agent` background worker               |
| Railway      | `ghcr.io/beamhop/agent` service, no domain or TCP proxy |

Platforms: Linux and macOS are first-class. Windows works with srt's alpha backend, with WSL2 as the
fallback.

## Docs

- [Quickstart](docs/quickstart.md) — install options, first agent, first channel
- [Channels](docs/channels.md) — Nostr, Telegram, Slack and Discord setup, step by step
- [Harnesses](docs/harnesses.md) — discovery, adapters, approvals, adding any ACP agent
- [Sandbox](docs/sandbox.md) — profiles, learning mode, what is and isn't protected
- [Cloud](docs/cloud.md) — moving agents to Hetzner, DigitalOcean, Fly.io, Render, Railway
- [PWA](docs/pwa.md) — the control panel, pairing a phone
- [CLI reference](docs/cli.md) — every command, generated from the CLI itself
- [FAQ](docs/faq.md)
- [Contributing](CONTRIBUTING.md) · [Security policy](SECURITY.md) · [Changelog](CHANGELOG.md)

## License

[Apache-2.0](LICENSE). beamhop agents always identify as AI agents operated by their owner.
