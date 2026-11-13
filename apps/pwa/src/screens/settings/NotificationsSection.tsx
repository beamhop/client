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
import { useState } from 'react';
import { useApi, useCall, useMutationApi } from '../../api/index.ts';
import { enablePush } from '../../api/push.ts';
import { haptic } from '../../lib/haptics.ts';
import { Button } from '../../ui/Button.tsx';
import { Switch } from '../../ui/Choice.tsx';
import { NumberField } from '../../ui/Field.tsx';
import { StatusDot } from '../../ui/Status.tsx';
import { useToast } from '../../ui/Toast.tsx';
import { useAlertRules } from '../audit/alerts.ts';
import { requestPush, usePushEnv } from '../pair/push.tsx';
import { useThisDevice } from './DevicesSection.tsx';
import { Group } from './kit.tsx';

export const NotificationsSection = () => {
  const [env, refresh] = usePushEnv();
  const devices = useApi('device.list');
  const me = useThisDevice(devices.data?.devices);
  const call = useCall();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>();
  const toast = useToast();
  const alerts = useAlertRules();
  const a = alerts.rules;
  const set = (patch: AlertRulesPatch) =>
    void alerts.save(patch).catch((e: Error) => toast.show({ message: e.message, tone: 'error' }));
  // Categories for THIS device ("browser" is the PWA served by the local daemon). Unset = on.
  const deviceId = me?.id ?? 'browser';
  const prefsQ = useApi('device.pushPrefs', { id: deviceId });
  const prefsM = useMutationApi('device.pushPrefs', { invalidate: ['device.pushPrefs'] });
  const cat = (c: PushCategory) => prefsQ.data?.prefs[c] ?? true;
  const setCat = (c: PushCategory, v: boolean) =>
    prefsM
      .mutateAsync({ id: deviceId, prefs: { [c]: v } })
      .catch((e: Error) => toast.show({ message: e.message, tone: 'error' }));

  const on = env.permission === 'granted';
  const turnOn = async () => {
    setBusy(true);
    try {
      // Subscribe with the daemon's VAPID key (`device.pushKey`) and register it for this device.
      const r = await enablePush({ call }, deviceId);
      if (r === 'unsupported') await requestPush();
      refresh();
      if (r === 'subscribed') haptic('confirm');
    } catch (e) {
      toast.show({ message: (e as Error).message, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const test = () => {
    try {
      new Notification('beamhop · test', { body: 'Notifications work on this device.', tag: 'bh-test' });
      setNote('Sent. It should appear in a moment.');
    } catch {
      setNote('This browser only shows notifications from the installed app.');
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <Group title="This device" id="ntf-device">
        <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
          <div className="flex items-center gap-3">
            {on ? <Bell size={22} aria-hidden="true" /> : <BellSlash size={22} aria-hidden="true" />}
            <span className="min-w-0 flex-1 type-title-3 text-ink">{me?.name ?? 'This browser'}</span>
            <StatusDot
              state={on ? 'ready' : env.permission === 'denied' ? 'error' : 'stopped'}
              label={
                on
                  ? 'push on'
                  : env.permission === 'denied'
                    ? 'blocked'
                    : env.permission === 'unsupported'
                      ? 'unsupported'
                      : 'push off'
              }
            />
          </div>
          {env.needsInstall ? (
            <p className="type-body-sm text-ink-2">
              iPhone sends alerts only to the installed app (iOS 16.4+). Tap Share, then Add to Home Screen,
              and turn notifications on from there.
            </p>
          ) : env.permission === 'unsupported' ? (
            <p className="type-body-sm text-ink-2">
              This browser can't show notifications. Use the Nostr DM fallback below.
            </p>
          ) : env.permission === 'denied' ? (
            <p className="type-body-sm text-ink-2">
              Blocked for this site. Allow notifications in your browser's site settings, then come back.
            </p>
          ) : on ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" onPress={test}>
                Send a test notification
              </Button>
              {note && (
                <span role="status" className="type-body-sm text-ink-2">
                  {note}
                </span>
              )}
            </div>
          ) : (
            <>
              <p className="type-body-sm text-ink-2">
                Get approvals on this device? You'll be notified when an agent needs a decision, a budget runs
                out, or an agent stops. Nothing else.
              </p>
              <Button variant="primary" className="self-start" isPending={busy} onPress={() => void turnOn()}>
                Turn on notifications
              </Button>
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
            Approvals waiting
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
            Agent stopped unexpectedly
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
            minValue={1}
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
            Quiet hours
          </Switch>
          <Switch
            isSelected={a.nostrDm}
            onChange={(v) => set({ nostrDm: v })}
            description="The daemon also DMs owners over Nostr, so alerts arrive even where push isn't available."
          >
            Nostr DM fallback
          </Switch>
        </div>
      </Group>
    </div>
  );
};
