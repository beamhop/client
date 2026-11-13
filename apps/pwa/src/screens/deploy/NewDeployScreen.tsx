/**
 * TODO(deploy builder): New / Move to cloud wizard — SCREENS §8, JOURNEYS §7.
 * Route: /deploy/new. Stepper `01 Provider · 02 Size · 03 Harness & auth · 04 Mounts · 05 Plan · 06 Apply`;
 * terraform-style plan (+ create / ~ move / → clone / - stop, symbols AND words), primary `Deploy · €4.51/mo`.
 * Desktop: left form 640 + sticky Plan preview. Data: 'deploy.providers', 'deploy.options', 'deploy.plan', 'deploy.apply'.
 */
import { Screen } from '../../shell/Screen.tsx';
import { ScreenStub } from '../../shell/ScreenStub.tsx';
import { Stepper } from '../../ui/Stepper.tsx';

export const NewDeployScreen = () => (
  <Screen title="New cloud agent" back={{ href: '/deploy', label: 'Deploy' }} pane="detail" maxWidth="form" crumbs={[{ label: 'Deploy', href: '/deploy' }, { label: 'New' }]}>
    <div className="flex flex-col gap-6">
      <Stepper steps={['Provider', 'Size', 'Harness & auth', 'Mounts', 'Plan', 'Apply']} current={0} />
      <ScreenStub
        spec="SCREENS §8 · JOURNEYS §7"
        owner="src/screens/deploy/"
        outline={['Provider rows with one-line fit', 'Size & region with monthly estimate', 'Plan diff with symbols + words + cost readout', 'Apply timeline on a tick rail with live logs']}
        calls={[{ method: 'deploy.providers' }, { method: 'deploy.options', params: { provider: 'hetzner' } }]}
        cli="beamhop deploy plan reviewer --provider hetzner --json"
      />
    </div>
  </Screen>
);
