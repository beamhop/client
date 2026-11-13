/**
 * TODO(policy builder): Policy — SCREENS §7, JOURNEYS §5 (incl. learning mode).
 * Owns: src/screens/policy/**. Routes: /policy (layout, profiles + findings) → /policy/$profile.
 * Build: agent switcher, REACH summary (Reads/Writes/Talks to/Never hatched/Secrets), FINDINGS,
 * profile radio cards, Files/Network (ChipInput)/Env/Roles matrix/Routes, learning-mode triage cards
 * (SwipeAction), sticky save bar → review sheet with YAML diff (DiffView). Desktop: 560 editor + 360 reach.
 * Data: 'policy.get', 'policy.set', 'policy.suggestions', 'policy.applySuggestion', 'role.list'.
 */
import { Outlet } from '@tanstack/react-router';
import { Screen, SplitView } from '../../shell/Screen.tsx';
import { ScreenStub, useHasDetail } from '../../shell/ScreenStub.tsx';
import { StubList } from '../../shell/StubList.tsx';

const PROFILES = [
  { id: 'strict', blurb: 'Read-only mounts · API hosts only' },
  { id: 'workspace', blurb: 'Read/write mounts · package registries' },
  { id: 'custom', blurb: 'Your rules' },
];

export const PolicyScreen = () => {
  const hasDetail = useHasDetail('/policy');
  return (
    <SplitView
      hasDetail={hasDetail}
      list={
        <Screen title="Policy" pane="list">
          <StubList
            label="Sandbox profiles"
            items={PROFILES.map((p) => ({ href: `/policy/${p.id}`, title: p.id, slug: [p.blurb] }))}
          />
          <div className="mt-6">
            <ScreenStub
              spec="SCREENS §7 · JOURNEYS §5"
              owner="src/screens/policy/"
              outline={[
                'Reach summary in plain sentences',
                'Findings with one-tap fixes',
                'Profile picker with diff before applying',
                'Learning-mode suggestions as triage cards',
              ]}
              calls={[{ method: 'policy.suggestions' }, { method: 'role.list' }]}
            />
          </div>
        </Screen>
      }
    >
      <Outlet />
    </SplitView>
  );
};
