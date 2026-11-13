# FAQ

**Is beamhop an agent?**
No. It's the switchboard between agents you already use (Claude Code, Codex, Gemini CLI, …) and the
places people talk (Nostr, Telegram, Slack, Discord). Behavior comes from the harness and its own config
files; beamhop adds channel context, a sandbox, approvals and budgets.

**Do I need a server or a public URL?**
No. Every channel uses an outbound connection (Nostr relays, Telegram long polling, Slack Socket Mode,
the Discord Gateway). It runs fine on a laptop behind NAT. Cloud deploys are optional and open no inbound
ports.

**Does the agent see my API keys?**
No. The harness gets a placeholder key and a base URL pointing at beamhop's local broker, which adds the
real key on the way out. Keys live in the OS keychain (or an encrypted vault on headless Linux).

**Can a stranger who messages my bot make it do things?**
Unknown senders are ignored unless you mark the agent `public: true`, in which case they get the `viewer`
role: strict sandbox (read-only mounts, LLM hosts only), rate limits and DLP on every reply. Everything
they send is labelled as untrusted input.

**What happens if the agent gets prompt-injected?**
That is the design assumption. The sandbox limits what it can read, write and reach; risky actions need
your approval; budgets cap spend; outbound DLP catches secrets. It can still misuse whatever you allowed —
see [what is not protected](sandbox.md#what-is-not-protected).

**Why Nostr first?**
It gives every agent a real, portable identity (its own key, a verifiable owner attestation, an optional
NIP-05 handle on your domain), end-to-end encrypted DMs (NIP-17), groups (NIP-29) and an encrypted control
plane — with no accounts server and no open ports.

**Can I use my existing Nostr key as the owner?**
Yes: `beamhop init --owner-npub npub1…`. The daemon keeps only the npub; your key stays on your devices.
Agents always get their *own* keys — never give an agent your personal nsec.

**Does it work on Windows?**
Yes, with caveats: srt's Windows sandbox is alpha. `beamhop doctor` tells you what's available; WSL2 with
the Linux setup is the fallback and the safer choice today.

**Why is the standalone binary a folder, not one file?**
Node SEA can embed one script, but not native addons (the keychain binding), the sandbox runtime's helpers,
the Claude Agent SDK's platform binary, or the scripts that run as separate processes inside the sandbox.
Those ship in `lib/` next to the binary. Details in [quickstart.md](quickstart.md#standalone-binaries).

**Why is the npm install so big?**
Mostly the Claude Agent SDK, which bundles a Claude Code binary for your platform (~350 MB). It's an
optional dependency: if it is missing, the `claude` adapter is skipped and everything else works.

**How do I stop everything right now?**
`beamhop panic` (or the stop button in the PWA). It kills every session, pauses schedules and disconnects
channels, including on cloud daemons. Nothing resumes until `beamhop resume`.

**Where is my data?**
In `~/.beamhop` (or `BEAMHOP_HOME`): YAML configs, an SQLite database encrypted with a key from the
keychain, logs. Transcripts are kept 30 days and the audit log 1 year by default (`retention` per agent).
`beamhop data export` and `beamhop data purge --agent <a> [--before <date>]` do what they say. Telemetry
is off.

**How do I add a harness beamhop doesn't know?**
If it speaks ACP: `beamhop harness add myagent --acp "my-agent --acp"`. Otherwise, open an issue with the
harness's headless/RPC docs; adapters live in `packages/harness-*`.

**The daemon says "no sandbox backend available".**
Run `beamhop doctor` and apply the fixes it prints. On Ubuntu 24.04+ the usual culprit is AppArmor's
restriction on unprivileged user namespaces. Only on PaaS containers that can't do user namespaces should
you consider `BEAMHOP_UNSAFE_NO_SANDBOX=1` — read [sandbox.md](sandbox.md#prerequisites-and-doctor) first.
