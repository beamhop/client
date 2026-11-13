/**
 * Screen states (DESIGN §10, SCREENS §12): EmptyState, Skeleton (after 300 ms, min 400 ms, beam sweep),
 * ErrorState (stop-wash, left rule, Retry + Copy details), Banner (offline / caution / info).
 */
import { ArrowClockwise, Copy, Info, WarningCircle } from '@phosphor-icons/react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { cx } from '../lib/cx.ts';
import { announce } from '../lib/live.ts';
import { Button } from './Button.tsx';
import { CliStrip } from './CliStrip.tsx';
import { BeamGlyph } from './glyphs/index.tsx';

export interface EmptyStateProps {
  /** 32px glyph or mini beam-line diagram. Defaults to the beam glyph. */
  glyph?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  cli?: string;
  className?: string;
}

/** Left-aligned: glyph, title-3 headline, one sentence, one action, CLI strip. No illustration art. */
export const EmptyState = ({ glyph, title, children, action, cli, className }: EmptyStateProps) => (
  <div className={cx('flex max-w-[480px] flex-col items-start gap-3 py-6', className)}>
    <div className="text-ink-2">{glyph ?? <BeamGlyph size={32} />}</div>
    <h2 className="type-title-3 text-ink">{title}</h2>
    {children && <p className="type-body-sm text-ink-2">{children}</p>}
    {action && <div className="pt-1">{action}</div>}
    {cli && <CliStrip command={cli} className="mt-2 w-full" />}
  </div>
);

/** Show a loading UI only if loading lasts >300 ms, and then for ≥400 ms (no flicker). */
export const useDelayedLoading = (loading: boolean, delay = 300, minShow = 400): boolean => {
  const [show, setShow] = useState(false);
  const shownAt = useRef(0);
  useEffect(() => {
    if (loading) {
      const t = setTimeout(() => {
        shownAt.current = Date.now();
        setShow(true);
      }, delay);
      return () => clearTimeout(t);
    }
    if (!show) return;
    const left = Math.max(0, minShow - (Date.now() - shownAt.current));
    const t = setTimeout(() => setShow(false), left);
    return () => clearTimeout(t);
  }, [loading, delay, minShow, show]);
  return show;
};

/** Hairline outline block. Compose these into the layout of the screen being loaded. */
export const SkeletonBlock = ({
  className,
  rounded = 'lg',
}: {
  className?: string;
  rounded?: 'sm' | 'md' | 'lg';
}) => (
  <div
    aria-hidden="true"
    className={cx(
      'border border-line',
      { sm: 'rounded-sm', md: 'rounded-md', lg: 'rounded-lg' }[rounded],
      className,
    )}
  />
);

export interface SkeletonProps {
  /** Built-in layouts; or pass children made of SkeletonBlocks. */
  variant?: 'cards' | 'list' | 'detail';
  count?: number;
  label?: string;
  children?: ReactNode;
  className?: string;
}

/** Hairline skeleton + one flare-wash sweep line (static under reduced motion). */
export const Skeleton = ({
  variant = 'list',
  count = 3,
  label = 'Loading',
  children,
  className,
}: SkeletonProps) => (
  <div
    role="status"
    aria-label={label}
    className={cx('relative overflow-hidden', className)}
    data-skeleton=""
  >
    <span className="sr-only">{label}…</span>
    <div className="flex flex-col gap-3">
      {children ??
        Array.from({ length: count }, (_, i) =>
          variant === 'cards' ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
            <div key={i} className="flex flex-col gap-3 rounded-lg border border-line p-4">
              <div className="flex items-center gap-3">
                <SkeletonBlock className="size-7" rounded="sm" />
                <SkeletonBlock className="h-4 w-32" rounded="sm" />
              </div>
              <SkeletonBlock className="h-3 w-56 max-w-full" rounded="sm" />
              <SkeletonBlock className="h-3 w-40" rounded="sm" />
              <SkeletonBlock className="h-1.5 w-28" rounded="sm" />
            </div>
          ) : variant === 'detail' ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
            <div key={i} className="flex flex-col gap-2">
              <SkeletonBlock className="h-3 w-24" rounded="sm" />
              <SkeletonBlock className="h-20 w-full" />
            </div>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
            <div key={i} className="flex min-h-14 items-center gap-3 border-b border-line py-3">
              <SkeletonBlock className="size-2.5" rounded="sm" />
              <div className="flex flex-1 flex-col gap-2">
                <SkeletonBlock className="h-3.5 w-2/3" rounded="sm" />
                <SkeletonBlock className="h-3 w-1/2" rounded="sm" />
              </div>
            </div>
          ),
        )}
    </div>
    <span
      aria-hidden="true"
      className="skeleton-sweep pointer-events-none absolute inset-x-0 h-px bg-flare-wash shadow-[0_0_0_1px_var(--bh-flare-wash)]"
    />
  </div>
);

