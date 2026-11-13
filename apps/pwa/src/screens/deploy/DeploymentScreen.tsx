/**
 * TODO(deploy builder): Deployment detail — SCREENS §8 "Deployment detail".
 * Route: /deploy/$deploymentId. Topology RouteLine (you ── relays ── reviewer@fsn1), heartbeat,
 * versions + update confirm, cost this month, logs, Stop, Destroy… (plan + type-to-confirm).
 */
import { useParams } from '@tanstack/react-router';
import { Screen } from '../../shell/Screen.tsx';
import { ScreenStub } from '../../shell/ScreenStub.tsx';
import { RouteLine } from '../../ui/Status.tsx';

export const DeploymentScreen = () => {
  const { deploymentId } = useParams({ strict: false }) as { deploymentId: string };
  return (
    <Screen
      title={deploymentId}
      back={{ href: '/deploy', label: 'Deploy' }}
      pane="detail"
      crumbs={[{ label: 'Deploy', href: '/deploy' }, { label: deploymentId }]}
    >
      <div className="flex flex-col gap-6">
        <RouteLine
          nodes={[
            { label: 'you', kind: 'device' },
            { label: 'relays', kind: 'relay' },
            { label: 'ci-bot@ams', kind: 'agent' },
          ]}
        />
        <ScreenStub
          spec="SCREENS §8 Deployment detail"
          owner="src/screens/deploy/"
          outline={[
            'Topology + heartbeat',
            'Versions (beamhopd, harnesses) with update confirm',
            'Cost this month · logs · Stop · Destroy…',
          ]}
          calls={[{ method: 'deploy.list' }]}
        />
      </div>
    </Screen>
  );
};
