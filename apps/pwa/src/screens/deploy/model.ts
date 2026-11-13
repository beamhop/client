/**
 * Pure helpers for the Deploy screens: provider catalog copy (VPS vs PaaS trade-offs, sandbox notes),
 * plan-diff vocabulary (Terraform/OpenTofu `+ ~ -` with words), lamps, phases, cost math.
 */
import type { DeploymentView } from '@beamhop/core';
import type { LampState } from '../../api/derive.ts';

export interface ProviderInfo {
  fit: string;
  sandbox: 'full' | 'container' | 'microvm';
  sandboxNote: string;
  billing: string;
  tokenHelp: string;
  tokenUrl: string;
}

/** One-line fit per provider (JOURNEYS §7.1). Prices come from `deploy.options`, not from here. */
export const PROVIDER_INFO: Record<string, ProviderInfo> = {
  hetzner: {
    fit: 'VPS · full srt sandbox · EU + US regions',
    sandbox: 'full',
    sandboxNote: 'Same sandbox as this computer: bubblewrap namespaces + network allowlist.',
    billing: 'Fixed monthly price, billed hourly. Traffic included up to 20 TB.',
    tokenHelp: 'Hetzner Console → your project → Security → API tokens → Read & Write.',
    tokenUrl: 'https://console.hetzner.cloud/',
  },
  digitalocean: {
    fit: 'VPS · full srt sandbox · 14 regions',
    sandbox: 'full',
    sandboxNote: 'Same sandbox as this computer: bubblewrap namespaces + network allowlist.',
    billing: 'Fixed monthly price, billed hourly.',
    tokenHelp: 'DigitalOcean → API → Generate New Token (write scope).',
    tokenUrl: 'https://cloud.digitalocean.com/account/api/tokens',
  },
  fly: {
    fit: 'Micro-VM · srt network sandbox · per-second billing',
    sandbox: 'microvm',
    sandboxNote: 'The Firecracker VM is the filesystem boundary; the network allowlist and broker still apply.',
    billing: 'Per second while running. Stopped machines still pay for their volume.',
    tokenHelp: 'flyctl tokens create deploy, or Fly dashboard → Tokens.',
    tokenUrl: 'https://fly.io/dashboard',
  },
  render: {
    fit: 'Container · filesystem isolation = container only',
    sandbox: 'container',
    sandboxNote: "srt can't use namespaces here: the container is the filesystem boundary. Network allowlist and broker still apply.",
    billing: 'Fixed instance price per month.',
    tokenHelp: 'Render → Account settings → API keys.',
    tokenUrl: 'https://dashboard.render.com/u/settings',
  },
  railway: {
    fit: 'Container · usage-based on top of the plan fee',
    sandbox: 'container',
    sandboxNote: "srt can't use namespaces here: the container is the filesystem boundary. Network allowlist and broker still apply.",
    billing: 'Plan fee plus CPU/RAM by the minute.',
    tokenHelp: 'Railway → Account → Tokens.',
    tokenUrl: 'https://railway.com/account/tokens',
  },
};

export const providerTokenSecret = (provider: string) => `deploy/${provider}/token`;

export type PlanTone = 'add' | 'change' | 'remove' | 'move' | 'warn';
export const PLAN_SYMBOL: Record<PlanTone, string> = { add: '+', change: '~', remove: '-', move: '→', warn: '!' };

/** Terraform-style vocabulary: the word always appears next to the symbol. */
export const planTone = (op: string): PlanTone => {
  if (/^(create|install|add)$/.test(op)) return 'add';
  if (/^(move|keep|update|change)$/.test(op)) return 'change';
  if (/^(stop|destroy|delete|remove)$/.test(op)) return 'remove';
  if (/^(clone|copy|sync)$/.test(op)) return 'move';
  return 'warn';
};

export interface PlanAction {
  op: string;
  resource: string;
  detail: string;
}

/** Group plan rows: additions, changes, transfers, removals (stable within a group). */
export const groupPlan = (actions: PlanAction[]) => {
  const order: PlanTone[] = ['add', 'change', 'move', 'remove', 'warn'];
  return order
    .map((tone) => ({ tone, rows: actions.filter((a) => planTone(a.op) === tone) }))
    .filter((g) => g.rows.length > 0);
};

export const planCounts = (actions: PlanAction[]) => {
  const c = { add: 0, change: 0, move: 0, remove: 0, warn: 0 };
  for (const a of actions) c[planTone(a.op)]++;
  return c;
};

export const deployLamp = (d: DeploymentView): LampState =>
  d.status === 'running'
    ? 'ready'
    : d.status === 'provisioning'
      ? 'live'
      : d.status === 'error'
        ? 'error'
        : 'stopped';

export const usd = (n: number) => `$${n.toFixed(2)}`;

/** Spend so far this calendar month at a flat monthly price, from max(createdAt, 1st of month). */
export const monthToDate = (d: DeploymentView, now = Date.now()): number => {
  if (!d.monthlyCostUsd || d.status === 'destroyed') return 0;
  const n = new Date(now);
  const start = Math.max(new Date(d.createdAt).getTime(), new Date(n.getFullYear(), n.getMonth(), 1).getTime());
  const daysInMonth = new Date(n.getFullYear(), n.getMonth() + 1, 0).getDate();
  return Math.max(0, ((now - start) / 86_400_000 / daysInMonth) * d.monthlyCostUsd);
};

export const PHASES = [
  'Provision server',
  'cloud-init',
  'beamhopd',
  'doctor',
  'Harnesses',
  'Identity',
  'First heartbeat',
] as const;

/**
 * Phase progress for a deployment. TODO(core): the daemon should stream phase events; until then we
 * derive them from the deployment status and elapsed time (the mock takes ~8 s end to end).
 */
export const phaseState = (
  d: DeploymentView,
  now = Date.now(),
  totalMs = 8000,
): Array<{ name: string; state: 'done' | 'live' | 'todo' | 'error'; ms?: number }> => {
  const per = totalMs / PHASES.length;
  const elapsed = now - new Date(d.createdAt).getTime();
  return PHASES.map((name, i) => {
    if (d.status === 'running' || d.status === 'stopped' || d.status === 'destroyed')
      return { name, state: 'done' as const, ms: Math.round(per) };
    if (d.status === 'error') return { name, state: i < 3 ? ('done' as const) : i === 3 ? ('error' as const) : ('todo' as const) };
    const cur = Math.min(PHASES.length - 1, Math.floor(elapsed / per));
    return i < cur
      ? { name, state: 'done' as const, ms: Math.round(per) }
      : i === cur
        ? { name, state: 'live' as const, ms: Math.max(0, Math.round(elapsed - cur * per)) }
        : { name, state: 'todo' as const };
  });
};

/** Same rule as core `Slug`. */
export const AGENT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
