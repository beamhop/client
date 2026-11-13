# Quickstart

From nothing to an agent that answers you on your phone.

## 1. Install

| Option                 | Command                                                       | Needs Node? |
| ---------------------- | ------------------------------------------------------------- | ----------- |
| npx (try it)           | `npx beamhop <command>`                                       | 22.12+      |
| npm (recommended)      | `npm i -g beamhop`                                            | 22.12+      |
| Homebrew (macOS/Linux) | `brew install beamhop/tap/beamhop`                            | no          |
| Scoop (Windows)        | `scoop install https://github.com/beamhop/client/releases/latest/download/beamhop.json`* | no |
| winget (Windows)       | `winget install beamhop.beamhop`*                             | no          |
| Archive                | download `beamhop-<version>-<os>-<arch>.tar.gz` / `.zip` from the releases page | no |

\* The release pipeline renders the Scoop and winget manifests (`packaging/`); they are published to a
bucket / `winget-pkgs` per release.

Every release ships `SHA256SUMS` and a keyless cosign bundle for it. Verify an archive:

```bash
sha256sum -c SHA256SUMS --ignore-missing
cosign verify-blob SHA256SUMS --bundle SHA256SUMS.sigstore.json \
  --certificate-identity-regexp 'https://github.com/beamhop/client/.github/workflows/release.yml@.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

The npm package is published with [provenance](https://docs.npmjs.com/generating-provenance-statements):
`npm audit signatures` checks it.

### Sandbox prerequisites

| OS      | Needs                                                                                     |
| ------- | ----------------------------------------------------------------------------------------- |
| Linux   | `bubblewrap`, `socat`, `ripgrep` (`sudo apt install bubblewrap socat ripgrep`). On Ubuntu 24.04+ AppArmor restricts unprivileged user namespaces; `beamhop doctor` prints the fix. |
| macOS   | `ripgrep` (`brew install ripgrep`). Seatbelt is built in.                                 |
| Windows | srt's Windows backend is alpha; WSL2 with the Linux setup is the fallback.                |

Run `beamhop doctor` at any point: it checks each prerequisite and prints the exact fix.

### Standalone binaries

The archives contain a `beamhop` executable (a [Node SEA](https://nodejs.org/api/single-executable-applications.html):
the Node runtime with a small embedded launcher) and a `lib/` directory next to it with the JavaScript
bundle, the web UI and the native pieces. **Keep `lib/` next to the binary**; package managers do this
for you. Why it is not a single file: Node SEA cannot embed native addons (the OS keychain binding), the
sandbox runtime's helpers, the Claude Agent SDK's per-platform Claude Code binary, or the scripts that must
exist on disk because they run as separate processes inside the sandbox (the MCP server, the sandbox
runner). The binary runs those scripts itself, and only scripts from its own `lib/`.

## 2. Start the daemon

```bash
beamhop daemon
```

The daemon keeps everything in `~/.beamhop` (override with `BEAMHOP_HOME`) and listens only on
`127.0.0.1:7878` (`BEAMHOP_PORT`). The CLI reads its token from `~/.beamhop/api-token`. Leave it running;
use your OS's service manager (systemd user unit, launchd agent) if you want it at login. Ctrl-C stops it.
If the port is taken, start it with `BEAMHOP_PORT=<port> beamhop daemon` and use the same `BEAMHOP_PORT` (and
`BEAMHOP_HOME`, if you changed it) for every other `beamhop` command.

Secret storage: the OS keychain (macOS Keychain, Windows Credential Manager, libsecret on Linux). On a
headless Linux box without a keychain, set `BEAMHOP_VAULT_PASSPHRASE` to use the encrypted file vault;
without either, secrets live in memory only and `doctor` warns you.

## 3. Run the wizard

```bash
beamhop init
```

| Step        | What happens                                                                                   |
| ----------- | ---------------------------------------------------------------------------------------------- |
| 01 Doctor   | sandbox prerequisites, keychain                                                                 |
| 02 Harnesses| lists what was found: ready, needs login, not installed                                        |
| 03 Identity | creates your owner Nostr key, or `--owner-npub npub1…` to keep your own key on your devices    |
| 04 Phone    | QR code; scan it to pair the PWA as a device and compare the safety phrase                     |
| 05 Agent    | pick a harness, a preset, a folder (read-only by default) and a sandbox profile                 |
| 06 Hello    | the agent sends you a Nostr DM; reply from your phone (the PWA or any NIP-17 Nostr client signed in as your owner key) |
| 07 Next     | pointers to channels, NIP-05 and cloud                                                         |

Headless: `beamhop init --yes --agent-name helper --harness claude --mount ~/code/app:ro`. With `--yes`,
pairing and the hello round trip only run if you add `--pair` / `--hello`. `beamhop init --help` lists every
flag.

### Give it a model key

Agents reach their model only through beamhop's local broker, which adds the real key. Store it once:

```bash
beamhop secret set ANTHROPIC_API_KEY --from-env ANTHROPIC_API_KEY   # Claude Code
beamhop secret set OPENAI_API_KEY --from-env OPENAI_API_KEY         # Codex
beamhop secret set OPENROUTER_API_KEY                               # or paste it on stdin
```

`beamhop doctor` shows which keys are set (never their values).

## 4. Talk to it

The fastest check, without any channel:

```bash
beamhop session start helper "what's in this repo?"
beamhop session ls
beamhop session show <id>
```

Or open the web UI: `beamhop ui` prints a `http://127.0.0.1:…/#token=…` link to open in your browser. The
link carries your access token, so don't paste it anywhere.

From your phone: DM the agent's npub (shown by `beamhop agent show helper`) from a Nostr client, or add a
Telegram/Slack/Discord bot — see [channels.md](channels.md). In a group, the agent answers only when it is
@mentioned or replied to.

## 5. Approvals

When the agent wants to do something its role doesn't auto-allow (run a shell command, write a file), you
get an approval:

```bash
beamhop approvals
beamhop approve <id>            # or: --always for the rest of the session
beamhop deny <id>
```

Telegram, Slack and Discord show native buttons; on Nostr reply `/approve <id>`. The PWA's Inbox is a
swipeable card stack. Unanswered requests are denied after 15 minutes (`approvalTimeoutMinutes`).

## 6. Presets

`beamhop agent presets` lists the built-in starting points:

| Preset               | For                                                                         |
| -------------------- | --------------------------------------------------------------------------- |
| `personal-assistant` | just you, over DMs; works in mounted folders; asks before anything risky    |
| `code-reviewer`      | reads your repo, never writes; answers in team channels when mentioned      |
| `team-dev-bot`       | teammates ask for changes; one git worktree per thread; owners approve writes |
| `public-qa`          | anyone can ask; strict sandbox, read-only docs, tight rate limits, DLP on every reply |

```bash
beamhop agent add reviewer --harness claude --preset code-reviewer --mount ~/code/app:ro
beamhop agent set reviewer budgets.dailyUsd=3 concurrency.maxSessions=2
```

Agent configs are plain YAML in `~/.beamhop/agents/<name>.yaml`; the PWA edits the same files.

## When something goes wrong

- `beamhop doctor` — prerequisites and their fixes.
- `beamhop audit --limit 50` — every decision, violation and config change.
- `beamhop panic` — stop everything now. `beamhop resume` when you're ready; beamhop never resumes on its own.
