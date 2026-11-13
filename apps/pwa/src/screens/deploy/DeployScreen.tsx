/**
 * Deploy — SCREENS §8 List, JOURNEYS §7. Rows: monogram · `agent @ provider region` · lamp · slug
 * `size · $/mo · since`; destroyed deployments hatched at the bottom. Total monthly estimate on top.
 * Primary `New cloud agent`; the empty state explains both entry points (Agent → Move to cloud, here).
 *
 * Research used: Terraform/OpenTofu plan vocabulary for the wizard; Fly.io hidden costs (stopped
 * machines still pay storage) https://www.costbench.com/software/developer-tools/flyio/hidden-costs/ ;
 * PaaS pricing compared https://fly.io/learn/paas-pricing-compared/ .
 */
import { CloudArrowUp, Plus } from '@phosphor-icons/react';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { deployMonogram, useApi } from '../../api/index.ts';
import { t } from '../../i18n/index.ts';
import { cx } from '../../lib/cx.ts';
import { shortDate } from '../../lib/format.ts';
import { Screen, SplitView } from '../../shell/Screen.tsx';
import { useHasDetail } from '../../shell/ScreenStub.tsx';
import { LinkButton } from '../../ui/Button.tsx';
import { CliStrip } from '../../ui/CliStrip.tsx';
import { Eyebrow, LetterTile, MetaLine } from '../../ui/Meta.tsx';
import { EmptyState, ErrorState, Skeleton, useDelayedLoading } from '../../ui/States.tsx';
import { StatusDot } from '../../ui/Status.tsx';
import { deployLamp, usd } from './model.ts';

export const DeployScreen = () => {
  const hasDetail = useHasDetail('/deploy');
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const q = useApi('deploy.list', undefined, {
    refetchInterval: (query) =>
      query.state.data?.deployments.some((d) => d.status === 'provisioning') ? 2000 : false,
  });
  const showSkeleton = useDelayedLoading(q.isPending);
  const all = q.data?.deployments ?? [];
  const live = all.filter((d) => d.status !== 'destroyed');
  const gone = all.filter((d) => d.status === 'destroyed');
  const monthly = live.reduce((s, d) => s + (d.monthlyCostUsd ?? 0), 0);

  const row = (d: (typeof all)[number]) => {
    const href = `/deploy/${d.id}`;
    const active = pathname === href;
    const destroyed = d.status === 'destroyed';
    return (
      <li key={d.id}>
        <Link
          to={href}
          aria-current={active ? 'page' : undefined}
          className={cx(
            'relative flex min-h-16 items-center gap-3 rounded-md px-2 py-2.5 outline-none focus-visible:outline-2 focus-visible:outline-focus',
            active ? 'bg-flare-wash' : 'hover:bg-sunken',
          )}
        >
          {destroyed && <span aria-hidden="true" className="hatch absolute inset-0 rounded-md text-ink-3" />}
          <LetterTile code={deployMonogram(d.provider)} />
          <span className="relative flex min-w-0 flex-1 flex-col gap-0.5">
            <span className={cx('truncate type-title-3', destroyed ? 'text-ink-2' : 'text-ink')}>
              {d.agent}{' '}
              <span className="font-normal text-ink-2">
                @ {d.provider} {d.region}
              </span>
            </span>
            <MetaLine
              items={[
                d.size?.split(' · ')[0],
                d.monthlyCostUsd !== undefined && !destroyed && `${usd(d.monthlyCostUsd)}/mo`,
                t('deploy.list.since', { date: shortDate(d.createdAt) }),
              ]}
            />
          </span>
          <StatusDot state={deployLamp(d)} label={d.status} className="relative" />
        </Link>
      </li>
    );
  };

  return (
    <SplitView
      hasDetail={hasDetail}
      list={
        <Screen
          title={t('deploy.deploy.deploy')}
          pane="list"
          slug={
            live.length > 0 ? (
              <MetaLine
                items={[
                  t('deploy.list.count', { count: live.length }),
                  t('deploy.list.monthly', { cost: usd(monthly) }),
                ]}
              />
            ) : undefined
          }
          actions={
            <LinkButton
              href="/deploy/new"
              variant="primary"
              size="sm"
              icon={<Plus size={16} weight="bold" aria-hidden="true" />}
            >
              {t('deploy.deploy.newCloudAgent')}
            </LinkButton>
          }
        >
          {q.isError ? (
            <ErrorState
              title={t('deploy.deploy.couldnTLoadDeployments')}
              details={q.error}
              onRetry={() => void q.refetch()}
            >
              {q.error.message}
            </ErrorState>
          ) : q.isPending ? (
            showSkeleton ? (
              <Skeleton variant="list" count={3} label={t('deploy.deploy.loadingDeployments')} />
            ) : null
          ) : all.length === 0 ? (
            <EmptyState
              glyph={<CloudArrowUp size={32} aria-hidden="true" />}
              title={t('deploy.deploy.noCloudAgentsYet')}
              cli="beamhop deploy plan reviewer --provider hetzner"
              action={
                <LinkButton href="/deploy/new" variant="secondary">
                  {t('deploy.deploy.newCloudAgent')}
                </LinkButton>
              }
            >
              {t('deploy.deploy.runAnAgentOn')}
            </EmptyState>
          ) : (
            <div className="flex flex-col gap-4">
              <ul aria-label={t('deploy.deploy.cloudAgents')} className="-mx-2 flex flex-col">
                {live.map(row)}
              </ul>
              {gone.length > 0 && (
                <section aria-labelledby="dep-gone">
                  <Eyebrow id="dep-gone" count={gone.length}>
                    {t('deploy.deploy.destroyed')}
                  </Eyebrow>
                  <ul className="-mx-2 flex flex-col">{gone.map(row)}</ul>
                </section>
              )}
              <CliStrip command="beamhop deploy list" />
            </div>
          )}
        </Screen>
      }
    >
      <Outlet />
    </SplitView>
  );
};
