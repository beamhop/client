/**
 * Settings → Devices (SCREENS §10, JOURNEYS §9 "Devices list"). This device first, then the others;
 * `inactive` after 90 days unseen; Remove = one confirm sheet naming the consequence (§7A Lost phone:
 * removal ≤ 3 taps, no key rotation); Pair a device → the computer-side pairing panel in a sheet.
 */
import type { DeviceView } from '@beamhop/core';
import { DeviceMobile, Laptop, Plus } from '@phosphor-icons/react';
import { useState } from 'react';
import { useApi, useBeamhop, useMutationApi } from '../../api/index.ts';
import { t } from '../../i18n/index.ts';
import { ago, shortDate } from '../../lib/format.ts';
import { useNow } from '../../lib/useNow.ts';
import { Button } from '../../ui/Button.tsx';
import { CliStrip } from '../../ui/CliStrip.tsx';
import { Badge, MetaLine } from '../../ui/Meta.tsx';
import { ConfirmDialog, Sheet } from '../../ui/Sheet.tsx';
import { Banner, EmptyState, ErrorState, Skeleton, useDelayedLoading } from '../../ui/States.tsx';
import { useToast } from '../../ui/Toast.tsx';
import { thisDeviceId } from '../pair/deviceKey.ts';
import { PairingPanel } from '../pair/PairingPanel.tsx';
import { Group, List, Row, RowMenu } from './kit.tsx';

const DAY = 86_400_000;
const isPhone = (name: string) => /iPhone|iPad|Pixel|Android|phone/i.test(name);

/** The device id this browser paired as; in the demo, the most recently seen device. */
export const useThisDevice = (devices: DeviceView[] | undefined) => {
  const { mock } = useBeamhop();
  const stored = thisDeviceId();
  if (!devices) return undefined;
  const hit = stored ? devices.find((d) => d.id === stored) : undefined;
  if (hit || !mock) return hit;
  return [...devices].sort((a, b) => (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? ''))[0];
};

export const inactiveDays = (d: DeviceView, now: number) =>
  d.lastSeenAt ? Math.floor((now - new Date(d.lastSeenAt).getTime()) / DAY) : 0;

const DeviceRow = ({
  d,
  me,
  now,
  onRemove,
}: {
  d: DeviceView;
  me: boolean;
  now: number;
  onRemove: (d: DeviceView) => void;
}) => {
  const idle = inactiveDays(d, now);
  const Icon = isPhone(d.name) ? DeviceMobile : Laptop;
  return (
    <Row
      leading={<Icon size={22} aria-hidden="true" />}
      title={d.name}
      aside={
        me ? (
          <Badge tone="outline">{t('settings.devices.thisDevice')}</Badge>
        ) : idle >= 90 ? (
          <Badge tone="caution">inactive {idle} d</Badge>
        ) : null
      }
      slug={
        <MetaLine
          items={[
            `paired ${shortDate(d.pairedAt)}`,
            d.lastSeenAt && (me ? 'now' : `last seen ${ago(d.lastSeenAt, now)}`),
            d.pushEnabled ? { value: 'push on', tone: 'go' } : t('settings.ntf.state.off'),
          ]}
        />
      }
      actions={
        <RowMenu
          label={t('settings.actionsFor', { name: d.name })}
          items={[
            {
              id: 'remove',
              label: t('settings.devices.removeMenu'),
              destructive: true,
              onAction: () => onRemove(d),
            },
          ]}
        />
      }
    />
  );
};

