/** Audit → Security (JOURNEYS §6 Security events). */
import type { AuditEvent } from '@beamhop/core';
import { LockSimple, ShieldCheck } from '@phosphor-icons/react';
import { useNavigate } from '@tanstack/react-router';
import { type ReactNode, useMemo, useState } from 'react';
import { useApi, useMutationApi } from '../../api/index.ts';
import { t } from '../../i18n/index.ts';
import { cx } from '../../lib/cx.ts';
import { clock, when } from '../../lib/format.ts';
import { useNow } from '../../lib/useNow.ts';
import { Button } from '../../ui/Button.tsx';
import { Sparkline } from '../../ui/Charts.tsx';
import { SegmentedControl } from '../../ui/Choice.tsx';
import { Badge, Eyebrow, MetaLine } from '../../ui/Meta.tsx';
import { EmptyState, ErrorState, Skeleton, useDelayedLoading } from '../../ui/States.tsx';
import { useToast } from '../../ui/Toast.tsx';
import {
  actionsFor,
  buckets,
  categoryOf,
  levelOf,
  RANGE_MS,
  SEC_CATEGORIES,
  type SecCategory,
  type SecRange,
  spikeThreshold,
} from './model.ts';
import { EventSheet, LevelLamp } from './Sheets.tsx';

type Filter = 'all' | SecCategory;

const CAT_LABEL = (c: Filter) => t(`audit.sec.cat.${c}`);

