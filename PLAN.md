# beamhop — Plan

beamhop connects AI agent harnesses (Claude Code, Copilot CLI, Codex, Gemini CLI, OpenCode, pi, and any harness that speaks ACP) to messaging channels. Nostr is the first channel; Discord, Slack and Telegram follow. A harness can run on the user's laptop or on one of five cloud providers. Every harness runs inside a sandbox that the user configures. beamhop can be driven from a UI or entirely from a CLI.

## 1. Decisions (from interview)

| Topic | Decision |
|---|---|
| Use cases | Controlling your own agent remotely; agents talking to each other in a mesh; team or community bots |
| Language | Go: one static binary for Windows, macOS and Linux |
| UI | One web frontend, served two ways: inside a desktop app, and by the daemon on servers |
| Clouds | Hetzner, DigitalOcean, Fly.io, Render, Railway |
| Harness integration | Headless/SDK modes, ACP, and an MCP server that beamhop provides |
| Harnesses | Claude Code, Copilot CLI, Codex CLI, Gemini CLI, OpenCode, pi, and any other ACP harness |
| Channel auth | Allowlist plus roles |
| Nostr transport | NIP-17 DMs, NIP-29 groups, public notes (kind 1), NIP-90 DVM jobs |
| Secrets | OS keychain plus a broker; the agent never sees the real secret |
| Remote control | Over Nostr itself (encrypted control events, no open ports) |
| License | Open source (Apache-2.0 recommended, because it includes a patent grant) |
| Release | One launch with the full scope. The internal build order is in §10. |

## 2. Architecture

```
            ┌──────────── UI (web frontend: Wails desktop / daemon-served) ────────────┐
            │                                   CLI (beamhop ...)                       │
            └──────────────┬─────────────────────────────────────────┬──────────────────┘
                           │ local API (unix socket / named pipe)     │ remote control over Nostr
                     ┌─────▼──────────────────── beamhopd ───────────▼─────────────┐
                     │  Router / Session mgr ── Policy & Roles ── Audit log         │
                     │      │            │                │                        │
                     │  Channel adapters  Harness adapters  Sandbox backends        │
                     │  (nostr, discord,  (acp, claude,     (seatbelt, bwrap+       │
                     │   slack, telegram) codex, pi, ...)    landlock, mxc/appcont, │
                     │                                       microvm, gvisor)       │
                     │      Egress proxy + Secret broker  ── Keychain               │
                     │      MCP server (channel tools exposed to the harness)       │
                     │      Deployers (hetzner, do, fly, render, railway)           │
                     └──────────────────────────────────────────────────────────────┘
```

**Core rule:** every part that can vary is a Go interface defined in `pkg/` and registered in a registry. Adding a new channel, harness, sandbox or cloud provider means adding one package and leaves the core untouched. Later versions can also load out-of-process plugins over gRPC with `hashicorp/go-plugin`.

### Core interfaces (sketch)

```go
type Channel interface {   // nostr, discord, slack, telegram
    Connect(ctx, cfg) error
    Subscribe(ctx, filter) (<-chan InboundMsg, error)
    Send(ctx, OutboundMsg) error
    Identity() Principal                 // how senders are identified (npub, discord user id...)
}

type Harness interface {   // acp, claude, codex, copilot, gemini, opencode, pi
    Capabilities() HarnessCaps           // streaming, tool approval hooks, resume, MCP support
    Start(ctx, SessionSpec, Sandbox) (Session, error)
}
type Session interface {
    Prompt(ctx, Input) (<-chan Event, error)   // text, tool_call, permission_request, done
    Approve(ctx, reqID, Decision) error
    Cancel(ctx) error; Close() error
}

type Sandbox interface {   // seatbelt, bwrap, mxc, microvm, gvisor, none(cloud-vm)
    Probe() Support                       // available on this host? strength?
    Wrap(cmd *exec.Cmd, Policy) (*exec.Cmd, error)
}

type Deployer interface {  // hetzner, digitalocean, fly, render, railway
    Plan(ctx, DeploySpec) (Diff, error); Apply(ctx, DeploySpec) (Deployment, error)
    Status(ctx, id) (State, error); Destroy(ctx, id) error; Logs(ctx, id) (io.ReadCloser, error)
}
```

