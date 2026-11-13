/** Audit → Usage (JOURNEYS §6 Usage). */
import { ArrowDownRight, ArrowUpRight, ChartBar } from '@phosphor-icons/react';
import { type ReactNode, useMemo, useState } from 'react';
import { useApi } from '../../api/index.ts';
import { t } from '../../i18n/index.ts';
import { cx } from '../../lib/cx.ts';
import { shortDate, tokens, usd } from '../../lib/format.ts';
import { BarChart } from '../../ui/Charts.tsx';
import { SegmentedControl } from '../../ui/Choice.tsx';
import { Eyebrow, Readout } from '../../ui/Meta.tsx';
import { EmptyState, ErrorState, Skeleton, useDelayedLoading } from '../../ui/States.tsx';
import { SegmentedMeter } from '../../ui/Status.tsx';
import { useAlertRules } from './alerts.ts';
import { aggregateUsage, type Breakdown, type Metric, monthForecast, OTHER } from './model.ts';

type Range = '7' | '14' | '30';

export const UsageTab = ({ alertButton }: { alertButton: ReactNode }) => {
  const [range, setRange] = useState<Range>('14');
  const [breakdown, setBreakdown] = useState<Breakdown>('agent');
  const [metric, setMetric] = useState<Metric>('usd');
  const n = Number(range);
  const usage = useApi('usage.query', { days: Math.min(365, n * 2) });
  const month = useApi('usage.query', { days: 31 });
  const agents = useApi('agent.list');
  const { rules } = useAlertRules();
  const showSkeleton = useDelayedLoading(usage.isPending);
  const rows = usage.data?.rows ?? [];
  const view = useMemo(() => aggregateUsage(rows, n, breakdown, metric), [rows, n, breakdown, metric]);
  const forecast = useMemo(() => monthForecast(month.data?.rows ?? []), [month.data]);

  if (usage.error)
    return (
      <ErrorState title={t('audit.usage.error')} details={usage.error} onRetry={() => void usage.refetch()}>
        {usage.error.message}
      </ErrorState>
    );
  if (usage.isPending)
    return showSkeleton ? <Skeleton variant="detail" label={t('audit.usage.loading')} /> : null;

  const fmt = (v: number) => (metric === 'usd' ? usd(v) : tokens(v));
  const delta = view.previous ? view.total.usd - view.previous.usd : null;
  const label = (id: string) =>
    id === OTHER
      ? t('audit.usage.other')
      : breakdown === 'channel' && id === 'direct'
        ? t('audit.usage.direct')
        : breakdown === 'peer' && id === 'people'
          ? t('audit.usage.people')
          : id;
  const list = agents.data?.agents ?? [];
  const budgeted = list.filter((a) => a.config.budgets.dailyUsd);
  const spentToday = list.reduce((a, x) => a + x.usageToday.usd, 0);
  const budgetToday = budgeted.reduce((a, x) => a + (x.config.budgets.dailyUsd ?? 0), 0);

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="usage-total" className="flex flex-col gap-1">
        <h2 id="usage-total" className="type-micro text-ink-2">
          {t('audit.usage.totalTitle', { count: n })}
        </h2>
        <Readout>{usd(view.total.usd)}</Readout>
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 type-meta text-ink-2">
          {delta !== null && (
            <span
              className={cx(
                'inline-flex items-center gap-1',
                delta > 0 ? 'text-caution-text' : 'text-go-text',
              )}
            >
              {delta > 0 ? (
                <ArrowUpRight size={14} weight="bold" aria-hidden="true" />
              ) : (
                <ArrowDownRight size={14} weight="bold" aria-hidden="true" />
              )}
              {t(delta > 0 ? 'audit.usage.up' : 'audit.usage.down', {
                amount: usd(Math.abs(delta)),
                count: n,
              })}
            </span>
          )}
          <span>
            {t('audit.usage.tokens', { tokens: tokens(view.total.tokens), minutes: view.total.minutes })}
          </span>
          <span>{t('audit.usage.pace', { amount: usd(forecast) })}</span>
        </p>
      </section>

      <section aria-labelledby="usage-budgets">
        <Eyebrow id="usage-budgets" action={alertButton}>
          {t('audit.usage.budgets')}
        </Eyebrow>
        {budgetToday > 0 && (
          <div className="mb-2 flex min-h-12 items-center gap-3">
            <span className="w-24 shrink-0 type-label text-ink">{t('audit.usage.allAgents')}</span>
            <SegmentedMeter
              className="min-w-0 flex-1"
              name={t('audit.usage.allBudget')}
              value={spentToday}
              max={budgetToday}
              label={t('audit.usage.meter', { spent: usd(spentToday), max: usd(budgetToday) })}
              valueText={t('audit.usage.meterSpoken', { spent: usd(spentToday), max: usd(budgetToday) })}
            />
          </div>
        )}
        <ul className="grid grid-cols-1 gap-x-8 border-t border-line expanded:grid-cols-2">
          {budgeted.map((a) => {
            const max = a.config.budgets.dailyUsd ?? 0;
            const pct = max ? (a.usageToday.usd / max) * 100 : 0;
            return (
              <li key={a.config.name} className="flex min-h-12 items-center gap-3 border-b border-line py-2">
                <span className="w-24 shrink-0 truncate type-meta text-ink">{a.config.name}</span>
                <SegmentedMeter
                  className="min-w-0 flex-1"
                  name={t('audit.usage.agentBudget', { agent: a.config.name })}
                  value={a.usageToday.usd}
                  max={max}
                  label={t('audit.usage.meter', { spent: usd(a.usageToday.usd), max: usd(max) })}
                  valueText={t('audit.usage.meterSpoken', { spent: usd(a.usageToday.usd), max: usd(max) })}
                />
                {pct >= rules.budgetWarn && (
                  <span className="sr-only">{t('audit.usage.overWarn', { pct: rules.budgetWarn })}</span>
                )}
              </li>
            );
          })}
        </ul>
        <p className="mt-2 type-meta text-ink-2">
          {t('audit.usage.alertAt', { warn: rules.budgetWarn, alert: rules.budgetAlert })}
        </p>
      </section>

      <section aria-labelledby="usage-chart" className="flex flex-col gap-3">
        <Eyebrow id="usage-chart">{t('audit.usage.chartTitle')}</Eyebrow>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <SegmentedControl<Range>
            label={t('audit.usage.range')}
            size="sm"
            value={range}
            onChange={setRange}
            options={[
              { id: '7', label: '7 d' },
              { id: '14', label: '14 d' },
              { id: '30', label: '30 d' },
            ]}
          />
          <SegmentedControl<Breakdown>
            label={t('audit.usage.by')}
            size="sm"
            value={breakdown}
            onChange={setBreakdown}
            options={[
              { id: 'agent', label: t('audit.usage.byAgent') },
              { id: 'channel', label: t('audit.usage.byChannel') },
              { id: 'peer', label: t('audit.usage.byPeer') },
            ]}
          />
          <SegmentedControl<Metric>
            label={t('audit.usage.metric')}
            size="sm"
            value={metric}
            onChange={setMetric}
            options={[
              { id: 'usd', label: t('audit.usage.cost') },
              { id: 'tokens', label: t('audit.usage.tokensLabel') },
            ]}
          />
        </div>
        {view.total.usd === 0 && view.total.tokens === 0 ? (
          <EmptyState
            glyph={<ChartBar size={32} aria-hidden="true" />}
            title={t('audit.usage.emptyTitle')}
            cli="beamhop usage --days 14"
          >
            {t('audit.usage.emptyBody')}
          </EmptyState>
        ) : (
          <BarChart
            key={`${breakdown}-${metric}-${range}`}
            label={t('audit.usage.chartLabel', {
              metric: metric === 'usd' ? t('audit.usage.cost') : t('audit.usage.tokensLabel'),
              count: n,
              by: t(
                `audit.usage.by${breakdown === 'agent' ? 'Agent' : breakdown === 'channel' ? 'Channel' : 'Peer'}`,
              ),
            })}
            height={180}
            data={view.days.map((d, i) => ({ label: shortDate(`${d}T12:00:00`), values: view.values[i]! }))}
            series={view.series.map((s) => ({ id: s.id, label: label(s.id) }))}
            format={fmt}
            legendExtra={(id) =>
              metric === 'usd'
                ? `${tokens(view.totals[id]?.tokens ?? 0)} tok`
                : usd(view.totals[id]?.usd ?? 0)
            }
          />
        )}
        <p className="type-body-sm text-ink-2">{t('audit.usage.source')}</p>
      </section>
    </div>
  );
};
