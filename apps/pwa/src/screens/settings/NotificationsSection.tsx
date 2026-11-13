/**
 * Settings → Notifications (SCREENS §10, JOURNEYS §9.5, §6 Alerts). Push for THIS device (purpose
 * pre-prompt, permission only inside the tap, test notification, denied/iOS explanations), which alerts
 * are sent, thresholds, quiet hours and the Nostr DM fallback.
 *
 * TODO(core): alert rules are daemon config without an API yet; they are kept on this device
 * (useLocalPref) and the CLI equivalent is shown.
 */
import { Bell, BellSlash } from '@phosphor-icons/react';
import { useState } from 'react';
import { useApi, useCall } from '../../api/index.ts';
import { haptic } from '../../lib/haptics.ts';
import { Button } from '../../ui/Button.tsx';
import { Switch } from '../../ui/Choice.tsx';
import { CliStrip } from '../../ui/CliStrip.tsx';
import { NumberField } from '../../ui/Field.tsx';
import { StatusDot } from '../../ui/Status.tsx';
import { requestPush, usePushEnv } from '../pair/push.tsx';
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
  const devices = useApi('device.list');
  const me = useThisDevice(devices.data?.devices);
  const call = useCall();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>();
  const [a, set] = useLocalPref('bh.settings.alerts', ALERT_DEFAULTS);

  const on = env.permission === 'granted';
  const turnOn = async () => {
    setBusy(true);
    try {
      const r = await requestPush();
      refresh();
      if (r.permission === 'granted' && me)
        await call('device.pushSubscribe', { id: me.id, subscription: r.subscription });
      if (r.permission === 'granted') haptic('confirm');
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

      <Group title="Send me" id="ntf-rules" note="These apply to every device with notifications on.">
        <div className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface px-4">
          <Switch
            isSelected={a.approvals}
            onChange={(v) => set({ approvals: v })}
            description="Always on the lock screen, with Allow / Deny where the platform supports it."
          >
            Approvals waiting
          </Switch>
          <div className="flex flex-col gap-2 py-1">
            <Switch
              isSelected={a.budget}
              onChange={(v) => set({ budget: v })}
              description="Once per agent per day."
            >
              Budget threshold
            </Switch>
            {a.budget && (
              <NumberField
                label="Alert at"
                unit="% of the daily budget"
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
            isSelected={a.crash}
            onChange={(v) => set({ crash: v })}
            description="Exit codes and the last log line."
          >
            Agent stopped unexpectedly
          </Switch>
          <div className="flex flex-col gap-2 py-1">
            <Switch
              isSelected={a.security}
              onChange={(v) => set({ security: v })}
              description="Blocked hosts, DLP blocks, unknown senders."
            >
              Security spike
            </Switch>
            {a.security && (
              <NumberField
                label="When more than"
                unit="events per hour"
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
            description="22:00–07:00 local time. Approvals still come through, silently."
          >
            Quiet hours
          </Switch>
          <Switch
            isSelected={a.dmFallback}
            onChange={(v) => set({ dmFallback: v })}
            description="When push isn't available, the daemon DMs your owner npub over Nostr."
          >
            Nostr DM fallback
          </Switch>
        </div>
      </Group>
      <CliStrip command={`beamhop config set alerts.budgetPct ${a.budgetPct}`} />
    </div>
  );
};