### Repository layout

```
cmd/beamhop        CLI (cobra)             cmd/beamhopd   daemon
pkg/channel/{nostr,discord,slack,telegram}
pkg/harness/{acp,claude,codex,pi,...}      pkg/sandbox/{policy,seatbelt,bwrap,landlock,windows,microvm,gvisor}
pkg/proxy          egress proxy + secret broker
pkg/mcp            MCP server exposing channel tools
pkg/authz          principals, roles, approvals
pkg/deploy/{hetzner,digitalocean,fly,render,railway}
pkg/api            local API (protobuf/Connect) shared by CLI, UI and remote-over-Nostr
ui/                web frontend (Svelte or React + TS)
desktop/           Wails shell
```

## 3. Harness adapters

beamhop prefers **ACP (Agent Client Protocol)** as the common protocol, because it carries streaming, tool-permission requests, sessions and MCP server injection. A native adapter is used where a harness has no ACP support, or where its native protocol is richer.

| Harness | Mode | Notes |
|---|---|---|
| Generic ACP | `acp` adapter | Covers any harness that speaks ACP over stdio. Gemini CLI, Copilot CLI, OpenCode and others use this path first. |
| Claude Code | Agent SDK / `claude -p --output-format stream-json --input-format stream-json` | Uses the native permission-prompt tool, which is then routed to the channel for approval. The ACP adapter is a fallback. |
| Codex CLI | `codex app-server` (JSON-RPC), fallback `codex exec --json` | |
| Copilot CLI | ACP mode | |
| Gemini CLI | ACP mode | |
| OpenCode | ACP mode or its server API | |
| pi | RPC/JSON mode | Verify the protocol before building the adapter. |

- **MCP server from beamhop:** each session gets tools such as `channel.send`, `channel.read_history`, `channel.list_members`, `mesh.ask_agent` and `mesh.post_job` (NIP-90). These let the agent act inside the channel on its own initiative, not only reply.
- **Approval routing:** when the harness asks for permission, beamhop decides where the request goes based on the sender's role. It is either auto-approved by policy, sent to the owner as a DM or push, or shown in the UI.
- **Version pinning:** harness CLIs change often. Each adapter declares the version ranges it supports, and a contract test runs against every one.

## 4. Channels

### Nostr (first), using `nbd-wtf/go-nostr`
- **NIP-17** (gift-wrapped DMs, NIP-44 encryption) for one-to-one conversations with the owner or a user.
- **NIP-29** relay groups for team channels and agent meshes. NIP-29 membership is mapped onto beamhop roles.
- **Kind 1** public notes and replies, opt-in for each agent, with rate limits.
- **NIP-90 DVM** for structured jobs between agents: request kinds 5xxx, results 6xxx, feedback 7000. Payment over zaps is optional and comes later.
- **Identity:** each agent has its own keypair, which the owner's key links to its agent keys with a signed attestation event. Keys are stored in the OS keychain; NIP-46 bunker signing is optional.
- **Relays:** relay lists per agent (NIP-65), reconnect with backoff, deduplication, and replay protection based on event id plus a timestamp window.
- **Control plane:** custom encrypted event kinds carry the local API (protobuf inside NIP-44) between the owner's devices and their daemons. Only keys on the allowlist can call the control API.

### Later channels
Discord (bot gateway), Slack (Socket Mode, so no public URL is needed), and Telegram (Bot API long-polling). Each one maps its user IDs to beamhop principals, and threads to sessions.

## 5. Authorization model

- **Principal** = (channel, id), for example `nostr:npub…`, `discord:1234`. Principals can be linked into a single person.
- **Roles:** built in are `owner`, `admin`, `user`, `viewer` and `agent` (a peer agent in the mesh). Custom roles are allowed.
- Each role sets:
  - the harness permission mode
  - the sandbox policy profile
  - which tools are allowed or denied
  - which approvals are needed
  - rate limits and budgets (tokens, dollars, minutes)
