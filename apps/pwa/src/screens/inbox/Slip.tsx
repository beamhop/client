/**
 * The transmission slip (DESIGN §3.6, JOURNEYS §2 "Data on each slip"): what is asked above the
 * perforation, your decision below. Shared by the mobile stack, the desktop detail pane, the
 * full-screen detail and the Home preview.
 */
import type { ApprovalView } from '@beamhop/core';
import { ArrowsClockwise, Check, CheckSquare, Globe, Square, Warning, X } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import { approvalTarget, RISK_LABEL } from '../../api/index.ts';
import { t } from '../../i18n/index.ts';
import { cx } from '../../lib/cx.ts';
import { countdown } from '../../lib/format.ts';
import { Button } from '../../ui/Button.tsx';
import { UntrustedQuote } from '../../ui/Card.tsx';
import { Badge, Kbd, MetaLine, Readout } from '../../ui/Meta.tsx';
import { inputOf, type QuorumState, reachOf, type SlipGroup, swipeMode } from './model.ts';

export const isOwner = (a: ApprovalView) => a.requestedBy.role === 'owner';

/** `reviewer · tg:group/-100123 · thread 842 · from Alice (user)` */
export const SlipSlug = ({ a, className }: { a: ApprovalView; className?: string }) => {
  const i = inputOf(a);
  return (
    <MetaLine
      className={cx('whitespace-normal', className)}
      items={[
        { value: a.agent, tone: 'ink' },
        i.channel ? { value: i.channel, truncate: 26 } : undefined,
        i.thread ? `thread ${i.thread}` : undefined,
        `from ${a.requestedBy.displayName ?? a.requestedBy.principal} (${a.requestedBy.role})`,
      ]}
    />
  );
};

const MiniDiff = ({ diff }: { diff: string }) => {
  const lines = diff.split('\n').slice(0, 6);
  const add = diff.split('\n').filter((l) => l.startsWith('+')).length;
  const del = diff.split('\n').filter((l) => l.startsWith('-')).length;
  return (
    <div className="mt-2 overflow-hidden rounded-md bg-sunken">
      <p className="flex justify-end gap-2 px-3 pt-1.5 type-meta">
        <span className="text-go-text">+{add}</span>
        <span className="text-stop-text">−{del}</span>
      </p>
      <pre
        className="overflow-x-auto px-3 pb-2 type-code"
        tabIndex={0}
        aria-label={t('inbox.slip.changePreview')}
      >
        {lines.map((l, n) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional
            key={n}
            className={cx(
              'block',
              l.startsWith('+') && 'bg-go-wash text-go-text',
              l.startsWith('-') && 'bg-stop-wash text-stop-text',
            )}
          >
            {l}
          </span>
        ))}
      </pre>
    </div>
  );
};

/** The "what": plain sentence first (title), raw value second. */
export const WhatBlock = ({ a, full }: { a: ApprovalView; full?: boolean }) => {
  const i = inputOf(a);
  const r = reachOf(a);
  if (r === 'access')
    return (
      <div className="mt-2 flex flex-col gap-2">
        <code className="block rounded-md bg-sunken px-3 py-2 type-code break-all text-ink">
          {i.principal ?? a.requestedBy.principal}
        </code>
        {i.message && <UntrustedQuote label={t('inbox.slip.theyWrote')}>{i.message}</UntrustedQuote>}
      </div>
    );
  if (r === 'network') {
    const host = i.host ?? approvalTarget(a);
    return (
      <div className="mt-2 flex flex-col gap-1.5">
        <span className="inline-flex min-h-8 w-fit max-w-full items-center gap-1.5 rounded-sm border border-dashed border-caution-text bg-caution-wash px-2 type-meta break-all text-caution-text">
          <Globe size={14} aria-hidden="true" />
          {host}
        </span>
        {full && i.url && <p className="type-meta break-all text-ink-2">{i.url}</p>}
        {i.firstTime && <p className="type-meta text-ink-2">{t('inbox.slip.firstTime')}</p>}
      </div>
    );
  }
  return (
    <>
      <code
        className={cx(
          'mt-2 block rounded-md bg-sunken px-3 py-2 type-code text-ink',
          full ? 'break-all whitespace-pre-wrap' : 'line-clamp-3 break-all',
        )}
      >
        {i.command ?? i.path ?? approvalTarget(a)}
      </code>
      {full && i.remoteUrl && <p className="mt-1.5 type-meta break-all text-ink-2">{i.remoteUrl}</p>}
      {i.diff && <MiniDiff diff={i.diff} />}
    </>
  );
};

