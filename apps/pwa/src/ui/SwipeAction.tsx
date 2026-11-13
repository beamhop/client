/**
 * SwipeAction (DESIGN §8.4, JOURNEYS §2): horizontal drag with commit thresholds — 35% of width, or
 * ≥600 px/s with ≥15% travel; intent locks after 10px (Motion `dragDirectionLock`). The card follows
 * the finger 1:1, rotates up to 6°, a stamp fades in, the backdrop tints; a `tick` haptic fires when
 * crossing the threshold. Commit happens on release only.
 *
 * Swipe is an accelerator only (WCAG 2.5.1 / 2.5.7): the children render prop receives `commit(dir)`
 * so the always-visible buttons trigger the very same animated commit, and the focused card accepts
 * `A` (right) / `D` (left).
 */
import { animate, motion, type PanInfo, useMotionValue, useTransform } from 'motion/react';
import { type KeyboardEvent, type ReactNode, useRef, useState } from 'react';
import { cx } from '../lib/cx.ts';
import { haptic } from '../lib/haptics.ts';
import { reduced, spring, useReduced } from './motion.ts';

export type SwipeDir = 'left' | 'right';

export interface SwipeActionProps {
  /** Called once the right commit finishes (or immediately with `rightMode: 'intent'`). */
  onSwipeRight?: () => void;
  onSwipeLeft?: () => void;
  /**
   * `commit` (default) flies the card out. `intent` springs back and calls onSwipeRight —
   * used for ELEVATED/HIGH approvals where swiping right opens the scope sheet instead.
   */
  rightMode?: 'commit' | 'intent';
  rightStamp?: string;
  leftStamp?: string;
  /** Keyboard shortcuts when the card itself has focus. */
  keys?: { right?: string; left?: string };
  disabled?: boolean;
  /** Accessible name of the group (e.g. "Approval from reviewer: Run a shell command…"). */
  'aria-label': string;
  /** Hint read after the name. */
  hint?: string;
  className?: string;
  children: (api: { commit: (dir: SwipeDir) => void; dragging: boolean }) => ReactNode;
}

const COMMIT_RATIO = 0.35;
const FLING_RATIO = 0.15;
const FLING_VELOCITY = 600;

export const SwipeAction = ({
  onSwipeRight,
  onSwipeLeft,
  rightMode = 'commit',
  rightStamp = 'ALLOW ONCE',
  leftStamp = 'DENY',
  keys = { right: 'a', left: 'd' },
  disabled,
  className,
  hint,
  children,
  ...aria
}: SwipeActionProps) => {
  const reduce = useReduced();
  const ref = useRef<HTMLDivElement>(null);
  const x = useMotionValue(0);
  const [dragging, setDragging] = useState(false);
  const [gone, setGone] = useState(false);
  const crossed = useRef<SwipeDir | null>(null);
  const width = () => ref.current?.offsetWidth ?? 343;

  const rotate = useTransform(x, (v) => (reduce ? 0 : Math.max(-6, Math.min(6, (v / width()) * 6))));
  const rightOpacity = useTransform(x, (v) => Math.max(0, Math.min(1, v / (width() * COMMIT_RATIO))));
  const leftOpacity = useTransform(x, (v) => Math.max(0, Math.min(1, -v / (width() * COMMIT_RATIO))));

  const finish = (dir: SwipeDir) => {
    if (dir === 'right') {
      haptic('confirm');
      onSwipeRight?.();
    } else {
      haptic('reject');
      onSwipeLeft?.();
    }
  };

  const commit = (dir: SwipeDir, velocity = 0) => {
    if (disabled || gone) return;
    const handler = dir === 'right' ? onSwipeRight : onSwipeLeft;
    if (!handler) {
      void animate(x, 0, reduce ? reduced : spring.settle);
      return;
    }
    if (dir === 'right' && rightMode === 'intent') {
      void animate(x, 0, reduce ? reduced : spring.settle);
      onSwipeRight?.();
      return;
    }
    setGone(true);
    if (reduce) {
      finish(dir);
      return;
    }
    const target = (dir === 'right' ? 1 : -1) * (width() + 80);
    void animate(x, target, { ...spring.throw, velocity }).then(() => {
      finish(dir);
      // If the parent keeps the card (e.g. the request failed), bring it back.
      requestAnimationFrame(() => {
        if (ref.current?.isConnected) {
          setGone(false);
          void animate(x, 0, spring.settle);
        }
      });
    });
  };

  const onDrag = (_e: unknown, info: PanInfo) => {
    const t = width() * COMMIT_RATIO;
    const dir: SwipeDir | null = info.offset.x > t ? 'right' : info.offset.x < -t ? 'left' : null;
    if (dir && crossed.current !== dir) haptic('tick');
    crossed.current = dir;
  };

  const onDragEnd = (_e: unknown, info: PanInfo) => {
    setDragging(false);
    crossed.current = null;
    const w = width();
    const dx = info.offset.x;
    const vx = info.velocity.x;
    const far = Math.abs(dx) >= w * COMMIT_RATIO;
    const fling =
      Math.abs(vx) >= FLING_VELOCITY && Math.abs(dx) >= w * FLING_RATIO && Math.sign(vx) === Math.sign(dx);
    if (far || fling) commit(dx > 0 ? 'right' : 'left', vx);
    else void animate(x, 0, reduce ? reduced : spring.settle);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement).isContentEditable) return;
    const k = e.key.toLowerCase();
    if (keys.right && k === keys.right && onSwipeRight) {
      e.preventDefault();
      commit('right');
    } else if (keys.left && k === keys.left && onSwipeLeft) {
      e.preventDefault();
      commit('left');
    }
  };

  const tint = useTransform(x, (v) =>
    v > 0 ? 'var(--bh-go-wash)' : v < 0 ? 'var(--bh-stop-wash)' : 'transparent',
  );
  const hintId = useRef(`swipe-hint-${Math.random().toString(36).slice(2, 8)}`).current;

  return (
    <motion.div className={cx('relative rounded-lg', className)} style={{ backgroundColor: tint }}>
      <motion.div
        ref={ref}
        role="group"
        aria-label={aria['aria-label']}
        aria-describedby={hint ? hintId : undefined}
        tabIndex={0}
        onKeyDown={onKeyDown}
        drag={disabled ? false : 'x'}
        dragDirectionLock
        dragElastic={0.9}
        dragMomentum={false}
        style={{ x, rotate, touchAction: 'pan-y' }}
        onDragStart={() => setDragging(true)}
        onDrag={onDrag}
        onDragEnd={onDragEnd}
        className={cx(
          'relative rounded-lg outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
          dragging && 'z-10',
        )}
        data-dragging={dragging || undefined}
      >
        {children({ commit, dragging })}
        <motion.span
          aria-hidden="true"
          style={{ opacity: rightOpacity }}
          className="pointer-events-none absolute top-5 left-5 -rotate-[8deg] rounded-sm border-2 border-go-text px-2 py-0.5 font-mono text-sm font-semibold tracking-wider text-go-text"
        >
          {rightMode === 'intent' ? 'ALLOW…' : rightStamp}
        </motion.span>
        <motion.span
          aria-hidden="true"
          style={{ opacity: leftOpacity }}
          className="pointer-events-none absolute top-5 right-5 rotate-[8deg] rounded-sm border-2 border-stop-text px-2 py-0.5 font-mono text-sm font-semibold tracking-wider text-stop-text"
        >
          {leftStamp}
        </motion.span>
      </motion.div>
      {hint && (
        <span id={hintId} className="sr-only">
          {hint}
        </span>
      )}
    </motion.div>
  );
};
