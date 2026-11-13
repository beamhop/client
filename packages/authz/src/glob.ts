/**
 * Tiny glob matcher for tool names and route targets.
 * Supports `*` (any run of characters, including none) and `?` (exactly one character).
 * Everything else is literal. Matching is done on NFC-normalized strings, per code point.
 *
 * Implemented as the classic greedy wildcard algorithm with single-star backtracking, which is
 * O(pattern × value) in the worst case. A regular expression such as `^.*a.*a.*a.*b$` backtracks
 * polynomially in the number of stars and can be driven into a hang by an agent-chosen value
 * (route targets come from the agent).
 */
const fold = (s: string, caseInsensitive: boolean): string[] => {
  const n = s.normalize('NFC');
  return [...(caseInsensitive ? n.toLowerCase() : n)];
};

const wildcard = (p: string[], v: string[]): boolean => {
  let pi = 0;
  let vi = 0;
  let star = -1;
  let mark = 0;
  while (vi < v.length) {
    if (pi < p.length && (p[pi] === '?' || (p[pi] !== '*' && p[pi] === v[vi]))) {
      pi++;
      vi++;
    } else if (pi < p.length && p[pi] === '*') {
      star = pi++;
      mark = vi;
    } else if (star !== -1) {
      pi = star + 1;
      vi = ++mark;
    } else return false;
  }
  while (pi < p.length && p[pi] === '*') pi++;
  return pi === p.length;
};

export const globMatch = (
  pattern: string,
  value: string,
  opts: { caseInsensitive?: boolean } = {},
): boolean => {
  const ci = opts.caseInsensitive ?? true;
  return wildcard(fold(pattern, ci), fold(value, ci));
};

export const anyGlobMatch = (patterns: readonly string[], values: readonly string[]): string | undefined => {
  for (const p of patterns) for (const v of values) if (globMatch(p, v)) return p;
  return undefined;
};
