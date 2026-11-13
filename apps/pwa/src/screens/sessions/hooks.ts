/**
 * Behaviour hooks for the session view:
 *  - useStickToBottom: follow the stream only while the reader is at the bottom; detach on an upward
 *    scroll; count what arrived meanwhile for the `↓ 3 new` pill (pattern: use-stick-to-bottom,
 *    MUI X Chat "scrolling" behaviour).
 *  - useSmoothText: reveal streamed text at an even pace between chunk arrivals (no animation per token;
 *    instant under reduced motion).
 *  - useSessionAnnouncer: the polite live-region script from DESIGN §12 / JOURNEYS §3 — never token by
 *    token: "responding", the finished message, progress at most every 10 s, approvals, "finished".
 *  - useSessionSwipe: horizontal swipe to prev/next session (30% width or 500 px/s, intent lock after
 *    10 px, left 24 px reserved for browser back, ignores gestures that start in scrollable regions).
 */
import type { SessionEventView, SessionView } from '@beamhop/core';
import {
  type RefObject,
  type PointerEvent as RPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { announce } from '../../lib/live.ts';
import { useReduced } from '../../ui/motion.ts';
import type { Activity } from './model.ts';

// ─────────── Stick to bottom ───────────

const scrollerOf = (el: HTMLElement | null): HTMLElement | null =>
  (el?.closest('[data-scroll-root]') as HTMLElement | null) ?? null;

const metrics = (sc: HTMLElement | null) => {
  if (sc) return { top: sc.scrollTop, height: sc.scrollHeight, view: sc.clientHeight };
  const d = document.documentElement;
  return { top: window.scrollY, height: d.scrollHeight, view: window.innerHeight };
};

export const useStickToBottom = (contentRef: RefObject<HTMLElement | null>, ready: boolean) => {
  const [pinned, setPinned] = useState(true);
  const pinnedRef = useRef(true);
  const lastTop = useRef(0);

  const setPin = useCallback((v: boolean) => {
    pinnedRef.current = v;
    setPinned(v);
  }, []);

  const scrollToBottom = useCallback(
    (smooth = false) => {
      const sc = scrollerOf(contentRef.current);
      const target = sc ?? document.scrollingElement ?? document.documentElement;
      const top = target.scrollHeight;
      if (sc) sc.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
      else window.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
      lastTop.current = metrics(sc).top;
      setPin(true);
    },
    [contentRef, setPin],
  );

  // Track the reader: an upward scroll away from the bottom detaches; reaching the bottom re-attaches.
  useEffect(() => {
    if (!ready) return;
    const sc = scrollerOf(contentRef.current);
    const target: HTMLElement | Window = sc ?? window;
    const onScroll = () => {
      const m = metrics(sc);
      const dist = m.height - m.top - m.view;
      if (dist < 32) {
        if (!pinnedRef.current) setPin(true);
      } else if (m.top < lastTop.current - 2 && pinnedRef.current) setPin(false);
      lastTop.current = m.top;
    };
    target.addEventListener('scroll', onScroll, { passive: true });
    return () => target.removeEventListener('scroll', onScroll);
  }, [contentRef, ready, setPin]);

  // Initial position: newest at the bottom.
  useEffect(() => {
    if (ready) requestAnimationFrame(() => scrollToBottom(false));
  }, [ready, scrollToBottom]);

  // Content grows (new events, streamed text, expanded rows): follow only while pinned.
  useEffect(() => {
    const el = contentRef.current;
    if (!ready || !el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (pinnedRef.current) {
        const sc = scrollerOf(el);
        if (sc) sc.scrollTop = sc.scrollHeight;
        else window.scrollTo({ top: document.documentElement.scrollHeight });
        lastTop.current = metrics(sc).top;
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [contentRef, ready]);

  return { pinned, scrollToBottom, setPinned: setPin };
};

/** Count blocks that arrived while detached. */
export const useUnseen = (count: number, pinned: boolean) => {
  const base = useRef(count);
  if (pinned) base.current = count;
  return Math.max(0, count - base.current);
};

// ─────────── Smooth text ───────────

export const useSmoothText = (text: string, active: boolean): string => {
  const reduce = useReduced();
  const [shown, setShown] = useState(text.length);
  const shownRef = useRef(text.length);
  const target = useRef(text);
  target.current = text;

  useEffect(() => {
    if (!active || reduce) {
      shownRef.current = text.length;
      setShown(text.length);
      return;
    }
    if (shownRef.current > text.length) {
      shownRef.current = text.length;
      setShown(text.length);
    }
    let raf = 0;
    const tick = () => {
      const goal = target.current.length;
      const left = goal - shownRef.current;
      if (left <= 0) return;
      // Catch up within ~8 frames; at least 1 char per frame.
      shownRef.current += Math.max(1, Math.ceil(left / 8));
      setShown(shownRef.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text, active, reduce]);

  return active && !reduce ? text.slice(0, Math.min(shown, text.length)) : text;
};

// ─────────── Announcer ───────────

const clip = (s: string, n = 320) => (s.length > n ? `${s.slice(0, n)}…` : s);

export const useSessionAnnouncer = ({
  session,
  events,
  activity,
  ready,
}: {
  session?: SessionView;
  events: SessionEventView[];
  activity: Activity | null;
  ready: boolean;
}) => {
  const seen = useRef<number | null>(null);
  const streaming = useRef<{ seq: number; text: string } | null>(null);
  const lastStatus = useRef(session?.status);
  const lastProgressAt = useRef(0);
  const lastActivityLabel = useRef<string | undefined>(undefined);
  const agent = session?.agent ?? 'The agent';

  // Reset when switching sessions.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on session id
  useEffect(() => {
    seen.current = null;
    streaming.current = null;
    lastStatus.current = session?.status;
  }, [session?.id]);

  useEffect(() => {
    if (!ready) return;
    const maxSeq = events.at(-1)?.seq ?? 0;
    if (seen.current === null) {
      seen.current = maxSeq;
      return;
    }
    const finishStream = () => {
      const s = streaming.current;
      if (s?.text) announce(`${agent}: ${clip(s.text)}`);
      streaming.current = null;
    };
    for (const e of events) {
      const isNew = e.seq > (seen.current ?? 0);
      if (e.kind === 'assistant' && (isNew || streaming.current?.seq === e.seq)) {
        if (streaming.current && streaming.current.seq !== e.seq) finishStream();
        if (!streaming.current) announce(`${agent} is responding`);
        streaming.current = { seq: e.seq, text: e.text ?? '' };
        continue;
      }
      if (!isNew) continue;
      if (e.kind !== 'usage' && streaming.current) finishStream();
      if (e.kind === 'permission') announce(`${agent} needs approval: ${e.text ?? 'a request'}`);
      if (e.kind === 'error') announce(`${agent} error: ${clip(e.text ?? '')}`);
      if (e.kind === 'user' && e.from?.role !== 'owner')
        announce(`${e.from?.displayName ?? 'Someone'} wrote: ${clip(e.text ?? '', 160)}`);
    }
    seen.current = Math.max(seen.current, maxSeq);
  }, [events, ready, agent]);

  useEffect(() => {
    const now = Date.now();
    if (activity?.kind === 'tool') {
      const label = activity.detail ?? activity.label;
      if (label !== lastActivityLabel.current && now - lastProgressAt.current >= 10_000) {
        lastProgressAt.current = now;
        lastActivityLabel.current = label;
        announce(`Still working: ${label}`);
      }
    }
  }, [activity]);

  useEffect(() => {
    const prev = lastStatus.current;
    const cur = session?.status;
    lastStatus.current = cur;
    if (!ready || !prev || prev === cur) return;
    if (prev === 'running' && (cur === 'idle' || cur === 'ended')) {
      const s = streaming.current;
      streaming.current = null;
      announce(s?.text ? `${agent} finished: ${clip(s.text)}` : `${agent} finished.`);
    }
  }, [session?.status, ready, agent]);
};

// ─────────── Swipe between sessions ───────────

export interface SwipeState {
  dx: number;
  dragging: boolean;
}

export const useSessionSwipe = ({
  onPrev,
  onNext,
  enabled,
}: {
  onPrev?: () => void;
  onNext?: () => void;
  enabled: boolean;
}) => {
  const [state, setState] = useState<SwipeState>({ dx: 0, dragging: false });
  const g = useRef<{
    x: number;
    y: number;
    t: number;
    id: number;
    lock: 'h' | 'v' | null;
    w: number;
    samples: Array<[number, number]>;
  } | null>(null);

  const onPointerDown = (e: RPointerEvent<HTMLElement>) => {
    if (!enabled || e.pointerType === 'mouse') return;
    const el = e.target as HTMLElement;
    if (e.clientX < 24) return; // browser back edge
    if (el.closest('[role="region"], textarea, input, [data-noswipe], pre, table')) return;
    g.current = {
      x: e.clientX,
      y: e.clientY,
      t: e.timeStamp,
      id: e.pointerId,
      lock: null,
      w: e.currentTarget.offsetWidth || window.innerWidth,
      samples: [[e.timeStamp, e.clientX]],
    };
  };

  const onPointerMove = (e: RPointerEvent<HTMLElement>) => {
    const s = g.current;
    if (!s || s.id !== e.pointerId) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (!s.lock) {
      if (Math.hypot(dx, dy) < 10) return;
      s.lock = Math.abs(dx) > Math.abs(dy) * 1.5 ? 'h' : 'v';
      if (s.lock === 'v') {
        g.current = null;
        return;
      }
    }
    s.samples.push([e.timeStamp, e.clientX]);
    if (s.samples.length > 6) s.samples.shift();
    const hasTarget = dx > 0 ? !!onPrev : !!onNext;
    setState({ dx: hasTarget ? dx : dx * 0.25, dragging: true });
  };

  const end = (e: RPointerEvent<HTMLElement>) => {
    const s = g.current;
    g.current = null;
    if (s?.lock !== 'h') return;
    const dx = e.clientX - s.x;
    const [t0, x0] = s.samples[0] ?? [s.t, s.x];
    const v = ((e.clientX - x0) / Math.max(1, e.timeStamp - t0)) * 1000;
    const far = Math.abs(dx) >= s.w * 0.3;
    const fling = Math.abs(v) >= 500 && Math.sign(v) === Math.sign(dx) && Math.abs(dx) > 24;
    setState({ dx: 0, dragging: false });
    if (far || fling) {
      if (dx > 0) onPrev?.();
      else onNext?.();
    }
  };

  return {
    state,
    bind: {
      onPointerDown,
      onPointerMove,
      onPointerUp: end,
      onPointerCancel: () => {
        g.current = null;
        setState({ dx: 0, dragging: false });
      },
    },
  };
};

/** Width of an element, live. */
export const useWidth = (ref: RefObject<HTMLElement | null>) => {
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setW(e?.contentRect.width ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
};
