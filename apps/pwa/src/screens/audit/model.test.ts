import type { AuditEvent, UsageRow } from '@beamhop/core';
import { describe, expect, it } from 'vitest';
import {
  actionsFor,
  aggregateUsage,
  blockedHost,
  blockedPath,
  buckets,
  categoryOf,
  lastDays,
  matchLog,
  monthForecast,
  OTHER,
  spikeThreshold,
  toCsv,
  toJsonl,
} from './model.ts';

const NOW = Date.UTC(2026, 10, 13, 12);
const DAY = 86_400_000;
const row = (daysAgo: number, agent: string, usd: number, extra: Partial<UsageRow> = {}): UsageRow => ({
  day: new Date(NOW - daysAgo * DAY).toISOString().slice(0, 10),
  agent,
  inputTokens: usd * 1000,
  outputTokens: 0,
  usd,
  minutes: 1,
  ...extra,
});
const ev = (p: Partial<AuditEvent>): AuditEvent => ({
  id: 'a',
  at: new Date(NOW - 3600_000).toISOString(),
  actor: 'srt',
  type: 'x',
  severity: 'info',
  summary: 's',
  data: {},
  ...p,
});

describe('usage aggregation', () => {
  it('fills every day of the range and totals by series', () => {
    const v = aggregateUsage([row(0, 'a', 2), row(1, 'a', 1), row(1, 'b', 3)], 7, 'agent', 'usd', NOW);
    expect(v.days).toEqual(lastDays(7, NOW));
    expect(v.days).toHaveLength(7);
    expect(v.series.map((s) => s.id)).toEqual(['a', 'b']);
    expect(v.total.usd).toBe(6);
    expect(v.values.at(-1)).toEqual({ a: 2 });
    expect(v.previous).toBeNull();
  });
  it('groups the 5th+ series into other and compares with the previous period', () => {
    const rows = ['a', 'b', 'c', 'd', 'e', 'f'].map((n, i) => row(0, n, 10 - i));
    rows.push(row(9, 'a', 4));
    const v = aggregateUsage(rows, 7, 'agent', 'usd', NOW);
    expect(v.series.map((s) => s.id)).toEqual(['a', 'b', 'c', 'd', OTHER]);
    expect(v.totals[OTHER]?.usd).toBe(6 + 5);
    expect(v.previous?.usd).toBe(4);
  });
  it('breaks down by channel and peer with readable fallbacks', () => {
    const rows = [row(0, 'a', 1, { channel: 'tg' }), row(0, 'b', 1), row(0, 'c', 1, { peer: 'summarizer' })];
    expect(
      aggregateUsage(rows, 7, 'channel', 'usd', NOW)
        .series.map((s) => s.id)
        .sort(),
    ).toEqual(['direct', 'tg']);
    expect(aggregateUsage(rows, 7, 'peer', 'tokens', NOW).values.at(-1)).toEqual({
      people: 2000,
      summarizer: 1000,
    });
  });
  it('forecasts the month from the last 7 days', () => {
    const rows = Array.from({ length: 13 }, (_, i) => row(i, 'a', 1));
    // 13 days spent this month (1–13 Nov) + 17 days left at $1/day
    expect(monthForecast(rows, NOW)).toBeCloseTo(30);
  });
});

