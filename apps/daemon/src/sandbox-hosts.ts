/**
 * The hosts a harness needs in its sandbox, and a probe that checks them through the same policy a
 * session would run with. Used by the Sandbox "Test" action, by the agent's policy view, and to explain
 * a failed turn ("could not reach …") when the sandbox did not name a blocked host.
 */

import { spawn } from 'node:child_process';
import type { AgentConfig } from '@beamhop/core';
import { compilePolicy } from '@beamhop/sandbox';
import type { Daemon } from './daemon.ts';
import { activeMethod } from './harness-auth.ts';
import { homeOf } from './home-login.ts';

export interface RequiredHost {
  host: string;
  /** Who needs it, for display: the harness itself or its sign-in. */
  source: string;
}

export type HostStatus = 'ok' | 'blocked' | 'unreachable' | 'skipped';

export interface HostResult extends RequiredHost {
  status: HostStatus;
  detail?: string;
}

/** Hosts the harness's own service and its active sign-in need (what a session adds to the sandbox). */
export const requiredHosts = async (d: Daemon, harnessId: string): Promise<RequiredHost[]> => {
  const plugin = d.registry.harness(harnessId);
  const name = plugin?.displayName ?? harnessId;
  const out: RequiredHost[] = (plugin?.network ?? []).map((host) => ({ host, source: name }));
  const login = await activeMethod(d.secrets, harnessId);
  if (login?.kind === 'home') {
    for (const host of homeOf(login).network) out.push({ host, source: `${name} sign-in (${login.label})` });
  }
  const byHost = new Map<string, RequiredHost>();
  for (const r of out) if (!byHost.has(r.host)) byHost.set(r.host, r);
  return [...byHost.values()];
};

/** The sandbox policy a session of this agent would run with, including its harness's hosts. */
export const sessionPolicyFor = async (agent: AgentConfig, required: RequiredHost[]) => {
  const eff = compilePolicy(agent.sandbox.profile, agent.mounts, (agent.sandbox.policy ?? {}) as never);
  const allow = [...new Set([...eff.net.allow, ...required.map((r) => r.host)])];
  return { ...eff, net: { ...eff.net, allow } };
};

const curlHost = (
  wrap: (
    cmd: string,
    args: string[],
  ) => Promise<{ cmd: string; args: string[]; env: Record<string, string> }>,
  host: string,
): Promise<{ code: number | null; out: string; err: string }> =>
  wrap('curl', ['-sS', '-m', '10', '-o', '/dev/null', '-w', '%{http_code}', `https://${host}/`]).then(
    ({ cmd, args, env }) =>
      new Promise((resolve) => {
        const p = spawn(cmd, args, {
          env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        let err = '';
        p.stdout.on('data', (b) => (out += b));
        p.stderr.on('data', (b) => (err += b));
        p.on('error', (e) => resolve({ code: null, out, err: e.message }));
        p.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
      }),
  );

/**
 * Probe each required host through the agent's sandbox. `ok` = the request got an HTTP answer (any
 * status); `blocked` = the sandbox refused it (named in its violations); `unreachable` = it failed
 * otherwise (DNS, TLS, the network itself), with curl's message.
 */
export const probeHosts = async (
  d: Daemon,
  agent: AgentConfig,
  required: RequiredHost[],
): Promise<HostResult[]> => {
  if (required.length === 0) return [];
  const plugin = d.registry.harness(agent.harness);
  const policy = await sessionPolicyFor(agent, required);
  const sb = await d.sandboxFactory(policy, {
    env: {},
    localAllow: [],
    log: d.log.child({ component: 'sandbox-test', agent: agent.name }),
    ...(plugin?.macosTrustd ? { macosTrustd: true } : {}),
  });
  const refused = new Set<string>();
  const off = sb.onViolation?.((v) => {
    if (v.kind === 'net.allow' && !v.allowed) refused.add(v.value);
  });
  try {
    const results: HostResult[] = [];
    for (const r of required) {
      if (r.host.startsWith('*.')) {
        results.push({ ...r, status: 'skipped', detail: 'a wildcard; checked when a host under it is used' });
        continue;
      }
      const res = await curlHost((c, a) => sb.wrap(c, a), r.host);
      // The violation is reported by the proxy a moment after the refused request.
      await new Promise((ok) => setTimeout(ok, 150));
      if (res.code === 0) results.push({ ...r, status: 'ok' });
      else if (refused.has(r.host))
        results.push({ ...r, status: 'blocked', detail: 'the sandbox refused this host' });
      else results.push({ ...r, status: 'unreachable', detail: res.err || `curl exit ${res.code}` });
    }
    return results;
  } finally {
    off?.();
    await sb.close();
  }
};

/** Required hosts that the sandbox cannot reach, for a failure message. Empty when all are fine. */
export const unreachableRequired = async (d: Daemon, agent: AgentConfig): Promise<HostResult[]> => {
  const required = await requiredHosts(d, agent.harness);
  return (await probeHosts(d, agent, required)).filter(
    (r) => r.status === 'blocked' || r.status === 'unreachable',
  );
};