export const SecurityTab = ({ alertButton }: { alertButton: ReactNode }) => {
  const now = useNow(60_000);
  const navigate = useNavigate();
  const toast = useToast();
  const audit = useApi('audit.query', { limit: 1000 });
  const grant = useMutationApi('role.grant');
  const [range, setRange] = useState<SecRange>('7d');
  const [filter, setFilter] = useState<Filter>('all');
  const [highOnly, setHighOnly] = useState(false);
  const [ignored, setIgnored] = useState<Set<string>>(new Set());
  const [handled, setHandled] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<AuditEvent | null>(null);
  const showSkeleton = useDelayedLoading(audit.isPending);

  const inRange = useMemo(
    () =>
      (audit.data?.events ?? []).filter(
        (e) => categoryOf(e) && now - new Date(e.at).getTime() <= RANGE_MS[range] && !ignored.has(e.id),
      ),
    [audit.data, range, now, ignored],
  );
  const byCat = useMemo(() => {
    const m = new Map<SecCategory, AuditEvent[]>();
    for (const e of inRange) {
      const c = categoryOf(e)!;
      m.set(c, [...(m.get(c) ?? []), e]);
    }
    return m;
  }, [inRange]);
  const shown = inRange.filter(
    (e) => (filter === 'all' || categoryOf(e) === filter) && (!highOnly || levelOf(e) === 'high'),
  );

  if (audit.error)
    return (
      <ErrorState title={t('audit.sec.error')} details={audit.error} onRetry={() => void audit.refetch()}>
        {audit.error.message}
      </ErrorState>
    );
  if (audit.isPending) return showSkeleton ? <Skeleton variant="list" count={5} /> : null;

  const rangeWord = t(`audit.sec.range.${range}`);
  const allowSender = (e: AuditEvent) =>
    grant
      .mutateAsync({ principal: e.actor, role: 'viewer', agent: e.agent })
      .then(() => {
        setHandled((h) => ({ ...h, [e.id]: t('audit.sec.allowedViewer') }));
        toast.show({
          message: t('audit.sec.allowedToast', { who: e.actor, agent: e.agent ?? '' }),
          tone: 'success',
        });
      })
      .catch((err: Error) => toast.show({ message: err.message, tone: 'error' }));

  const actionButtons = (e: AuditEvent) => {
    if (handled[e.id]) return <span className="type-meta text-go-text">{handled[e.id]}</span>;
    return actionsFor(e).map((a) => {
      switch (a) {
        case 'by-design':
          return (
            <Badge key={a} tone="outline">
              <LockSimple size={12} weight="bold" aria-hidden="true" /> {t('audit.sec.byDesign')}
            </Badge>
          );
        case 'allow-host':
          return (
            <Button
              key={a}
              variant="secondary"
              size="sm"
              onPress={() =>
                void navigate({
                  to: '/policy/$profile',
                  params: { profile: e.agent ?? '' },
                  search: { allowHost: String(e.data.host) } as never,
                })
              }
              aria-label={t('audit.sec.allowHostAria', { host: String(e.data.host), agent: e.agent ?? '' })}
            >
              {t('audit.sec.allow')}
            </Button>
          );
        case 'allow-path':
          return (
            <Button
              key={a}
              variant="secondary"
              size="sm"
              onPress={() => void navigate({ to: '/policy/$profile', params: { profile: e.agent ?? '' } })}
            >
              {t('audit.sec.review')}
            </Button>
          );
        case 'allow-sender':
          return (
            <span key={a} className="flex gap-2">
              <Button variant="secondary" size="sm" onPress={() => void allowSender(e)}>
                {t('audit.sec.allowViewer')}
              </Button>
              <Button
                variant="quiet"
                size="sm"
                onPress={() => {
                  setIgnored((s) => new Set(s).add(e.id));
                  toast.show({ message: t('audit.sec.ignored') });
                }}
              >
                {t('audit.sec.ignore')}
              </Button>
            </span>
          );
        case 'open-session':
          return (
            <Button
              key={a}
              variant="quiet"
              size="sm"
              onPress={() =>
                void navigate({ to: '/sessions/$sessionId', params: { sessionId: String(e.data.session) } })
              }
            >
              {t('audit.sec.openSession')}
            </Button>
          );
        case 'open-channel':
          return (
            <Button
              key={a}
              variant="quiet"
              size="sm"
              onPress={() =>
                void navigate({ to: '/channels/$id', params: { id: String(e.data.channel) } } as never)
              }
            >
              {t('audit.sec.openChannel')}
            </Button>
          );
        default:
          return null;
      }
    });
  };

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="sec-spikes">
        <Eyebrow id="sec-spikes" action={alertButton}>
          {t('audit.sec.spikes')}
        </Eyebrow>
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <SegmentedControl<SecRange>
            label={t('audit.sec.rangeLabel')}
            size="sm"
            value={range}
            onChange={setRange}
            options={[
              { id: '24h', label: '24 h' },
              { id: '7d', label: '7 d' },
              { id: '14d', label: '14 d' },
            ]}
          />
        </div>
        <ul
          aria-label={t('audit.sec.filterLabel')}
          className="grid grid-cols-1 border-t border-line medium:grid-cols-2 medium:gap-x-8"
        >
          <li className="border-b border-line">
            <button
              type="button"
              aria-pressed={filter === 'all'}
              onClick={() => setFilter('all')}
              className={cx(
                'flex min-h-12 w-full items-center gap-3 px-1 text-left outline-none focus-visible:outline-2 focus-visible:outline-focus',
                filter === 'all' ? 'bg-flare-wash' : 'hover:bg-sunken',
              )}
            >
              <span className="min-w-0 flex-1 truncate type-body-sm font-semibold text-ink">
                {CAT_LABEL('all')}
              </span>
              <span className="w-8 text-right font-mono text-[13px] text-ink tabular-nums">
                {inRange.length}
              </span>
            </button>
          </li>
          {SEC_CATEGORIES.map((c) => {
            const evs = byCat.get(c) ?? [];
            const b = buckets(evs, range, now);
            const spike = spikeThreshold(b.values);
            const spikes = b.values.filter((v) => v >= spike).length;
            return (
              <li key={c} className="border-b border-line">
                <button
                  type="button"
                  aria-pressed={filter === c}
                  onClick={() => setFilter((f) => (f === c ? 'all' : c))}
                  className={cx(
                    'flex min-h-12 w-full items-center gap-3 px-1 text-left outline-none focus-visible:outline-2 focus-visible:outline-focus',
                    filter === c ? 'bg-flare-wash' : 'hover:bg-sunken',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate type-body-sm text-ink">{CAT_LABEL(c)}</span>
                  <span className="relative shrink-0 overflow-hidden">
                    <Sparkline
                      values={b.values}
                      spikeAt={spike}
                      width={range === '24h' ? 96 : 84}
                      label={t('audit.sec.sparkLabel', {
                        cat: CAT_LABEL(c),
                        count: evs.length,
                        range: rangeWord,
                      })}
                      labels={b.values.map((_, i) =>
                        range === '24h'
                          ? clock(b.start + i * b.size)
                          : when(b.start + i * b.size)
                              .split(' ')
                              .slice(0, 2)
                              .join(' '),
                      )}
                    />
                  </span>
                  <span
                    className={cx(
                      'w-8 text-right font-mono text-[13px] tabular-nums',
                      evs.length === 0 ? 'text-ink-3' : spikes ? 'text-caution-text' : 'text-ink',
                    )}
                  >
                    {evs.length}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="sec-events" className="flex flex-col gap-3">
        <Eyebrow id="sec-events" count={shown.length}>
          {filter === 'all' ? t('audit.sec.events') : CAT_LABEL(filter)}
        </Eyebrow>
        <SegmentedControl<'all' | 'high'>
          label={t('audit.sec.levelLabel')}
          size="sm"
          className="self-start [&>*]:flex-auto"
          value={highOnly ? 'high' : 'all'}
          onChange={(v) => setHighOnly(v === 'high')}
          options={[
            { id: 'all', label: t('audit.sec.levelAll') },
            { id: 'high', label: t('audit.sec.levelHigh') },
          ]}
        />
        {shown.length === 0 ? (
          <EmptyState
            glyph={<ShieldCheck size={32} aria-hidden="true" />}
            title={t('audit.sec.emptyTitle', { range: rangeWord })}
            action={
              range !== '14d' ? (
                <Button variant="secondary" onPress={() => setRange('14d')}>
                  {t('audit.sec.show14')}
                </Button>
              ) : undefined
            }
          >
            {filter === 'all'
              ? t('audit.sec.emptyBody')
              : t('audit.sec.emptyFiltered', { cat: CAT_LABEL(filter) })}
          </EmptyState>
        ) : (
          <ul aria-label={t('audit.sec.events')} className="flex flex-col border-t border-line">
            {shown.map((e) => {
              const btns = actionButtons(e);
              return (
                <li key={e.id} className="flex gap-3 border-b border-line py-3">
                  <LevelLamp e={e} className="mt-1" />
                  <div className="min-w-0 flex-1">
                    <button
                      type="button"
                      onClick={() => setOpen(e)}
                      className="block w-full rounded-sm text-left outline-none hover:underline focus-visible:outline-2 focus-visible:outline-focus"
                    >
                      <span className="block type-body-sm text-ink [overflow-wrap:anywhere]">
                        {e.summary}
                      </span>
                    </button>
                    <MetaLine
                      className="mt-0.5"
                      items={[when(e.at, new Date(now)), e.agent, CAT_LABEL(categoryOf(e)!), e.actor]}
                    />
                    {(Array.isArray(btns) ? btns.length > 0 : !!btns) && (
                      <div className="mt-2 flex flex-wrap items-center gap-2">{btns}</div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <EventSheet event={open} onClose={() => setOpen(null)} />
    </div>
  );
};
