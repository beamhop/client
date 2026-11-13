/** Tiny semver subset: parse "x.y.z" (prefix/suffix tolerated) and check comparator ranges. */

export type Version = [number, number, number];

/** Extract the first `x.y[.z]` from arbitrary `--version` output (e.g. "codex-cli 0.167.2"). */
export const parseVersion = (s: string): Version | undefined => {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(s);
  if (!m) return undefined;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
};

export const compareVersions = (a: Version, b: Version): number => {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
};

/**
 * `range` is space-separated comparators (all must hold), e.g. ">=1.0.0 <2.0.0".
 * `||` separates alternatives. Supported ops: >=, >, <=, <, =, (bare version means =).
 * An empty/undefined range accepts everything.
 */
export const satisfies = (version: string, range: string | undefined): boolean => {
  if (!range?.trim()) return true;
  const v = parseVersion(version);
  if (!v) return false;
  return range.split('||').some((alt) =>
    alt
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .every((c) => {
        const m = /^(>=|<=|>|<|=)?v?(.+)$/.exec(c);
        if (!m) return false;
        const target = parseVersion(m[2] ?? '');
        if (!target) return false;
        const cmp = compareVersions(v, target);
        switch (m[1] ?? '=') {
          case '>=':
            return cmp >= 0;
          case '>':
            return cmp > 0;
          case '<=':
            return cmp <= 0;
          case '<':
            return cmp < 0;
          default:
            return cmp === 0;
        }
      }),
  );
};