export const QuorumRow = ({ q }: { q: QuorumState }) => (
  <div className="flex flex-col gap-1.5">
    <p className="type-meta text-ink-2">
      {t('inbox.quorum.progress', { yes: q.yes, needed: q.needed })}
      {q.youVoted && q.remaining > 0 && (
        <span className="text-caution-text"> · {t('inbox.quorum.waiting', { count: q.remaining })}</span>
      )}
    </p>
    <ul className="flex flex-wrap gap-x-4 gap-y-1" aria-label={t('inbox.quorum.label')}>
      {q.seats.map((s, n) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: seats are positional
        <li key={n} className="flex items-center gap-1.5 type-meta">
          {s.done ? (
            <CheckSquare size={16} weight="fill" className="text-go-text" aria-hidden="true" />
          ) : (
            <Square size={16} className="text-ink-3" aria-hidden="true" />
          )}
          <span className={s.done ? 'text-ink' : 'text-ink-2'}>{s.name}</span>
          <span className="sr-only">{s.done ? 'approved' : t('inbox.slip.notYet')}</span>
        </li>
      ))}
    </ul>
  </div>
);

/** `Auto-denies in 12:40` — Doto on the focused slip only (one readout per screen), caution < 2 min. */
export const Countdown = ({ a, now, big }: { a: ApprovalView; now: number; big?: boolean }) => {
  const left = new Date(a.expiresAt).getTime() - now;
  const urgent = left < 120_000;
  return (
    <p className={cx('flex items-baseline gap-2 type-body-sm', urgent ? 'text-caution-text' : 'text-ink-2')}>
      <span>{t('inbox.slip.autoDenies')}</span>
      {big ? (
        <Readout size="md" tone={urgent ? 'caution' : 'ink'}>
          {countdown(left)}
        </Readout>
      ) : (
        <span className={cx('type-meta tabular-nums', urgent ? 'text-caution-text' : 'text-ink')}>
          {countdown(left)}
        </span>
      )}
    </p>
  );
};

export const InjectionHint = ({ a }: { a: ApprovalView }) =>
  isOwner(a) ? null : (
    <p className="flex items-start gap-2 type-body-sm text-ink-2">
      <Warning size={16} weight="bold" className="mt-0.5 shrink-0 text-caution-text" aria-hidden="true" />
      <span>
        {t('inbox.slip.after', {
          name: a.requestedBy.displayName ?? a.requestedBy.principal,
          role: a.requestedBy.role,
        })}
      </span>
    </p>
  );

/** The plain-language sentence for a request. */
export const slipTitle = (a: ApprovalView): string =>
  a.kind === 'access-request'
    ? t('inbox.access.title', { who: a.requestedBy.displayName ?? 'Someone', agent: a.agent })
    : a.title;

export const TimesBadge = ({ n }: { n: number }) =>
  n > 1 ? (
    <Badge tone="outline" className="translate-y-[-1px]">
      ×{n}
      <span className="sr-only"> {t('inbox.slip.identicalRequestsOneDecision')}</span>
    </Badge>
  ) : null;

/** Top zone content. */
export const SlipBody = ({
  g,
  now,
  focused,
  quorum,
  full,
  hideTitle,
}: {
  g: SlipGroup;
  now: number;
  focused?: boolean;
  quorum?: QuorumState | null;
  full?: boolean;
  /** The screen title already says it (detail pane). */
  hideTitle?: boolean;
}) => {
  const a = g.lead;
  const i = inputOf(a);
  return (
    <div className="flex flex-col gap-3">
      <SlipSlug a={a} />
      <div>
        {!hideTitle && (
          <h3 className="flex flex-wrap items-baseline gap-x-2 type-title-3 text-ink">
            {slipTitle(a)}
            <TimesBadge n={g.items.length} />
          </h3>
        )}
        <WhatBlock a={a} full={full} />
      </div>
      {i.why && <UntrustedQuote>{i.why}</UntrustedQuote>}
      {a.kind !== 'access-request' && <InjectionHint a={a} />}
      {quorum && <QuorumRow q={quorum} />}
      <Countdown a={a} now={now} big={focused} />
    </div>
  );
};

