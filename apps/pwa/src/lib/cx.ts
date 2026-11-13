/** Tiny className joiner. Falsy values are dropped. */
export const cx = (...parts: Array<string | false | null | undefined | 0>): string =>
  parts.filter(Boolean).join(' ');

/** Compose a RAC render-prop className with extra classes. */
export const composeCx =
  <T>(base: string | ((s: T) => string), extra?: string | ((s: T) => string)) =>
  (s: T): string =>
    cx(
      typeof base === 'function' ? base(s) : base,
      typeof extra === 'function' ? extra(s) : (extra ?? undefined),
    );