export interface ErrorStateProps {
  /** `Couldn't reach relay.damus.io` — what happened. */
  title: string;
  /** Why, and what now. */
  children?: ReactNode;
  onRetry?: () => void;
  /** Error object / payload copied by `Copy details` (code + JSON). */
  details?: unknown;
  /** Extra actions. */
  actions?: ReactNode;
  /** `Showing data from 10:31` when cached data stays visible above. */
  cachedNote?: string;
  className?: string;
}

const detailsText = (d: unknown): string => {
  if (d instanceof Error) {
    const extra = d as Error & { code?: unknown; data?: unknown };
    return JSON.stringify({ name: d.name, message: d.message, code: extra.code, data: extra.data }, null, 2);
  }
  try {
    return JSON.stringify(d, null, 2);
  } catch {
    return String(d);
  }
};

/** Calm, specific, recoverable. No red walls (DESIGN §1 Unflappable). */
export const ErrorState = ({
  title,
  children,
  onRetry,
  details,
  actions,
  cachedNote,
  className,
}: ErrorStateProps) => {
  const [copied, setCopied] = useState(false);
  return (
    <div
      role="alert"
      className={cx('rounded-md border-l-[3px] border-stop-text bg-stop-wash px-4 py-3.5', className)}
    >
      <div className="flex items-start gap-2.5">
        <WarningCircle
          size={20}
          weight="bold"
          className="mt-0.5 shrink-0 text-stop-text"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <h2 className="type-title-3 text-ink">{title}</h2>
          {children && <div className="mt-1 type-body-sm text-ink-2">{children}</div>}
          {cachedNote && <p className="mt-1 type-meta text-ink-2">{cachedNote}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            {onRetry && (
              <Button
                variant="secondary"
                size="sm"
                icon={<ArrowClockwise size={16} aria-hidden="true" />}
                onPress={onRetry}
              >
                Retry
              </Button>
            )}
            {details !== undefined && (
              <Button
                variant="quiet"
                size="sm"
                icon={<Copy size={16} aria-hidden="true" />}
                onPress={async () => {
                  try {
                    await navigator.clipboard.writeText(detailsText(details));
                    setCopied(true);
                    announce('Error details copied.');
                    setTimeout(() => setCopied(false), 1500);
                  } catch {
                    /* clipboard blocked */
                  }
                }}
              >
                {copied ? 'Copied' : 'Copy details'}
              </Button>
            )}
            {actions}
          </div>
        </div>
      </div>
    </div>
  );
};

export interface BannerProps {
  tone?: 'caution' | 'info' | 'stop' | 'go';
  icon?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
  hatched?: boolean;
}

/** Full-width strip, wash bg, hairlines top/bottom, icon + one sentence + action. */
export const Banner = ({ tone = 'caution', icon, children, action, className, hatched }: BannerProps) => (
  <div
    className={cx(
      'relative flex min-h-11 items-center gap-3 border-y border-line px-gutter py-2 type-body-sm text-ink',
      { caution: 'bg-caution-wash', info: 'bg-sunken', stop: 'bg-stop-wash', go: 'bg-go-wash' }[tone],
      className,
    )}
  >
    {hatched && (
      <span aria-hidden="true" className="hatch pointer-events-none absolute inset-0 text-stop-text" />
    )}
    <span
      aria-hidden="true"
      className={cx(
        'relative shrink-0',
        { caution: 'text-caution-text', info: 'text-ink-2', stop: 'text-stop-text', go: 'text-go-text' }[
          tone
        ],
      )}
    >
      {icon ?? <Info size={18} weight="bold" />}
    </span>
    <div className="relative min-w-0 flex-1">{children}</div>
    {action && <div className="relative shrink-0">{action}</div>}
  </div>
);
