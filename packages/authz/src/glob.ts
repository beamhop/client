/**
 * Tiny glob matcher for tool names and route targets.
 * Supports `*` (any run of characters, including none) and `?` (exactly one character).
 * Everything else is literal. Matching is done on NFC-normalized strings.
 */
const cache = new Map<string, RegExp>();

const toRegExp = (pattern: string, caseInsensitive: boolean): RegExp => {
  const key = `${caseInsensitive ? 'i' : 's'}:${pattern}`;
  let re = cache.get(key);
  if (!re) {
    let src = '';
    for (const ch of pattern.normalize('NFC')) {
      if (ch === '*') src += '.*';
      else if (ch === '?') src += '.';
      else src += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    re = new RegExp(`^${src}$`, caseInsensitive ? 'isu' : 'su');
    if (cache.size > 1000) cache.clear();
    cache.set(key, re);
  }
  return re;
};

export const globMatch = (pattern: string, value: string, opts: { caseInsensitive?: boolean } = {}): boolean =>
  toRegExp(pattern, opts.caseInsensitive ?? true).test(value.normalize('NFC'));

export const anyGlobMatch = (patterns: readonly string[], values: readonly string[]): string | undefined => {
  for (const p of patterns) for (const v of values) if (globMatch(p, v)) return p;
  return undefined;
};
