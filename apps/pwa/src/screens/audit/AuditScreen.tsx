/**
 * TODO(audit builder): Audit / Monitoring — SCREENS §9, JOURNEYS §6.
 * Owns: src/screens/audit/**. Route: /audit?tab=usage|security|log (validated in router.tsx).
 * Build: Usage ($ Doto readout, SegmentedMeter vs budgets, range + breakdown segmented, BarChart with
 * legend rows + table view), Security (category chips, Sparkline per category, event rows with actions),
 * Log (search + filters, virtualized rows, event detail, Export/Purge). Data: 'usage.query', 'audit.query'.
 */
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useMemo } from 'react';
import { useApi } from '../../api/index.ts';
import { shortDate, usd } from '../../lib/format.ts';
import type { AuditTab } from '../../router.tsx';
import { Screen } from '../../shell/Screen.tsx';
import { ScreenStub } from '../../shell/ScreenStub.tsx';
import { BarChart } from '../../ui/Charts.tsx';
import { SegmentedControl } from '../../ui/Choice.tsx';
import { Readout } from '../../ui/Meta.tsx';

export const AuditScreen = () => {
  const { tab } = useSearch({ strict: false }) as { tab: AuditTab };
  const navigate = useNavigate();
  const usage = useApi('usage.query', { days: 14 });
  const { data, series, total } = useMemo(() => {
    const rows = usage.data?.rows ?? [];
    const agents = [...new Set(rows.map((r) => r.agent))];
    const days = [...new Set(rows.map((r) => r.day))].sort();
    return {
      series: agents.map((a) => ({ id: a, label: a })),
      data: days.map((d) => ({ label: shortDate(`${d}T12:00:00`), values: Object.fromEntries(rows.filter((r) => r.day === d).map((r) => [r.agent, r.usd])) })),
      total: rows.reduce((a, r) => a + r.usd, 0),
    };
  }, [usage.data]);
  return (
    <Screen
      title="Audit"
      actions={
        <SegmentedControl<AuditTab>
          label="Audit view"
          size="sm"
          value={tab}
          onChange={(t) => void navigate({ to: '/audit', search: { tab: t } })}
          options={[
            { id: 'usage', label: 'Usage' },
            { id: 'security', label: 'Security' },
            { id: 'log', label: 'Log' },
          ]}
        />
      }
    >
      {tab === 'usage' && (
        <div className="flex flex-col gap-4">
          <div>
            <p className="type-micro text-ink-2">Last 14 days</p>
            <Readout>{usd(total)}</Readout>
          </div>
          {data.length > 0 && <BarChart label="Spend per day, last 14 days, by agent" data={data} series={series} format={(n) => usd(n)} />}
        </div>
      )}
      <div className="mt-6">
        <ScreenStub
          spec={`SCREENS §9 · tab ${tab}`}
          owner="src/screens/audit/"
          outline={['Usage: readout, range, breakdown, stacked bars, legend = data table', 'Security: category chips, 24 h sparklines, event rows with actions', 'Log: search, filters, virtualized rows, Export JSONL/CSV, Purge…']}
          calls={[{ method: 'audit.query', params: { limit: 200 } }, { method: 'usage.query', params: { days: 14 } }]}
          cli="beamhop audit --since 24h"
        />
      </div>
    </Screen>
  );
};
