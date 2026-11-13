/**
 * Global overlays opened from anywhere (keyboard, sidebar, More, Inbox): the ⌘K command palette and the
 * `?` keyboard-shortcut sheet. A tiny external store so the main chunk only carries the state; the
 * overlays themselves are lazy (Overlays.tsx).
 */
import { useSyncExternalStore } from 'react';

export type Overlay = 'palette' | 'shortcuts' | null;

let current: Overlay = null;
const listeners = new Set<() => void>();

export const openOverlay = (o: Exclude<Overlay, null>) => {
  current = o;
  for (const l of listeners) l();
};

export const closeOverlay = () => {
  current = null;
  for (const l of listeners) l();
};

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

export const useOverlay = (): Overlay =>
  useSyncExternalStore(
    subscribe,
    () => current,
    () => current,
  );

/** `⌘K` on Apple platforms, `Ctrl K` elsewhere (labels only; both modifiers work). */
export const modKey = (): string =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
    ? '⌘'
    : 'Ctrl ';
