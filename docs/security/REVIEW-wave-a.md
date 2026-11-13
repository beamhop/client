# Security review — wave A (sandbox, broker, MCP bridge, daemon API)

Scope: `packages/sandbox`, `packages/broker`, `packages/mcp`, `apps/daemon/src/rpc-server.ts`.
Threat model: `PLAN.md` §7A. The agent inside the sandbox is assumed fully prompt-injected. Local
processes and channel content are hostile too. All "confirmed" findings were reproduced on Linux
with real srt 0.0.82 + bubblewrap, or against the real HTTP servers, before they were fixed. Each
one has a regression test that failed before the fix and passes after it.

## Findings

| ID | Severity | Area | Status | Regression test |
| --- | --- | --- | --- | --- |
| SBX-1 | **High** | sandbox runner | Fixed | `packages/sandbox/test/security.real.test.ts` |
| LLM-1 | **High** | LLM proxy | Fixed (default deny) | `packages/broker/test/proxy.test.ts` (LLM-1) |
| MCP-1 | **High** (latent) | MCP `channel_send_file` | Fixed: helper + contract | `packages/mcp/test/paths.test.ts` |
| DLP-1 | Medium | outbound DLP | Fixed | `packages/broker/test/dlp.test.ts` |
| DLP-2 | Medium | outbound DLP | Fixed | `packages/broker/test/dlp.test.ts` |
| API-1 | Medium | daemon API | Fixed | `apps/daemon/test/rpc-origin.test.ts` |
| API-2 | Medium | daemon API | Fixed | `apps/daemon/test/rpc-origin.test.ts` |
| API-3 | Medium | daemon API (WS) | Fixed | `apps/daemon/test/rpc-origin.test.ts` |
| SBX-3 | Low | sandbox policy | Fixed | `packages/sandbox/test/security.real.test.ts` |
| SBX-2 | Low | sandbox runner | Fixed (hardening) | `packages/sandbox/test/security.real.test.ts` |
| R-1 | High (residual) | egress to LLM hosts | Documented | n/a |
| R-2 | Medium (residual) | budget race | Documented | n/a |
| R-3 | Medium (residual) | proxy path scope | Documented | n/a |
| R-4…R-10 | Low / info | various | Documented | n/a |

### SBX-1: sandbox survives a hard kill of the runner (High)

**Repro.** Wrap `sh -c 'trap "" TERM; (setsid sleep N &); sleep N'`, spawn it, then send SIGKILL
to the runner process (this is what a daemon crash or a hard `panic` does). Both `sleep`
processes kept running, still with full sandbox filesystem access. They were reparented, with
`/bin/sh -c bwrap …` still alive.

**Cause.** The runner spawned srt's wrapped command with `shell: true`, so bwrap's parent was an
intermediate `/bin/sh`, not the runner. bwrap's `--die-with-parent` therefore watched the shell,
which survives the runner's death. SIGTERM and the timeout path worked, because the shell dies
on those signals.

**Fix.** On Linux, when srt returns a `bwrap …` command, the runner `exec`s it
(`runner.mjs`), so bwrap is the runner's direct child. A SIGKILL of the runner now delivers
PDEATHSIG to bwrap, and `--unshare-pid` takes the whole tree down.

**Residual.** On macOS, `sandbox-exec` has no die-with-parent. The daemon should kill the
runner's process group on stop. Untested here.

### LLM-1: provider-side network tools let the agent exfiltrate data with the owner's key (High)

**Repro.** Through the broker, POST `/anthropic/v1/messages` with `mcp_servers: [{url: <attacker>}]`
or a `web_fetch_*` / `web_search_*` tool. Variants: OpenAI `tools: [{type: "mcp" | "web_search_preview"}]`,
`web_search_options`, or OpenRouter `model: "…:online"` / `plugins: [{id: "web"}]`. The broker
forwarded all of them with the real key. The provider then connects to attacker-chosen URLs from
its own infrastructure, which bypasses the srt egress allowlist entirely. Sending the JSON as
`text/plain` also skipped the broker's JSON handling.

**Fix.** `createLlmProxy` now parses every non-empty body, whatever its content-type. It refuses
(403) bodies that ask for provider-side network features (`serverSideToolUse()`), and it refuses
(400) bodies that claim JSON but do not parse. Opt-in: `allowServerSideTools: true`. Ordinary
function tools are unaffected.

