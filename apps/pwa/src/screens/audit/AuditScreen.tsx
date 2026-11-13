/**
 * Audit / Monitoring — SCREENS §9, JOURNEYS §6. Route: /audit?tab=usage|security|log.
 * Usage: Doto readout for the range, pace + delta, budget meters vs limits, stacked daily bars by
 * agent/channel/peer (hand-rolled SVG with legend-as-data-rows and a table view). Security: category
 * filters with sparklines, severity-shaped event rows with one-tap actions. Log: search + filters,
 * paged infinite list, event detail, export (download or `data.export`). Alert rules sheet from Usage
 * and Security.
 *
 * Research used: accessible SVG charts — name the graphic, keep a real data table one tap away, test
 * the fallback is exposed (https://www.tempertemper.net/blog/do-graphs-and-charts-need-to-be-accessible,
 * https://sarasoueidan.com/blog/accessible-data-charts-for-khan-academy-2018-annual-report/); audit-log
 * patterns — summary row with subject/outcome/time, full record in a detail view, filters by actor/type/
 * date that survive opening a record, export as JSON/CSV (https://www.saasframe.io/patterns/audit-log);
 * usage-billing dashboards show a running total plus a month-end pace
 * (https://blog.railway.com/p/usage-based-vs-fixed-pricing-2026).
 */
import { BellSimple } from '@phosphor-icons/react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import { t } from '../../i18n/index.ts';
import { useExpanded } from '../../lib/media.ts';
import type { AuditTab } from '../../router.tsx';
import { Screen } from '../../shell/Screen.tsx';
import { Button } from '../../ui/Button.tsx';
import { SegmentedControl } from '../../ui/Choice.tsx';
import { LogTab } from './LogTab.tsx';
import { SecurityTab } from './SecurityTab.tsx';
import { AlertsSheet } from './Sheets.tsx';
import { UsageTab } from './UsageTab.tsx';

export const AuditScreen = () => {
  const { tab } = useSearch({ strict: false }) as { tab: AuditTab };
  const navigate = useNavigate();
  const expanded = useExpanded();
  const [alerts, setAlerts] = useState(false);
  const tabs = (
    <SegmentedControl<AuditTab>
      label={t('audit.tabs')}
      size={expanded ? 'sm' : 'md'}
      className={expanded ? undefined : 'w-full'}
      value={tab}
      onChange={(next) => void navigate({ to: '/audit', search: { tab: next }, replace: true })}
      options={[
        { id: 'usage', label: t('audit.tab.usage') },
        { id: 'security', label: t('audit.tab.security') },
        { id: 'log', label: t('audit.tab.log') },
      ]}
    />
  );
  const alertButton = (
    <Button
      variant="quiet"
      size="sm"
      icon={<BellSimple size={16} aria-hidden="true" />}
      onPress={() => setAlerts(true)}
    >
      {t('audit.alerts.open')}
    </Button>
  );
  return (
    <Screen title={t('nav.audit')} actions={expanded ? tabs : undefined} maxWidth="wide">
      {!expanded && <div className="mb-5">{tabs}</div>}
      <div className="relative">
        {tab === 'usage' && <UsageTab alertButton={alertButton} />}
        {tab === 'security' && <SecurityTab alertButton={alertButton} />}
        {tab === 'log' && <LogTab />}
      </div>
      <AlertsSheet isOpen={alerts} onOpenChange={setAlerts} />
    </Screen>
  );
};
