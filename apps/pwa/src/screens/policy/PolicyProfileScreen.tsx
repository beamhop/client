/**
 * TODO(policy builder): Policy profile editor — SCREENS §7 (Network sub-screen, Roles, Review sheet).
 * Route: /policy/$profile.
 */
import { useParams } from '@tanstack/react-router';
import { Screen } from '../../shell/Screen.tsx';
import { ScreenStub } from '../../shell/ScreenStub.tsx';
import { ChipGroup } from '../../ui/Chip.tsx';

export const PolicyProfileScreen = () => {
  const { profile } = useParams({ strict: false }) as { profile: string };
  return (
    <Screen
      title={profile}
      back={{ href: '/policy', label: 'Policy' }}
      pane="detail"
      crumbs={[{ label: 'Policy', href: '/policy' }, { label: profile }]}
    >
      <div className="flex flex-col gap-6">
        <ChipGroup
          label="Never (locked)"
          items={['~/.ssh', '~/.aws', '~/.config/gh', 'keychains', 'browser profiles'].map((p) => ({
            id: p,
            label: p,
            variant: 'locked' as const,
          }))}
        />
        <ScreenStub
          spec="SCREENS §7"
          owner="src/screens/policy/"
          outline={[
            'Files: mounts with RO|RW, deny list',
            'Network: allowed chips, suggested (learning), always blocked',
            'Env allowlist · Roles matrix (Auto | Ask | Deny)',
            'Review & save → plain-language + YAML diff',
          ]}
          calls={[{ method: 'policy.get', params: { name: 'reviewer' } }]}
          cli={`beamhop policy show --profile ${profile}`}
        />
      </div>
    </Screen>
  );
};