**Residual.** Feature names change. The blocklist covers today's names (`web_fetch`, `web_search`,
`mcp`, `url_context`, `mcp_servers`, `web_search_options`, `plugins`, `:online`). Review it when
providers add tools. See R-1 for the egress that cannot be closed at this layer.

### MCP-1: `channel_send_file` confinement was left to handlers (High, latent)

The bridge validates only that `path` is a string. The handler reads the file **on the host,
outside the sandbox**, so a naive `startsWith(sessionDir)` / `readFile` check can be beaten in
three ways:

- **Planted symlink.** A symlink inside the session dir pointing at `~/.ssh/<key>` is followed by
  the unsandboxed daemon.
- **Mount containing a denied dir.** With `~` mounted and `~/.ssh` denied, the path is "inside a
  mount" but must still be refused.
- **Other tricks.** `..` segments, directories/FIFOs (a FIFO blocks the daemon), and a symlink
  swapped in between the check and the open (TOCTOU).

**Fix.** New `openConfinedFile(path, roots, deny, {maxBytes})` in `@beamhop/mcp`:

1. Takes the realpath before checking containment, and checks against the deny list as well.
2. Accepts regular files only.
3. Opens with `O_NOFOLLOW|O_NONBLOCK`.
4. Re-checks the opened descriptor: same dev/inode, and on Linux the `/proc/self/fd` path.

The bridge's handler contract now says handlers must use it. No handler exists yet in this wave.

**Residual.** Hard links are not detected. Inside the sandbox, denied paths are masked, so the
agent cannot hard-link them. Any file the agent can read, it could copy into the session dir
anyway.

### DLP-1: zero-width / invisible / fullwidth obfuscation bypassed DLP (Medium)

**Repro.** Interleave U+200B (also ZWNJ, ZWJ, word joiner, BOM, soft hyphen) inside a GitHub-style
token or a vault value, or write a known secret in fullwidth letters. Before the fix, nothing was
found and the text went out unredacted.

**Fix.** `scanOutbound` strips invisible code points (zero-width, bidi controls, variation
selectors, tag characters, Hangul fillers) and NFKC-folds each code point before matching. An
index map projects findings back onto the original text, so the redaction covers the obfuscated
span.

### DLP-2: base64 / hex of a secret bypassed DLP (Medium)

**Repro.** Send `base64(knownSecret)`, base64url, hex, a known secret embedded at any byte
offset in a larger base64 blob, or `base64("GITHUB_TOKEN=<token>")`. Before the fix, none of these
was caught.

**Fix.**
- Known secrets are also matched as hex (both cases) and as the alignment-independent core of
  their base64 / base64url encoding (3 alignments). The match is widened to the whole encoded
  token.
- Base64 and hex tokens of 24 chars or more (at most 200 per message) are decoded. If the decoded
  text is mostly printable, it is re-scanned with all rules and the whole token is redacted.

**Not caught (by design, documented):**
- A secret split across several messages. Per-message scanning cannot see it; a per-conversation
  sliding window would be needed.
- Cross-script homoglyphs (Cyrillic "а" for Latin "a").
- Custom encodings: rot13, reversal, gzip+base64, base32, URL-encoding, and line-wrapped base64
  with embedded newlines.
- Paraphrase ("the key starts with …").

DLP is a tripwire against accidental and lazy leaks. It is not a boundary against a determined
agent that holds a secret. The real control is that the agent never holds secrets: the broker
injects them upstream.

### API-1 / API-2 / API-3: no Origin / Host policy on the daemon API (Medium)

**Before.** `/rpc` and `/ws` relied on the bearer token alone. The server answered any `Host`,
so a DNS-rebound attacker page counts as same-origin and can read the unauthenticated PWA. It
accepted any `Origin`, including cross-site WebSocket upgrades and `Origin: null`. It also
accepted `text/plain` POSTs, a CORS "simple" request that skips the preflight. This was not
exploitable without the token, but the token travels in `?token=` URLs (WebSocket), which leak
easily through history and screenshots. Defence in depth was missing.

**Fix (`rpc-server.ts`, `createOriginPolicy`):**
- `Host` must be a loopback name on the bound port (`127.0.0.1`, `localhost`, `[::1]`) or an
  entry of the new `allowedHosts` option. Otherwise the request gets 403. This applies to
  everything except `/healthz`.
