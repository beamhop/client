/**
 * Minimal ICU-ish message formatting (DESIGN §11: all strings in en.json, ICU plurals, no concatenation).
 * Supports `{name}` interpolation and `{count, plural, =0 {…} one {# x} other {# xs}}`.
 * Add keys to en.json; call `t('key', { count: 3 })`.
 */
import en from './en.json';

export type MessageKey = keyof typeof en;
type Vars = Record<string, string | number>;

const findClose = (s: string, from: number): number => {
  let depth = 0;
  for (let i = from; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
};

const pluralRules = new Intl.PluralRules('en');

const formatPlural = (body: string, n: number): string => {
  // body: "=0 {…} one {…} other {…}"
  const options: Record<string, string> = {};
  let i = 0;
  while (i < body.length) {
    const open = body.indexOf('{', i);
    if (open === -1) break;
    const sel = body.slice(i, open).trim();
    const close = findClose(body, open);
    options[sel] = body.slice(open + 1, close);
    i = close + 1;
  }
  const chosen = options[`=${n}`] ?? options[pluralRules.select(n)] ?? options.other ?? '';
  return chosen.replace(/#/g, String(n));
};

export const format = (template: string, vars: Vars = {}): string => {
  let out = '';
  let i = 0;
  while (i < template.length) {
    const open = template.indexOf('{', i);
    if (open === -1) {
      out += template.slice(i);
      break;
    }
    out += template.slice(i, open);
    const close = findClose(template, open);
    const inner = template.slice(open + 1, close);
    const m = /^(\w+)\s*,\s*plural\s*,(.*)$/s.exec(inner);
    if (m) {
      const n = Number(vars[m[1]!] ?? 0);
      out += format(formatPlural(m[2]!, n), vars);
    } else {
      out += String(vars[inner.trim()] ?? `{${inner}}`);
    }
    i = close + 1;
  }
  return out;
};

export const t = (key: MessageKey, vars?: Vars): string => format(en[key], vars);
