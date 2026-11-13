/**
 * Card (DESIGN §9.2: surface + 1px line + radius-lg, no resting shadow) and TicketCard,
 * the transmission slip (§3.6): two zones split by a perforation with 6px notches cut into both edges.
 */
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-aria-components';
import { cx } from '../lib/cx.ts';

export interface CardProps {
  children: ReactNode;
  className?: string;
  /** Make the whole card a link (nested interactive elements must sit outside or stop propagation). */
  href?: string;
  /** Accessible label for the card link. */
  linkLabel?: string;
  as?: 'div' | 'article' | 'section' | 'li';
  tone?: 'surface' | 'sunken' | 'flare' | 'caution' | 'stop';
  padding?: 'none' | 'sm' | 'md';
}

const TONE = {
  surface: 'bg-surface border-line',
  sunken: 'bg-sunken border-line',
  flare: 'bg-flare-wash border-line',
  caution: 'bg-caution-wash border-line',
  stop: 'bg-stop-wash border-line',
};

export const Card = ({
  children,
  className,
  href,
  linkLabel,
  as: As = 'div',
  tone = 'surface',
  padding = 'md',
}: CardProps) => (
  <As
    className={cx(
      'relative rounded-lg border',
      TONE[tone],
      padding === 'md' && 'p-4',
      padding === 'sm' && 'p-3',
      href &&
        'transition-colors duration-[var(--dur-fast)] has-[[data-card-link][data-hovered]]:border-line-strong',
      className,
    )}
  >
    {href && (
      <Link
        href={href}
        aria-label={linkLabel}
        data-card-link=""
        className="absolute inset-0 z-0 rounded-lg outline-none data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-focus"
      />
    )}
    <div
      className={cx(
        href && 'pointer-events-none relative [&_a]:pointer-events-auto [&_button]:pointer-events-auto',
      )}
    >
      {children}
    </div>
  </As>
);

export interface TicketCardProps {
  /** Top zone: what is asked. */
  children: ReactNode;
  /** Bottom zone: decision buttons. */
  decision?: ReactNode;
  /** micro eyebrow, e.g. `APPROVAL · #a41f`, with a right-aligned tag. */
  eyebrow?: ReactNode;
  tag?: ReactNode;
  state?: 'resting' | 'dragging' | 'expired' | 'decided';
  /** Status line replacing the decision zone for expired/decided slips. */
  statusLine?: ReactNode;
  className?: string;
  /** Scroll the top zone internally (decision zone never scrolls away). */
  maxTopHeight?: string;
  /** Tighter padding for previews (Home "Needs you"). */
  compact?: boolean;
}

export const TicketCard = ({
  children,
  decision,
  eyebrow,
  tag,
  state = 'resting',
  statusLine,
  className,
  maxTopHeight,
  compact,
}: TicketCardProps) => {
  const topRef = useRef<HTMLDivElement>(null);
  const [perfY, setPerfY] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = topRef.current;
    if (!el) return;
    const update = () => setPerfY(el.offsetHeight);
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const hatched = state === 'expired' || state === 'decided';
  return (
    <div
      className={cx(
        'slip-notch relative rounded-lg border border-line bg-surface',
        state === 'dragging' && 'shadow-lift',
        className,
      )}
      style={
        perfY !== null ? ({ ['--bh-perf-y' as string]: `${perfY}px` } as React.CSSProperties) : undefined
      }
      data-slip-state={state}
    >
      {hatched && (
        <span
          aria-hidden="true"
          className="hatch pointer-events-none absolute inset-0 rounded-lg text-ink-3"
        />
      )}
      <div
        ref={topRef}
        className={cx('relative', compact ? 'px-4 py-3' : 'p-4', maxTopHeight && 'overflow-y-auto')}
        style={maxTopHeight ? { maxHeight: maxTopHeight } : undefined}
      >
        {(eyebrow || tag) && (
          <div className="mb-3 flex items-center justify-between gap-3">
            <span className="type-micro text-ink-2">{eyebrow}</span>
            {tag}
          </div>
        )}
        {children}
      </div>
      <div aria-hidden="true" className="perforation mx-3" />
      <div className={cx('relative', compact ? 'px-2 py-2' : 'p-3')}>
        {statusLine ? (
          <p className="flex min-h-12 items-center px-1 type-body-sm text-ink-2">{statusLine}</p>
        ) : (
          decision
        )}
      </div>
    </div>
  );
};

/** The "untrusted quote" styling for agent-supplied justifications (ink-2, left rule). */
export const UntrustedQuote = ({
  label = 'The agent says',
  children,
}: {
  label?: string;
  children: ReactNode;
}) => (
  <blockquote className="border-l-2 border-line-strong pl-3 type-body-sm text-ink-2">
    <span className="type-micro text-ink-3">{label}</span>
    <span className="mt-0.5 block">“{children}”</span>
  </blockquote>
);