describe('security', () => {
  it('maps event types to categories', () => {
    expect(categoryOf(ev({ type: 'sandbox.blocked_host' }))).toBe('host');
    expect(categoryOf(ev({ type: 'mesh.hop_limit' }))).toBe('hop');
    expect(categoryOf(ev({ type: 'mesh.peer_blocked' }))).toBe('peer');
    expect(categoryOf(ev({ type: 'dlp.redacted' }))).toBe('dlp');
    expect(categoryOf(ev({ type: 'approval.decided' }))).toBeUndefined();
  });
  // Regression (real daemon): beamhopd's own audit types and data shapes.
  it('maps beamhopd event types (sandbox.violation, mesh.limit, sender.blocked, pairing.locked)', () => {
    const net = ev({ type: 'sandbox.violation', agent: 'r', data: { kind: 'net.allow', value: 'pypi.org' } });
    const fs = ev({ type: 'sandbox.violation', agent: 'r', data: { kind: 'fs.read', value: '~/.ssh/id' } });
    expect(categoryOf(net)).toBe('host');
    expect(categoryOf(fs)).toBe('path');
    expect(blockedHost(net)).toBe('pypi.org');
    expect(blockedPath(fs)).toBe('~/.ssh/id');
    expect(blockedHost(fs)).toBeUndefined();
    expect(actionsFor(net)).toEqual(['allow-host']);
    expect(actionsFor(fs)).toEqual(['by-design']);
    expect(categoryOf(ev({ type: 'mesh.limit', data: { reason: 'hop_cap' } }))).toBe('hop');
    expect(categoryOf(ev({ type: 'mesh.limit', data: { reason: 'turn_cap' } }))).toBe('peer');
    expect(categoryOf(ev({ type: 'sender.blocked' }))).toBe('sender');
    expect(categoryOf(ev({ type: 'pairing.locked' }))).toBe('pairing');
    expect(categoryOf(ev({ type: 'dlp.hit' }))).toBe('dlp');
  });
  it('never offers Allow for always-blocked targets', () => {
    expect(
      actionsFor(ev({ type: 'sandbox.blocked_host', agent: 'r', data: { host: '169.254.169.254' } })),
    ).toEqual(['by-design']);
    expect(
      actionsFor(ev({ type: 'sandbox.blocked_host', agent: 'r', data: { host: 'pypi.org', session: 's1' } })),
    ).toEqual(['allow-host', 'open-session']);
    expect(
      actionsFor(ev({ type: 'sandbox.blocked_path', agent: 'r', data: { path: '~/.ssh/id_ed25519' } })),
    ).toEqual(['by-design']);
    expect(actionsFor(ev({ type: 'sender.unknown', agent: 'h' }))).toEqual(['allow-sender']);
  });
  it('buckets hourly for 24 h and daily for longer ranges', () => {
    const es = [
      ev({ at: new Date(NOW - 30 * 60_000).toISOString() }),
      ev({ at: new Date(NOW - 5 * DAY).toISOString() }),
    ];
    expect(buckets(es, '24h', NOW).values.reduce((a, b) => a + b)).toBe(1);
    const d = buckets(es, '7d', NOW).values;
    expect(d).toHaveLength(7);
    expect(d.reduce((a, b) => a + b)).toBe(2);
    expect(spikeThreshold([0, 0, 0, 8])).toBe(4);
    expect(spikeThreshold([0, 0, 0, 1])).toBe(3);
  });
});

describe('log', () => {
  it('filters by text, type and age', () => {
    const e = ev({
      summary: 'reviewer was blocked from pypi.org',
      type: 'sandbox.blocked_host',
      agent: 'reviewer',
    });
    expect(matchLog(e, { q: 'PYPI' }, NOW)).toBe(true);
    expect(matchLog(e, { q: 'npm' }, NOW)).toBe(false);
    expect(matchLog(e, { type: 'approval.decided' }, NOW)).toBe(false);
    expect(matchLog(e, { sinceMs: 60_000 }, NOW)).toBe(false);
  });
  it('exports CSV with quoting and JSONL one event per line', () => {
    const e = ev({ summary: 'said "hi", then left', data: { a: 1 } });
    const csv = toCsv([e]).split('\n');
    expect(csv[0]).toBe('id,at,agent,actor,type,severity,summary,data');
    expect(csv[1]).toContain('"said ""hi"", then left"');
    expect(csv[1]).toContain('"{""a"":1}"');
    expect(
      toJsonl([e, e])
        .split('\n')
        .map((l) => JSON.parse(l).id),
    ).toEqual(['a', 'a']);
  });
});
