/**
 * Small 5-field cron parser (minute hour day-of-month month day-of-week) with IANA timezone support.
 * Supports `*`, lists (`1,2`), ranges (`1-5`), steps (`*\/15`, `1-30/5`), month/day names and the
 * macros @hourly @daily @midnight @weekly @monthly @yearly @annually.
 * Day-of-month and day-of-week follow Vixie cron: when both are restricted, either may match.
 */
import { BeamhopError } from '@beamhop/core';

export interface CronExpr {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domStar: boolean;
  dowStar: boolean;
}

const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const parseField = (field: string, min: number, max: number, names?: string[], nameBase = 0): Set<number> => {
  const out = new Set<number>();
  const val = (s: string): number => {
    const lower = s.toLowerCase();
    if (names) {
      const i = names.indexOf(lower);
      if (i >= 0) return i + nameBase;
    }
    if (!/^\d+$/.test(s)) throw new BeamhopError('invalid_input', `invalid cron value "${s}"`);
    return Number(s);
  };
  for (const part of field.split(',')) {
    const [range, stepS] = part.split('/');
    const step = stepS === undefined ? 1 : Number(stepS);
    if (!Number.isInteger(step) || step < 1)
      throw new BeamhopError('invalid_input', `invalid cron step "${part}"`);
    let lo: number;
    let hi: number;
    if (range === '*' || range === undefined) {
      lo = min;
      hi = max;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-');
      lo = val(a ?? '');
      hi = val(b ?? '');
    } else {
      lo = val(range);
      hi = stepS === undefined ? lo : max;
    }
    if (lo < min || hi > max || lo > hi)
      throw new BeamhopError('invalid_input', `cron value out of range in "${part}" (${min}-${max})`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
};

export const parseCron = (expr: string): CronExpr => {
  const e = MACROS[expr.trim().toLowerCase()] ?? expr.trim();
  const f = e.split(/\s+/);
  if (f.length !== 5) throw new BeamhopError('invalid_input', `cron needs 5 fields, got "${expr}"`);
  const dow = parseField(f[4]!, 0, 7, DAYS);
  if (dow.has(7)) {
    dow.delete(7);
    dow.add(0);
  }
  return {
    minute: parseField(f[0]!, 0, 59),
    hour: parseField(f[1]!, 0, 23),
    dom: parseField(f[2]!, 1, 31),
    month: parseField(f[3]!, 1, 12, MONTHS, 1),
    dow,
    domStar: f[2] === '*',
    dowStar: f[4] === '*',
  };
};

const formatters = new Map<string, Intl.DateTimeFormat>();
const fmt = (tz: string): Intl.DateTimeFormat => {
  let f = formatters.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        weekday: 'short',
      });
    } catch {
      throw new BeamhopError('invalid_input', `unknown timezone "${tz}"`);
    }
    formatters.set(tz, f);
  }
  return f;
};

const parts = (ms: number, tz: string) => {
  const p: Record<string, string> = {};
  for (const x of fmt(tz).formatToParts(new Date(ms))) p[x.type] = x.value;
  return {
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    dow: DAYS.indexOf((p.weekday ?? '').toLowerCase().slice(0, 3)),
  };
};

const MIN = 60_000;

/** Next fire time strictly after `afterMs` (epoch ms), or undefined if none within ~4 years. */
export const nextCronTime = (expr: CronExpr | string, afterMs: number, tz = 'UTC'): number | undefined => {
  const c = typeof expr === 'string' ? parseCron(expr) : expr;
  let t = Math.floor(afterMs / MIN) * MIN + MIN;
  const limit = afterMs + 4 * 366 * 24 * 60 * MIN;
  for (let i = 0; i < 200_000 && t < limit; i++) {
    const p = parts(t, tz);
    const domOk = c.dom.has(p.day);
    const dowOk = c.dow.has(p.dow);
    const dayOk = c.domStar && c.dowStar ? true : c.domStar ? dowOk : c.dowStar ? domOk : domOk || dowOk;
    if (!c.month.has(p.month) || !dayOk) {
      t += (24 * 60 - (p.hour * 60 + p.minute)) * MIN; // next local midnight (approx. across DST)
      continue;
    }
    if (!c.hour.has(p.hour)) {
      t += (60 - p.minute) * MIN;
      continue;
    }
    if (!c.minute.has(p.minute)) {
      t += MIN;
      continue;
    }
    return t;
  }
  return undefined;
};
