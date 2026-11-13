/**
 * Settings → Updates (SCREENS §10, §12 updates). beamhop version, harness catalog auto-update,
 * explicit-confirm app updates (`updates.get` / `updates.set`), cloud daemons' versions.
 */
import { deployMonogram, useApi, useMutationApi } from '../../api/index.ts';
import { t } from '../../i18n/index.ts';
import { Switch } from '../../ui/Choice.tsx';
import { CliStrip } from '../../ui/CliStrip.tsx';
import { LetterTile, MetaLine } from '../../ui/Meta.tsx';
import { Skeleton } from '../../ui/States.tsx';
import { StatusDot } from '../../ui/Status.tsx';
import { useToast } from '../../ui/Toast.tsx';
import { Group, List, Row } from './kit.tsx';

export const UpdatesSection = () => {
  const status = useApi('system.status');
  const deploys = useApi('deploy.list');
  const harnesses = useApi('harness.list');
  const updates = useApi('updates.get');
  const save = useMutationApi('updates.set');
  const toast = useToast();
  const u = updates.data;
  const set = (patch: { catalogAuto?: boolean; appPrompt?: boolean }) =>
    void save.mutateAsync(patch).catch((e: Error) => toast.show({ message: e.message, tone: 'error' }));
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

      <Group title="Automatic" id="upd-auto">
        {updates.isError ? (
          <p className="type-body-sm text-stop-text">
            Couldn't load update settings: {updates.error.message}
          </p>
        ) : !u ? (
          <Skeleton variant="list" count={2} />
        ) : (
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
        )}
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
