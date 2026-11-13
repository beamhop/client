/**
 * Pure data shaping for Audit (JOURNEYS §6): usage aggregation by agent/channel/peer over a day range
 * (top 5 series + "other"), period comparison and month forecast, security-event categories with
 * sparkline buckets, log filtering, CSV/JSONL export. Unit-tested in model.test.ts.
 */
import type { AuditEvent, UsageRow } from '@beamhop/core';
import { privateKind } from '../policy/model.ts';

export type Breakdown = 'agent' | 'channel' | 'peer';
export type Metric = 'usd' | 'tokens';

const DAY = 86_400_000;
export const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);
/** The last `n` UTC day keys ending today, oldest first (matches the daemon's `day`). */
export const lastDays = (n: number, now = Date.now()): string[] =>
  Array.from({ length: n }, (_, i) => dayKey(now - (n - 1 - i) * DAY));

export const seriesKey = (r: UsageRow, b: Breakdown): string =>
  b === 'agent' ? r.agent : b === 'channel' ? (r.channel ?? 'direct') : (r.peer ?? 'people');

export interface Totals {
  usd: number;
  tokens: number;
  minutes: number;
}
const zero = (): Totals => ({ usd: 0, tokens: 0, minutes: 0 });
const slot = (m: Record<string, Totals>, k: string): Totals => {
  m[k] ??= zero();
  return m[k];
};
const add = (t: Totals, r: UsageRow) => {
  t.usd += r.usd;
  t.tokens += r.inputTokens + r.outputTokens;
  t.minutes += r.minutes;
};

export const OTHER = 'other';

export interface UsageView {
  days: string[];
  series: Array<{ id: string; label: string }>;
  /** day → series → value (metric). */
  values: Array<Record<string, number>>;
  totals: Record<string, Totals>;
  total: Totals;
  previous: Totals | null;
}

/** Aggregate rows for the last `range` days. Rows older than that count as the previous period. */
export const aggregateUsage = (
  rows: UsageRow[],
  range: number,
  breakdown: Breakdown,
  metric: Metric,
  now = Date.now(),
): UsageView => {
  const days = lastDays(range, now);
  const first = days[0]!;
  const prevFirst = dayKey(now - (2 * range - 1) * DAY);
  const cur = rows.filter((r) => r.day >= first);
  const prevRows = rows.filter((r) => r.day < first && r.day >= prevFirst);
  const totals: Record<string, Totals> = {};
  for (const r of cur) add(slot(totals, seriesKey(r, breakdown)), r);
  const ranked = Object.entries(totals).sort((a, b) => b[1].usd - a[1].usd || a[0].localeCompare(b[0]));
  const top = ranked.slice(0, ranked.length > 5 ? 4 : 5).map(([k]) => k);
  const keyOf = (r: UsageRow) => {
    const k = seriesKey(r, breakdown);
    return top.includes(k) ? k : OTHER;
  };
  const merged: Record<string, Totals> = {};
  for (const r of cur) add(slot(merged, keyOf(r)), r);
  const ids = [...top, ...(ranked.length > top.length ? [OTHER] : [])];
  const values = days.map((d) => {
    const v: Record<string, number> = {};
    for (const r of cur.filter((x) => x.day === d)) {
      const k = keyOf(r);
      v[k] = (v[k] ?? 0) + (metric === 'usd' ? r.usd : r.inputTokens + r.outputTokens);
    }
    return v;
  });
  const total = zero();
  for (const r of cur) add(total, r);
  let previous: Totals | null = null;
  if (prevRows.length) {
    previous = zero();
    for (const r of prevRows) add(previous, r);
  }
  return { days, series: ids.map((id) => ({ id, label: id })), values, totals: merged, total, previous };
};

