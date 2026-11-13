import { useSyncExternalStore } from 'react';

/** Breakpoints in rem (DESIGN §6.4) so 200% zoom collapses to the compact shell. */
export const BP = {
  medium: '(min-width: 37.5rem)',
  expanded: '(min-width: 64rem)',
  wide: '(min-width: 90rem)',
} as const;

export const useMediaQuery = (query: string): boolean =>
  useSyncExternalStore(
    (fn) => {
      const m = window.matchMedia?.(query);
      m?.addEventListener?.('change', fn);
      return () => m?.removeEventListener?.('change', fn);
    },
    () => !!window.matchMedia?.(query).matches,
    () => false,
  );

/** ≥1024px: sidebar + split view. */
export const useExpanded = (): boolean => useMediaQuery(BP.expanded);
export const useWide = (): boolean => useMediaQuery(BP.wide);
export const useStandalone = (): boolean =>
  useMediaQuery('(display-mode: standalone)') ||
  (typeof navigator !== 'undefined' && (navigator as { standalone?: boolean }).standalone === true);
