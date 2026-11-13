/**
 * Shared derivations from API entities to UI vocabulary (lamp states, monograms, slugs).
 * Keep screens consistent: use these instead of re-deriving per screen.
 */
import type { AgentView, ApprovalView, ChannelView, HarnessView, SessionView } from '@beamhop/core';

/** DESIGN §3.3 lamp states. */
export type LampState = 'live' | 'ready' | 'needs-you' | 'paused' | 'stopped' | 'error' | 'offline' | 'panic';

export const agentLamp = (a: AgentView, opts: { pending?: number; panic?: boolean } = {}): LampState => {
  if (opts.panic) return 'panic';
  if (a.status === 'error') return 'error';
  if ((opts.pending ?? 0) > 0) return 'needs-you';
  if (a.status === 'busy' || a.status === 'starting') return 'live';
  if (a.status === 'paused') return 'paused';
  if (a.status === 'stopped') return 'stopped';
  return 'ready';
};

/** Home card order: live → needs you → error → ready → stopped; ties by last activity. */
const LAMP_ORDER: Record<LampState, number> = {
  live: 0,
  'needs-you': 1,
  error: 2,
  offline: 2,
  ready: 3,
  paused: 4,
  stopped: 5,
  panic: 6,
};
export const sortByLamp = <T extends { lamp: LampState; last?: string }>(xs: T[]): T[] =>
  xs
    .slice()
    .sort((a, b) => LAMP_ORDER[a.lamp] - LAMP_ORDER[b.lamp] || (b.last ?? '').localeCompare(a.last ?? ''));

export const sessionLamp = (s: SessionView): LampState =>
  s.status === 'running'
    ? 'live'
    : s.status === 'queued'
      ? 'paused'
      : s.status === 'error'
        ? 'error'
        : s.status === 'idle'
          ? 'ready'
          : 'stopped';

export const channelLamp = (c: ChannelView): LampState =>
  c.status === 'connected'
    ? 'ready'
    : c.status === 'connecting'
      ? 'paused'
      : c.status === 'error'
        ? 'error'
        : c.status === 'disabled'
          ? 'stopped'
          : 'offline';

export const harnessLamp = (h: HarnessView): LampState =>
  h.status === 'ready'
    ? 'ready'
    : h.status === 'needs-login'
      ? 'needs-you'
      : h.status === 'not-installed'
        ? 'stopped'
        : 'error';

/** DESIGN §7 monogram tiles. */
const HARNESS_MONO: Record<string, string> = {
  claude: 'CC',
  codex: 'CX',
  copilot: 'GH',
  gemini: 'GM',
  opencode: 'OC',
  pi: 'pi',
};
const PROVIDER_MONO: Record<string, string> = { nostr: 'NS', telegram: 'TG', slack: 'SL', discord: 'DC' };
const DEPLOY_MONO: Record<string, string> = {
  hetzner: 'HZ',
  digitalocean: 'DO',
  fly: 'FL',
  render: 'RN',
  railway: 'RW',
};

export const harnessMonogram = (id: string): string =>
  HARNESS_MONO[id] ?? (id.startsWith('acp:') ? 'AC' : id.slice(0, 2).toUpperCase());
export const providerMonogram = (p: string): string => PROVIDER_MONO[p] ?? p.slice(0, 2).toUpperCase();
export const deployMonogram = (p: string): string => DEPLOY_MONO[p] ?? p.slice(0, 2).toUpperCase();

export const HARNESS_NAMES: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  copilot: 'Copilot CLI',
  gemini: 'Gemini CLI',
  opencode: 'OpenCode',
  pi: 'pi',
};
export const PROVIDER_NAMES: Record<string, string> = {
  nostr: 'Nostr',
  telegram: 'Telegram',
  slack: 'Slack',
  discord: 'Discord',
};

/** Short harness label for slug lines: `claude 2.1.4`. */
export const harnessSlug = (id: string, harnesses?: HarnessView[]): string => {
  const h = harnesses?.find((x) => x.id === id);
  return h?.version ? `${id} ${h.version}` : id;
};

/** Channel target → compact provider-prefixed label, e.g. `tg:group/-100123`. */
export const targetLabel = (target: string, channels?: ChannelView[]): string => {
  const i = target.indexOf(':');
  const name = target.slice(0, i);
  const rest = target.slice(i + 1);
  const provider = channels?.find((c) => c.config.name === name)?.config.provider;
  if (provider === 'slack') {
    const id = rest.split('/')[1] ?? '';
    const pretty: Record<string, string> = { C0DEPLOYS: '#deploys', C0ENG: '#eng' };
    return `slack:${pretty[id] ?? rest}`;
  }
  if (provider === 'telegram') return `tg:${rest}`;
  return target;
};

/** Relay health for the connection pill: from the nostr channel's settings (when present). */
export const relayHealth = (channels?: ChannelView[]): { up: number; total: number } | undefined => {
  const n = channels?.find((c) => c.config.provider === 'nostr');
  if (!n) return undefined;
  const relays = (n.config.settings.relays as string[] | undefined) ?? [];
  const up =
    n.status === 'connected' ? ((n.config.settings.relaysUp as string[] | undefined) ?? relays).length : 0;
  return { up, total: relays.length };
};

export const RISK_LABEL: Record<ApprovalView['risk'], 'LOW' | 'ELEVATED' | 'HIGH'> = {
  low: 'LOW',
  medium: 'ELEVATED',
  high: 'HIGH',
};

/** One-line "what" for an approval: the command / host / path. */
export const approvalTarget = (a: ApprovalView): string => {
  const i = (a.input ?? {}) as Record<string, unknown>;
  return String(i.command ?? i.host ?? i.path ?? i.principal ?? a.title);
};
