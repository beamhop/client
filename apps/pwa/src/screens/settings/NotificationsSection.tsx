/**
 * Settings → Notifications (SCREENS §10, JOURNEYS §9.5, §6 Alerts). Push for THIS device (purpose
 * pre-prompt, permission only inside the tap, test notification, denied/iOS explanations), which alerts
 * are sent, thresholds, quiet hours and the Nostr DM fallback.
 *
 * Categories are the daemon's per-device push prefs (`device.pushPrefs`); thresholds, quiet hours and
 * the DM fallback are daemon config without an API yet, so they stay on this device (useLocalPref).
 */

import type { PushCategory } from '@beamhop/core';
import { Bell, BellSlash } from '@phosphor-icons/react';
import { useState } from 'react';
import { useApi, useBeamhop, useConnection } from '../../api/index.ts';
import { t } from '../../i18n/index.ts';
import { haptic } from '../../lib/haptics.ts';
import { Button } from '../../ui/Button.tsx';
import { Switch } from '../../ui/Choice.tsx';
import { CliStrip } from '../../ui/CliStrip.tsx';
import { NumberField } from '../../ui/Field.tsx';
import { StatusDot } from '../../ui/Status.tsx';
import { useToast } from '../../ui/Toast.tsx';
import { turnOnPush, usePushDeviceId, usePushEnv, usePushPrefs } from '../pair/push.tsx';
import { useThisDevice } from './DevicesSection.tsx';
import { Group, useLocalPref } from './kit.tsx';

export const ALERT_DEFAULTS = {
  approvals: true,
  budget: true,
  budgetPct: 80,
  crash: true,
  security: true,
  securityPerHour: 5,
  quiet: false,
  dmFallback: true,
};

