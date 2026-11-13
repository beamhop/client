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
| `auggie`       | Auggie (Augment Code) | ACP (`--acp`)      | auto-update disabled in the sandbox                                   |
| `kimi-code`    | Kimi Code             | ACP (`acp`)        |                                                                       |
| `cline`        | Cline CLI             | ACP (`--acp`)      |                                                                       |

ACP harnesses use `session/request_permission`, which beamhop answers. The npm package bundles the Claude
Agent SDK (it includes its own Claude Code binary for your platform), so the `claude` adapter works even
without a separate install as long as you are logged in or have an API key.

### Logging harnesses in

Agents run their harness in a sandbox that can never read your own login: the macOS keychain, `~/.config`
and friends are always denied. So beamhop keeps one login per harness in its encrypted vault, and every
agent on that harness uses it. **Harnesses → (harness) → Log in…** in the app, or:

```bash
beamhop harness status                     # login state of every installed harness
printenv ANTHROPIC_API_KEY | beamhop harness login claude
beamhop harness login claude --method claude-subscription   # paste the `claude setup-token` token
beamhop harness login codex                                  # sign in with your ChatGPT plan (browser)
beamhop harness login codex --browser --no-open              # same over SSH: prints a page and a code
beamhop harness login copilot --from gh                      # imports `gh auth token`
beamhop harness status copilot --check     # verify for real
beamhop harness logout copilot
```

| Harness      | Login methods (first one set wins)                                   | Agent sees it?               |
| ------------ | -------------------------------------------------------------------- | ---------------------------- |
| claude       | Anthropic API key · Claude subscription token (`claude setup-token`) | no (broker)                  |
| codex        | **ChatGPT plan** (sign-in) · OpenAI API key                          | sign-in: **yes** · key: no   |
| gemini       | **Google account** (sign-in) · Gemini API key                        | **yes**                      |
| cline        | **Cline account** · **ChatGPT plan** (sign-ins)                      | **yes**                      |
| kimi-code    | **Kimi Code subscription** (sign-in)                                 | **yes**                      |
| auggie       | **Augment account** (sign-in)                                        | **yes**                      |
| cursor-agent | **Cursor account** (sign-in)                                         | **yes**                      |
| opencode     | **ChatGPT plan** · **GitHub Copilot** (sign-ins) · OpenRouter · Anthropic · OpenAI API key | sign-ins: **yes** · keys: no |
| pi           | **ChatGPT plan** · **GitHub Copilot** · **Kimi Code** (sign-ins) · OpenRouter · Anthropic · OpenAI API key | sign-ins: **yes** · keys: no |
| copilot      | GitHub token (fine-grained, "Copilot Requests", or `gh auth token`)  | **yes**                      |

*Broker* methods never reach the agent: beamhop's LLM broker adds the key (or the subscription token, as
Bearer with Anthropic's OAuth flag) to the harness's requests. GitHub Copilot and Gemini talk to services
the broker cannot stand in for, so their token is handed to the harness and **the agent can read it**:
prefer a narrowly scoped token. Copilot is started with `--secret-env-vars` (the token stays out of the
shells and MCP servers it runs) and keeps its state in the session directory (`COPILOT_HOME`), never in
your `~/.copilot`; outbound DLP redacts stored secrets from messages.

**Subscription sign-ins.** Sign-ins (**Sign in with ChatGPT plan** in the app, `beamhop harness login
<id> --browser` in the CLI) run the harness's own login, but into a fresh folder beamhop owns, never your
`~/.codex` & co. The files it writes are kept in the vault (encrypted); each session gets its own copy, and
when the harness refreshes its tokens the new ones are saved back. The sandbox allows that subscription's
own servers (e.g. `chatgpt.com`, `auth.openai.com`) while the sign-in is in use; requests go there
directly, not through the broker, so **the agent can read the sign-in** and beamhop's per-agent spending
limits don't see subscription usage. It is a second sign-in, separate from yours: refresh tokens rotate,
so sharing your own would log one of you out. Over SSH, `--no-open` uses the harness's device-code flow
where it has one (Codex, Cline, Kimi, OpenCode, pi). pi signs in to subscriptions only from its own
screen, so beamhop runs pi's own sign-in code (from pi's install) with a small helper and writes pi's
`auth.json`; OpenCode keeps logins in its database, so beamhop moves them with `opencode auth export` /
`import` instead of copying the database (which also holds session history).

**Status.** A harness is *ready* only when agents can authenticate: installed but not logged in (or
rejected) shows *needs login*, whatever your own login says. `Check` (or `--check`) verifies the stored
login for real: provider keys against the provider's free key/models endpoint, Copilot by starting it in
the sandbox and closing it before any prompt. The result is kept until the login changes.
`beamhop doctor` fails for harnesses your agents use but that are not logged in.

**Per agent.** An agent can use its own credential instead: `secretEnv: ["COPILOT_GITHUB_TOKEN=TEAM_TOKEN"]`
(`beamhop agent set <agent> 'secretEnv=["COPILOT_GITHUB_TOKEN=TEAM_TOKEN"]'`, with `TEAM_TOKEN` stored via
`beamhop secret set TEAM_TOKEN`).

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

- beamhop owns the conversation, not the harness. Each DM or thread keeps its transcript in beamhop, and every
  time a harness starts (a new session, a harness or model switch, a changed mount or sandbox, an idle
  timeout, a daemon restart or a move to another host) its first prompt carries the conversation so far.
  No harness-native resume token is used, so switching harness or model never breaks a conversation.
- The replay holds beamhop's transcript (tool calls as one line each) plus, on Slack, Discord and Nostr, the
  channel's own messages the agent wasn't addressed in. It fills up to `historyShare` (default 0.4) of the
  model's context window, newest first; a thread's opening message is always kept. `historyShare: 0` turns
  it off.
- A thread keeps its whole history. In a DM or a channel's main line, `/new` starts a clean context and
  `/resume` brings it back.
- A harness process ends after `sessionIdleMinutes` (default 120) or on `/new`; the conversation goes on.
  Setting changes take effect at the next message, never mid-turn.
- Up to `concurrency.maxSessions` (default 3) run in parallel; more wait in a queue.
- A read-write mount that is a git repo gets one **git worktree per session** on branch
  `beamhop/<thread>`; a read-write mount that isn't git is shared with a write lock (unless
  `parallelUnsafe: true`); read-only mounts are shared.
- `/model`, `/harness` and `/mode plan|auto|read-only` change the session within what the role allows.
