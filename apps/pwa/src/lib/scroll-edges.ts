/**
 * Marks a horizontal scroller with `data-edge-start` / `data-edge-end` while content is hidden on that
 * side (pairs with the `scroll-rail` utility's edge fade). Also brings the selected item into view on
 * mount, so a pre-selected chip or tab is never parked off-screen.
 */
import { type RefObject, useEffect } from 'react';

const SELECTED = '[aria-current="page"],[aria-selected="true"],[aria-pressed="true"],[data-selected]';

export const useScrollEdges = <T extends HTMLElement>(ref: RefObject<T | null>, deps: unknown[] = []) => {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const max = el.scrollWidth - el.clientWidth;
      el.toggleAttribute('data-edge-start', el.scrollLeft > 2);
      el.toggleAttribute('data-edge-end', max - el.scrollLeft > 2);
    };
    const sel = el.querySelector<HTMLElement>(SELECTED);
    if (sel && el.scrollWidth > el.clientWidth) {
      const left = sel.offsetLeft - el.offsetLeft;
      if (left < el.scrollLeft || left + sel.offsetWidth > el.scrollLeft + el.clientWidth)
        el.scrollLeft = left - 24;
    }
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro?.disconnect();
    };
  }, [ref, ...deps]);
};