- Unknown senders are ignored by default, with an optional "request access" flow.
- **Session mapping:** each (agent, channel thread or DM) gets its own conversation and working directory, which can be persistent or ephemeral.
- **Prompt-injection posture:** all channel content is treated as untrusted. Even for the owner, the sandbox and the egress policy stay on. Roles can change the policy but cannot switch the sandbox off.

## 6. Sandboxing (research summary)

Industry practice in 2026 has settled on two layers. One is an **OS-native process sandbox**. The other is a **host-side egress proxy that also injects secrets**. A **per-session microVM** is the optional stronger mode. Claude Code (srt), Codex, Copilot, Gemini CLI, Docker Sandboxes and Microsoft MXC all use variants of this design.

### One policy, compiled to each backend

```yaml
fs:      { read: [~/projects/foo], write: [~/projects/foo], deny: [~/.ssh, ~/.aws, ~/.config/gh, keychains, browser profiles] }
net:     { mode: proxy, allow: [api.anthropic.com, github.com], deny_private_ips: true }
secrets: [{ name: GITHUB_TOKEN, inject_to: api.github.com, header: Authorization }]
env:     { passthrough: [PATH, LANG] }
proc:    { max_procs: 256, cpu: 2, mem: 4GiB, timeout: 2h }
```

The schema is modelled on the srt and MXC schemas, so policies can be exchanged with them. There is a **learning mode**: beamhop runs permissively, records what the harness touches, and the UI proposes a tighter policy from that record.

### Tiers

| Tier | macOS | Linux | Windows | Cloud |
|---|---|---|---|---|
| 0 (always on) | Egress proxy + secret broker + env scrub | same | same | same |
| 1 (default) | Seatbelt (`sandbox-exec`) profile generated by beamhop | bubblewrap + seccomp, plus Landlock when the kernel supports it | MXC process container / AppContainer + WFP, falling back to WSL2 + bwrap | n/a |
| 2 (strong, opt-in; recommended for public channels) | Apple `container` (macOS 26) or libkrun | libkrun / Firecracker | Docker Sandboxes / WSL2 VM | n/a |
| 3 (cloud) | | | | VPS: gVisor (`runsc`) container per agent, or Firecracker/Kata when KVM is available. PaaS (Fly, Render, Railway): the platform VM or container is the boundary; beamhop adds Tier 0 and drops privileges. |

- **The whole harness process is wrapped**, not only its shell tool. This gives one consistent policy for every harness. Each harness's own sandbox can stay on as an extra layer.
- **Implementation:** the policy compiler is written natively in Go. It generates Seatbelt profiles, bwrap arguments, Landlock rulesets and Windows tokens/ACLs. Anthropic's Apache-2.0 `sandbox-runtime` is the reference design and test oracle, but it is not a runtime dependency, because it needs Node.
- **Egress proxy:** HTTP CONNECT and SOCKS5. It allowlists by SNI and host, blocks loopback, link-local and metadata IPs after DNS resolution, and blocks raw TCP and UDP. The sandbox can reach only the proxy port.
- **Secrets:** the sandbox receives placeholder values, and the proxy swaps in the real value for the matching host. The LLM API key is the hard case, because the harness needs it. Prefer routing LLM calls through the proxy with injection. Otherwise use short-lived or scoped keys.
- **Doctor:** `beamhop doctor` checks which tiers this host supports and prints fixes. One example is Ubuntu's AppArmor setting that restricts unprivileged user namespaces.

**Still to verify before building:** whether MXC is fully released and under what license, whether Docker Sandboxes supports Linux, whether libkrun runs natively on Windows, and the details of Codex's sandbox internals.

## 7. Secrets and keys

- Storage: macOS Keychain, Windows Credential Manager, libsecret/KWallet on Linux, through `zalando/go-keyring`. On headless Linux servers, fall back to an encrypted file using age with a passphrase or a systemd credential.
- The broker hands each secret only to the proxy rule it is bound to. Every use is logged.
- Nostr nsec: either in the keychain or through a NIP-46 bunker.

## 8. Cloud deployment

| Provider | Model | How |
|---|---|---|
| Hetzner, DigitalOcean | VPS | Provider API, then a cloud-init install of beamhopd, then gVisor containers per agent. Firewall: outbound only. |
| Fly.io, Render, Railway | Container | Publish the `ghcr.io/beamhop/agent` image and deploy through each provider's API. Runs as a worker with no inbound ports. |

