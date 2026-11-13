/**
 * Agents list — SCREENS §4.1. Compact: dense agent cards (no beam line) with one-tap Stop/Start;
 * expanded: 320px list pane of rows (monogram · name · lamp · slug) + detail pane (Outlet).
 * Sorted live → needs you → error → ready → stopped, like Home. `+ New agent` is the one primary.
 *
 * Research: list/detail with persistent selection and a single creation primary follows Cloudscape's
 * resource-management "table/cards view" pattern (https://cloudscape.design/patterns/resource-management/view/)
 * — the card carries state + the one frequent action (stop), everything else lives in the detail.
 */
import type { AgentView } from '@beamhop/core';
import { Play, Plus, Stop } from '@phosphor-icons/react';
import { Outlet, useRouterState } from '@tanstack/react-router';
import { useMemo } from 'react';
import { Link } from 'react-aria-components';
import {
  agentLamp,
  harnessMonogram,
  type LampState,
  sortByLamp,
  useApi,
  useMutationApi,
} from '../../api/index.ts';
import { t } from '../../i18n/index.ts';
import { cx } from '../../lib/cx.ts';
import { since, usd } from '../../lib/format.ts';
import { haptic } from '../../lib/haptics.ts';
import { useExpanded } from '../../lib/media.ts';
import { usePanicState } from '../../shell/panic.tsx';
import { Screen, SplitView } from '../../shell/Screen.tsx';
import { useHasDetail } from '../../shell/ScreenStub.tsx';
import { BarAction, IconButton, LinkButton } from '../../ui/Button.tsx';
import { Card } from '../../ui/Card.tsx';
import { LetterTile, MetaLine } from '../../ui/Meta.tsx';
import { EmptyState, ErrorState, Skeleton, useDelayedLoading } from '../../ui/States.tsx';
import { SegmentedMeter, StatusDot } from '../../ui/Status.tsx';
import { useToast } from '../../ui/Toast.tsx';

interface Row {
  a: AgentView;
  lamp: LampState;
  last?: string;
  pending: number;
}

export const agentSlug = (a: AgentView) => [
  a.config.harness,
  a.config.sandbox.profile,
  a.location.kind === 'cloud' ? (a.location.provider ?? 'cloud') : 'local',
];

const StartStop = ({ a, panic }: { a: AgentView; panic: boolean }) => {
  const stop = useMutationApi('agent.stop');
  const start = useMutationApi('agent.start');
  const toast = useToast();
  const running = a.status !== 'stopped' && a.status !== 'error';
  if (panic) return null;
  return running ? (
    <IconButton
      label={t('agents.stopName', { name: a.config.name })}
      icon={<Stop size={18} weight="fill" />}
      variant="secondary"
      isDisabled={stop.isPending}
      onPress={() => {
        haptic('tick');
        stop
          .mutateAsync({ name: a.config.name })
          .then(() => toast.show({ message: t('agents.stopped', { name: a.config.name }) }))
          .catch((e: Error) => toast.show({ tone: 'error', message: e.message }));
      }}
    />
  ) : (
    <IconButton
      label={t('agents.startName', { name: a.config.name })}
      icon={<Play size={18} weight="fill" />}
      variant="secondary"
      isDisabled={start.isPending}
      onPress={() =>
        start
          .mutateAsync({ name: a.config.name })
          .then(() => toast.show({ message: t('agents.started', { name: a.config.name }) }))
          .catch((e: Error) => toast.show({ tone: 'error', message: e.message }))
      }
    />
  );
};

const lampLabel = (r: Row) =>
  r.lamp === 'needs-you' ? t('agents.lamp.needs', { count: r.pending }) : undefined;

/** Compact card: tile · name · lamp / slug / what it's doing / budget meter + Stop. */
const AgentCard = ({ r, panic }: { r: Row; panic: boolean }) => {
  const { a } = r;
  const budget = a.config.budgets.dailyUsd ?? 0;
  const doing =
    a.status === 'error'
      ? (a.error ?? t('agents.status.error'))
      : a.activeSessions > 0
        ? t('agents.activeSessions', { count: a.activeSessions })
        : a.lastActivityAt
          ? t('agents.idleSince', { since: since(a.lastActivityAt) })
          : t('agents.neverRan');
  return (
    <li>
      <Card href={`/agents/${a.config.name}`} linkLabel={a.config.name} padding="sm">
        <div className="flex items-start gap-3">
          <LetterTile code={harnessMonogram(a.config.harness)} className="mt-0.5" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex items-center justify-between gap-2">
              <h2 className="truncate type-title-3 text-ink">{a.config.name}</h2>
              <StatusDot state={r.lamp} label={lampLabel(r)} />
            </div>
            <MetaLine items={agentSlug(a)} />
            <p
              className={cx('truncate type-body-sm', a.status === 'error' ? 'text-stop-text' : 'text-ink-2')}
            >
              {doing}
            </p>
            <div className="mt-1.5 flex items-center gap-2">
              {budget > 0 ? (
                <SegmentedMeter
                  compact
                  name={t('agents.budgetName', { name: a.config.name })}
                  value={a.usageToday.usd}
                  max={budget}
                  label={`${usd(a.usageToday.usd)} / ${usd(budget)}`}
                  valueText={t('agents.budgetText', { used: usd(a.usageToday.usd), max: usd(budget) })}
                  className="min-w-0 flex-1"
                />
              ) : (
                <span className="flex-1 type-meta text-ink-2">{t('agents.noBudget')}</span>
              )}
              <StartStop a={a} panic={panic} />
            </div>
          </div>
        </div>
      </Card>
    </li>
  );
};

