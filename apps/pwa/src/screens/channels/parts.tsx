/** Small building blocks shared by the channel screens and the wizard. */
import { ArrowUpRight, CheckCircle, WarningCircle } from '@phosphor-icons/react';
import { forwardRef, type ReactNode } from 'react';
import { cx } from '../../lib/cx.ts';
import { type ButtonVariant, buttonClass } from '../../ui/Button.tsx';
import { CopyButton } from '../../ui/CliStrip.tsx';
import { HopMeter } from '../../ui/glyphs/index.tsx';
import { LetterTile, MetaLine } from '../../ui/Meta.tsx';

/**
 * A deep link into a provider's own UI (BotFather, Slack, Discord portal). Opens a new tab/app; the
 * wizard keeps its place (draft.ts) and re-focuses on return (visibilitychange).
 */
export const ExternalButton = ({
  href,
  children,
  variant = 'secondary',
  fullWidth,
  onOpen,
  className,
}: {
  href: string;
  children: ReactNode;
  variant?: ButtonVariant;
  fullWidth?: boolean;
  onOpen?: () => void;
  className?: string;
}) => (
  <a
    href={href}
    target="_blank"
    rel="noopener noreferrer"
    onClick={onOpen}
    className={buttonClass(
      variant,
      'lg',
      cx(
        'no-underline outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        fullWidth && 'w-full',
        className,
      ),
    )}
  >
    <span className="min-w-0 truncate">{children}</span>
    <ArrowUpRight size={18} weight="bold" aria-hidden="true" />
    <span className="sr-only"> (opens in a new tab)</span>
  </a>
);

/** Wizard step heading: `05 · PAIR` micro + title-2. Focus target when the step changes. */
export const StepHeading = forwardRef<
  HTMLHeadingElement,
  { index: number; total: number; label: string; children: ReactNode; lead?: ReactNode }
>(({ index, total, label, children, lead }, ref) => (
  <div className="flex flex-col gap-1">
    <p className="type-micro text-flare-text">
      {String(index + 1).padStart(2, '0')} · {label}
      <span className="sr-only">
        {' '}
        (step {index + 1} of {total})
      </span>
    </p>
    <h2 ref={ref} tabIndex={-1} className="type-title-2 text-ink outline-none">
      {children}
    </h2>
    {lead && <p className="mt-1 max-w-[56ch] type-body text-ink-2">{lead}</p>}
  </div>
));
StepHeading.displayName = 'StepHeading';

/** One line of a "send this to BotFather" script: number · text · copyable value. */
export const ScriptStep = ({
  n,
  children,
  copy,
  note,
}: {
  n: number;
  children: ReactNode;
  copy?: string;
  note?: ReactNode;
}) => (
  <li className="flex gap-3 border-b border-line py-3 last:border-b-0">
    <span
      aria-hidden="true"
      className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-sm bg-sunken font-mono text-[11px] text-ink-2"
    >
      {n}
    </span>
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <div className="type-body text-ink">{children}</div>
      {copy && (
        <div className="flex min-w-0 items-center gap-1 rounded-md bg-sunken pl-3">
          <code className="min-w-0 flex-1 truncate py-2 type-code text-ink">{copy}</code>
          <CopyButton value={copy} label={`Copy ${copy}`} compact />
        </div>
      )}
      {note && <p className="type-body-sm text-ink-2">{note}</p>}
    </div>
  </li>
);

/** The bot as the provider sees it, after `channel.validate`. */
export const IdentityCard = ({
  name,
  handle,
  provider,
  note,
  tone = 'go',
}: {
  name: string;
  handle?: string;
  provider: string;
  note?: ReactNode;
  tone?: 'go' | 'caution' | 'neutral';
}) => (
  <div
    className={cx(
      'flex items-start gap-3 rounded-lg border border-line px-4 py-3',
      tone === 'go' ? 'bg-go-wash' : tone === 'neutral' ? 'bg-surface' : 'bg-caution-wash',
    )}
  >
    <LetterTile code={initials(name)} size={40} tone="ink" />
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <p className="flex items-center gap-1.5 type-title-3 text-ink">
        <span className="truncate">{name}</span>
      </p>
      <MetaLine items={[handle, provider].filter(Boolean) as string[]} />
      {note && <p className="mt-1 type-body-sm text-ink">{note}</p>}
    </div>
    {tone === 'neutral' ? null : tone === 'go' ? (
      <CheckCircle size={22} weight="fill" className="shrink-0 text-go-text" aria-label="Valid" />
    ) : (
      <WarningCircle
        size={22}
        weight="fill"
        className="shrink-0 text-caution-text"
        aria-label="Valid with a warning"
      />
    )}
  </div>
);

export const initials = (name: string): string => {
  const words = name
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length >= 2) return `${words[0]![0]}${words[1]![0]}`.toUpperCase();
  return (words[0] ?? '?').slice(0, 2).toUpperCase();
};

/** `▂▄▆ Waiting for you in Telegram…` — the concrete progress line (no spinners). */
export const WaitingLine = ({ children, done }: { children: ReactNode; done?: boolean }) => (
  <p role="status" className="flex items-center gap-2.5 type-meta text-ink-2">
    <HopMeter up={done ? 3 : 2} total={3} busy={!done} tone="ink" />
    <span>{children}</span>
  </p>
);

/** A tiny two-column fact list (`dt`/`dd`) for detail screens. */
export const Facts = ({ rows, className }: { rows: Array<[string, ReactNode]>; className?: string }) => (
  <dl className={cx('grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4', className)}>
    {rows.map(([k, v]) => (
      <div key={k} className="contents">
        <dt className="border-b border-line py-2.5 type-meta text-ink-2">{k}</dt>
        <dd className="min-w-0 border-b border-line py-2.5 type-body-sm break-words text-ink">{v}</dd>
      </div>
    ))}
  </dl>
);
