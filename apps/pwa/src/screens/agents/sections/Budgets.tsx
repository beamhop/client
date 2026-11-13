/**
 * Budgets & retention: today's spend/tokens/minutes, 7-day spend chart, the agent's limits (NumberFields
 * with steppers; empty = no limit), the global per-role limits that also apply (read-only), and how
 * long transcripts and audit entries are kept (+ export).
 */
import type { AgentView } from '@beamhop/core';
import { DownloadSimple } from '@phosphor-icons/react';
import { useMemo } from 'react';
import { useApi, useMutationApi } from '../../../api/index.ts';
import { t } from '../../../i18n/index.ts';
import { shortDate, tokens, usd } from '../../../lib/format.ts';
import { Button, LinkButton } from '../../../ui/Button.tsx';
import { BarChart } from '../../../ui/Charts.tsx';
import { NumberField } from '../../../ui/Field.tsx';
import { MetaLine } from '../../../ui/Meta.tsx';
import { ErrorState } from '../../../ui/States.tsx';
import { SegmentedMeter } from '../../../ui/Status.tsx';
import { useToast } from '../../../ui/Toast.tsx';
import { Block, Rows, SaveBar, useAgentDraft } from '../parts.tsx';

const opt = (v: number) => (Number.isNaN(v) ? undefined : v);

