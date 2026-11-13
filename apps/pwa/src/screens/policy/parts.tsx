/**
 * Building blocks shared by the Policy screens: tick-ruler section headers (DESIGN §3.8), the REACH
 * summary (plain sentences grouped by verb), findings with one-tap fixes, and the plain-language change list.
 */
import { ALWAYS_DENY_READ, type SandboxPolicy } from '@beamhop/core';
import { ArrowsInSimple, ArrowsOutSimple, Circle, LockSimple } from '@phosphor-icons/react';
import { type ReactNode, useState } from 'react';
import { t } from '../../i18n/index.ts';
import { cx } from '../../lib/cx.ts';
import { Button } from '../../ui/Button.tsx';
import { StatusDot } from '../../ui/Status.tsx';
import { type Change, type Finding, foldersOf, LOCKED_HEADLINE } from './model.ts';

/** Section with a micro heading over a tuning-dial tick ruler. */
export const Section = ({
  id,
  title,
  aside,
  children,
  className,
  description,
}: {
  id: string;
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  description?: ReactNode;
}) => (
  <section id={id} aria-labelledby={`${id}-h`} className={cx('scroll-mt-20', className)}>
    <div className="flex min-h-11 items-end justify-between gap-3">
      <h2 id={`${id}-h`} tabIndex={-1} className="type-micro text-ink-2 outline-none">
        {title}
      </h2>
      {aside}
    </div>
    <TickRule className="mt-1 mb-3" />
    {description && <p className="-mt-1 mb-3 type-body-sm text-ink-2">{description}</p>}
    {children}
  </section>
);

export const TickRule = ({ className }: { className?: string }) => (
  <div
    aria-hidden="true"
    className={cx('h-[7px] border-b border-line-strong', className)}
    style={{
      backgroundImage:
        'repeating-linear-gradient(90deg, var(--bh-line-strong) 0 1px, transparent 1px 40px), repeating-linear-gradient(90deg, var(--bh-line) 0 1px, transparent 1px 8px)',
      backgroundSize: '100% 7px, 100% 3px',
      backgroundPosition: '0 0, 0 4px',
      backgroundRepeat: 'no-repeat',
    }}
  />
);

/** Hatched, locked list (always-denied paths, blocked ranges): compact, not removable, lock-marked. */
export const LockedStrip = ({ label, items, note }: { label: string; items: string[]; note?: string }) => (
  <div className="relative overflow-hidden rounded-md border border-line bg-sunken px-3 py-2.5">
    <span aria-hidden="true" className="hatch pointer-events-none absolute inset-0 text-ink-2" />
    <p className="relative flex items-center gap-1.5 type-micro text-ink-2">
      <LockSimple size={12} weight="bold" aria-hidden="true" />
      {label}
    </p>
    <ul aria-label={label} className="relative mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
      {items.map((x) => (
        <li key={x} className="type-meta text-ink [overflow-wrap:anywhere]">
          {x}
        </li>
      ))}
    </ul>
    {note && <p className="relative mt-1.5 type-body-sm text-ink-2">{note}</p>}
  </div>
);

/** Inline mono value token. */
export const Mono = ({ children, className }: { children: ReactNode; className?: string }) => (
  <span className={cx('font-mono text-[0.875em] text-ink [overflow-wrap:anywhere]', className)}>
    {children}
  </span>
);

/** Render a sentence with its value as mono. */
export const ValueText = ({ text, value }: { text: string; value?: string }) => {
  if (!value) return <>{text}</>;
  const i = text.indexOf(value);
  if (i === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <Mono>{value}</Mono>
      {text.slice(i + value.length)}
    </>
  );
};

const PathList = ({ items, max = 4, label }: { items: string[]; max?: number; label: string }) => {
  const [all, setAll] = useState(false);
  if (!items.length) return <span className="type-body-sm text-ink-3">{t('policy.reach.nothing')}</span>;
  const shown = all ? items : items.slice(0, max);
  return (
    <ul aria-label={label} className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
      {shown.map((p) => (
        <li key={p} className="type-meta text-ink [overflow-wrap:anywhere]">
          {p}
        </li>
      ))}
      {items.length > max && (
        <li>
          <button
            type="button"
            onClick={() => setAll((x) => !x)}
            aria-expanded={all}
            className="-my-3 min-h-11 type-meta text-ink-2 underline underline-offset-[3px] hover:text-ink"
          >
            {all ? t('policy.reach.less') : t('policy.reach.more', { count: items.length - max })}
          </button>
        </li>
      )}
    </ul>
  );
};

/**
 * REACH (JOURNEYS §5.1): Reads / Writes / Talks to / Never / Secrets. The single most important element:
 * answers "can it read ~/.ssh?" and "which hosts can it reach?" at a glance.
 */