export const NotificationsSection = () => {
  const [env, refresh] = usePushEnv();
  const conn = useConnection();
  const { client } = useBeamhop();
  const devices = useApi('device.list');
  const me = useThisDevice(devices.data?.devices);
  const deviceId = usePushDeviceId();
  const prefs = usePushPrefs(deviceId);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>();
  const [a, set] = useLocalPref('bh.settings.alerts', ALERT_DEFAULTS);

  // On = the browser allows it AND the daemon holds a subscription for this device.
  const on = env.permission === 'granted' && (me?.pushEnabled ?? true);
  const turnOn = async () => {
    if (!deviceId) return;
    setBusy(true);
    try {
      const r = await turnOnPush(client, deviceId, { demo: conn.kind === 'mock' });
      refresh();
      if (r === 'granted') {
        haptic('confirm');
        toast.show({ message: t('settings.ntf.onToast'), tone: 'success' });
      }
    } catch (err) {
      toast.show({
        message: t('settings.ntf.failed', { reason: String((err as Error).message ?? err) }),
        tone: 'error',
      });
    } finally {
      setBusy(false);
    }
  };
  const togglePref = (c: PushCategory, v: boolean) => {
    prefs.set(c, v).catch(() => toast.show({ message: t('settings.ntf.prefFailed'), tone: 'error' }));
  };
  const test = () => {
    try {
      new Notification(t('settings.ntf.testTitle'), { body: t('settings.ntf.testBody'), tag: 'bh-test' });
      setNote(t('settings.ntf.testSent'));
    } catch {
      setNote(t('settings.ntf.testInstalledOnly'));
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <Group title={t('settings.ntf.thisDevice')} id="ntf-device">
        <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
          <div className="flex items-center gap-3">
            {on ? <Bell size={22} aria-hidden="true" /> : <BellSlash size={22} aria-hidden="true" />}
            <span className="min-w-0 flex-1 type-title-3 text-ink">
              {me?.name ?? t('settings.ntf.thisBrowser')}
            </span>
            <StatusDot
              state={on ? 'ready' : env.permission === 'denied' ? 'error' : 'stopped'}
              label={
                on
                  ? t('settings.ntf.state.on')
                  : env.permission === 'denied'
                    ? t('settings.ntf.state.blocked')
                    : env.permission === 'unsupported'
                      ? t('settings.ntf.state.unsupported')
                      : t('settings.ntf.state.off')
              }
            />
          </div>
          {env.needsInstall ? (
            <p className="type-body-sm text-ink-2">{t('settings.ntf.needsInstall')}</p>
          ) : env.permission === 'unsupported' ? (
            <p className="type-body-sm text-ink-2">{t('settings.ntf.unsupported')}</p>
          ) : env.permission === 'denied' ? (
            <p className="type-body-sm text-ink-2">{t('settings.ntf.denied')}</p>
          ) : on ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" onPress={test}>
                {t('settings.ntf.test')}
              </Button>
              {note && (
                <span role="status" className="type-body-sm text-ink-2">
                  {note}
                </span>
              )}
            </div>
          ) : (
            <>
              <p className="type-body-sm text-ink-2">{t('settings.ntf.prePrompt')}</p>
              <Button
                variant="primary"
                className="self-start"
                isPending={busy}
                isDisabled={!deviceId}
                onPress={() => void turnOn()}
              >
                {t('settings.ntf.turnOn')}
              </Button>
              {!deviceId && <p className="type-meta text-ink-2">{t('settings.ntf.noDevice')}</p>}
            </>
          )}
        </div>
      </Group>

      <Group title={t('settings.ntf.sendMe')} id="ntf-rules" note={t('settings.ntf.sendMeNote')}>
        <div className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface px-4">
          <Switch
            isSelected={prefs.isOn('approvals')}
            onChange={(v) => togglePref('approvals', v)}
            description={t('settings.ntf.approvals.desc')}
          >
            {t('settings.ntf.approvals')}
          </Switch>
          <div className="flex flex-col gap-2 py-1">
            <Switch
              isSelected={prefs.isOn('budget')}
              onChange={(v) => togglePref('budget', v)}
              description={t('settings.ntf.budget.desc')}
            >
              {t('settings.ntf.budget')}
            </Switch>
            {prefs.isOn('budget') && (
              <NumberField
                label={t('settings.ntf.budget.at')}
                unit={t('settings.ntf.budget.unit')}
                minValue={10}
                maxValue={100}
                step={5}
                value={a.budgetPct}
                onChange={(v) => Number.isFinite(v) && set({ budgetPct: v })}
                className="pb-3"
              />
            )}
          </div>
          <Switch
            isSelected={prefs.isOn('crash')}
            onChange={(v) => togglePref('crash', v)}
            description={t('settings.ntf.crash.desc')}
          >
            {t('settings.ntf.crash')}
          </Switch>
          <Switch
            isSelected={prefs.isOn('offline')}
            onChange={(v) => togglePref('offline', v)}
            description={t('settings.ntf.offline.desc')}
          >
            {t('settings.ntf.offline')}
          </Switch>
          <div className="flex flex-col gap-2 py-1">
            <Switch
              isSelected={prefs.isOn('security')}
              onChange={(v) => togglePref('security', v)}
              description={t('settings.ntf.security.desc')}
            >
              {t('settings.ntf.security')}
            </Switch>
            {prefs.isOn('security') && (
              <NumberField
                label={t('settings.ntf.security.when')}
                unit={t('settings.ntf.security.unit')}
                minValue={1}
                maxValue={100}
                value={a.securityPerHour}
                onChange={(v) => Number.isFinite(v) && set({ securityPerHour: v })}
                className="pb-3"
              />
            )}
          </div>
          <Switch
            isSelected={a.quiet}
            onChange={(v) => set({ quiet: v })}
            description={t('settings.ntf.quiet.desc')}
          >
            {t('settings.ntf.quiet')}
          </Switch>
          <Switch
            isSelected={a.dmFallback}
            onChange={(v) => set({ dmFallback: v })}
            description={t('settings.ntf.dm.desc')}
          >
            {t('settings.ntf.dm')}
          </Switch>
        </div>
      </Group>
      <CliStrip command={`beamhop config set alerts.budgetPct ${a.budgetPct}`} />
    </div>
  );
};
