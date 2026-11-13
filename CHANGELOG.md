# Changelog

All notable changes to beamhop are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/) (pre-1.0: minor versions may break things).

## [Unreleased]

## [0.1.0] - unreleased

First public build.

### Added

- **Daemon and CLI** (`beamhop`, `beamhopd`): one zod-typed JSON-RPC API over localhost HTTP/WS, a local
  socket and encrypted Nostr control events; every CLI command supports `--json`. First-run wizard
  `beamhop init`, `doctor`, `status`, `panic` / `resume`.
- **Harnesses:** catalog-driven discovery (12 known harnesses), adapters for ACP (Gemini CLI, Copilot CLI,
  OpenCode, Cursor CLI, goose, Qwen Code, Auggie, Kimi Code, Cline, any ACP agent), Claude Code (Agent
  SDK), Codex (`app-server`) and pi (RPC + approval gate). beamhop is the only approval gate.
- **Channels:** Nostr (NIP-17 DMs, NIP-29 groups, kind 1 notes, NIP-90 jobs, per-agent keys, kind 0
  profile, owner attestation, NIP-05 helper), Telegram (long polling), Slack (Socket Mode, manifest link),
  Discord (Gateway). Setup wizards, `/pair` owner pairing, native buttons for approvals.
- **Sandbox:** srt on every harness and the MCP server; `strict` / `workspace` / `custom` profiles;
  learning mode with suggestions; always-denied credential paths; private-range and metadata egress
  blocking.
- **Broker:** keychain / encrypted-vault secret store, LLM key-injecting proxy (refuses provider-side
  network tools by default), outbound DLP (patterns + exact held values, obfuscation-aware), SSRF-safe
  attachment fetcher.
- **Authorization:** owners/admins/users/viewers/agents, linked identities, N-of-M approvals, budgets per
  agent/role/person/peer/session, routes for cross-channel posting, mesh hop and turn limits.
- **MCP server** for agents: `channel_*`, `mesh_*`, `session_status`.
- **Cloud:** deployers for Hetzner, DigitalOcean, Fly.io, Render and Railway with plan/cost preview, spend
  cap, provisioning over Nostr and no inbound ports; container image `ghcr.io/beamhop/agent`.
- **PWA:** installable control panel (React 19, React Aria), served by the daemon; mock mode for
  development.
- **Distribution:** a single bundled npm package `beamhop` (esbuild; CLI, daemon, MCP server, runtime
  assets and the PWA); standalone Node SEA binaries for Linux, macOS and Windows; release workflow with npm
  provenance, multi-arch cosign-signed container image, signed checksums, and Homebrew / Scoop / winget
  manifests.
- **Docs:** README, user guides, generated CLI reference, security policy.

### Fixed

- `beamhop agent set` now expands dotted keys (`budgets.dailyUsd=3`) into nested patches, as its help text
  always promised; previously such keys were silently ignored.
- `beamhop channel add` prints the validation message (for Discord, the bot invite link).

### Security

- Two internal security review waves (sandbox, broker, MCP bridge, daemon API; authz, store, channels).
  Findings and residual risks: [docs/security](docs/security/).

### Known limitations

- The hosted PWA's Nostr transport (remote control from a paired phone) is still landing; the local PWA
  and channel buttons work.
- Windows sandboxing relies on srt's alpha backend; WSL2 is the fallback.
- Standalone binaries are a binary plus a `lib/` folder, not a single file (native modules and sandboxed
  helper scripts must exist on disk).

[Unreleased]: https://github.com/beamhop/beamhop/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/beamhop/beamhop/releases/tag/v0.1.0
