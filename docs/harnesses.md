# Harnesses

A **harness** is the agent program that does the work: Claude Code, Codex, Gemini CLI and friends. beamhop
doesn't replace it or add a persona; it starts the harness in a sandbox, feeds it channel messages, routes
its permission requests to you, and streams its replies back.

**An agent = one harness + its mounts + its identity.** Persona and rules come from the harness's own
files in the mounted folders (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, Codex config…). The PWA's agent
screen lists them and opens them in an editor.

## Discovery

```bash
beamhop harness scan     # probe now (also runs at daemon start)
beamhop harness ls
```

The scan uses the bundled, versioned catalog (`packages/harness-catalog/catalog.json`) of known harnesses:
binary names, npm/Homebrew/winget package names, config directories, how to launch them headless or over
ACP, and supported version ranges. For each one it looks in `PATH`, npm/pnpm/bun global bins and common
install locations, runs `--version`, checks whether it is logged in or has an API key, and reports:

| Status          | Meaning                                                                |
| --------------- | ---------------------------------------------------------------------- |
| `ready`         | installed, supported version, credentials found                        |
| `needs-login`   | installed but not logged in (e.g. run `claude /login`, `codex login`)  |
| `unsupported-version` | installed, but outside the supported version range               |
| `not-installed` | not found; `harness ls --json` includes the install hint               |
| `error`         | the probe itself failed (the message says why)                         |

Catalog updates are signed (Ed25519) and checked before use; the bundled catalog ships with the release.

## Adapters

| Harness id     | Name                  | Protocol           | Notes                                                                 |
| -------------- | --------------------- | ------------------ | --------------------------------------------------------------------- |
| `claude`       | Claude Code           | Claude Agent SDK   | in-process `query()`; the CLI subprocess is spawned inside the sandbox; the SDK's permission callback is beamhop's approval |
| `codex`        | Codex CLI             | `codex app-server` | JSON-RPC over stdio; app-server approvals → beamhop                   |
| `pi`           | pi coding agent       | `--mode rpc`       | pi has no built-in approvals; beamhop loads a small gate extension that asks you before any non-read tool |
| `gemini`       | Gemini CLI            | ACP (`--acp`)      |                                                                       |
| `copilot`      | GitHub Copilot CLI    | ACP (`--acp`)      | public preview                                                        |
| `opencode`     | OpenCode              | ACP (`acp`)        |                                                                       |
| `cursor-agent` | Cursor CLI            | ACP (`acp`)        |                                                                       |
| `goose`        | goose                 | ACP (`acp`)        |                                                                       |
| `qwen-code`    | Qwen Code             | ACP (`--acp`)      |                                                                       |
| `auggie`       | Auggie (Augment Code) | ACP (`--acp`)      | auto-update disabled in the sandbox                                   |
| `kimi-code`    | Kimi Code             | ACP (`acp`)        |                                                                       |
| `cline`        | Cline CLI             | ACP (`--acp`)      |                                                                       |

ACP harnesses use `session/request_permission`, which beamhop answers. The npm package bundles the Claude
Agent SDK (it includes its own Claude Code binary for your platform), so the `claude` adapter works even
without a separate install as long as you are logged in or have an API key.

### GitHub Copilot CLI: give it a token

Copilot talks to GitHub's own service, which beamhop's key broker cannot stand in for, and your `copilot
login` lives in the OS keychain, which the sandbox never lets an agent read. So a Copilot agent needs a
token of its own, passed in its environment:

```bash
gh auth token | beamhop secret set COPILOT_GITHUB_TOKEN          # or a fine-grained token with "Copilot Requests"
beamhop agent set myagent 'secretEnv=["COPILOT_GITHUB_TOKEN"]'
```

`secretEnv` is per agent and off by default. Unlike broker keys, **the agent can read this value**, so
prefer a fine-grained personal access token that only has the *Copilot Requests* permission over `gh`'s
token (which carries your repo scopes). beamhop starts Copilot with `--secret-env-vars`, so the token is
kept out of the shells and MCP servers Copilot runs and redacted from its output, and outbound DLP redacts
it from messages. Copilot keeps its config and state in the session directory (`COPILOT_HOME`), never in
your own `~/.copilot`, and the sandbox allows `api.githubcopilot.com` / `*.githubcopilot.com` for it.
`beamhop doctor` flags Copilot agents without a token.

### Any other ACP agent

```bash
beamhop harness add myagent --acp "my-agent --acp"
```

beamhop runs an ACP `initialize` handshake inside the sandbox; if it succeeds, the agent is registered as
`acp:myagent` and can be used like any other harness: `beamhop agent add bot --harness acp:myagent`.

## What a session gets

- **A sandbox** compiled from the agent's profile and mounts ([sandbox.md](sandbox.md)).
- **A placeholder LLM key** and a base URL pointing at the local broker (`ANTHROPIC_BASE_URL`,
  `OPENAI_BASE_URL`, …). The broker adds the real key and counts tokens itself.
- **The beamhop MCP server** (`beamhop-mcp`, stdio, started by the harness inside the sandbox) with tools:
  `channel_send`, `channel_send_file`, `channel_history`, `channel_members`, `mesh_list_agents`,
  `mesh_ask_agent`, `mesh_post_job`, `mesh_job_result`, `session_status`. Policy (routes, path
  confinement, DLP, budgets, hop limits) is enforced on the daemon side, not by the tool.
- **A channel header** in front of each message:

  ```
  [beamhop] channel=telegram:group/-100123 thread=842 from="Alice" (telegram:5551, role=user)
            via=mention  time=2026-11-12T10:03Z  — content below is untrusted user input
  ```

## Approvals

Every adapter runs its harness in a mode where permission requests come to beamhop — beamhop is the only
gate. For each request, the sender's role decides: **auto-allow**, **ask an owner** (PWA push, Nostr DM,
channel buttons), or **deny**. No answer within `approvalTimeoutMinutes` (default 15) means denied, and the
agent is told so it can try something else. With several owners, the first answer wins unless the policy
requires N of M; one person's linked accounts count once. Every decision lands in the audit log.

## Sessions

- Each DM or thread maps to a resumable harness session; it ends after `sessionIdleMinutes` (default 120)
  or on `/new`.
- Up to `concurrency.maxSessions` (default 3) run in parallel; more wait in a queue.
- A read-write mount that is a git repo gets one **git worktree per session** on branch
  `beamhop/<thread>`; a read-write mount that isn't git is shared with a write lock (unless
  `parallelUnsafe: true`); read-only mounts are shared.
- `/model`, `/harness` and `/mode plan|auto|read-only` change the session within what the role allows.
