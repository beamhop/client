# Cloud

Run an agent on a server instead of your laptop. Two entry points:

- **Move to cloud** (`--mode move`, default): an existing agent's config and identity move with it; git
  mounts are cloned on the server, other mounts are copied once (rsync over SSH on a VPS, a volume upload
  on PaaS). Ongoing Mutagen sync is opt-in per mount (VPS only).
- **New cloud agent** (`--mode new`): created directly on the server; mounts are git repos or empty volumes.

Either way you see the plan and the estimated monthly cost before anything is created.

## Providers

| Provider     | id             | Kind | What gets created                                                     | Default region / size |
| ------------ | -------------- | ---- | --------------------------------------------------------------------- | --------------------- |
| Hetzner      | `hetzner`      | VPS  | server via the Cloud API; cloud-init installs Node, beamhop, srt prerequisites and your harnesses; firewall allows outbound only | `fsn1` / `cx23` |
| DigitalOcean | `digitalocean` | VPS  | droplet + cloud firewall, same cloud-init                              | `fra1` / `s-1vcpu-2gb` |
| Fly.io       | `fly`          | PaaS | machine running `ghcr.io/beamhop/agent`, no services/ports, restart always | `fra` / `shared-cpu-1x-1gb` |
| Render       | `render`       | PaaS | background worker from `ghcr.io/beamhop/agent` + persistent disk       | `frankfurt` / `standard` |
| Railway      | `railway`      | PaaS | service from `ghcr.io/beamhop/agent` + volume; no domain, no TCP proxy | `europe-west4-drams3a` / `usage-small` |

## Setup

Store the provider's API token in the keychain (it never leaves your machine; the server never gets it):

```bash
beamhop secret set deploy.hetzner.token          # reads the value from stdin
# or: beamhop secret set deploy.hetzner.token --from-env HCLOUD_TOKEN
beamhop deploy providers                         # shows which providers are configured
```

Secret names: `deploy.hetzner.token`, `deploy.digitalocean.token`, `deploy.fly.token`,
`deploy.render.token`, `deploy.railway.token`.

## Deploy

```bash
beamhop deploy plan  --provider hetzner --agent reviewer [--region fsn1] [--size cx23]
beamhop deploy apply --provider hetzner --agent reviewer
beamhop deploy ls
beamhop deploy destroy <id>
```

`plan` lists every resource it will create (`+`), change (`~`) or delete (`-`), the estimated
`$/month` and warnings (PaaS pricing caveats, sandbox mode). `apply` refuses plans above the deploy spend
cap unless an owner approves.

## How the server is controlled

- The server starts **"awaiting provisioning"**: no secrets are baked into the image, cloud-init or provider
  env vars. Your daemon sends the agent identity and secrets over the encrypted Nostr control channel to the
  server's provisioning key; the server stores them in its own vault. The container entrypoint even drops
  secret-looking environment variables.
- There are **no inbound ports**: VPS firewalls allow outbound only, PaaS services get no domain or TCP
  proxy. Control happens only over Nostr control events from npubs on the allowlist, with replay
  protection.
- `beamhop panic` reaches cloud daemons over the same channel.
- Deployment state is kept locally (`~/.beamhop/deployments.json`) and mirrored to an encrypted Nostr event,
  so a second device of yours can manage the deployments.

## Sandbox on servers

- **Hetzner, DigitalOcean:** full srt. cloud-init grants user namespaces to `bwrap` only through an
  AppArmor profile, instead of flipping Ubuntu's global sysctl.
- **Fly.io:** Firecracker VMs; srt is expected to run normally, and `beamhop doctor` verifies user
  namespaces on first boot.
- **Render, Railway:** the container may not allow user namespaces, so bubblewrap can fail. Then the
  container is the filesystem boundary and the broker still holds the keys, but srt's filesystem and egress
  rules don't apply (`BEAMHOP_UNSAFE_NO_SANDBOX=1`). The plan shows this warning. Prefer a VPS or Fly for
  agents that read anything sensitive.

## Harness auth on a server

Per agent (`harnessAuth` in the agent YAML):

- `api-key` (default): the key stays in your keychain or the remote vault and the broker injects it; the
  sandbox only ever sees a placeholder.
- `subscription`: device-code/OAuth login for the harness, run on the server through the PWA. Some
  subscription plans don't allow use on servers or by other people; beamhop shows a warning with a link to
  the provider's terms.

## The container image

`ghcr.io/beamhop/agent:<version>` is built from `packages/deploy/Dockerfile` (Node 22 slim, bubblewrap,
socat, ripgrep, git, tini; runs as uid 10001; `HEALTHCHECK` on the daemon socket) for linux/amd64 and
linux/arm64, with SBOM and build provenance, and signed with keyless cosign. Verify:

```bash
cosign verify ghcr.io/beamhop/agent:0.1.0 \
  --certificate-identity-regexp 'https://github.com/beamhop/client/.github/workflows/release.yml@.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Build your own with preinstalled harnesses:

```bash
docker build --build-arg BEAMHOP_VERSION=0.1.0 \
  --build-arg HARNESS_PACKAGES="@anthropic-ai/claude-code @openai/codex" \
  -t my/agent:0.1.0 packages/deploy
```