- A request with an `Origin` must be same-origin with an allowed host. Otherwise 403, including
  `null`.
- `/rpc` and `/ws` also refuse `Sec-Fetch-Site: cross-site|same-site`. Static pages accept those,
  so links into the PWA keep working.
- `/rpc` requires `content-type: application/json` (otherwise 415).
- Non-browser clients (no `Origin`) are unchanged.

### SBX-2: runner config readable from inside the sandbox (Low, hardening)

**Repro.** From inside the sandbox, `cat $TMPDIR/bh-sbx-*/cfg-*.json` returned the full compiled
policy. The violation socket itself was **not** reachable: srt's seccomp filter refuses `AF_UNIX`
(`EPERM`), and the directory is read-only. So violation forging was not possible on Linux.

**Fix.** The per-sandbox directory is added to srt `denyRead` and `denyWrite`. This also covers
macOS, where unix sockets are not blocked by seccomp.

### SBX-3: allow-listing `localhost` opened every host loopback port (Low)

srt deliberately lets the reserved `localhost` names resolve to loopback. So a `custom` / `workspace`
`net.allow` entry of `localhost`, `*.localhost`, `127.x`, `0.0.0.0` or `[::1]` exposed every local
service through srt's host-side proxy: the daemon API, other sessions' MCP bridges and broker, and
dev servers. This was confirmed with a test server on a random port. It requires owner
configuration.

**Fix.** `compilePolicy` drops loopback names and literals from `net.allow`
(`isLoopbackAllowEntry`). Host-loopback access goes only through `localAllow` with an explicit
`ip:port`, as the broker does.

### Follow-up: host-loopback access without touching NO_PROXY (core loop)

The first broker integration removed `127.0.0.1` from the sandbox's `NO_PROXY` so the harness reached
the host broker through srt's proxy. That broke harnesses with their own in-sandbox loopback server
(opencode), and proxy-unaware clients (node `fetch` in `beamhop-mcp`) could not reach the MCP bridge
from the isolated network namespace at all.

**Now (Linux).** srt's `NO_PROXY` is left alone. For every `127.0.0.1:<port>` entry in `localAllow`
(broker, MCP bridge) the runner starts a `socat` listener on `127.0.0.1:<port>` *inside* the
sandbox's network namespace, which tunnels each connection as `CONNECT 127.0.0.1:<port>` through
srt's HTTP proxy, authenticated with srt's per-run proxy token read from `$HTTP_PROXY` at run time
(never in argv). srt still decides: only the allow-listed `ip:port` entries pass, so SBX-3 holds.
The forwarders die with the sandbox's pid namespace. **macOS** (no network namespace) keeps the
`NO_PROXY` approach; `beamhop-mcp` honours `HTTP(S)_PROXY`/`NO_PROXY` there via undici's
`EnvHttpProxyAgent`.

**Tests.** `packages/sandbox/test/sandbox.real.test.ts` (forwarding: proxy-unaware client reaches
the allowed port, own loopback server works, another host port is refused directly and through the
proxy) and `apps/daemon/test/core-loop.test.ts` (daemon + harness in srt: broker key injection, MCP
`session_status`/`channel_send`, own loopback, other loopback closed). The latter fails on the old
runner.

## Verified not vulnerable (attempted, blocked)

- **Loopback / metadata through srt's proxy (Linux, real srt).** Refused targets: other
  `127.0.0.1` ports, `127.0.0.2`, `0.0.0.0`, decimal / hex / octal forms of 127.0.0.1,
  `[::ffff:127.0.0.1]`, `[::ffff:169.254.169.254]`, `169.254.169.254` directly and via the proxy,
  and wildcard-DNS names embedding the metadata IP. Direct `localhost` / `[::1]` connections fail
  (`--unshare-net`). Only the broker `ip:port` is reachable.
- **DNS rebinding of an allowed (non-`localhost`) name to loopback, link-local, metadata or this
  host's interface addresses.** srt's resolved-address guard refuses it. beamhop also adds
  RFC 1918, CGNAT and ULA through `deniedResolvedAddresses`. The guard is not evaluated when a
  `parentProxy` is configured: that proxy owns the policy (see R-7).
