# Security policy

beamhop runs AI agents that read untrusted messages and act on your machine, so we take reports
seriously — including "this is documented but worse than you think".

## Reporting a vulnerability

**Please do not open a public issue.** Instead, use GitHub's private vulnerability reporting:
**Security → Report a vulnerability** on <https://github.com/beamhop/client>. Include:

- what an attacker controls (a channel message, a file the agent reads, a peer agent, a local process…)
- what they gain (sandbox escape, secret exfiltration, impersonation, spend, approval bypass…)
- a reproduction (commands, config, platform, srt version) and the beamhop version (`beamhop --version`)

We aim to acknowledge within 3 working days and to agree on a fix and disclosure timeline within 14 days.
We credit reporters in the release notes unless you prefer otherwise.

Never include real secrets in a report. If you accidentally exposed one of your own tokens while testing,
rotate it.

## Scope

In scope: everything in this repository — the daemon, CLI, PWA, channel and harness adapters, the sandbox
integration, the broker/LLM proxy, the MCP server, deployers, the container image and release artifacts.

The threat model is in [PLAN.md §7A](PLAN.md#7a-threat-model): any agent may be fully prompt-injected
through any channel, and we still want to prevent data exfiltration, host compromise, impersonation and
spend abuse. Known residual risks are listed in [docs/sandbox.md](docs/sandbox.md#what-is-not-protected)
and the reviews under [docs/security](docs/security/); a report that shows one of them is exploitable in a
way the docs understate is welcome.

Out of scope: vulnerabilities in the harnesses themselves (report those upstream — we're happy to help
coordinate), in srt (report to [anthropics/sandbox-runtime](https://github.com/anthropics/sandbox-runtime)),
and attacks that require an already-compromised account of the same OS user.

## Supported versions

Before 1.0, only the latest release gets security fixes.

## Verifying releases

- npm: published with provenance — `npm audit signatures`.
- Binaries: `SHA256SUMS` is signed with keyless cosign (`SHA256SUMS.sigstore.json`); see
  [docs/quickstart.md](docs/quickstart.md#1-install).
- Container: `ghcr.io/beamhop/agent` is cosign-signed and carries build provenance; see
  [docs/cloud.md](docs/cloud.md#the-container-image).
