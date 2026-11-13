/**
 * Theme / contrast / motion / haptics preferences (DESIGN §4.6, SCREENS §10 Appearance).
 * Persisted in localStorage `bh.appearance`; applied as data attributes on <html>.
 * public/boot.js applies the same resolution before first paint — keep them in sync.
 */
import { useSyncExternalStore } from 'react';

export type ThemePref = 'system' | 'light' | 'dark';
export type ContrastPref = 'system' | 'more';
export type MotionPref = 'system' | 'reduced';

export interface Appearance {
  theme: ThemePref;
  contrast: ContrastPref;
  motion: MotionPref;
  haptics: boolean;
}

export interface ResolvedAppearance {
  theme: 'light' | 'dark';
  contrast: 'normal' | 'more';
  motion: 'full' | 'reduced';
}

const KEY = 'bh.appearance';
const DEFAULTS: Appearance = { theme: 'system', contrast: 'system', motion: 'system', haptics: true };

const mq = (q: string): boolean => typeof window !== 'undefined' && !!window.matchMedia?.(q).matches;

const read = (): Appearance => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Appearance>;
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
};

let current: Appearance = typeof window === 'undefined' ? { ...DEFAULTS } : read();
const listeners = new Set<() => void>();

export const resolveAppearance = (a: Appearance = current): ResolvedAppearance => ({
  theme: a.theme === 'system' ? (mq('(prefers-color-scheme: dark)') ? 'dark' : 'light') : a.theme,
  contrast: a.contrast === 'system' ? (mq('(prefers-contrast: more)') ? 'more' : 'normal') : 'more',
  motion: a.motion === 'system' ? (mq('(prefers-reduced-motion: reduce)') ? 'reduced' : 'full') : 'reduced',
});

let resolved: ResolvedAppearance = resolveAppearance();

const apply = () => {
  if (typeof document === 'undefined') return;
  resolved = resolveAppearance();
  const r = document.documentElement;
  r.dataset.theme = resolved.theme;
  r.dataset.contrast = resolved.contrast;
  r.dataset.motion = resolved.motion;
  // theme-color follows --bh-bg (DESIGN §4.6). Replace the two media metas with one explicit value.
  const color = getComputedStyle(r).getPropertyValue('--bh-theme-color').trim();
  if (color) {
    for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.setAttribute('content', color);
  }
};

const emit = () => {
  for (const l of listeners) l();
};

export const getAppearance = (): Appearance => current;
export const getResolvedAppearance = (): ResolvedAppearance => resolved;

export const setAppearance = (patch: Partial<Appearance>): void => {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* private mode: preference lasts for this tab only */
  }
  apply();
  emit();
};

/** Call once at startup: applies attributes and follows OS changes while a pref is "system". */
export const initAppearance = (): (() => void) => {
  apply();
  const queries = [
    '(prefers-color-scheme: dark)',
    '(prefers-contrast: more)',
    '(prefers-reduced-motion: reduce)',
  ];
  const mqls = queries.map((q) => window.matchMedia?.(q)).filter(Boolean) as MediaQueryList[];
  const onChange = () => {
    apply();
    emit();
  };
  for (const m of mqls) m.addEventListener?.('change', onChange);
  return () => {
    for (const m of mqls) m.removeEventListener?.('change', onChange);
  };
};

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/** React hook: `[prefs, resolved, set]`. */
export const useAppearance = (): [Appearance, ResolvedAppearance, (p: Partial<Appearance>) => void] => {
  const prefs = useSyncExternalStore(subscribe, getAppearance, getAppearance);
  const res = useSyncExternalStore(subscribe, getResolvedAppearance, getResolvedAppearance);
  return [prefs, res, setAppearance];
};
