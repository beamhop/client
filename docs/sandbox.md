# Sandbox

Every harness process — and the beamhop MCP server it starts — runs inside Anthropic's
[sandbox-runtime](https://github.com/anthropics/sandbox-runtime) (srt), used as a library. Each session gets
its own host-side runner that initializes srt for that session only, so policies and proxies are never
shared between sessions.

| OS      | Filesystem isolation             | Network                                                         |
| ------- | -------------------------------- | --------------------------------------------------------------- |
| Linux   | bubblewrap (user + pid + net namespaces, `--die-with-parent`) | no network namespace egress except srt's HTTP/SOCKS proxies, which enforce the allowlist |
| macOS   | Seatbelt (`sandbox-exec`)        | srt's proxies                                                   |
| Windows | srt's Windows backend (**alpha**): dedicated sandbox user + WFP egress fence; WSL2 + Linux srt as fallback | |

The **assumption** behind every rule below: the agent may be fully prompt-injected by anything it reads.

## Profiles

Set per agent (`beamhop policy set <agent> strict|workspace|custom`); roles can force a stricter one
(non-owners default to `strict`). No role can turn the sandbox off.

| Profile               | Mounts                                  | Network allowlist                                                   | Overrides |
| --------------------- | --------------------------------------- | ------------------------------------------------------------------- | --------- |
| `strict`              | every mount **read-only**, whatever its mode | LLM provider APIs only                                         | may only *restrict* (extra deny paths/hosts) or add read paths |
| `workspace` (default) | `rw` mounts writable, `ro` read-only    | LLM APIs + GitHub/GitLab + npm, PyPI, crates.io, Go proxy, JSR      | can add hosts and paths |
| `custom`              | as declared                             | exactly what you list                                               | the overrides *are* the policy |

LLM provider hosts: `api.anthropic.com`, `api.openai.com`, `openrouter.ai`,
`generativelanguage.googleapis.com`, `api.mistral.ai`, `api.groq.com`, `api.deepseek.com`, `api.x.ai`.

Always, in every profile:

- **Never readable:** `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.config/gcloud`, `~/.azure`,
  `~/.kube`, `~/.docker/config.json`, `~/.netrc`, `~/.npmrc`, `~/.beamhop`, keychains and browser profiles.
  Deny wins over allow: a mount inside a denied path is dropped.
- **Private networks denied:** cloud metadata (`169.254.169.254`, `metadata.google.internal`, …),
  RFC 1918, CGNAT, link-local and ULA ranges, also when a public name resolves to them (DNS rebinding).
  Loopback is never allow-listed; only the broker's and the MCP bridge's exact `ip:port` are reachable.
- **Environment from an allowlist** (`PATH`, `LANG`, `TERM`, `HOME` plus what you add to
  `env.passthrough`). Real API keys are never in it.
- **Time limit** per session (`proc.maxSessionMinutes`, default 60).

See the effective policy (after mounts, profile and overrides are compiled):

```bash
beamhop policy show reviewer
```

Edit overrides in `~/.beamhop/agents/<name>.yaml` under `sandbox.policy`, in the PWA's Policy screen, or
with `beamhop agent set`, e.g. `beamhop agent set reviewer 'sandbox.policy.net.allow=["api.example.com"]'`.

## Learning mode

Not sure what an agent needs? Turn on learning mode, let it work, then review suggestions:

```bash
beamhop agent set reviewer sandbox.policy.learning=true
# … use the agent …
beamhop policy suggestions --agent reviewer
beamhop policy accept <id>         # adds the host/path to the agent's policy
beamhop policy reject <id>
beamhop agent set reviewer sandbox.policy.learning=false
```

In learning mode **outbound network connections to hosts outside the allowlist are allowed and logged**
instead of blocked; filesystem rules stay enforced and their violations are logged. Every violation is in
the audit log (`sandbox.violation`) and becomes a suggestion; the PWA shows them as swipeable "allow these
3 domains?" cards. Learning mode is a trust decision: while it is on, the egress allowlist is not a
boundary. Use it with mounts and a role you would trust with open network access, and turn it off after.

## Secrets

- **LLM keys** stay in beamhop's encrypted vault. The harness gets a placeholder and
  `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` pointing at the local broker, which adds the real key and
  forwards over TLS. The broker strips client credentials, fixes the upstream host per route, and refuses
  requests that ask the provider to fetch URLs or call MCP servers on the agent's behalf (`web_fetch`,
  `web_search`, `mcp_servers`, OpenRouter `:online`, …) unless you opt in.
- **Outbound DLP**: before anything goes to a non-owner, it is scanned for secret patterns plus the exact
  values the broker holds (also zero-width-obfuscated, fullwidth, base64 and hex forms). Matches are
  redacted or blocked depending on the role, logged, and owners are alerted. Messages to owners are only
  warned about.