export const BudgetsSection = ({ agent }: { agent: AgentView }) => {
  const d = useAgentDraft(agent);
  const c = d.draft;
  const name = c.name;
  const usage = useApi('usage.query', { days: 7, agent: name });
  const roles = useApi('role.list');
  const exp = useMutationApi('data.export');
  const toast = useToast();
  const b = c.budgets;
  const setB = (k: keyof typeof b, v: number) =>
    d.set((x) => ({ ...x, budgets: { ...x.budgets, [k]: opt(v) } }));

  const chart = useMemo(() => {
    const days: string[] = [];
    for (let i = 6; i >= 0; i--) days.push(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10));
    const by = new Map<string, number>();
    for (const r of usage.data?.rows ?? []) by.set(r.day, (by.get(r.day) ?? 0) + r.usd);
    return days.map((day) => ({ label: shortDate(`${day}T12:00:00`), values: { usd: by.get(day) ?? 0 } }));
  }, [usage.data]);
  const week = chart.reduce((a, x) => a + x.values.usd, 0);

  return (
    <div className="flex flex-col gap-10">
      <Block id="bud-today" title={t('agents.bud.today')}>
        <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4">
          {b.dailyUsd !== undefined ? (
            <SegmentedMeter
              name={t('agents.budgetName', { name })}
              value={agent.usageToday.usd}
              max={b.dailyUsd}
              label={t('agents.budgetLabel', { used: usd(agent.usageToday.usd), max: usd(b.dailyUsd) })}
              valueText={t('agents.budgetText', { used: usd(agent.usageToday.usd), max: usd(b.dailyUsd) })}
            />
          ) : (
            <p className="type-meta text-ink-2">
              {t('agents.bud.spent', { amount: usd(agent.usageToday.usd) })}
            </p>
          )}
          {b.dailyTokens !== undefined && (
            <SegmentedMeter
              name={t('agents.bud.tokensName', { name })}
              value={agent.usageToday.tokens}
              max={b.dailyTokens}
              label={`${tokens(agent.usageToday.tokens)} / ${tokens(b.dailyTokens)} tokens`}
              valueText={`${tokens(agent.usageToday.tokens)} of ${tokens(b.dailyTokens)} tokens used today`}
            />
          )}
          <MetaLine
            items={[
              `${tokens(agent.usageToday.tokens)} tokens`,
              `${agent.usageToday.minutes} min`,
              t('agents.bud.week', { amount: usd(week) }),
            ]}
          />
        </div>
        {usage.isError ? (
          <ErrorState
            title={t('agents.bud.usageError')}
            onRetry={() => void usage.refetch()}
            details={usage.error}
          />
        ) : (
          usage.data && (
            <BarChart
              data={chart}
              series={[{ id: 'usd', label: t('agents.bud.spend') }]}
              label={t('agents.bud.chart', { name })}
              format={(n) => usd(n)}
              height={96}
              legend={false}
            />
          )
        )}
        <LinkButton href="/audit" variant="quiet" size="sm" className="self-start">
          {t('agents.bud.allUsage')}
        </LinkButton>
      </Block>

      <Block
        id="bud-limits"
        title={t('agents.bud.limits')}
        description={t('agents.bud.limitsHint')}
        cli={`beamhop agent set ${name} --daily-usd ${b.dailyUsd ?? 0}`}
      >
        <div className="grid gap-5 medium:grid-cols-2">
          <NumberField
            label={t('agents.bud.dailyUsd')}
            value={b.dailyUsd ?? Number.NaN}
            minValue={0}
            step={0.5}
            formatOptions={{ style: 'currency', currency: 'USD' }}
            onChange={(v) => setB('dailyUsd', v)}
            description={t('agents.bud.dailyUsdHint')}
          />
          <NumberField
            label={t('agents.bud.dailyTokens')}
            value={b.dailyTokens ?? Number.NaN}
            minValue={0}
            step={50_000}
            onChange={(v) => setB('dailyTokens', v)}
            description={t('agents.bud.empty')}
          />
          <NumberField
            label={t('agents.bud.session')}
            value={b.perSessionMinutes ?? Number.NaN}
            minValue={1}
            step={5}
            unit="min"
            onChange={(v) => setB('perSessionMinutes', v)}
            description={t('agents.bud.empty')}
          />
          <NumberField
            label={t('agents.bud.rate')}
            value={b.messagesPerMinute ?? Number.NaN}
            minValue={1}
            unit="/min"
            onChange={(v) => setB('messagesPerMinute', v)}
            description={t('agents.bud.empty')}
          />
        </div>
      </Block>

      {roles.data && (
        <Block id="bud-roles" title={t('agents.bud.roles')} description={t('agents.bud.rolesHint')}>
          <Rows label={t('agents.bud.roles')}>
            {roles.data.roles
              .filter((r) => r.name !== 'owner')
              .map((r) => (
                <li key={r.name} className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-0.5 px-4 py-2">
                  <span className="w-16 type-label text-ink">{r.name}</span>
                  <MetaLine
                    className="min-w-0 flex-1 whitespace-normal"
                    items={[
                      r.budget.messagesPerMinute
                        ? `${r.budget.messagesPerMinute} msg/min`
                        : t('agents.bud.noRate'),
                      r.budget.perSessionMinutes ? `${r.budget.perSessionMinutes} min/session` : undefined,
                      r.budget.dailyUsd !== undefined && `${usd(r.budget.dailyUsd)}/day`,
                    ]}
                  />
                </li>
              ))}
          </Rows>
        </Block>
      )}

      <Block
        id="bud-retention"
        title={t('agents.bud.retention')}
        description={t('agents.bud.retentionHint')}
        cli={`beamhop agent set ${name} --transcript-days ${c.retention.transcriptDays}`}
      >
        <div className="grid gap-5 medium:grid-cols-2">
          <NumberField
            label={t('agents.bud.transcripts')}
            value={c.retention.transcriptDays}
            minValue={1}
            maxValue={3650}
            unit={t('agents.bud.days')}
            onChange={(v) =>
              !Number.isNaN(v) && d.set((x) => ({ ...x, retention: { ...x.retention, transcriptDays: v } }))
            }
          />
          <NumberField
            label={t('agents.bud.audit')}
            value={c.retention.auditDays}
            minValue={30}
            maxValue={3650}
            unit={t('agents.bud.days')}
            onChange={(v) =>
              !Number.isNaN(v) && d.set((x) => ({ ...x, retention: { ...x.retention, auditDays: v } }))
            }
          />
        </div>
        <Button
          variant="secondary"
          className="self-start"
          icon={<DownloadSimple size={16} aria-hidden="true" />}
          isPending={exp.isPending}
          onPress={() =>
            exp
              .mutateAsync({ agent: name })
              .then((r) =>
                toast.show({ tone: 'success', message: t('agents.bud.exported', { path: r.path }) }),
              )
              .catch((e: Error) => toast.show({ tone: 'error', message: e.message }))
          }
        >
          {t('agents.bud.export', { name })}
        </Button>
      </Block>
      <SaveBar agent={agent} d={d} />
    </div>
  );
};
