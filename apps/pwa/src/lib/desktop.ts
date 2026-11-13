/**
 * The desktop app (apps/desktop) loads this UI with a preload script that exposes `window.beamhopDesktop`.
 * In a plain browser or on a phone it doesn't exist and nothing changes. The flag only changes what the
 * UI looks like; the daemon decides what a caller may do (`system.whoami` `via: 'local'`).
 */
import { useSyncExternalStore } from 'react';

export type DesktopCliStatus =
  | { state: 'installed'; path: string; onPath: boolean }
  | { state: 'other'; path: string }
  | { state: 'absent' }
  | { state: 'unsupported'; reason: string };

export interface BeamhopDesktop {
  version: string;
  platform: 'darwin' | 'linux' | 'win32';
  cli: {
    status(): Promise<DesktopCliStatus>;
    install(): Promise<{ status: DesktopCliStatus; profile?: string }>;
    uninstall(): Promise<void>;
  };
  daemon: { restart(): Promise<void>; openLog(): Promise<void> };
}

declare global {
  interface Window {
    beamhopDesktop?: BeamhopDesktop;
  }
}

/** The bridge, or undefined outside the desktop app. */
export const desktop = (): BeamhopDesktop | undefined =>
  typeof window === 'undefined' ? undefined : window.beamhopDesktop;

export const isDesktop = (): boolean => !!desktop();

// ─────────── "Show command-line equivalents" (per window, localStorage) ───────────

export const SHOW_CLI_KEY = 'bh.showCli';
const listeners = new Set<() => void>();

const readShowCli = (): boolean => {
  try {
    return localStorage.getItem(SHOW_CLI_KEY) === '1';
  } catch {
    return false;
  }
};

/** The stored preference (only consulted in the desktop app). */
export const getShowCliPref = (): boolean => readShowCli();

export const setShowCliPref = (on: boolean): void => {
  try {
    localStorage.setItem(SHOW_CLI_KEY, on ? '1' : '0');
    override = undefined;
  } catch {
    /* storage blocked: the change still applies until reload */
    override = on;
  }
  for (const l of listeners) l();
};

let override: boolean | undefined;

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  const onStorage = (e: StorageEvent) => {
    if (e.key === SHOW_CLI_KEY) fn();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener('storage', onStorage);
  };
};

/** Whether command-line equivalents are shown: always in a browser, opt-in in the desktop app. */
export const showCli = (): boolean => !isDesktop() || (override ?? readShowCli());

/** Reactive `showCli()`: every component updates when the setting changes. */
export const useShowCli = (): boolean => useSyncExternalStore(subscribe, showCli, () => true);

/** Reactive stored preference (for the Settings toggle). */
export const useShowCliPref = (): [boolean, (on: boolean) => void] => [
  useSyncExternalStore(
    subscribe,
    () => override ?? readShowCli(),
    () => false,
  ),
  setShowCliPref,
];

/**
 * Daemon messages sometimes end with the command to run ("Not logged in. Run: beamhop harness login
 * codex"). Where command lines are hidden, drop that tail; the screen offers a button instead.
 */
export const withoutCommand = (text: string | undefined, show: boolean): string | undefined => {
  if (!text || show) return text;
  const out = text.replace(/\s*\b(?:or )?run:?\s+`?[a-z][\w.-]*\b[^\n]*$/i, '').trim();
  return out || undefined;
};