export const ReachSummary = ({
  agent,
  policy,
  className,
}: {
  agent: string;
  policy: SandboxPolicy;
  className?: string;
}) => {
  const folders = foldersOf(policy);
  const writes = folders.filter((f) => f.mode === 'rw').map((f) => f.path);
  const [allLocked, setAllLocked] = useState(false);
  const locked = allLocked ? [...ALWAYS_DENY_READ, ...policy.fs.deny] : LOCKED_HEADLINE;
  const uniqLocked = [...new Set(locked)];
  const extraLocked = new Set([...ALWAYS_DENY_READ, ...policy.fs.deny]).size - LOCKED_HEADLINE.length;
  const row = 'grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 border-b border-line py-2.5 last:border-b-0';
  const dt = 'pt-px type-micro text-ink-2';
  return (
    <dl className={cx('rounded-lg border border-line bg-surface px-4 py-1', className)}>
      <div className={row}>
        <dt className={dt}>{t('policy.reach.reads')}</dt>
        <dd>
          <PathList items={folders.map((f) => f.path)} label={t('policy.reach.readsLabel', { agent })} />
        </dd>
      </div>
      <div className={row}>
        <dt className={dt}>{t('policy.reach.writes')}</dt>
        <dd>
          <PathList items={writes} label={t('policy.reach.writesLabel', { agent })} />
          {writes.length > 0 && (
            <p className="mt-0.5 type-body-sm text-ink-2">{t('policy.reach.writesNote')}</p>
          )}
        </dd>
      </div>
      <div className={row}>
        <dt className={dt}>{t('policy.reach.talks')}</dt>
        <dd>
          <p className="mb-0.5 type-body-sm text-ink-2">
            {t('policy.reach.hosts', { count: policy.net.allow.length })}
          </p>
          <PathList items={policy.net.allow} max={5} label={t('policy.reach.talksLabel', { agent })} />
        </dd>
      </div>
      <div className={cx(row, 'relative -mx-4 px-4')}>
        <span aria-hidden="true" className="hatch pointer-events-none absolute inset-0 text-ink-2" />
        <dt className={cx(dt, 'relative flex items-start gap-1')}>
          <LockSimple size={12} weight="bold" aria-hidden="true" className="mt-0.5" />
          {t('policy.reach.never')}
        </dt>
        <dd className="relative">
          <ul aria-label={t('policy.reach.neverLabel')} className="flex flex-wrap gap-x-2.5 gap-y-1">
            {uniqLocked.map((p) => (
              <li key={p} className="type-meta text-ink [overflow-wrap:anywhere]">
                {p}
              </li>
            ))}
            {!allLocked && <li className="type-meta text-ink">{t('policy.reach.browsers')}</li>}
            <li>
              <button
                type="button"
                onClick={() => setAllLocked((x) => !x)}
                aria-expanded={allLocked}
                className="-my-3 min-h-11 type-meta text-ink-2 underline underline-offset-[3px] hover:text-ink"
              >
                {allLocked
                  ? t('policy.reach.less')
                  : t('policy.reach.more', { count: Math.max(0, extraLocked) })}
              </button>
            </li>
          </ul>
          <p className="mt-0.5 type-body-sm text-ink-2">{t('policy.reach.neverNote')}</p>
        </dd>
      </div>
      <div className={row}>
        <dt className={dt}>{t('policy.reach.secrets')}</dt>
        <dd className="type-body-sm text-ink-2">
          {policy.secrets.length === 0 ? (
            t('policy.reach.noSecrets')
          ) : (
            <>
              {t('policy.reach.secretsLead')}{' '}
              {policy.secrets.map((s, i) => (
                <span key={s.name}>
                  {i > 0 && ', '}
                  <Mono>{s.name}</Mono>
                </span>
              ))}
            </>
          )}
        </dd>
      </div>
    </dl>
  );
};

export const FindingList = ({
  findings,
  onFix,
  className,
}: {
  findings: Finding[];
  onFix?: (f: Finding) => void;
  className?: string;
}) =>
  findings.length === 0 ? (
    <p className={cx('flex items-center gap-2 type-body-sm text-ink-2', className)}>
      <StatusDot state="ready" hideLabel />
      {t('policy.findings.none')}
    </p>
  ) : (
    <ul className={cx('flex flex-col', className)}>
      {findings.map((f) => (
        <li key={f.id} className="flex gap-2.5 border-b border-line py-3 first:pt-1 last:border-b-0">
          <StatusDot
            state={f.severity === 'stop' ? 'error' : 'needs-you'}
            label={f.severity === 'stop' ? t('policy.findings.risk') : t('policy.findings.caution')}
            hideLabel
            className="h-5 shrink-0 self-start"
          />
          <div className="min-w-0 flex-1">
            <p className="type-body-sm text-ink [overflow-wrap:anywhere]">
              <ValueText text={f.title} value={f.value} />
            </p>
            {f.fix && onFix && (
              <Button variant="secondary" size="sm" className="mt-2" onPress={() => onFix(f)}>
                {f.fix.label}
              </Button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );

export const CHANGE_ICON = {
  widen: <ArrowsOutSimple size={16} weight="bold" aria-hidden="true" className="text-caution-text" />,
  tighten: <ArrowsInSimple size={16} weight="bold" aria-hidden="true" className="text-go-text" />,
  neutral: <Circle size={8} weight="fill" aria-hidden="true" className="mx-1 text-ink-3" />,
};

export const ChangeList = ({ changes, className }: { changes: Change[]; className?: string }) => (
  <ul className={cx('flex flex-col', className)}>
    {changes.map((c, i) => (
      <li
        // biome-ignore lint/suspicious/noArrayIndexKey: changes are positional and re-derived
        key={i}
        className="flex items-start gap-2.5 border-b border-line py-2.5 last:border-b-0"
      >
        <span className="mt-0.5 shrink-0">{CHANGE_ICON[c.kind]}</span>
        <span className="sr-only">
          {c.kind === 'widen'
            ? t('policy.change.widen')
            : c.kind === 'tighten'
              ? t('policy.change.tighten')
              : t('policy.change.neutral')}
          :
        </span>
        <span className="min-w-0 flex-1 type-body-sm text-ink">
          <ValueText text={c.text} value={c.value} />
        </span>
      </li>
    ))}
  </ul>
);
