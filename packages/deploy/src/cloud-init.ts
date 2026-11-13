import { BeamhopError } from '@beamhop/core';
import { stringify } from 'yaml';
import { resolveHarnessPackages } from './harness-packages.ts';
import {
  assertAgentSlug,
  assertNoSecrets,
  assertNpub,
  assertPubkey,
  assertSecretRef,
  assertSshPubkey,
  assertVersion,
} from './validate.ts';

export const REMOTE_USER = 'beamhop';
export const REMOTE_HOME = '/home/beamhop';
export const REMOTE_BEAMHOP_HOME = '/home/beamhop/.beamhop';
export const REMOTE_WORKSPACES = '/home/beamhop/.beamhop/workspaces';

export interface CloudInitOptions {
  agent: string;
  /** Harness ids (catalog ids, e.g. "claude", "codex"). */
  harnesses: string[];
  /** Exact beamhop version to install (cloud daemons follow the owner's local version, §12). */
  beamhopVersion: string;
  /** Owner npub: the only principal allowed to provision the daemon. */
  ownerNpub: string;
  /**
   * Name of the vault entry the daemon will hold its own nsec under once it is provisioned over
   * the Nostr control channel. This is a *reference*, never the key.
   */
  daemonNsecRef: string;
  /** One-time provisioning public key (hex or npub). The matching secret stays on the owner's machine. */
  provisioningPubkey?: string;
  /** Opt-in SSH: OpenSSH public keys for the `beamhop` user. Without it, sshd is disabled and port 22 closed. */
  sshAuthorizedKeys?: string[];
  /** Override harness → npm package mapping (e.g. from the signed catalog). */
  harnessPackages?: Record<string, string[]>;
  /** nodejs.org/dist channel directory, e.g. "latest-v22.x" (default) or "v22.12.0". */
  nodeDist?: string;
  /** Provider id, recorded in the daemon env for diagnostics. */
  provider?: string;
}

/**
 * Installs Node from the official nodejs.org tarball, verifying it against SHASUMS256.txt.
 * Arch is detected so Hetzner CAX (arm64) works too.
 */
const NODE_INSTALL_SCRIPT = `#!/bin/sh
# Installs Node.js from the official tarball (https://nodejs.org/dist/) and verifies its SHA-256.
set -eu
DIST="\${1:-latest-v22.x}"
case "$(dpkg --print-architecture)" in
  amd64) NARCH=x64 ;;
  arm64) NARCH=arm64 ;;
  *) echo "unsupported architecture" >&2; exit 1 ;;
esac
TMP="$(mktemp -d)"
cd "$TMP"
curl -fsSLO --retry 5 "https://nodejs.org/dist/$DIST/SHASUMS256.txt"
FILE="$(grep -oE "node-v2[2-9]\\.[0-9]+\\.[0-9]+-linux-$NARCH\\.tar\\.xz" SHASUMS256.txt | head -n 1)"
[ -n "$FILE" ] || { echo "no Node 22+ tarball found in $DIST" >&2; exit 1; }
curl -fsSLO --retry 5 "https://nodejs.org/dist/$DIST/$FILE"
grep " $FILE\\$" SHASUMS256.txt | sha256sum -c -
tar -xJf "$FILE" -C /usr/local --strip-components=1 --no-same-owner
cd /
rm -rf "$TMP"
node --version
`;

/**
 * Ubuntu 24.04 restricts unprivileged user namespaces through AppArmor, which breaks bubblewrap
 * (srt's Linux backend, §7). Grant userns to bwrap only, instead of flipping the global sysctl.
 */
const BWRAP_APPARMOR = `abi <abi/4.0>,
include <tunables/global>

profile beamhop-bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/beamhop-bwrap>
}
`;

export const renderSystemdUnit = (agent: string): string => `[Unit]
Description=beamhop daemon (agent ${agent})
Documentation=https://beamhop.dev
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${REMOTE_USER}
Group=${REMOTE_USER}
EnvironmentFile=/etc/beamhop/beamhopd.env
ExecStart=/usr/local/bin/beamhop daemon --foreground
Restart=always
RestartSec=5
# Hardening. RestrictNamespaces= is intentionally absent: srt's bubblewrap needs user namespaces.
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=${REMOTE_BEAMHOP_HOME}
PrivateTmp=yes
ProtectKernelModules=yes
UMask=0077

[Install]
WantedBy=multi-user.target
`;

const envFile = (
  o: Required<Pick<CloudInitOptions, 'agent' | 'ownerNpub' | 'daemonNsecRef'>> & {
    provisioningPubkey?: string;
    harnesses: string[];
    provider?: string;
    beamhopVersion: string;
  },
): string => {
  const lines: Record<string, string> = {
    BEAMHOP_HOME: REMOTE_BEAMHOP_HOME,
    // ProtectSystem=strict makes $HOME read-only; harness caches/configs live under ~/.beamhop.
    XDG_CONFIG_HOME: `${REMOTE_BEAMHOP_HOME}/xdg/config`,
    XDG_CACHE_HOME: `${REMOTE_BEAMHOP_HOME}/xdg/cache`,
    XDG_DATA_HOME: `${REMOTE_BEAMHOP_HOME}/xdg/data`,
    XDG_STATE_HOME: `${REMOTE_BEAMHOP_HOME}/xdg/state`,
    npm_config_cache: `${REMOTE_BEAMHOP_HOME}/xdg/cache/npm`,
    NODE_ENV: 'production',
    BEAMHOP_AGENT: o.agent,
    BEAMHOP_VERSION: o.beamhopVersion,
    BEAMHOP_OWNER_NPUB: o.ownerNpub,
    BEAMHOP_DAEMON_NSEC_REF: o.daemonNsecRef,
    // The daemon starts without any secret and waits for the owner to provision it over Nostr.
    BEAMHOP_AWAIT_PROVISIONING: '1',
    BEAMHOP_HARNESSES: o.harnesses.join(','),
    BEAMHOP_SANDBOX_FS: 'srt',
  };
  if (o.provisioningPubkey) lines.BEAMHOP_PROVISIONING_PUBKEY = o.provisioningPubkey;
  if (o.provider) lines.BEAMHOP_DEPLOY_PROVIDER = o.provider;
  return `${Object.entries(lines)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')}\n`;
};

