/**
 * Asks before a navigation throws away unsaved edits. Router navigations (links, tab switches, back)
 * go through TanStack's blocker so the screen can show its own confirm; reload/close falls back to the
 * browser's native beforeunload prompt, the only thing a page may show there.
 */
import { useBlocker } from '@tanstack/react-router';
import { useRef } from 'react';

/**
 * Only a change of page loses the draft: search/hash updates on the same path (filters, sheet state)
 * keep the component mounted.
 */
export const leavesPage = (current: { pathname: string }, next: { pathname: string }): boolean =>
  current.pathname !== next.pathname;

export const useLeaveGuard = (dirty: boolean) => {
  // The blocker reads this at navigation time, so a save that clears `dirty` right before a
  // programmatic navigate is not blocked by a stale closure.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  return useBlocker({
    shouldBlockFn: ({ current, next }) => dirtyRef.current && leavesPage(current, next),
    enableBeforeUnload: () => dirtyRef.current,
    disabled: !dirty,
    withResolver: true,
  });
};
