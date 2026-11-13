/**
 * Pull to refresh (DESIGN §8.4: 72px with rubber-band resistance 0.5; the Scan button is the visible
 * alternative). Touch only, only when the page is scrolled to the top, vertical intent only.
 * Returns the current pull distance (for the indicator) and whether release would trigger.
 */
import { useEffect, useRef, useState } from 'react';
import { haptic } from '../../lib/haptics.ts';

export const PULL_THRESHOLD = 72;

export const usePullToRefresh = (onRefresh: () => void, enabled = true) => {
  const [pull, setPull] = useState(0);
  const start = useRef<{ x: number; y: number } | null>(null);
  const armed = useRef(false);
  const cb = useRef(onRefresh);
  cb.current = onRefresh;

  useEffect(() => {
    if (!enabled) return;
    const scrollTop = () => document.scrollingElement?.scrollTop ?? window.scrollY;
    const down = (e: TouchEvent) => {
      const t = e.touches[0];
      start.current = t && scrollTop() <= 0 && e.touches.length === 1 ? { x: t.clientX, y: t.clientY } : null;
    };
    const move = (e: TouchEvent) => {
      const s = start.current;
      const t = e.touches[0];
      if (!s || !t) return;
      const dy = t.clientY - s.y;
      const dx = Math.abs(t.clientX - s.x);
      if (dy <= 0 || dx > dy) {
        if (dy < -4 || dx > 10) start.current = null;
        setPull(0);
        return;
      }
      const d = Math.min(120, dy * 0.5);
      if (d >= PULL_THRESHOLD && !armed.current) haptic('tick');
      armed.current = d >= PULL_THRESHOLD;
      setPull(d);
    };
    const up = () => {
      if (armed.current) cb.current();
      armed.current = false;
      start.current = null;
      setPull(0);
    };
    window.addEventListener('touchstart', down, { passive: true });
    window.addEventListener('touchmove', move, { passive: true });
    window.addEventListener('touchend', up);
    window.addEventListener('touchcancel', up);
    return () => {
      window.removeEventListener('touchstart', down);
      window.removeEventListener('touchmove', move);
      window.removeEventListener('touchend', up);
      window.removeEventListener('touchcancel', up);
    };
  }, [enabled]);

  return { pull, armed: pull >= PULL_THRESHOLD };
};
