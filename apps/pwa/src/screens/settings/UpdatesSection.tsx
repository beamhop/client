/**
 * Settings → Updates (SCREENS §10, §12 updates). beamhop version, harness catalog auto-update,
 * explicit-confirm app updates, cloud daemons' versions.
 * TODO(core): `updates.catalogAuto` / `updates.appPrompt` have no API yet; kept on this device with the CLI shown.
 */
import { deployMonogram, useApi } from '../../api/index.ts';
import { Switch } from '../../ui/Choice.tsx';
import { CliStrip } from '../../ui/CliStrip.tsx';
import { LetterTile, MetaLine } from '../../ui/Meta.tsx';
import { Skeleton } from '../../ui/States.tsx';
import { StatusDot } from '../../ui/Status.tsx';
import { Group, List, Row, useLocalPref } from './kit.tsx';

export const UpdatesSection = () => {
  const status = useApi('system.status');
  const deploys = useApi('deploy.list');
  const harnesses = useApi('harness.list');
  const [u, set] = useLocalPref('bh.settings.updates', { catalogAuto: true, appPrompt: true });
  const clouds = (deploys.data?.deployments ?? []).filter((d) => d.status !== 'destroyed');

  return (
    <div className="flex flex-col gap-8">
      <Group title="beamhop" id="upd-app">
        {status.data ? (
          <div className="flex items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="type-title-3 text-ink">beamhopd {status.data.version}</p>
              <MetaLine items={[status.data.home, `up ${Math.round(status.data.uptimeSec / 3600)} h`]} />
            </div>
            <StatusDot state="ready" label="up to date" />
          </div>
        ) : (
          <Skeleton variant="list" count={1} />
        )}
      </Group>

      <Group title="Automatic" id="upd-auto">
        <div className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface px-4">
          <Switch
            isSelected={u.catalogAuto}
            onChange={(v) => set({ catalogAuto: v })}
            description={`Harness and channel definitions (${harnesses.data?.harnesses.length ?? '…'} harnesses). Signed; never changes your config.`}
          >
            Update the catalog automatically
          </Switch>
          <Switch
            isSelected={u.appPrompt}
            onChange={(v) => set({ appPrompt: v })}
            description="beamhop itself never updates without you. Off: just a dot on Settings."
          >
            Ask me when a new version is out
          </Switch>
        </div>
      </Group>

      <Group title="Cloud daemons" id="upd-cloud">
        {clouds.length ? (
          <List>
            {clouds.map((d) => (
              <Row
                key={d.id}
                leading={<LetterTile code={deployMonogram(d.provider)} />}
                title={`${d.agent} @ ${d.provider} ${d.region ?? ''}`}
                slug={<MetaLine items={[`beamhopd ${status.data?.version ?? '…'}`, d.status]} />}
                aside={<StatusDot state="ready" label="same version" hideLabel />}
              />
            ))}
          </List>
        ) : (
          <p className="type-body-sm text-ink-2">No cloud daemons. They follow this computer's version.</p>
        )}
      </Group>
      <CliStrip command="beamhop update --check" />
    </div>
  );
};
