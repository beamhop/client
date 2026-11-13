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
}

const LOOPBACK_NO_PROXY = 'localhost,127.0.0.1,::1';

/** Compile an effective SandboxPolicy to srt settings. Deny always wins over allow. */
export const toSrtConfig = (policy: SandboxPolicy, opts: SrtConfigOptions = {}): SrtSettings => {
  const deny = policy.fs.deny;
  const notDenied = (p: string) => !deny.some((d) => isWithin(p, d));
  const home = opts.home ?? homedir();

  const allowWrite = policy.fs.write.filter(notDenied);
  const denyRead = [...deny];
  let allowRead: string[] = [];
  if (opts.isolateHome) {
    const readable = [...policy.fs.read, ...allowWrite, ...(opts.extraRead ?? [])].filter(notDenied);
    // If a mount *is* the home (or contains it) there is nothing to isolate.
    if (!readable.some((p) => isWithin(home, p))) {
      denyRead.push(home);
      allowRead = readable.filter((p) => isWithin(p, home));
    }
  }

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
      // Belt and braces: a denied path is never writable either (srt's tmpfs masks are writable).
      denyWrite: [...deny],
    },
  };
};
