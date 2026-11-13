/**
 * Settings → Notifications (SCREENS §10, JOURNEYS §9.5, §6 Alerts). Push for THIS device (purpose
 * pre-prompt, permission only inside the tap, test notification, denied/iOS explanations), which alerts
 * are sent, thresholds, quiet hours and the Nostr DM fallback.
 *
 * Which categories reach this device: `device.pushPrefs`. Thresholds, crash alerts, quiet hours and
 * the Nostr DM fallback are daemon-wide alert rules (`alerts.get` / `alerts.set`, the same rules as
 * Audit → Alert rules).
 */
import type { AlertRulesPatch, PushCategory } from '@beamhop/core';
import { Bell, BellSlash } from '@phosphor-icons/react';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { methodKey, useApi, useBeamhop, useConnection } from '../../api/index.ts';
import { t } from '../../i18n/index.ts';
import { haptic } from '../../lib/haptics.ts';
import { Button } from '../../ui/Button.tsx';
import { Switch } from '../../ui/Choice.tsx';
import { NumberField } from '../../ui/Field.tsx';
import { StatusDot } from '../../ui/Status.tsx';
import { useToast } from '../../ui/Toast.tsx';
import { useAlertRules } from '../audit/alerts.ts';
import { turnOnPush, usePushDeviceId, usePushEnv, usePushPrefs } from '../pair/push.tsx';
import { useThisDevice } from './DevicesSection.tsx';
import { Group } from './kit.tsx';

export const NotificationsSection = () => {
  const [env, refresh] = usePushEnv();
  const conn = useConnection();
  const { client } = useBeamhop();
  const devices = useApi('device.list');
  const me = useThisDevice(devices.data?.devices);
  // Paired device id (hosted), "browser" (local daemon), or the demo's device.
  const deviceId = usePushDeviceId();
  const prefs = usePushPrefs(deviceId);
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>();
  const alerts = useAlertRules();
  const a = alerts.rules;
  const set = (patch: AlertRulesPatch) =>
    void alerts.save(patch).catch((e: Error) => toast.show({ message: e.message, tone: 'error' }));
  // Categories for THIS device (`device.pushPrefs`); unset = on.
  const cat = (c: PushCategory) => prefs.isOn(c);
  const setCat = (c: PushCategory, v: boolean) =>
    prefs.set(c, v).catch(() => toast.show({ message: t('settings.ntf.prefFailed'), tone: 'error' }));

  // On = the browser allows it AND the daemon holds a subscription for this device.
  const on = env.permission === 'granted' && (me?.pushEnabled ?? true);
  const turnOn = async () => {
    if (!deviceId) return;
    setBusy(true);
    try {
      // device.pushKey → PushManager → device.pushSubscribe (a placeholder subscription in the demo).
      const r = await turnOnPush(client, deviceId, { demo: conn.kind === 'mock' });
      refresh();
      await qc.invalidateQueries({ queryKey: methodKey('device.list') });
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

      <Group title="Send me" id="ntf-rules" note="Which alerts reach this device.">
        <div className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface px-4">
          <Switch
            isSelected={cat('approvals')}
            onChange={(v) => void setCat('approvals', v)}
            description="Always on the lock screen, with Allow / Deny where the platform supports it."
          >
            {t('settings.ntf.approvals')}
          </Switch>
          <Switch
            isSelected={cat('budget')}
            onChange={(v) => void setCat('budget', v)}
            description="Once per agent per day."
          >
            Budget threshold
          </Switch>
          <Switch
            isSelected={cat('crash')}
            onChange={(v) => void setCat('crash', v)}
            description="Exit codes and the last log line."
          >
            {t('settings.ntf.crash')}
          </Switch>
          <Switch
            isSelected={cat('security')}
            onChange={(v) => void setCat('security', v)}
            description="Blocked hosts, DLP blocks, unknown senders."
          >
            Security spike
          </Switch>
          <Switch
            isSelected={cat('offline')}
            onChange={(v) => void setCat('offline', v)}
            description="A cloud agent stops sending heartbeats."
          >
            Cloud agent offline
          </Switch>
        </div>
      </Group>

      <Group
        title="Alert rules"
        id="ntf-thresholds"
        note="Kept by your computer and used for every device and owner."
      >
        <div className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface px-4">
          <NumberField
            label="Budget alert at"
            unit="% of the daily budget"
            // With step 5 the steps start at minValue: 5 keeps them on round numbers (70, not 71).
            minValue={5}
            maxValue={a.budgetAlert}
            step={5}
            value={a.budgetWarn}
            onChange={(v) => Number.isFinite(v) && v !== a.budgetWarn && set({ budgetWarn: Math.round(v) })}
            className="py-3"
          />
          <div className="grid grid-cols-2 gap-3 py-3">
            <NumberField
              label="Security spike: more than"
              unit="events"
              minValue={1}
              maxValue={10_000}
              value={a.spikeEvents}
              onChange={(v) =>
                Number.isFinite(v) && v !== a.spikeEvents && set({ spikeEvents: Math.round(v) })
              }
            />
            <NumberField
              label="Within"
              unit="min"
              minValue={1}
              maxValue={1440}
              value={a.spikeMinutes}
              onChange={(v) =>
                Number.isFinite(v) && v !== a.spikeMinutes && set({ spikeMinutes: Math.round(v) })
              }
            />
          </div>
          <Switch
            isSelected={a.crash}
            onChange={(v) => set({ crash: v })}
            description="Sent when an agent exits on its own."
          >
            Crash alerts
          </Switch>
          <Switch
            isSelected={a.quietHours}
            onChange={(v) => set({ quietHours: v })}
            description={`${a.quietStart}–${a.quietEnd} on your computer's clock. Security alerts still come through.`}
          >
            {t('settings.ntf.quiet')}
          </Switch>
          <Switch
            isSelected={a.nostrDm}
            onChange={(v) => set({ nostrDm: v })}
            description="The daemon also DMs owners over Nostr, so alerts arrive even where push isn't available."
          >
            {t('settings.ntf.dm')}
          </Switch>
        </div>
      </Group>
    </div>
  );
};
