/**
 * Settings → Updates (SCREENS §10, §12 updates). beamhop version, harness catalog auto-update,
 * explicit-confirm app updates, cloud daemons' versions.
 * TODO(core): `updates.catalogAuto` / `updates.appPrompt` have no API yet; kept on this device with the CLI shown.
 */
import { deployMonogram, useApi } from '../../api/index.ts';
import { t } from '../../i18n/index.ts';
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
            <StatusDot state="ready" label={t('settings.updates.upToDate')} />
          </div>
        ) : (
          <Skeleton variant="list" count={1} />
        )}
      </Group>

      <Group title={t('settings.updates.automatic')} id="upd-auto">
        <div className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface px-4">
          <Switch
            isSelected={u.catalogAuto}
            onChange={(v) => set({ catalogAuto: v })}
            description={t('settings.updates.catalogDesc', { count: harnesses.data?.harnesses.length ?? 0 })}
          >
            {t('settings.updates.updateTheCatalogAutomatically')}
          </Switch>
          <Switch
            isSelected={u.appPrompt}
            onChange={(v) => set({ appPrompt: v })}
            description="beamhop itself never updates without you. Off: just a dot on Settings."
          >
            {t('settings.updates.askMeWhenA')}
          </Switch>
        </div>
      </Group>

      <Group title={t('settings.updates.cloudDaemons')} id="upd-cloud">
        {clouds.length ? (
          <List>
            {clouds.map((d) => (
              <Row
                key={d.id}
                leading={<LetterTile code={deployMonogram(d.provider)} />}
                title={`${d.agent} @ ${d.provider} ${d.region ?? ''}`}
                slug={<MetaLine items={[`beamhopd ${status.data?.version ?? '…'}`, d.status]} />}
                aside={<StatusDot state="ready" label={t('settings.updates.sameVersion')} hideLabel />}
              />
            ))}
          </List>
        ) : (
          <p className="type-body-sm text-ink-2">{t('settings.updates.noCloudDaemonsThey')}</p>
        )}
      </Group>
      <CliStrip command="beamhop update --check" />
    </div>
  );
};