- **Process tree after SIGTERM or timeout.** The whole tree dies (`--die-with-parent` +
  `--unshare-pid`). Only SIGKILL was broken (SBX-1).
- **Writes to the runner dir or socket.** Refused: the filesystem is read-only, and `AF_UNIX` is
  refused by seccomp.
- **Runner argv `--` injection.** The separator is checked at its fixed position. User args
  follow it and are shell-quoted individually; srt re-quotes them for bwrap.
- **LLM proxy.**
  - Absolute-form and `//` request targets give 400, so it is not an open proxy.
  - `..` and `%2e` / `%2f` / `\` in the path give 400. Double-encoding is only decoded once
    upstream.
  - `Host` is not forwarded; the upstream host is fixed per route.
  - Client credentials (`authorization`, `x-api-key`, cookies, org/project headers) are stripped.
  - `set-cookie` is not returned.
  - Node's strict HTTP parser rejects CL/TE smuggling.
- **MCP bridge.**
  - Loopback only. Exact `Host` match. Any `Origin` is refused.
  - 256-bit tokens, hashed before the map lookup, so there is no useful timing signal.
  - 1 MiB body cap, `headersTimeout` 10 s, strict re-validation with zod.
  - Per-token contexts with no shared mutable state, so there is no cross-session confusion.

## Residual risks (not fixable at this layer, or design decisions)

- **R-1 (High): exfiltration through allowed LLM hosts.** Every profile allows direct egress to
  the provider APIs. An agent can carry data out in requests made with *its own* key (the attacker
  then reads their own provider logs), or through content a model echoes. Recommendations:
  - When the broker is in use, compile the sandbox allowlist **without** `LLM_PROVIDER_HOSTS`, so
    the broker becomes the only path.
  - Consider per-request logging and size limits in the broker.
  - Exfiltration inside prompts sent with the owner's key cannot be prevented: prompt content is
    the product.
- **R-2 (Medium): budget race.** `checkBudget` runs before the request and usage is only known
  afterwards. N parallel requests can all pass a nearly exhausted budget. Fix in the daemon:
  reserve an estimated cost per in-flight request, or cap concurrency per session.
- **R-3 (Medium): proxy path scope.** Any method and path under a route's upstream is forwarded
  with the real key, for example OpenAI `/v1/files`, `/v1/fine_tuning`, batch or admin endpoints.
  Recommendation: a per-route allowlist of `(method, path-prefix)`, such as `POST /v1/messages`,
  `POST /v1/chat/completions` and `POST /v1/responses`.
- **R-4 (Low): the session token is passed raw in `UsageEvent.session`.** Consumers must not log
  it; prefer a session id.
- **R-5 (Low): headers named in a client `Connection:` header are not stripped** before
  forwarding. Not exploitable against the current upstreams.
- **R-6 (Low): the host-side runner inherits the sandbox env.** If an owner passes `NODE_OPTIONS`
  or `LD_PRELOAD` through `env.passthrough`, it also affects the *unsandboxed* runner. These
  values are owner-controlled, not agent-controlled. Recommendation: spawn the runner with a
  minimal env, pass the sandbox env in the cfg file, and refuse loader variables in
  `env.passthrough`.
- **R-7 (Low): `parentProxy` disables srt's resolved-address guard.** The corporate proxy must
  enforce its own private-range policy.
- **R-8 (Low): token theft by same-user local processes.** Harness env (`/proc/<pid>/environ`),
  the API token file and the broker/bridge tokens are all readable by any process of the same UID
  outside the sandbox. This is out of scope: a hostile same-UID process already owns the account.
  Inside the sandbox, `/proc` is a fresh pid namespace.
- **R-9 (Info): `?token=` query auth** stays because browsers cannot set headers on WebSocket.
  Mitigations: `Referrer-Policy: no-referrer` and the new Origin/Host policy. A short-lived WS
  ticket minted over `/rpc` would be better.
- **R-10 (Info): the `none` backend** (`BEAMHOP_UNSAFE_NO_SANDBOX=1`) enforces nothing beyond env
  scrubbing and the broker, by design. It is loudly warned.

## Commands

```
pnpm run typecheck   # clean
pnpm run lint        # clean
pnpm vitest run      # 17 files, 248 passed, 1 skipped
```
