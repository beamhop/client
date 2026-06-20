import { useCallback, useEffect, useRef, useState } from "react";
import type { DOMAttributes, PointerEvent as ReactPointerEvent } from "react";

export type PanAxis = "horizontal" | "vertical" | "none";

export type PointerHandlers = Pick<
  DOMAttributes<HTMLElement>,
  "onPointerDown" | "onPointerMove" | "onPointerUp" | "onPointerCancel"
>;

const DEADZONE = 8;
const RATIO = 1.2;

/**
 * PURE. Returns "none" until the larger of |dx|/|dy| escapes the deadzone.
 * Past it, the gesture locks to "horizontal" when |dx| dominates |dy| by `ratio`,
 * otherwise "vertical". Locking early (and once) avoids axis jitter mid-drag.
 */
export const classifyAxis = (
  dx: number,
  dy: number,
  deadzone: number = DEADZONE,
  ratio: number = RATIO,
): PanAxis => {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (Math.max(ax, ay) <= deadzone) return "none";
  return ax >= ay * ratio ? "horizontal" : "vertical";
};

/**
 * PURE. Maps a raw pull distance onto a capped, eased value so the sheet feels
 * heavier the further you drag. Below `max` it tracks 1:1; past `max` the excess
 * is logarithmically dampened and the result is hard-capped just above `max`.
 */
export const pullResistance = (raw: number, max: number): number => {
  if (raw <= 0) return 0;
  if (raw <= max) return raw;
  // Rubber-band: only a shrinking fraction of the overshoot is honoured.
  const overshoot = raw - max;
  return max + Math.log10(1 + overshoot) * (max / 8);
};

type EdgeState = {
  pointerId: number;
  startX: number;
  startY: number;
  axis: PanAxis;
};

/**
 * Left-edge-swipe → back. Arms only when the pointer goes down within `edge`
 * pixels of the left side. Once the axis locks horizontal we own the gesture;
 * if it locks vertical we bail so native scrolling keeps working. Commits
 * `onBack` on pointer-up when the horizontal travel exceeds `threshold`.
 */
export const useEdgeSwipeBack = (
  onBack: () => void,
  opts?: { edge?: number; threshold?: number; enabled?: boolean },
): { handlers: PointerHandlers } => {
  const edge = opts?.edge ?? 24;
  const threshold = opts?.threshold ?? 60;
  const enabled = opts?.enabled ?? true;

  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  const state = useRef<EdgeState | undefined>(undefined);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>): void => {
      if (!enabled) return;
      if (e.clientX > edge) return;
      state.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        axis: "none",
      };
    },
    [enabled, edge],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLElement>): void => {
      const s = state.current;
      if (!s || s.pointerId !== e.pointerId) return;
      if (s.axis === "none") {
        const axis = classifyAxis(e.clientX - s.startX, e.clientY - s.startY);
        if (axis === "none") return;
        // Vertical lock means the user is scrolling, not navigating — release.
        if (axis === "vertical") {
          state.current = undefined;
          return;
        }
        s.axis = axis;
      }
    },
    [],
  );

  const finish = useCallback((e: ReactPointerEvent<HTMLElement>): void => {
    const s = state.current;
    if (!s || s.pointerId !== e.pointerId) return;
    const committed = s.axis === "horizontal" && e.clientX - s.startX > threshold;
    state.current = undefined;
    if (committed) onBackRef.current();
  }, [threshold]);

  const cancel = useCallback((e: ReactPointerEvent<HTMLElement>): void => {
    if (state.current?.pointerId === e.pointerId) state.current = undefined;
  }, []);

  return {
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: finish,
      onPointerCancel: cancel,
    },
  };
};

const innerWidth = (): number =>
  typeof window === "undefined" ? 0 : window.innerWidth;

type TabState = {
  pointerId: number;
  startX: number;
  startY: number;
  axis: PanAxis;
};

/**
 * Horizontal swipe between tabs. Locks to an axis after the deadzone; vertical
 * locks release the gesture for native scroll. Commits `onPrev` (swipe right) or
 * `onNext` (swipe left) when horizontal travel passes a fraction of the viewport.
 */
export const useSwipeTabs = (opts: {
  onPrev: () => void;
  onNext: () => void;
  widthFraction?: number;
  enabled?: boolean;
}): { handlers: PointerHandlers } => {
  const widthFraction = opts.widthFraction ?? 0.25;
  const enabled = opts.enabled ?? true;

  const cbRef = useRef(opts);
  cbRef.current = opts;
  const state = useRef<TabState | undefined>(undefined);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>): void => {
      if (!enabled) return;
      state.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        axis: "none",
      };
    },
    [enabled],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLElement>): void => {
      const s = state.current;
      if (!s || s.pointerId !== e.pointerId) return;
      if (s.axis === "none") {
        const axis = classifyAxis(e.clientX - s.startX, e.clientY - s.startY);
        if (axis === "none") return;
        if (axis === "vertical") {
          state.current = undefined;
          return;
        }
        s.axis = axis;
      }
    },
    [],
  );

  const finish = useCallback((e: ReactPointerEvent<HTMLElement>): void => {
    const s = state.current;
    if (!s || s.pointerId !== e.pointerId) return;
    const dx = e.clientX - s.startX;
    state.current = undefined;
    if (s.axis !== "horizontal") return;
    if (Math.abs(dx) <= innerWidth() * widthFraction) return;
    if (dx > 0) cbRef.current.onPrev();
    else cbRef.current.onNext();
  }, [widthFraction]);

  const cancel = useCallback((e: ReactPointerEvent<HTMLElement>): void => {
    if (state.current?.pointerId === e.pointerId) state.current = undefined;
  }, []);

  return {
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: finish,
      onPointerCancel: cancel,
    },
  };
};