/**
 * Render the cloud-init user_data for a VPS (Hetzner, DigitalOcean).
 *
 * Guarantees: no secrets are embedded (only the owner npub, a provisioning *public* key and a
 * secret *reference*); no inbound ports unless SSH is explicitly opted into; the daemon runs as an
 * unprivileged `beamhop` user under a hardened systemd unit.
 */
export const renderCloudInit = (opts: CloudInitOptions): string => {
  const agent = assertAgentSlug(opts.agent);
  const version = assertVersion(opts.beamhopVersion);
  const ownerNpub = assertNpub(opts.ownerNpub);
  const nsecRef = assertSecretRef(opts.daemonNsecRef);
  const provisioningPubkey = opts.provisioningPubkey ? assertPubkey(opts.provisioningPubkey) : undefined;
  const sshKeys = (opts.sshAuthorizedKeys ?? []).map(assertSshPubkey);
  const ssh = sshKeys.length > 0;
  const harnessPkgs = resolveHarnessPackages(opts.harnesses, opts.harnessPackages);
  const nodeDist = opts.nodeDist ?? 'latest-v22.x';
  if (!/^(latest-v2[2-9]\.x|v2[2-9]\.\d+\.\d+)$/.test(nodeDist)) {
    throw new BeamhopError(
      'invalid_input',
      `nodeDist must be "latest-v22.x"-style or an exact v22+ version, got "${nodeDist}"`,
    );
  }

  const user: Record<string, unknown> = {
    name: REMOTE_USER,
    gecos: 'beamhop daemon',
    shell: '/bin/bash',
    lock_passwd: true,
    // Lets the daemon read its own journal for `beamhop logs` over the control channel.
    groups: ['systemd-journal'],
  };
  if (ssh) user.ssh_authorized_keys = sshKeys;

  const runcmd: (string | string[])[] = [
    ['/usr/local/sbin/beamhop-install-node', nodeDist],
    ['npm', 'install', '--global', '--no-fund', '--no-audit', `beamhop@${version}`, ...harnessPkgs],
    [
      'sh',
      '-c',
      'if command -v apparmor_parser >/dev/null 2>&1 && [ -d /sys/kernel/security/apparmor ]; then apparmor_parser -r /etc/apparmor.d/beamhop-bwrap; fi',
    ],
    ['install', '-d', '-o', REMOTE_USER, '-g', REMOTE_USER, '-m', '0700', REMOTE_BEAMHOP_HOME],
    ['install', '-d', '-o', REMOTE_USER, '-g', REMOTE_USER, '-m', '0700', REMOTE_WORKSPACES],
    ['ufw', 'default', 'deny', 'incoming'],
    ['ufw', 'default', 'allow', 'outgoing'],
    ...(ssh
      ? [['ufw', 'limit', 'OpenSSH']]
      : [['sh', '-c', 'systemctl disable --now ssh.socket ssh.service >/dev/null 2>&1 || true']]),
    ['ufw', '--force', 'enable'],
    ['systemctl', 'daemon-reload'],
    ['systemctl', 'enable', '--now', 'beamhopd.service'],
  ];

  const doc = {
    users: [user],
    disable_root: true,
    ssh_pwauth: false,
    package_update: true,
    package_upgrade: true,
    packages: [
      'ca-certificates',
      'curl',
      'xz-utils',
      'git',
      'rsync',
      'bubblewrap',
      'socat',
      'ripgrep',
      'ufw',
      'apparmor',
      'unattended-upgrades',
    ],
    write_files: [
      { path: '/usr/local/sbin/beamhop-install-node', permissions: '0755', content: NODE_INSTALL_SCRIPT },
      { path: '/etc/apparmor.d/beamhop-bwrap', permissions: '0644', content: BWRAP_APPARMOR },
      {
        path: '/etc/beamhop/beamhopd.env',
        permissions: '0644',
        content: envFile({
          agent,
          ownerNpub,
          daemonNsecRef: nsecRef,
          provisioningPubkey,
          harnesses: opts.harnesses,
          provider: opts.provider,
          beamhopVersion: version,
        }),
      },
      {
        path: '/etc/systemd/system/beamhopd.service',
        permissions: '0644',
        content: renderSystemdUnit(agent),
      },
    ],
    runcmd,
    final_message: `beamhop ${version} installed; beamhopd is awaiting provisioning over Nostr.`,
  };

  const out = `#cloud-config\n${stringify(doc, { lineWidth: 0 })}`;
  assertNoSecrets(out, 'cloud-init user_data');
  // Hetzner caps user_data at 32 KiB, DigitalOcean at 64 KiB.
  if (Buffer.byteLength(out) > 32 * 1024)
    throw new BeamhopError('invalid_input', 'cloud-init user_data exceeds 32 KiB');
  return out;
};
