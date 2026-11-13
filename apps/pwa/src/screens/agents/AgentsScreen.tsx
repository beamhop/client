/**
 * TODO(agents builder): Agents list — SCREENS §4.1.
 * Owns: src/screens/agents/**. Routes: /agents (layout) → /agents/$name, /agents/$name/$section
 * (AgentDetailScreen.tsx), /agents/new (NewAgentScreen.tsx).
 * Build: dense agent cards (no beam line) on compact, list rows + detail pane on desktop,
 * `+ New agent` primary. Data: useApi('agent.list'), useApi('harness.list').
 */
import { Plus } from '@phosphor-icons/react';
import { Outlet } from '@tanstack/react-router';
import { agentLamp, harnessMonogram, useApi } from '../../api/index.ts';
import { Screen, SplitView } from '../../shell/Screen.tsx';
import { ScreenStub, useHasDetail } from '../../shell/ScreenStub.tsx';
import { StubList } from '../../shell/StubList.tsx';
import { LinkButton } from '../../ui/Button.tsx';

export const AgentsScreen = () => {
  const hasDetail = useHasDetail('/agents');
  const q = useApi('agent.list');
  return (
    <SplitView
      hasDetail={hasDetail}
      list={
        <Screen title="Agents" pane="list" actions={<LinkButton href="/agents/new" variant="primary" size="sm" icon={<Plus size={16} weight="bold" aria-hidden="true" />}>New agent</LinkButton>}>
          <StubList
            label="Agents"
            loading={q.isPending}
            items={(q.data?.agents ?? []).map((a) => ({
              href: `/agents/${a.config.name}`,
              title: a.config.name,
              tile: harnessMonogram(a.config.harness),
              slug: [a.config.harness, a.config.sandbox.profile, a.location.kind === 'cloud' ? (a.location.provider ?? 'cloud') : 'local'],
              lamp: agentLamp(a),
            }))}
          />
          <div className="mt-6">
            <ScreenStub spec="SCREENS §4.1" owner="src/screens/agents/" outline={['Dense agent cards (compact) / rows + detail (desktop)', 'Card overflow: Open, New session, Stop, Move to cloud']} cli="beamhop agent list" />
          </div>
        </Screen>
      }
    >
      <Outlet />
    </SplitView>
  );
};