type PullState = {
  pointerId: number;
  startX: number;
  startY: number;
  axis: PanAxis;
  raf: number | undefined;
};

const cancelRaf = (id: number | undefined): void => {
  if (id !== undefined && typeof cancelAnimationFrame !== "undefined") {
    cancelAnimationFrame(id);
  }
};

/**
 * Pull-to-refresh. Attach to the SCROLL element; we read `scrollTop` off the
 * event's currentTarget. Arms only when already at the top (scrollTop <= 0) and
 * the user pulls DOWN with a vertical-locked gesture; a horizontal lock releases.
 * pullDistance is the only state we set per-move, throttled through rAF.
 */
export const usePullToRefresh = (
  onRefresh: () => void | Promise<void>,
  opts?: { threshold?: number; max?: number; enabled?: boolean },
): { handlers: PointerHandlers; pullDistance: number; refreshing: boolean } => {
  const threshold = opts?.threshold ?? 64;
  const max = opts?.max ?? 96;
  const enabled = opts?.enabled ?? true;

  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;
  const state = useRef<PullState | undefined>(undefined);
  const refreshingRef = useRef(false);

  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  // rAF cleanup on unmount so we never set state after teardown.
  useEffect(() => () => cancelRaf(state.current?.raf), []);

  const release = useCallback((): void => {
    const s = state.current;
    if (s) cancelRaf(s.raf);
    state.current = undefined;
    // Animate the indicator home unless a refresh is actively running.
    if (!refreshingRef.current) setPullDistance(0);
  }, []);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>): void => {
      if (!enabled || refreshingRef.current) return;
      // iOS rubber-band can report scrollTop < 0 at rest; treating <= 0 as "top"
      // arms PTR through the bounce instead of fighting it.
      if (e.currentTarget.scrollTop > 0) return;
      state.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        axis: "none",
        raf: undefined,
      };
    },
    [enabled],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLElement>): void => {
      const s = state.current;
      if (!s || s.pointerId !== e.pointerId) return;

      // If the list has scrolled away from the top mid-gesture, abandon PTR and
      // hand control back to native scroll (also covers iOS negative→positive).
      if (e.currentTarget.scrollTop > 0) {
        release();
        return;
      }

      const dx = e.clientX - s.startX;
      const dy = e.clientY - s.startY;

      if (s.axis === "none") {
        const axis = classifyAxis(dx, dy);
        if (axis === "none") return;
        // Horizontal lock isn't a pull — release for whatever owns that axis.
        if (axis === "horizontal") {
          state.current = undefined;
          return;
        }
        // Only a downward pull arms; an upward flick at the top is native scroll.
        if (dy <= 0) {
          state.current = undefined;
          return;
        }
        s.axis = axis;
      }

      // Pulling back up past the origin ends the gesture.
      if (dy <= 0) {
        release();
        return;
      }

      const next = pullResistance(dy, max);
      if (s.raf === undefined) {
        s.raf = requestAnimationFrame(() => {
          if (state.current === s) s.raf = undefined;
          setPullDistance(next);
        });
      }
    },
    [max, release],
  );

  const finish = useCallback(
    (e: ReactPointerEvent<HTMLElement>): void => {
      const s = state.current;
      if (!s || s.pointerId !== e.pointerId) return;
      cancelRaf(s.raf);
      const dy = e.clientY - s.startY;
      const crossed = s.axis === "vertical" && pullResistance(dy, max) >= threshold;
      state.current = undefined;

      if (!crossed) {
        setPullDistance(0);
        return;
      }

      refreshingRef.current = true;
      setRefreshing(true);
      setPullDistance(threshold);

      const settle = (): void => {
        refreshingRef.current = false;
        setRefreshing(false);
        setPullDistance(0);
      };
      const result = onRefreshRef.current();
      if (result && typeof result.then === "function") {
        result.then(settle, settle);
      } else {
        settle();
      }
    },
    [max, threshold],
  );

  const cancel = useCallback(
    (e: ReactPointerEvent<HTMLElement>): void => {
      if (state.current?.pointerId === e.pointerId) release();
    },
    [release],
  );

  return {
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: finish,
      onPointerCancel: cancel,
    },
    pullDistance,
    refreshing,
  };
};
