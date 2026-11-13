/**
 * Policy — SCREENS §7, JOURNEYS §5. List pane: every agent's sandbox as a one-line reach summary with
 * learning/findings state, the three profiles, and the roles table. Detail (/policy/$profile) is the
 * per-agent editor, a profile explainer, or the roles matrix (see PolicyProfileScreen).
 * Desktop with nothing selected: profiles compared side by side.
 */
import type { AgentView } from '@beamhop/core';
import { CaretRight, UsersThree } from '@phosphor-icons/react';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { harnessMonogram, useApi } from '../../api/index.ts';
import { t } from '../../i18n/index.ts';
import { cx } from '../../lib/cx.ts';
import { Screen, SplitView } from '../../shell/Screen.tsx';
import { useHasDetail } from '../../shell/ScreenStub.tsx';
import { Eyebrow, LetterTile, MetaLine } from '../../ui/Meta.tsx';
import { EmptyState, ErrorState, Skeleton, useDelayedLoading } from '../../ui/States.tsx';
import { StatusDot } from '../../ui/Status.tsx';
import { findingsFor, PROFILES } from './model.ts';
import { ProfileCompare } from './ProfileInfo.tsx';

const rowClass = (active: boolean) =>
  cx(
    'flex min-h-16 items-center gap-3 rounded-md px-2 py-2.5 outline-none data-[focus-visible]:outline-2 focus-visible:outline-2 focus-visible:outline-focus',
    active ? 'bg-flare-wash' : 'hover:bg-sunken',
  );

const useActive = () => useRouterState({ select: (s) => s.location.pathname });

const AgentRow = ({ a, path }: { a: AgentView; path: string }) => {
  const name = a.config.name;
  const pol = useApi('policy.get', { name });
  const sugg = useApi('policy.suggestions', { name });
  const p = pol.data?.effective;
  const pending = sugg.data?.suggestions.length ?? 0;
  const findings = p ? findingsFor(p, { pendingSuggestions: pending }).length : 0;
  const href = `/policy/${name}`;
  const active = path === href;
  return (
    <li>
      <Link to="/policy/$profile" params={{ profile: name }} aria-current={active ? 'page' : undefined} className={rowClass(active)}>
        <LetterTile code={harnessMonogram(a.config.harness)} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate type-title-3 text-ink">{name}</span>
          {p ? (
            <MetaLine
              items={[
                pol.data?.profile ?? '',
                t('policy.list.hosts', { count: p.net.allow.length }),
              ]}
            />
          ) : (
            <span className="h-4" />
          )}
        </span>
        {p?.learning ? (
          <StatusDot state="needs-you" label={t('policy.list.learning')} />
        ) : findings > 0 ? (
          <span className="type-meta whitespace-nowrap text-caution-text">
            {t('policy.list.findings', { count: findings })}
          </span>
        ) : (
          <StatusDot state="ready" label={t('policy.list.ok')} />
        )}
      </Link>
    </li>
  );
};

export const PolicyScreen = () => {
  const hasDetail = useHasDetail('/policy');
  const agents = useApi('agent.list');
  const path = useActive();
  const showSkeleton = useDelayedLoading(agents.isPending);
  const list = agents.data?.agents ?? [];
  const usage = (p: string) => list.filter((a) => a.config.sandbox.profile === p).map((a) => a.config.name);

  return (
    <SplitView
      hasDetail={hasDetail}
      empty={<ProfileCompare />}
      list={
        <Screen title={t('nav.policy')} pane="list" slug={<MetaLine items={[t('policy.list.slug')]} />}>
          <section aria-labelledby="pol-agents">
            <Eyebrow id="pol-agents" count={agents.data ? list.length : undefined}>
              {t('policy.list.agents')}
            </Eyebrow>
            {agents.error ? (
              <ErrorState title={t('policy.list.error')} details={agents.error} onRetry={() => void agents.refetch()}>
                {agents.error.message}
              </ErrorState>
            ) : agents.isPending ? (
              showSkeleton ? (
                <Skeleton variant="list" count={4} />
              ) : null
            ) : list.length === 0 ? (
              <EmptyState title={t('policy.list.emptyTitle')} cli="beamhop agent create" action={<Link to="/agents/new" className="type-label underline">{t('policy.list.emptyAction')}</Link>}>
                {t('policy.list.emptyBody')}
              </EmptyState>
            ) : (
              <ul aria-label={t('policy.list.agents')} className="-mx-2 flex flex-col">
                {list.map((a) => (
                  <AgentRow key={a.config.name} a={a} path={path} />
                ))}
              </ul>
            )}
          </section>
          <section aria-labelledby="pol-profiles" className="mt-6">
            <Eyebrow id="pol-profiles">{t('policy.list.profiles')}</Eyebrow>
            <ul aria-label={t('policy.list.profiles')} className="-mx-2 flex flex-col">
              {PROFILES.map((p) => {
                const used = usage(p);
                const active = path === `/policy/${p}`;
                return (
                  <li key={p}>
                    <Link to="/policy/$profile" params={{ profile: p }} aria-current={active ? 'page' : undefined} className={rowClass(active)}>
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="font-mono text-[15px] font-medium text-ink">{p}</span>
                        <span className="type-body-sm text-ink-2">{t(`policy.profile.${p}.short`)}</span>
                        <MetaLine
                          items={[used.length ? t('policy.list.usedBy', { names: used.join(', ') }) : t('policy.list.unused')]}
                        />
                      </span>
                      <CaretRight size={16} aria-hidden="true" className="shrink-0 text-ink-3" />
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
          <section aria-labelledby="pol-roles" className="mt-6">
            <Eyebrow id="pol-roles">{t('policy.list.rolesTitle')}</Eyebrow>
            <ul className="-mx-2 flex flex-col">
              <li>
                <Link to="/policy/$profile" params={{ profile: 'roles' }} aria-current={path === '/policy/roles' ? 'page' : undefined} className={rowClass(path === '/policy/roles')}>
                  <span className="grid size-7 shrink-0 place-items-center rounded-sm bg-sunken text-ink-2">
                    <UsersThree size={16} aria-hidden="true" />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="type-title-3 text-ink">{t('policy.roles.title')}</span>
                    <span className="type-body-sm text-ink-2">{t('policy.list.rolesBlurb')}</span>
                  </span>
                  <CaretRight size={16} aria-hidden="true" className="shrink-0 text-ink-3" />
                </Link>
              </li>
            </ul>
          </section>
        </Screen>
      }
    >
      <Outlet />
    </SplitView>
  );
};