/** Expanded list-pane row. */
const AgentRow = ({ r, active }: { r: Row; active: boolean }) => (
  <li>
    <Link
      href={`/agents/${r.a.config.name}`}
      aria-current={active ? 'page' : undefined}
      className={cx(
        'flex min-h-14 items-center gap-3 rounded-md px-2 py-2.5 outline-none data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus',
        active ? 'bg-flare-wash' : 'data-[hovered]:bg-sunken',
      )}
    >
      <LetterTile code={harnessMonogram(r.a.config.harness)} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate type-title-3 text-ink">{r.a.config.name}</span>
        <MetaLine items={agentSlug(r.a)} />
      </span>
      <StatusDot state={r.lamp} label={lampLabel(r)} />
    </Link>
  </li>
);

export const AgentsScreen = () => {
  const hasDetail = useHasDetail('/agents');
  const expanded = useExpanded();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const q = useApi('agent.list');
  const approvals = useApi('approval.list');
  const { panic } = usePanicState();
  const showSkeleton = useDelayedLoading(q.isPending);

  const rows = useMemo<Row[]>(() => {
    const pending = new Map<string, number>();
    for (const ap of approvals.data?.approvals ?? []) pending.set(ap.agent, (pending.get(ap.agent) ?? 0) + 1);
    return sortByLamp(
      (q.data?.agents ?? []).map((a) => ({
        a,
        pending: pending.get(a.config.name) ?? 0,
        lamp: agentLamp(a, { pending: pending.get(a.config.name), panic }),
        last: a.lastActivityAt,
      })),
    );
  }, [q.data, approvals.data, panic]);

  const live = rows.filter((r) => r.lamp === 'live').length;
  const body = q.isPending ? (
    showSkeleton ? (
      <Skeleton variant={expanded ? 'list' : 'cards'} count={4} label={t('agents.loading')} />
    ) : null
  ) : q.isError && !q.data ? (
    <ErrorState title={t('agents.loadError')} details={q.error} onRetry={() => void q.refetch()}>
      {t('agents.loadErrorBody')}
    </ErrorState>
  ) : rows.length === 0 ? (
    <EmptyState
      title={t('agents.empty.title')}
      action={
        <LinkButton
          href="/agents/new"
          variant="primary"
          icon={<Plus size={16} weight="bold" aria-hidden="true" />}
        >
          {t('agents.new')}
        </LinkButton>
      }
      cli="beamhop agent add reviewer --harness claude --preset code-reviewer"
    >
      {t('agents.empty.body')}
    </EmptyState>
  ) : expanded ? (
    <ul aria-label={t('nav.agents')} className="-mx-2 mt-2 flex flex-col">
      {rows.map((r) => (
        <AgentRow
          key={r.a.config.name}
          r={r}
          active={
            pathname === `/agents/${r.a.config.name}` || pathname.startsWith(`/agents/${r.a.config.name}/`)
          }
        />
      ))}
    </ul>
  ) : (
    <ul aria-label={t('nav.agents')} className="flex flex-col gap-3">
      {rows.map((r) => (
        <AgentCard key={r.a.config.name} r={r} panic={panic} />
      ))}
    </ul>
  );

  // Creating an agent is a focused task: on wide screens it takes the whole main area (two columns).
  if (expanded && pathname === '/agents/new') return <Outlet />;

  return (
    <SplitView
      hasDetail={hasDetail}
      listWidth={320}
      list={
        <Screen
          title={t('nav.agents')}
          pane="list"
          slug={
            rows.length > 0 && !expanded ? (
              <MetaLine
                items={[
                  t('agents.countAll', { count: rows.length }),
                  live > 0 && { value: t('agents.countLive', { count: live }), tone: 'flare' },
                ]}
              />
            ) : undefined
          }
          actions={
            <BarAction
              href="/agents/new"
              label={t('agents.new')}
              icon={<Plus size={20} weight="bold" aria-hidden="true" />}
            />
          }
        >
          {body}
        </Screen>
      }
    >
      <Outlet />
    </SplitView>
  );
};