- `beamhop deploy --provider hetzner --agent foo`: `plan` and `apply` are idempotent, and the state is stored locally and mirrored in an encrypted Nostr event.
- Cloud daemons are controlled over Nostr (§4), so they need no public endpoints.
- Provider API tokens are kept in the keychain and are never sent to the deployed host.
- Agent secrets are delivered to the remote daemon over the encrypted control channel and stored in its local vault.

## 9. UI and CLI

- **CLI first.** Every action is a CLI command over the local API, and the UI calls the same API. Every command accepts `--json`.
  - `beamhop init` / `doctor`
  - `beamhop agent add|ls|start|stop|logs`
  - `beamhop channel add nostr --relay ...`
  - `beamhop join <agent> <channel>`
  - `beamhop role grant <principal> <role>`
  - `beamhop policy edit|learn|apply`
  - `beamhop secret set`
  - `beamhop deploy ...`
  - `beamhop approve <id>`
- **UI** (web frontend, TypeScript): agents, channels and memberships, live session view, an approvals inbox, the policy editor with learning-mode suggestions, the audit log, secrets (names only), deployments, and budgets.
- **Desktop:** a Wails v3 shell, which is native to Go and replaces Tauri now that the core is Go. It provides a tray icon, OS notifications for approvals, and launches the daemon at login.
- **Server:** beamhopd serves the same UI on localhost. It can be reached through an SSH tunnel, or controlled from the desktop app over Nostr.

## 10. Build order (internal; one public launch)

1. **Core:** daemon, local API, CLI skeleton, config, audit log, keychain.
2. **Harness layer:** generic ACP adapter, then Claude, Codex and pi native adapters; the MCP server; approval routing.
3. **Nostr:** NIP-17, then NIP-29, then kind 1, then NIP-90, plus agent identity and the control plane.
4. **Sandbox:** policy schema, egress proxy and secret broker, Tier 1 backends on all 3 OSes, learning mode, `doctor`.
5. **Authorization:** principals, roles, budgets, rate limits.
6. **UI:** the web frontend, the Wails desktop app, and the daemon-served UI.
7. **Cloud:** Hetzner and DigitalOcean, then Fly, Render and Railway; Tier 3 sandboxing.
8. **Tier 2 microVM** backends.
9. **Channels:** Telegram, Slack, Discord.
10. **Hardening:** external security review, fuzzing of channel parsers, and red-team prompt-injection tests.
11. **Launch:** packaging and docs.

## 11. Quality, packaging, ops

- **Tests:**
  - unit tests for each interface
  - contract tests against each harness version
  - sandbox escape tests for each OS: try to read `~/.ssh`, reach a blocked host, or reach the metadata IP
  - a test Nostr relay (khatru) run in CI
- **CI:** GitHub Actions on Linux, macOS and Windows.
- **Releases:**
  - goreleaser builds Homebrew, winget, Scoop, deb/rpm packages and a container image
  - macOS builds are notarized and Windows builds are signed
  - artifacts carry SLSA provenance and are signed with cosign
- **Telemetry:** off by default. Logs are local and in OpenTelemetry format.

## 12. Risks and open questions

- **Single big launch** risks a long period with no user feedback. Mitigation: run private dogfooding from step 3 onward.
- **Harness churn:** CLI flags and protocols change often. Mitigation: prefer ACP, pin versions, and run contract tests nightly.
- **Windows sandboxing** is the least mature platform; it depends on MXC and srt's Windows approach settling.
- **Prompt injection through channels:** the sandbox limits the damage but does not prevent the injection. Budgets, role-scoped tools and approvals are the remaining defences.
- **Relay reliability and spam:** use several relays, and add proof of work (NIP-13) or paid relays for public agents.
- **Open questions:**
  - Should Nostr agent identities be published openly (NIP-05)?
  - Should zaps or payments for DVM jobs be in the launch?
  - Which UI framework: Svelte or React?
  - Should there be a hosted relay or bunker for users who don't run their own?