- **Downloads** of inbound attachments happen in the daemon through an SSRF-safe fetcher (every resolved
  address checked, redirects re-checked, size and time limits), never from inside the sandbox.

## Prerequisites and `doctor`

```bash
beamhop doctor
```

checks the platform, the srt library, `bwrap`/`socat`/`rg` on Linux, whether bubblewrap can create user
namespaces, Ubuntu's `kernel.apparmor_restrict_unprivileged_userns`, and the secret store — and prints the
fix for each. On Ubuntu 24.04+ you need either the sysctl set to 0 or an AppArmor profile that grants
`userns` to `bwrap` (what beamhop's cloud-init does on VPS deploys).

**PaaS without user namespaces** (some Render/Railway containers): bubblewrap cannot start there. Only
then, `BEAMHOP_UNSAFE_NO_SANDBOX=1` runs harnesses without srt; the container is the filesystem boundary
and the broker still holds the keys, but srt's filesystem and egress rules do **not** apply. The daemon
warns loudly on every session.

## What is protected

Verified on Linux with real srt + bubblewrap (see `packages/sandbox/test/security.real.test.ts` and
[REVIEW-wave-a](security/REVIEW-wave-a.md#verified-not-vulnerable-attempted-blocked)):

- reading `~/.ssh` and the other deny paths; writing outside `rw` mounts
- reaching a host not on the allowlist, other loopback ports, the metadata IP in any encoding
  (decimal/hex/octal, IPv4-mapped IPv6, wildcard DNS), and DNS rebinding to private ranges
- killing the runner (even with SIGKILL) takes the whole sandboxed process tree down
- the LLM proxy is not an open proxy: no absolute-form targets, no `..`/encoded traversal, no Host
  forwarding, no request smuggling, `set-cookie` dropped
- the MCP bridge: loopback only, exact Host, any `Origin` refused, 256-bit per-session tokens, input
  re-validated, 1 MiB body cap; `channel_send_file` is confined to the session's mounts and inbox

## What is not protected

These are documented residual risks from the security reviews
([wave A](security/REVIEW-wave-a.md#residual-risks-not-fixable-at-this-layer-or-design-decisions),
[wave B](security/REVIEW-wave-b.md#residual-risks)). Read them before you give an agent anything precious.

- **Exfiltration through allowed LLM hosts (R-1, high).** Every profile allows direct egress to the
  provider APIs. A prompt-injected agent can carry data out in requests made with *its own* API key (the
  attacker reads their own provider logs), or in content a model echoes back. Prompts sent with *your* key
  are the product — beamhop can't inspect them for intent. Keep mounts minimal and read-only.
- **Allowed hosts are allowed.** The `workspace` profile allows GitHub, GitLab and package registries; an
  agent can push to a repo it has credentials for, or publish to a registry it can reach. srt filters by
  domain, not by path or method.
- **Budget race (R-2, medium).** Budgets are checked before a request and usage is known only after it, so
  several parallel requests can overshoot a nearly exhausted budget.
- **Proxy path scope (R-3, medium).** Any method and path under a provider route is forwarded with the real
  key (for example OpenAI files or batch endpoints), not just chat/messages endpoints.
- **macOS kill semantics.** `sandbox-exec` has no die-with-parent; on a hard crash of the runner the daemon
  must kill the process group. Linux is covered by `--die-with-parent` + `--unshare-pid`.
- **Hard links** inside a writable mount are not detected by `channel_send_file` confinement (denied paths
  stay masked inside the sandbox, so this cannot reach them).
- **Runner environment (R-6, low).** Loader variables you add to `env.passthrough` (`NODE_OPTIONS`,
  `LD_PRELOAD`) also affect the unsandboxed host-side runner. These are owner-controlled; don't add them.
- **`parentProxy` (R-7, low).** With a corporate parent proxy, srt's resolved-address guard is skipped; the
  proxy must enforce its own private-range policy.
- **Same-user processes (R-8).** Anything running as your user outside the sandbox can read the API token
  file and process environments. That is outside the threat model: such a process already owns the
  account.
- **Windows** sandboxing is srt's alpha backend; treat it as weaker than Linux/macOS, or use WSL2.
- **No sandbox mode** (`BEAMHOP_UNSAFE_NO_SANDBOX=1`) enforces nothing beyond env scrubbing and the broker,
  by design.
- **Channel-level residuals** (wave B): on Nostr a peer agent that omits the hops tag looks human to the
  mesh counters (budgets and rate limits are the control); masked links can show different text than their
  target; Telegram can't fully suppress plain `@username` pings (beamhop neutralizes them outside code); a
  flood of valid gift-wraps can still evict the in-memory dedupe window (the store's persistent dedupe is
  the backstop); anyone can burn your live pairing code (DoS only — generate a new one).
