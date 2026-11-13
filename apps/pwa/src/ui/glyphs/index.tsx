/**
 * Custom CARRIER glyphs (DESIGN §7): 1.5px strokes, square caps, currentColor.
 * Decorative by default (aria-hidden); the meaning is always also carried by text.
 */
import type { SVGProps } from 'react';
import type { LampState } from '../../api/derive.ts';
import { cx } from '../../lib/cx.ts';

type G = SVGProps<SVGSVGElement> & { size?: number };

/** Status lamp, 10px (DESIGN §3.3). Colour lives here so shape and colour never drift apart. */
export const Lamp = ({
  state,
  size = 10,
  className,
}: {
  state: LampState;
  size?: number;
  className?: string;
}) => {
  const color: Record<LampState, string> = {
    live: 'text-flare-text dark:text-flare',
    ready: 'text-go',
    'needs-you': 'text-caution-text',
    paused: 'text-ink-2',
    stopped: 'text-ink-3',
    error: 'text-stop',
    offline: 'text-stop',
    panic: 'text-stop',
  };
  return (
    <span
      aria-hidden="true"
      className={cx('relative inline-grid shrink-0 place-items-center', color[state], className)}
      style={{ width: size, height: size }}
    >
      {state === 'live' && (
        <span className="lamp-halo absolute inset-0 rounded-full bg-flare hc:hidden" data-lamp-halo="" />
      )}
      <svg width={size} height={size} viewBox="0 0 10 10" className="relative" aria-hidden="true">
        {state === 'live' && (
          <>
            <circle cx="5" cy="5" r="3.2" fill="currentColor" />
            <circle
              cx="5"
              cy="5"
              r="4.4"
              fill="none"
              stroke="currentColor"
              strokeOpacity="0.45"
              strokeWidth="1"
            />
          </>
        )}
        {state === 'ready' && <circle cx="5" cy="5" r="4" fill="currentColor" />}
        {state === 'needs-you' && (
          <>
            <circle cx="5" cy="5" r="3.9" fill="none" stroke="currentColor" strokeWidth="1.2" />
            <path d="M5 1.1 A3.9 3.9 0 0 1 5 8.9 Z" fill="currentColor" />
          </>
        )}
        {state === 'paused' && (
          <>
            <rect x="2" y="1.5" width="2" height="7" fill="currentColor" />
            <rect x="6" y="1.5" width="2" height="7" fill="currentColor" />
          </>
        )}
        {state === 'stopped' && (
          <circle cx="5" cy="5" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
        )}
        {(state === 'error' || state === 'offline') && (
          <rect x="1.5" y="1.5" width="7" height="7" fill="currentColor" />
        )}
        {state === 'panic' && (
          <>
            <rect
              x="1.25"
              y="1.25"
              width="7.5"
              height="7.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <path d="M1.5 6.5 L6.5 1.5 M3.5 8.5 L8.5 3.5" stroke="currentColor" strokeWidth="1.1" />
          </>
        )}
      </svg>
    </span>
  );
};

const BAR_HEIGHTS = [4, 7, 10, 13, 16];

/** Hop meter: stepped bars (DESIGN §3.2). Shows `total` bars (max 5), `up` filled. */
export const HopMeter = ({
  up,
  total,
  tone = 'ink',
  busy = false,
  className,
}: {
  up: number;
  total: number;
  tone?: 'ink' | 'caution' | 'stop' | 'flare';
  busy?: boolean;
  className?: string;
}) => {
  const n = Math.max(1, Math.min(5, total));
  const heights = BAR_HEIGHTS.slice(5 - n);
  const fill = {
    ink: 'bg-ink',
    caution: 'bg-caution-text',
    stop: 'bg-stop-text',
    flare: 'bg-flare-text dark:bg-flare',
  }[tone];
  return (
    <span
      aria-hidden="true"
      className={cx('inline-flex h-4 items-end gap-[2px]', busy && 'hop-busy', className)}
    >
      {heights.map((h, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length decorative bars
          key={i}
          className={cx('w-[3px] rounded-[1px]', busy || i < up ? fill : 'bg-line-strong')}
          style={{ height: h }}
        />
      ))}
    </span>
  );
};

/** Gate: the 6px vertical bar that ends a policy-blocked beam line. */
export const Gate = ({ className }: { className?: string }) => (
  <span aria-hidden="true" className={cx('inline-block h-3 w-[2px] bg-caution-text', className)} />
);

/** Perforation rule with notches — used inside TicketCard; exported for one-off dividers. */
export const Perforation = ({ className }: { className?: string }) => (
  <div aria-hidden="true" className={cx('perforation', className)} />
);

/** Hatch fill block for locked / stopped areas. */
export const Hatch = ({ className }: { className?: string }) => (
  <span aria-hidden="true" className={cx('hatch block', className)} />
);

/** The carrier square from the wordmark. */
export const CarrierMark = ({ size = 8, className }: { size?: number; className?: string }) => (
  <span
    aria-hidden="true"
    className={cx('inline-block bg-flare-text dark:bg-flare', className)}
    style={{ width: size, height: size }}
  />
);

/** Beam glyph for empty states: node ── node ── node (32px tall). */
export const BeamGlyph = ({ size = 32, ...p }: G) => (
  <svg width={size * 3} height={size} viewBox="0 0 96 32" fill="none" aria-hidden="true" {...p}>
    <path d="M6 16 H90" stroke="currentColor" strokeWidth="1" strokeDasharray="0" />
    <rect x="2" y="12" width="8" height="8" fill="currentColor" />
    <circle cx="48" cy="16" r="5" fill="var(--bh-bg)" stroke="currentColor" strokeWidth="1.5" />
    <circle cx="27" cy="16" r="3" fill="currentColor" />
    <circle cx="69" cy="16" r="3" fill="currentColor" />
    <rect x="86" y="12" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="1.5" />
  </svg>
);

/** Transmission slip outline (with notches) for empty Inbox. */
export const SlipGlyph = ({ size = 32, ...p }: G) => (
  <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" {...p}>
    <path
      d="M5 4 H27 V19 A2.5 2.5 0 0 0 27 24 V28 H5 V24 A2.5 2.5 0 0 0 5 19 Z"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="miter"
    />
    <path d="M8 21.5 H24" stroke="currentColor" strokeWidth="1" strokeDasharray="2 2" />
    <path d="M9 9 H20 M9 13 H16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
  </svg>
);
