/**
 * Formatting helpers. DESIGN §11: numbers exact and unit-ful; local times `10:42` with date when not
 * today; relative only under 1 hour. Mono values are interpolated, never translated.
 */

const pad = (n: number) => String(n).padStart(2, '0');

export const clock = (d: Date | string | number): string => {
  const x = new Date(d);
  return `${pad(x.getHours())}:${pad(x.getMinutes())}`;
};

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const shortDate = (d: Date | string | number): string => {
  const x = new Date(d);
  return `${x.getDate()} ${MONTHS[x.getMonth()]}`;
};

/** `10:42` today, `12 Nov 10:42` otherwise. */
export const when = (d: Date | string | number, now = new Date()): string => {
  const x = new Date(d);
  return sameDay(x, now) ? clock(x) : `${shortDate(x)} ${clock(x)}`;
};

/** `now`, `4 min ago` under one hour, otherwise `when()`. */
export const ago = (d: Date | string | number, now = Date.now()): string => {
  const ms = now - new Date(d).getTime();
  if (ms < 45_000) return 'now';
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`;
  return when(d, new Date(now));
};

/** Compact duration: `42s`, `6m`, `2 h`, `3 d`. */
export const since = (d: Date | string | number, now = Date.now()): string => {
  const s = Math.max(0, Math.round((now - new Date(d).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86_400)} d`;
};

/** Countdown `12:40` / `1:05:10`. */
export const countdown = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
};

export const usd = (n: number, digits = 2): string => `$${n.toFixed(digits)}`;

export const tokens = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
};

/**
 * Middle ellipsis for ids and paths (DESIGN §3.4): `npub1x7k…q9fz`, `~/code/…/app`.
 * Paths keep the first and last segment; other strings keep head/tail characters.
 */
export const middleTruncate = (value: string, max = 16): string => {
  if (value.length <= max) return value;
  if (value.includes('/') && !value.includes('://')) {
    const parts = value.split('/');
    if (parts.length > 3) {
      const short = `${parts[0]}/${parts[1]}/…/${parts[parts.length - 1]}`;
      if (short.length <= max + 4) return short;
    }
  }
  const keep = Math.max(2, max - 1);
  const head = Math.ceil(keep * 0.55);
  const tail = keep - head;
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
};

/** Plural helper for quick strings outside i18n tables: `plural(3, 'session')` → `3 sessions`. */
export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Two-digit zero padded count for Doto readouts: `03`. */
export const pad2 = (n: number): string => pad(n);
