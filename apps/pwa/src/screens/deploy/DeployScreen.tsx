/**
 * TODO(deploy builder): Deploy — SCREENS §8, JOURNEYS §7.
 * Owns: src/screens/deploy/**. Routes: /deploy (layout) → /deploy/new (NewDeployScreen),
 * /deploy/$deploymentId (DeploymentScreen).
 * Build: rows (tile HZ/DO/FL/RN/RW · `agent @ provider region` · heartbeat lamp · cost slug),
 * `+ New cloud agent`, empty state explaining both entry points. Data: 'deploy.list', 'deploy.providers'.
 */
import { Plus } from '@phosphor-icons/react';
import { Outlet } from '@tanstack/react-router';
import { deployMonogram, useApi } from '../../api/index.ts';
import type { LampState } from '../../api/derive.ts';
import { Screen, SplitView } from '../../shell/Screen.tsx';
import { ScreenStub, useHasDetail } from '../../shell/ScreenStub.tsx';
import { StubList } from '../../shell/StubList.tsx';
import { LinkButton } from '../../ui/Button.tsx';

const LAMP: Record<string, LampState> = { running: 'ready', provisioning: 'paused', stopped: 'stopped', error: 'error', destroyed: 'stopped' };

export const DeployScreen = () => {
  const hasDetail = useHasDetail('/deploy');
  const q = useApi('deploy.list');
  return (
    <SplitView
      hasDetail={hasDetail}
      list={
        <Screen title="Deploy" pane="list" actions={<LinkButton href="/deploy/new" variant="primary" size="sm" icon={<Plus size={16} weight="bold" aria-hidden="true" />}>New</LinkButton>}>
          <StubList
            label="Deployments"
            loading={q.isPending}
            items={(q.data?.deployments ?? []).map((d) => ({
              href: `/deploy/${d.id}`,
              title: `${d.agent} @ ${d.provider} ${d.region ?? ''}`,
              tile: deployMonogram(d.provider),
              slug: [d.size ?? '', d.monthlyCostUsd ? `$${d.monthlyCostUsd.toFixed(2)}/mo` : ''].filter(Boolean),
              lamp: LAMP[d.status] ?? 'stopped',
              lampLabel: d.status,
            }))}
          />
          <div className="mt-6">
            <ScreenStub spec="SCREENS §8" owner="src/screens/deploy/" outline={['Rows with heartbeat lamp + cost', 'New / Move wizard: Provider · Size · Harness & auth · Mounts · Plan · Apply']} cli="beamhop deploy list" />
          </div>
        </Screen>
      }
    >
      <Outlet />
    </SplitView>
  );
};
