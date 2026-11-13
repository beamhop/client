import { homedir } from 'node:os';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import type { SandboxPolicy } from '@beamhop/core';
import { isWithin, METADATA_HOSTS, PRIVATE_IP_RANGES } from './policy.ts';

export type SrtSettings = SandboxRuntimeConfig;

export interface SrtConfigOptions {
  /**
   * Hide the whole home directory from reads, re-allowing only the policy's read/write paths
   * (and `extraRead`). Recommended for `strict`; the harness's own install/config dirs must then
   * be listed in `extraRead`.
   */
  isolateHome?: boolean;
  /** Paths re-allowed for reading under an isolated home (e.g. the harness install dir). */
  extraRead?: string[];
  home?: string;
  /**
   * Host-loopback destinations the sandbox may reach through srt's proxy, e.g. the LLM broker
   * `127.0.0.1:43123`. Each must be an explicit `ip:port`.
   */
  localAllow?: string[];
  /** Upstream proxy for srt's own outbound connections (e.g. a corporate proxy). */
  parentProxy?: { http?: string; https?: string; noProxy?: string };
  /**
   * macOS: let the sandbox reach `com.apple.trustd.agent`, which native binaries that verify TLS through
   * the system (GitHub Copilot CLI, Go tools) need, or every HTTPS request fails (OSStatus -26276).
   * srt's caveat: trustd's own certificate fetches are a possible exfiltration path outside the proxy.
   * Only for harnesses that declare they need it (catalog `macosTrustd`).
   */
  macosTrustd?: boolean;
}

const LOOPBACK_NO_PROXY = 'localhost,127.0.0.1,::1';

/** Compile an effective SandboxPolicy to srt settings. Deny always wins over allow. */
export const toSrtConfig = (policy: SandboxPolicy, opts: SrtConfigOptions = {}): SrtSettings => {
  const deny = policy.fs.deny;
  const own = policy.fs.own ?? [];
  const isOwn = (p: string) => own.some((o) => isWithin(p, o));
  const notDenied = (p: string) => isOwn(p) || !deny.some((d) => isWithin(p, d));
  const home = opts.home ?? homedir();

  const allowWrite = policy.fs.write.filter(notDenied);
  const denyRead = [...deny];
  // srt's allowRead re-allows reads inside denyRead regions: the session's own dirs.
  let allowRead: string[] = [...own];
  if (opts.isolateHome) {
    const readable = [...policy.fs.read, ...allowWrite, ...(opts.extraRead ?? [])].filter(notDenied);
    // If a mount *is* the home (or contains it) there is nothing to isolate.
    if (!readable.some((p) => isWithin(home, p))) {
      denyRead.push(home);
      allowRead = [...new Set([...allowRead, ...readable.filter((p) => isWithin(p, home))])];
    }
  }
  // Every denied path is also write-denied (belt and braces: srt's tmpfs masks are writable), except a
  // region holding an own dir: denyWrite has no carve-outs and would win over its allowWrite. Writes
  // there are still default-deny. If a broader writable path (a mount of ~) covers that region, keep
  // the denyWrite: the beamhop home must never become writable, even if the own dir then is not.
  const broadWrite = allowWrite.filter((w) => !isOwn(w));
  const denyWrite = deny.filter(
    (d) => !own.some((o) => isWithin(o, d)) || broadWrite.some((w) => isWithin(d, w)),
  );

  const allowedDomains = [...new Set([...policy.net.allow, ...(opts.localAllow ?? [])])];
  const deniedDomains = [...new Set([...policy.net.deny, ...METADATA_HOSTS])].filter(
    (d) => !(opts.localAllow ?? []).includes(d),
  );

  const parentProxy = opts.parentProxy
    ? {
        ...opts.parentProxy,
        noProxy: [LOOPBACK_NO_PROXY, opts.parentProxy.noProxy].filter(Boolean).join(','),
      }
    : undefined;

  const trustd =
    opts.macosTrustd && process.platform === 'darwin' ? { enableWeakerNetworkIsolation: true } : {};
  return {
    network: {
      allowedDomains,
      deniedDomains,
      ...(policy.net.denyPrivateIps ? { deniedResolvedAddresses: [...PRIVATE_IP_RANGES] } : {}),
      ...(parentProxy ? { parentProxy } : {}),
    },
    filesystem: {
      denyRead,
      allowRead,
      allowWrite,
      denyWrite,
    },
    ...trustd,
  };
};
