# Security review — wave C (cloud, pairing, push, git ops, hosted PWA)

Scope:

- Web Push: `apps/daemon/src/push.ts`, `alerts.ts`, `apps/pwa/public/push-sw.js`, `apps/pwa/src/api/push.ts`.
- Cloud provisioning, heartbeats and panic-to-cloud: `apps/daemon/src/cloud.ts`, `remote.ts`, and the
  deploy contract in `packages/deploy` (cloud-init, PaaS env, `docker/entrypoint.sh`).
- Device pairing: `apps/daemon/src/pairing.ts`, `packages/channel-nostr/src/pairing.ts`, the
  unpaired-sender path and rate limits of `control-server.ts`.
- Owner key handling: `apps/daemon/src/identity.ts`, `identity.ownerExport`.
- Hosted PWA: `apps/pwa/src/api/{nostr,device-key,signer*,pairing,daemons,connection}.ts`, the build.
- `beamhop init`, `beamhop device pair`, the SEA launcher (`apps/cli/scripts/sea.mjs`) and
  `scripts/check-no-secrets.mjs`.
- Added mid-review: the new daemon API methods: `fs.list`, `agent.instructionsWrite`,
  `session.merge` / `session.openPr` (`git-ops.ts`), always-rules (`rules.ts`), `role.define/delete`,
  `alerts.set`, `system.whoami`.

Threat model as in `PLAN.md` §7A: any agent may be fully prompt-injected; relays, other Nostr users
and whoever learns a public key are hostile; a cloud host may be compromised after provisioning.
Waves A and B are not repeated.

