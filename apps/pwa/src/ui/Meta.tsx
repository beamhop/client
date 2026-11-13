/**
 * Typographic atoms: LetterTile (monogram), MetaLine (slug line), Readout (Doto), Eyebrow (micro header),
 * Badge / CountBadge / RiskTag, Kbd.
 */
import { ArrowRight } from '@phosphor-icons/react';
import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-aria-components';
import { cx } from '../lib/cx.ts';
import { middleTruncate } from '../lib/format.ts';

/** 28×28 monogram tile (DESIGN §7). Decorative: the provider name is always next to it in text. */
export const LetterTile = ({
  code,
  size = 28,
  tone = 'sunken',
  className,
}: {
  code: string;
  size?: number;
  tone?: 'sunken' | 'ink' | 'flare';
  className?: string;
}) => (
  <span
    aria-hidden="true"
    className={cx(
      'inline-grid shrink-0 place-items-center rounded-sm font-mono text-[11px] leading-none font-semibold select-none',
      tone === 'sunken' && 'bg-sunken text-ink hc:border hc:border-line-strong',
      tone === 'ink' && 'bg-ink text-bg',
      tone === 'flare' && 'bg-flare text-on-flare',
      className,
    )}
    style={{ width: size, height: size, fontVariationSettings: '"wdth" 75', fontSize: size > 32 ? 14 : 11 }}
  >
    {code}
  </span>
);

export type MetaItem =
  | string
  | { value: string; truncate?: number; title?: string; tone?: 'ink' | 'flare' | 'caution' | 'stop' | 'go' };

const TONE: Record<string, string> = {
  ink: 'text-ink',
  flare: 'text-flare-text',
  caution: 'text-caution-text',
  stop: 'text-stop-text',
  go: 'text-go-text',
};

/** One mono line of metadata, ` · ` separated, long values middle-truncated (DESIGN §3.4). */
export const MetaLine = ({
  items,
  className,
  as: As = 'p',
}: {
  items: Array<MetaItem | false | null | undefined>;
  className?: string;
  as?: 'p' | 'span' | 'div';
}) => {
  const list = items.filter(Boolean) as MetaItem[];
  return (
    <As className={cx('relative type-meta text-ink-2 min-w-0 truncate', className)}>
      {list.map((it, i) => {
        const v = typeof it === 'string' ? { value: it } : it;
        const shown = v.truncate ? middleTruncate(v.value, v.truncate) : v.value;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: values may repeat; position is identity
          <Fragment key={`${v.value}-${i}`}>
            {i > 0 && <span aria-hidden="true"> · </span>}
            {i > 0 && <span className="sr-only">, </span>}
            <span title={shown !== v.value ? v.value : v.title} className={v.tone ? TONE[v.tone] : undefined}>
              {shown}
            </span>
          </Fragment>
        );
      })}
    </As>
  );
};

/** Dot-matrix readout (DESIGN §3.7). One per screen at most. */
export const Readout = ({
  children,
  className,
  tone = 'ink',
  size = 'lg',
}: {
  children: ReactNode;
  className?: string;
  tone?: 'ink' | 'caution' | 'stop' | 'flare';
  size?: 'lg' | 'md';
}) => (
  <span
    className={cx(
      size === 'lg' ? 'type-readout' : 'font-display text-[28px] leading-7 font-bold tabular-nums',
      { ink: 'text-ink', caution: 'text-caution-text', stop: 'text-stop-text', flare: 'text-flare-text' }[
        tone
      ],
      className,
    )}
  >
    {children}
  </span>
);

/** Micro uppercase section header: `NEEDS YOU · 3  →`. Heading level is semantic, look is constant. */
export const Eyebrow = ({
  children,
  count,
  href,
  level = 2,
  className,
  action,
  id,
}: {
  children: ReactNode;
  count?: number;
  href?: string;
  level?: 2 | 3 | 4;
  className?: string;
  action?: ReactNode;
  id?: string;
}) => {
  const H = `h${level}` as 'h2';
  const text = (
    <>
      {children}
      {count !== undefined && <span className="tabular-nums"> · {count}</span>}
    </>
  );
  return (
    <div className={cx('flex min-h-11 items-center justify-between gap-3', className)}>
      <H id={id} className="type-micro text-ink-2">
        {href ? (
          <Link
            href={href}
            className="inline-flex min-h-11 items-center gap-2 text-ink-2 outline-none hover:text-ink data-[focus-visible]:outline-2"
          >
            {text}
            <ArrowRight size={14} aria-hidden="true" />
          </Link>
        ) : (
          text
        )}
      </H>
      {action}
    </div>
  );
};

export type BadgeTone = 'neutral' | 'flare' | 'go' | 'stop' | 'caution' | 'outline';

/** Small rectangular tag (`radius-sm`, micro). For risk tiers, `this device`, `demo`… */
export const Badge = ({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
}) => (
  <span
    className={cx(
      'bh-chip inline-flex h-5 items-center gap-1 rounded-sm px-1.5 type-micro whitespace-nowrap',
      tone === 'neutral' && 'bg-sunken text-ink-2',
      tone === 'flare' && 'bg-flare-wash text-flare-text',
      tone === 'go' && 'bg-go-wash text-go-text',
      tone === 'stop' && 'bg-stop-wash text-stop-text',
      tone === 'caution' && 'bg-caution-wash text-caution-text',
      tone === 'outline' && 'border border-line-strong text-ink-2',
      className,
    )}
  >
    {children}
  </span>
);

/** Count badge (flare fill, mono 11, min 18px, pill) — tab bar Inbox. */
export const CountBadge = ({
  count,
  label,
  className,
}: {
  count: number;
  label?: string;
  className?: string;
}) =>
  count > 0 ? (
    <span
      className={cx(
        'inline-grid h-[18px] min-w-[18px] place-items-center rounded-full bg-flare px-1 font-mono text-[11px] leading-none font-medium text-on-flare tabular-nums',
        className,
      )}
    >
      {count > 99 ? '99+' : count}
      {label && <span className="sr-only"> {label}</span>}
    </span>
  ) : null;

const RISK_TONE = { LOW: 'neutral', ELEVATED: 'caution', HIGH: 'stop' } as const;
export const RiskTag = ({ risk }: { risk: 'LOW' | 'ELEVATED' | 'HIGH' }) => (
  <Badge tone={RISK_TONE[risk]}>
    <span className="sr-only">risk </span>
    {risk}
  </Badge>
);

/** Keyboard key cap. */
export const Kbd = ({ children, className }: { children: ReactNode; className?: string }) => (
  <kbd
    className={cx(
      'inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-line-strong border-b-2 bg-surface px-1 font-mono text-[11px] leading-none text-ink-2',
      className,
    )}
  >
    {children}
  </kbd>
);