export const DevicesSection = () => {
  const now = useNow(30_000);
  const q = useApi('device.list');
  const remove = useMutationApi('device.remove');
  const toast = useToast();
  const [pairing, setPairing] = useState(false);
  const [target, setTarget] = useState<DeviceView>();
  const showSkeleton = useDelayedLoading(q.isPending);
  const me = useThisDevice(q.data?.devices);

  if (q.isError)
    return (
      <ErrorState
        title={t('settings.devices.couldnTLoadYour')}
        details={q.error}
        onRetry={() => void q.refetch()}
      >
        {q.error.message}
      </ErrorState>
    );
  if (q.isPending)
    return showSkeleton ? (
      <Skeleton variant="list" count={3} label={t('settings.devices.loadingDevices')} />
    ) : null;

  const devices = q.data.devices;
  const others = devices.filter((d) => d.id !== me?.id);
  const stale = others.filter((d) => inactiveDays(d, now) >= 90);

  return (
    <div className="flex flex-col gap-8">
      {devices.length === 0 ? (
        <EmptyState
          glyph={<DeviceMobile size={32} aria-hidden="true" />}
          title={t('settings.devices.noPairedDevicesYet')}
          cli="beamhop device pair"
          action={
            <Button
              variant="primary"
              icon={<Plus size={16} weight="bold" aria-hidden="true" />}
              onPress={() => setPairing(true)}
            >
              {t('settings.devices.pairADevice')}
            </Button>
          }
        >
          {t('settings.devices.pairYourPhoneTo')}
        </EmptyState>
      ) : (
        <>
          {stale.length > 0 && (
            <Banner tone="caution" className="rounded-md border-x px-4">
              {stale.length === 1
                ? `${stale[0]!.name} hasn't been seen for ${inactiveDays(stale[0]!, now)} days. Remove it if you don't use it anymore.`
                : `${stale.length} devices haven't been seen for over 90 days.`}
            </Banner>
          )}
          {me && (
            <Group title={t('settings.ntf.thisDevice')} id="dev-this">
              <List>
                <DeviceRow d={me} me now={now} onRemove={setTarget} />
              </List>
            </Group>
          )}
          <Group
            title={me ? t('settings.devices.otherDevices') : t('settings.section.devices')}
            id="dev-other"
            note={t('settings.devices.pairedDevicesCanApprove')}
          >
            {others.length ? (
              <List>
                {others.map((d) => (
                  <DeviceRow key={d.id} d={d} me={false} now={now} onRemove={setTarget} />
                ))}
              </List>
            ) : (
              <p className="type-body-sm text-ink-2">{t('settings.devices.onlyThisDeviceSo')}</p>
            )}
          </Group>
          <Button
            variant="secondary"
            className="self-start"
            icon={<Plus size={16} weight="bold" aria-hidden="true" />}
            onPress={() => setPairing(true)}
          >
            {t('settings.devices.pairADevice')}
          </Button>
        </>
      )}
      <CliStrip command="beamhop device pair" />

      <Sheet
        isOpen={pairing}
        onOpenChange={setPairing}
        title={t('settings.devices.pairADevice')}
        subtitle={t('settings.devices.qr4WordSafety')}
        isDismissable={false}
        className="expanded:max-w-[720px]"
      >
        {pairing && <PairingPanel compact onPaired={() => void q.refetch()} />}
      </Sheet>

      <ConfirmDialog
        isOpen={!!target}
        onOpenChange={(o) => !o && setTarget(undefined)}
        title={t('settings.devices.removeTitle', { name: target?.name ?? t('settings.devices.device') })}
        confirmLabel={t('settings.devices.removeName', {
          name: target?.name ?? t('settings.devices.device'),
        })}
        isPending={remove.isPending}
        onConfirm={async () => {
          if (!target) return;
          try {
            await remove.mutateAsync({ id: target.id });
            toast.show({ message: `Removed · ${target.name}`, tone: 'success' });
            setTarget(undefined);
          } catch (e) {
            toast.show({ message: `Couldn't remove ${target.name}: ${(e as Error).message}`, tone: 'error' });
          }
        }}
      >
        <p>{t('settings.devices.removeBody', { name: target?.name ?? '' })}</p>
        {target?.id === me?.id && (
          <p className="mt-2 text-caution-text">{t('settings.devices.thatSTheDevice')}</p>
        )}
        <p className="mt-2 type-body-sm">{t('settings.devices.itSRemovedFrom')}</p>
      </ConfirmDialog>
    </div>
  );
};
