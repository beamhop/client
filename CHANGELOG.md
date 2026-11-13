# Changelog

All notable changes to beamhop are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/) (pre-1.0: minor versions may break things).

## [Unreleased]

### Added

- **New agent from scratch.** The New agent flow has a fifth choice next to the presets, "Start from
  scratch". You pick only the sandbox (workspace or strict). The agent starts with no channels and a
  $5/day budget, and you set the rest on its own screens. A strict agent's folders are locked read-only,
  since the strict sandbox never writes.

## [0.2.0] - 2026-11-13

One version for everything from here on: the CLI, the daemon, the desktop app and the web UI share it
(`node scripts/version.mjs`), and CI fails if a package drifts.

### Added

- **Model picker.** beamhop asks the harness which models its sign-in offers (Codex `model/list`, Claude
  Code, ACP agents, pi) and the agent's Setup and the New agent flow offer them, plus "Harness default"
  and a typed id. API `harness.models`.
- **Sandbox network controls** (agent → Sandbox → Network): allow all network per agent (deny rules,
  cloud metadata and private addresses still apply; not with the strict profile), your own allowlist,
  the hosts the harness and its sign-in need, blocked hosts with one-click Allow/Reject, and **Test
  connections** (API `sandbox.test`). A failed turn names the hosts the sandbox refused.
- `beamhop harness rm` / `harness.remove` for custom ACP harnesses.
- **Desktop app** (`apps/desktop`): the control panel in its own window with the daemon bundled, for macOS,
  Windows and Linux. Nothing else to install. Attaches to a daemon the CLI already runs, or starts its own;
  keeps running in the menu bar / tray when the window closes; open at login (starts hidden); Stop
  everything from the tray. Signed and notarized on macOS, Authenticode-signed on Windows when the
  certificate is configured. See [docs/desktop.md](docs/desktop.md).

- **Harness logins for sandboxed agents** (`beamhop harness status|login|logout`, Harnesses → Log in…).
  One login per harness in the vault, used by every agent on it: Anthropic / OpenAI / OpenRouter keys and
  Claude subscription tokens go through the broker (agents never see them); GitHub Copilot and Gemini get
  a token in their env (`--from gh` imports `gh auth token`). Status is real: "ready" now requires a
  working login, and Check verifies it against the provider or by starting the harness in the sandbox.
  Agents can override with `secretEnv: ["ENV=SECRET"]`. Copilot gets its API hosts in the sandbox, its
  state in the session dir (`COPILOT_HOME`) and `--secret-env-vars`.
- **Secrets in one encrypted file; the system keychain is opt-in.** Every secret (LLM keys, channel tokens,
  agent Nostr keys, the database key) lives in `~/.beamhop/vault.enc.json` (AES-256-GCM). Its key is a random
  256-bit key in `~/.beamhop/vault.key` (0600) by default, so macOS no longer prompts once per secret.
  `beamhop secret keychain on|off` or _Settings → Secrets → Vault key_ moves just that key into the system
  keychain (one item per beamhop home) and back; the vault is not re-encrypted. `BEAMHOP_VAULT_PASSPHRASE`
  still locks it with a passphrase on servers. `BEAMHOP_NO_KEYCHAIN` is gone, and secrets stored in the
  keychain by earlier builds are not migrated.

### Fixed

- Codex with a ChatGPT sign-in failed in the sandbox ("workspace routing discovery failed"): it needs
  macOS trustd, which only ACP plugins took from the catalog. Every harness plugin now does.
- Codex and pi passed the model "default" literally; a ChatGPT plan rejects it. They now leave it to the
  harness.
- A session on a harness that is not signed in fails at once with how to sign in, instead of hanging.
- Desktop app: no admin/keychain password prompt after an update (Chromium's mock keychain; the vault's
  keychain option stays opt-in), the window always shows the installed build's UI (the PWA service-worker
  cache is cleared at launch), and the app records only the daemon it started (a leftover daemon was
  never stopped or replaced after an update).
- Builds always rebuild the web UI instead of shipping an older `apps/pwa/dist`.
- Unsaved agent edits are no longer lost on a tab switch, quit or reload; the undo toast no longer covers
  the next approval's Deny; dialog buttons stay inside their dialogs; long hosts no longer widen pages on
  phones.
- CLI exit codes and input checks (`doctor`, `harness add`, `secret rm`, `role revoke`, `alerts set`
  units, `agent set` keys and mounts); the daemon runs with a long or relative `BEAMHOP_HOME`.
- Agents without a mounted folder (and git worktree mounts) failed to start: their session dir and
  worktrees live in the beamhop home, which the sandbox denies as a whole, so the harness could not read
  its own working directory ("ACP connection closed"). The sandbox now carves out exactly that session's
  own dirs (`fs.own`, set only by the daemon); the rest of the home, other sessions included, stays denied.
  `channel_send_file` accepts files from the session dir for the same reason.
- The daemon also denies its actual home when `BEAMHOP_HOME` is not `~/.beamhop`.
- A harness that fails to start now reports its own stderr instead of only "connection closed".
- Desktop app opened from Finder / the Dock did not find harnesses installed via nvm, Homebrew, npm & co.
  (it only had `/usr/bin:/bin:/usr/sbin:/sbin`). It now reads the login shell's PATH and tool-manager
  variables once at startup (10 s timeout) and gives them to the daemon; nothing else from the shell env.

### Changed

- Helpers the daemon starts with `process.execPath` (sandbox runner, MCP server) also run when the daemon
  runs on Electron's Node (`nodeExecEnv()` in `@beamhop/core`); the variable never reaches harnesses.

### Security

- `agent.instructions` no longer follows a symlinked instruction file out of the mount.
- An agent's `secretEnv` cannot hand beamhop's own secrets (its keys, agent and channel keys) to a
  harness; `agent.update` only accepts the agent's own identity key.
- A session's copy of a subscription sign-in is removed when the session stops.
- `secret.delete` refuses secrets still in use; `identity.ownerImport` needs `replace` to replace a held
  owner key; an approval quorum cannot exceed the approvers.
- An empty nostr relay list means no relays, not the public defaults.
- `beamhop data purge` without a filter needs `--yes`; audit entries only with `--audit`.
- Repeated sandbox denials (a harness retrying the same host) are warnings, so they no longer trip the
  security-spike alert.

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

[Unreleased]: https://github.com/beamhop/client/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/beamhop/client/releases/tag/v0.1.0