Each **confirmed** finding has a regression test that fails on the old code and passes now. For
GIT-1 the attack itself is shown by a precondition test (plain `git status` in a planted worktree
runs the attacker's command), and a real-bwrap probe showed that the old sandbox write set allowed
writing `<repo>/.git/config` and `.git/hooks/post-commit`.

## Findings

| ID | Severity | Area | Status | Regression test |
| --- | --- | --- | --- | --- |
| GIT-1 | **Critical** | session git worktrees: sandbox escape via `.git` | Fixed | `apps/daemon/test/security-wave-c-git.test.ts` |
| PROV-1 | **High** | cloud provisioning: first hello wins (TOFU) | Fixed | `apps/daemon/test/cloud.test.ts` (review wave C) |
| CTRL-1 | Medium | cloud host: controller key had full owner API | Fixed | `apps/daemon/test/cloud.test.ts` (review wave C) |
| PUSH-1 | Medium | Web Push endpoint SSRF from the daemon | Fixed | `apps/daemon/test/push.test.ts` (PUSH-1) |
| PAIR-1 | Medium | cancelled pairing still completable with its code | Fixed | `apps/daemon/test/security-wave-c.test.ts` |
| RULE-1 | Medium | always-rules: prefix rules widened to "run anything" | Fixed | `apps/daemon/test/security-wave-c.test.ts` |
| PWA-1 | Medium | hosted PWA had no CSP while holding the device key | Fixed | e2e smoke + pair (`apps/pwa/e2e`) on the built app |
| PAIR-2 | Low/Medium | `device pair --no-wait` / `--json` paired without confirmation | Fixed | `apps/cli/test/init.test.ts` (PAIR-2) |
| SCAN-1 | Low | secret scanner false negatives | Fixed | `apps/cli/test/check-no-secrets.test.ts` |
| OWN-1 | Low (hardening) | `ownerExport` refused by transport denylist | Fixed | `apps/daemon/test/security-wave-c.test.ts` |
| R-C1…R-C10 | Low / info | various | Documented | n/a |

### GIT-1: an agent could plant git config/hooks that unsandboxed git runs (Critical)

For a git rw mount, a session works in a linked worktree. To let the agent commit there, the whole
`<repo>/.git` directory was added to the sandbox write list (`sessions.ts`), and the worktree's own
`.git` pointer file was writable as part of the mount. From inside the sandbox an agent could:

- write `<repo>/.git/config` (`core.fsmonitor`, `core.sshCommand`, `alias.*`, filter drivers) or
  `<repo>/.git/hooks/*`, which run the next time **the owner** uses git in their repository, outside
  any sandbox;
- move any branch (`refs/heads/main`) to its own commit;
- rewrite `<worktree>/.git` (`gitdir: .evil`) or the admin dir's `commondir` to point at a fake
  repository it controls, whose config runs a command on `git status`.

The new `session.merge` / `session.openPr` handlers run `git status`, `git add -A`, `git commit`,
`git merge` and `git push` in that worktree from the unsandboxed daemon. With the planted
`core.fsmonitor`, a single tap on "Merge" in the PWA ran attacker code on the host. Also,
`repoOfWorktree` asked git in the (attacker-controlled) worktree which repository it belongs to.

Fix:

- The sandbox write set is now only `objects/`, `refs/heads/beamhop/`, `logs/refs/heads/beamhop/`
  and the worktree's own admin dir (`sandboxGitWritePaths`). Config, hooks, `info/`, other branches
  and other worktrees stay read-only. A real-bwrap test shows the agent can still commit on its
  branch, and cannot write the config, a hook or `refs/heads/main`.
- Before any daemon-side git in a worktree, `verifyWorktree` checks without running git there: `.git`
  is a small regular file pointing at `<repo>/.git/worktrees/<name>` of one of the agent's own
  repositories (resolved from the agent's mounts, outside the worktree); `commondir` and `gitdir`
  point back correctly; there is no `config.worktree`; and `HEAD` is exactly the session branch. A
  tampered worktree gives `sandbox_violation`. The same check runs when a worktree is reused.
- Every daemon-side git call runs with `core.hooksPath=<devnull>`, `core.fsmonitor=false` and
  `protocol.ext.allow=never` (`HARDENED_GIT_ARGS`).

### PROV-1: anyone who knew the provisioning pubkey could receive the agent's secrets (High)

The owner's daemon provisioned the **first** host that sent `beamhop.provision.hello` for a pending
deployment, with the matching agent name, to the provisioning pubkey P. P is public by design: it
sits in cloud-init or PaaS env, in provider metadata and deploy logs, and it shows as the `p` tag of
the real host's hello on public relays. Agent names are guessable or public (kind-0 profiles). The
hello is re-sent every 20 s and the listener may start after the host's first hello. So an observer
could answer in that window. It then received the agent's nsec, its LLM keys and its channel tokens,
encrypted to the attacker's own key.

Fix: a one-time **binding token** per deployment.

- `provisioningInfo` creates 32 random bytes (hex), stored locally as
  `beamhop.provision.<agent>.token`. That name is internal, so it is never provisioned or listed.
- The deployer puts it in the host's environment as `BEAMHOP_PROVISIONING_TOKEN`. In cloud-init the
  env file is now `0600`, root-only. The container entrypoint allowlists the variable.
- The host's hello carries `proof = HMAC-SHA256(token, "beamhop-provision-v1\n" + agent + "\n" + hostPubkey)`.
  The proof is bound to the sending key, so it cannot be replayed from another key.
- The owner's daemon verifies the proof in constant time before provisioning. Refusals are audited
  as `deploy.hello_refused` (security).
- The token is deleted after a successful provisioning or `deploy destroy`. The host removes it from
  `process.env` at start.

This puts no long-lived secret in cloud-init. The token only authorizes *receiving* the first
provisioning, and is worthless once that has happened. An attacker who can read the host's user data
*before* it is provisioned can still race. That is the same exposure as the provider console, and it
is documented as R-C1. Deployments created by a deployer that does not ask for provisioning info (no
token on record) keep the old first-hello behavior.

UX hook: while awaiting provisioning, the host logs `awaiting provisioning; this host's control key
is npub1…`, which shows in `beamhop deploy logs` and the provider console. The owner compares it with
the `npub` in `beamhop deploy status` / the PWA Deploy screen. On a mismatch, destroy the host.

### CTRL-1: the owner daemon's controller key was a full owner on the cloud host (Medium)

Provisioning adds the owner daemon's controller npub as a paired device on the host. Paired devices
act as the local owner, so this key could call every method: `secret.set`, `identity.ownerImport`,
`agent.update`, `deploy.*`, and so on. It is only needed for panic, resume and status. The one-time
provisioning key P, while allowlisted, could also reach every method besides `beamhop.provision`.

Fix: a per-key method allowlist in the control-plane handler (`CloudSide.methodsFor`).

- Controller keys may call only `system.panic`, `system.resume` and `system.status`.
- P may call only `beamhop.provision`.
- Controller keys are remembered as a union across re-provisionings, so an old key never becomes
  unrestricted.

### PUSH-1: push subscription endpoints were an SSRF primitive (Medium)

`device.pushSubscribe` accepted any `https:` URL. The daemon runs outside the sandbox (and may sit
behind `HTTPS_PROXY`), and it POSTs a VAPID-signed body to the endpoint on every alert. That includes
`https://127.0.0.1:<port>/…`, `https://169.254.169.254/…` and internal hosts. Any paired device, or
the local PWA, could aim it.

Fix: `isPushServiceEndpoint` accepts only `https:` on the default port, without credentials, on the
browsers' push services:

- `fcm.googleapis.com` and `android.googleapis.com`
- `*.push.services.mozilla.com`
- `web.push.apple.com`
- `*.notify.windows.com`

Lookalike hosts are refused, for example `fcm.googleapis.com.evil.example`.

### PAIR-1: "cancel" did not revoke the pairing code (Medium)

Cancelling a pairing before any device answered (`device.pairConfirm accept:false` while `waiting`)
set the record to `rejected` but left the one-time code valid. `device.pairComplete` never looked at
the record's status. Whoever had seen the QR code could still pair afterwards, and with
`requireConfirm: false` the device was allowlisted as an owner device immediately. That is exactly the
case the user had just tried to stop.

Fix: `complete()` refuses unless the pairing record is still `waiting`, after applying expiry. The
attempt counts as a failure for the limiter and is audited (`pairing-rejected` / `pairing-expired`).

### RULE-1: command prefix rules could be widened to arbitrary commands (Medium)

The interpreter blocklist compared the first word literally. These prefixes were accepted, and each
one matches any command:

- `FOO=1` (env assignment): matches `FOO=1 bash -c …`.
- `"bash"`, `python3.12`, `node22`, `PowerShell.exe`.
- `npx`, `sed -n` (GNU `e` executes), `find .` (`-exec`), `git` (`git -c alias.x=!sh x`).

Quoting characters were not shell metacharacters, so `git log '--output=…'` matched a `git log` rule.

Fix:

- The first word must be a plain program name.
- Names are normalized: path, Windows extension and version suffix are dropped.
- The interpreter list is extended with code-running tools.
- Tools that take subcommands (`git`, `npm`, `docker`, `make`, …) need a non-option subcommand in the
  prefix.
- Quotes, braces, parentheses and `!` count as metacharacters. A prefix rule never matches a request
  that contains them, and those requests need an exact rule.

These rules only skip the approval prompt. The command still runs in the sandbox. See R-C5 for why
this remains a blocklist.

### PWA-1: the hosted PWA had no Content-Security-Policy (Medium)

The daemon sends a strict CSP header, but the hosted copy (static hosting, app.beamhop.dev / GitHub
Pages) sent none. That is the copy that keeps the device key in IndexedDB. `device-key.ts` names a
strict CSP as the mitigation for script access to the key.

Fix: the production build injects
`<meta http-equiv="Content-Security-Policy">` with `script-src 'self'`, `object-src 'none'`,
`base-uri 'none'` and `form-action 'none'`, among other directives (`PWA_CSP` in `vite.config.ts`).
The dev server is excluded because it uses inline scripts.

Verified:

- The built `dist/index.html` has no inline script.
- The Playwright smoke and pair suites (54 tests) pass against the built app with the policy in
  place.

`frame-ancestors` cannot be set from a meta tag. See R-C6.

### PAIR-2: `beamhop device pair --no-wait` / `--json` paired without confirmation (Low/Medium)

The interactive path uses `requireConfirm: true`. The non-waiting and JSON paths did not, although
the help text promised "confirm later". A QR code printed into a shared terminal or CI log was
enough to pair silently.

Fix:

- Both paths start the pairing with `requireConfirm: true`.
- New `beamhop device confirm <pairingId>` shows the safety phrase. `--accept` or `--reject`
  decides.
- `docs/cli.md` is regenerated.

### SCAN-1: secret scanner false negatives (Low)

`scripts/check-no-secrets.mjs` had several blind spots:

- It skipped lines longer than 20,000 characters (minified bundles, lockfiles, snapshots).
- It skipped files over 2 MB.
- It treated UTF-16 files as binary.
- It had no rules for PEM private keys, npm, Google API, GitLab, Stripe live or Fly tokens.

Fix:

- Every line is scanned. All rules start with a literal prefix, so scanning stays linear.
- Files up to 32 MB are scanned. A larger text file is reported instead of being silently skipped.
- UTF-16 files with a BOM are decoded.
- Six rules are added. Three test fixtures (`broker/test/dlp.test.ts` PEM headers, the Fly token in
  `deploy/test/fly.test.ts`) now build those strings at runtime.

### OWN-1: `identity.ownerExport` used a transport denylist (Low, hardening)

It refused only `transport === 'nostr'`. It now requires `caller === 'local'` on `direct`, `http` or
`ws`, so a future transport or a non-local caller is refused by default.

## Verified not vulnerable (attempted)

- **SEA launcher "only scripts inside lib/".**
  - The check realpaths both sides, so `..`, symlinks out of `lib/` and other drives are refused.
    On Windows, `path.relative` handles case.
  - `process.execPath` is the resolved binary path.
  - A file named `..x.js` inside `lib/` is wrongly refused, which is safe.
  - Swapping a file between the check and the import needs write access to `lib/`, and at that point
    the attacker already controls the install.
- **`push-sw.js`.**
  - `notificationclick` only opens same-origin URLs: others fall back to the scope root.
  - It focuses only same-origin windows.
  - The payload carries no secrets: titles and bodies are bounded, and approvals carry only the id.
- **Control plane, unpaired senders.**
  - The rate limit (5 per sender and 30 overall per minute) runs before decryption.
  - Only `device.pairComplete` is reachable, and it must be signed by the key being paired, so a
    phished QR code cannot pair someone else's key.
  - A replayed `pairComplete` is stopped by the replay guard, and the code is single use.
  - Brute force with many npubs hits the global failure limit of `PairingLimiter`.
- **Safety phrase.**
  - It is 44 bits, derived from both pubkeys.
  - Grinding a matching device key inside the 10 + 5 minute window is not practical. The target
    phrase depends on the victim phone's fresh key, so nothing can be precomputed.
- **Device removal.**
  - The control allowlist is updated synchronously.
  - A call in flight gets no reply.
  - `notify` filters by the current allowlist.
  - The push subscription and preferences are dropped, and the owner `people` link is removed.
- **Heartbeats.**
  - The control client accepts only events authored by the followed host key and tagged to itself.
  - The heartbeat `npub` must match.
- **`fs.list`.**
  - Directories only, under home or the configured roots, checked on the realpath.
  - Symlinks must stay inside the roots.
  - Hidden and always-denied entries are skipped. Owner-only.
- **`agent.instructionsWrite`.**
  - Owner-only, limited to a fixed list of file names inside rw mounts.
  - A symlinked parent directory or target is refused.
  - The file is written with `O_EXCL | O_NOFOLLOW` and then renamed.
- **`session.openPr` / `remoteUrl`.**
  - The remote name is restricted to `[A-Za-z0-9._-]` and cannot start with `-`, so
    `--receive-pack=` style injection is impossible.
  - Branch names go through `check-ref-format` and cannot start with `-`.
  - Credentials are stripped from the URL in the approval card and the audit.
  - The push only runs after an approval.
  - The compare URL is only built for known hosts, with encoded components.
- **`role.define/delete`.**
  - Owner-only. `owner` and `agent` cannot be changed.
  - Fields are validated one by one.
  - A custom role that is in use cannot be deleted.
- **`alerts.set`.** Zod-validated, and the thresholds are ordered.
- **`system.whoami`.** It reflects the authenticated caller only.
- **Hosted PWA rendering.**
  - There is no `dangerouslySetInnerHTML` or `innerHTML`.
  - Links are app routes built from daemon data.
  - Daemon replies are authenticated: NIP-44, and the author must be the daemon key.
- **Cloud-init / entrypoint injection.**
  - Every interpolated value is validated: slug, semver, npub, hex, the new token pattern and npm
    specs.
  - YAML is produced by a serializer.
  - The entrypoint validates package specs and never `eval`s env.

## Residual risks

- **R-C1 (Medium): user data read before provisioning.**
  - Whoever can read the host's environment before it is provisioned can still race. That means the
    provider account, the provider metadata service from inside the VM, or PaaS team members.
  - Mitigation: compare the host npub (UX hook above).
  - A stricter mode would hold provisioning until the owner confirms the npub in the PWA. That needs a
    `deploy.confirmHost` method, which is a core contract change and was left out of this
    merge-friendly wave.
- **R-C2 (Medium): reftable repositories.** With `extensions.refStorage=reftable`, refs cannot be
  scoped per branch, so in-sandbox commits fail. They are not widened.
- **R-C3 (Low): remote-tracking refs and `FETCH_HEAD`.**
  - `refs/remotes/` is no longer writable, so an in-sandbox `git fetch` cannot update tracking refs.
    This is intended: a poisoned `origin/main` would mislead the owner.
- **R-C4 (Low): TOCTOU on worktree verification.**
  - Merge and PR refuse while the session is `running`.
  - A background process left in a stopped session's sandbox could change the admin dir between the
    check and the git call.
  - Hooks and fsmonitor are disabled anyway, and the config remains read-only.
- **R-C5 (Low): prefix rules are a blocklist.**
  - Any tool that executes its arguments and is not on the list (`tar --to-command`, `rsync -e`,
    editors) can still be widened.
  - Exact rules are the default, and the command still runs inside the sandbox.
- **R-C6 (Low): headers the hosted PWA cannot send.**
  - The static host should send `frame-ancestors 'none'` / `X-Frame-Options: DENY` and a CSP header.
    A meta tag cannot carry `frame-ancestors`.
  - Trusted Types (`require-trusted-types-for 'script'`) look feasible, since there are no HTML sinks
    in app code. They were left out until the e2e suite runs with a violation listener.
- **R-C7 (Low): device key in IndexedDB.**
  - WebCrypto has no secp256k1, so the AES-GCM wrapping protects disk dumps but not same-origin
    script. This is unchanged and documented in `device-key.ts`.
  - CSP (PWA-1) reduces the XSS surface.
  - NIP-07 extension prompts are outside the app's control. The app never asks an extension to sign
    for a daemon it was not paired with.
- **R-C8 (Low): push service list.**
  - New browsers or self-hosted push services (for example UnifiedPush) need an addition to
    `PUSH_SERVICE_HOSTS`. There is no config override, to keep the policy fixed.
- **R-C9 (Low): pairing lockout DoS.**
  - The global failure limit lets an attacker who knows the daemon pubkey block pairing for the
    window. Starting a new pairing does not reset it.
- **R-C10 (Info): owner nsec at rest.**
  - It sits in the daemon's secret store (keychain or vault) and is exported once. A cloud host never
    receives it: `beamhop.*` names are local-only.
  - When the daemon holds it, the owner key signs provisioning, so a compromised owner machine is
    still a total compromise, by design.

## API and contract changes

- **`@beamhop/core`:** none.
- **`@beamhop/deploy`.**
  - `ProvisioningInfo.provisioningToken?`, `CloudInitOptions.provisioningToken?` and
    `assertProvisioningToken` are new.
  - The env var `BEAMHOP_PROVISIONING_TOKEN` is new.
  - The cloud-init env file is now `0600`.
- **Daemon.**
  - The hello `params.proof` and the audit types `deploy.hello_refused` and `pairing.failed`
    (reasons `pairing-rejected` / `pairing-expired`) are new.
  - `repoOfWorktree(wt, { repos, branch })` replaces `repoOfWorktree(wt)`.
  - `verifyWorktree`, `sandboxGitWritePaths` and `HARDENED_GIT_ARGS` are new.
  - `isPushServiceEndpoint` and `PUSH_SERVICE_HOSTS` are new.
  - `CloudSide.methodsFor` and `CONTROLLER_METHODS` are new.
- **CLI:** new `beamhop device confirm <pairingId> [--accept|--reject]`. `device pair --no-wait` and
  `--json` now require confirmation.

## Commands

```
pnpm run typecheck                         # clean
pnpm run lint                              # clean
pnpm vitest run                            # 75 files, 1076 passed, 1 skipped (one load-related NOS-1 timeout passes alone)
node scripts/check-no-secrets.mjs          # clean
(cd apps/pwa && pnpm run typecheck && pnpm run test && pnpm run build)
(cd apps/pwa && pnpm exec playwright test e2e/smoke.spec.ts e2e/pair.spec.ts --project=desktop)  # 54 passed
```