/** Month-end forecast from the average of the last 7 days (Railway/Fly-style running total + pace). */
export const monthForecast = (rows: UsageRow[], now = Date.now()): number => {
  const last7 = lastDays(7, now);
  const spent7 = rows.filter((r) => last7.includes(r.day)).reduce((a, r) => a + r.usd, 0);
  const d = new Date(now);
  const monthStart = dayKey(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  const spentMonth = rows.filter((r) => r.day >= monthStart).reduce((a, r) => a + r.usd, 0);
  const remaining = daysInMonth - d.getUTCDate();
  return spentMonth + (spent7 / 7) * remaining;
};

// ─────────── security ───────────
export type SecCategory = 'host' | 'path' | 'peer' | 'pairing' | 'sender' | 'hop' | 'dlp';
export const SEC_CATEGORIES: SecCategory[] = ['host', 'path', 'peer', 'pairing', 'sender', 'hop', 'dlp'];

/**
 * beamhopd records every sandbox block as `sandbox.violation` with `data.kind` (`net.allow` |
 * `fs.read` | `fs.write`) and `data.value` (host or path); older/mock events use
 * `sandbox.blocked_host` / `sandbox.blocked_path` with `data.host` / `data.path`.
 */
const violationKind = (e: AuditEvent): string | undefined =>
  e.type === 'sandbox.violation' && typeof e.data.kind === 'string' ? e.data.kind : undefined;

/** The host a network block was about, whichever shape the event has. */
export const blockedHost = (e: AuditEvent): string | undefined =>
  typeof e.data.host === 'string'
    ? e.data.host
    : violationKind(e) === 'net.allow' && typeof e.data.value === 'string'
      ? e.data.value
      : undefined;

/** The path a filesystem block was about, whichever shape the event has. */
export const blockedPath = (e: AuditEvent): string | undefined =>
  typeof e.data.path === 'string'
    ? e.data.path
    : violationKind(e)?.startsWith('fs.') && typeof e.data.value === 'string'
      ? e.data.value
      : undefined;

export const categoryOf = (e: AuditEvent): SecCategory | undefined => {
  const t = e.type;
  if (t === 'sandbox.blocked_host') return 'host';
  if (t === 'sandbox.blocked_path') return 'path';
  const vk = violationKind(e);
  if (vk === 'net.allow') return 'host';
  if (vk?.startsWith('fs.')) return 'path';
  // beamhopd: `mesh.limit` with data.reason `hop_cap` | `turn_cap` | `human_required`.
  if (t === 'mesh.hop_limit' || (t === 'mesh.limit' && e.data.reason === 'hop_cap')) return 'hop';
  if (t.startsWith('mesh.')) return 'peer';
  if (t.startsWith('peer.')) return 'peer';
  if (t === 'pairing.failed' || t === 'pairing.locked') return 'pairing';
  if (t === 'sender.unknown' || t === 'sender.blocked') return 'sender';
  if (t.startsWith('dlp.')) return 'dlp';
  return undefined;
};

export type Level = 'high' | 'medium' | 'low';
export const levelOf = (e: AuditEvent): Level =>
  e.severity === 'security' ? 'high' : e.severity === 'warn' ? 'medium' : 'low';

export type SecRange = '24h' | '7d' | '14d';
export const RANGE_MS: Record<SecRange, number> = { '24h': DAY, '7d': 7 * DAY, '14d': 14 * DAY };

/** Bucketed counts for a sparkline: hourly for 24 h, daily otherwise. Oldest first. */
export const buckets = (events: AuditEvent[], range: SecRange, now = Date.now()) => {
  const n = range === '24h' ? 24 : range === '7d' ? 7 : 14;
  const size = RANGE_MS[range] / n;
  const start = now - RANGE_MS[range];
  const out = new Array<number>(n).fill(0);
  for (const e of events) {
    const i = Math.floor((new Date(e.at).getTime() - start) / size);
    if (i >= 0 && i < n) out[i]!++;
  }
  return { values: out, size, start };
};

/** A bucket is a spike when it is ≥ 3 and at least twice the mean of the others. */
export const spikeThreshold = (values: number[]) => {
  const mean = values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
  return Math.max(3, Math.ceil(mean * 2));
};

export type SecAction =
  | 'allow-host'
  | 'allow-path'
  | 'by-design'
  | 'allow-sender'
  | 'open-session'
  | 'open-channel';
const LOCKED_RE =
  /^~\/(\.ssh|\.aws|\.gnupg|\.config\/gh|\.config\/gcloud|\.azure|\.kube|\.netrc|\.npmrc|\.beamhop|Library\/Keychains)/;

export const actionsFor = (e: AuditEvent): SecAction[] => {
  const out: SecAction[] = [];
  const c = categoryOf(e);
  const host = blockedHost(e);
  const path = blockedPath(e);
  if (c === 'host' && host) out.push(privateKind(host) ? 'by-design' : e.agent ? 'allow-host' : 'by-design');
  if (c === 'path' && path) out.push(LOCKED_RE.test(path) ? 'by-design' : 'allow-path');
  if (c === 'sender' && e.agent) out.push('allow-sender');
  if (c === 'pairing' && typeof e.data.channel === 'string') out.push('open-channel');
  if (typeof e.data.session === 'string') out.push('open-session');
  return out;
};

// ─────────── log ───────────
export interface LogFilter {
  q?: string;
  type?: string;
  sinceMs?: number;
}
export const matchLog = (e: AuditEvent, f: LogFilter, now = Date.now()): boolean => {
  if (f.type && e.type !== f.type) return false;
  if (f.sinceMs && now - new Date(e.at).getTime() > f.sinceMs) return false;
  if (f.q) {
    const q = f.q.trim().toLowerCase();
    if (q && ![e.summary, e.actor, e.type, e.agent ?? ''].some((s) => s.toLowerCase().includes(q)))
      return false;
  }
  return true;
};

const csvCell = (v: unknown) => {
  const s = v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (events: AuditEvent[]): string =>
  [
    'id,at,agent,actor,type,severity,summary,data',
    ...events.map((e) =>
      [e.id, e.at, e.agent, e.actor, e.type, e.severity, e.summary, e.data].map(csvCell).join(','),
    ),
  ].join('\n');
export const toJsonl = (events: AuditEvent[]): string => events.map((e) => JSON.stringify(e)).join('\n');