export const allowLabel = (g: SlipGroup, quorum?: QuorumState | null): string => {
  const r = reachOf(g.lead);
  if (r === 'access') return t('inbox.btn.allowAccess');
  if (quorum) return t('inbox.btn.approve');
  return swipeMode(g) === 'commit' ? t('inbox.btn.allowOnce') : t('inbox.btn.allowScoped');
};

/** Bottom zone: Deny · Details · Allow (DOM order per JOURNEYS §2 Accessible alternatives). */
export const DecisionBar = ({
  g,
  quorum,
  onDeny,
  onDetails,
  onAllow,
  pending,
  hints,
  detailsLabel,
}: {
  g: SlipGroup;
  quorum?: QuorumState | null;
  onDeny: () => void;
  onDetails?: () => void;
  onAllow: () => void;
  pending?: 'allow' | 'deny' | null;
  /** Show keyboard hints (pointer: fine). */
  hints?: boolean;
  detailsLabel?: string;
}) => {
  const target = approvalTarget(g.lead);
  const access = g.lead.kind === 'access-request';
  const label = allowLabel(g, quorum);
  const scoped = swipeMode(g) === 'intent';
  const bar = (
    <div className="flex items-stretch gap-2">
      <Button
        variant="deny"
        className="flex-1"
        icon={<X size={16} weight="bold" aria-hidden="true" />}
        onPress={onDeny}
        isPending={pending === 'deny'}
        aria-label={`${access ? t('inbox.btn.ignore') : t('inbox.btn.deny')}: ${g.lead.agent}, ${target}`}
      >
        {access ? t('inbox.btn.ignore') : t('inbox.btn.deny')}
      </Button>
      {onDetails && (
        <Button variant="quiet" onPress={onDetails} aria-label={detailsLabel}>
          {t('inbox.btn.details')}
        </Button>
      )}
      <Button
        variant="allow"
        className="flex-1"
        icon={<Check size={16} weight="bold" aria-hidden="true" />}
        onPress={onAllow}
        isPending={pending === 'allow'}
        aria-label={`${label}${scoped ? t('inbox.slip.chooseScope') : ''}: ${g.lead.agent}, ${target}`}
      >
        {label}
      </Button>
    </div>
  );
  if (!hints) return bar;
  return (
    <div className="flex flex-col gap-2">
      {bar}
      <p
        aria-hidden="true"
        className="hidden flex-wrap gap-x-4 gap-y-1 type-meta text-ink-2 pointer-fine:flex"
      >
        <span>
          <Kbd>D</Kbd> {access ? t('inbox.btn.ignore').toLowerCase() : t('inbox.keys.denyShort')}
        </span>
        <span>
          <Kbd>{scoped ? '⇧A' : 'A'}</Kbd> {scoped ? t('inbox.keys.chooseShort') : t('inbox.keys.allowShort')}
        </span>
        <span>
          <Kbd>J</Kbd>/<Kbd>K</Kbd> {t('inbox.keys.moveShort')}
        </span>
        <span>
          <Kbd>U</Kbd> {t('inbox.keys.undoShort')}
        </span>
      </p>
    </div>
  );
};

/** Hatched status line for expired / decided-elsewhere / queued slips. */
export const StatusSlipLine = ({ children, icon }: { children: ReactNode; icon?: ReactNode }) => (
  <span className="flex items-center gap-2">
    {icon ?? <ArrowsClockwise size={16} aria-hidden="true" />}
    {children}
  </span>
);

export const riskWord = (a: ApprovalView) => RISK_LABEL[a.risk];
