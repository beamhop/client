/**
 * Settings — SCREENS §10, JOURNEYS §9 (devices). Section list on compact, sub-nav list pane + detail on
 * expanded. Each row carries a live slug (`3 devices · 1 inactive`, `8 names · OS keychain`), so the
 * list itself answers "is anything off?" before you open a section.
 *
 * Research used: Apple HIG Settings grouping (few groups, plain nouns, status on the row);
 * GitHub "Danger zone" separation for irreversible actions; DESIGN §10 state voices.
 */
import {
  ArrowsClockwise,
  Bell,
  CaretRight,
  ClockCounterClockwise,
  Crown,
  DeviceMobile,
  type Icon,
  IdentificationBadge,
  Key,
  Palette,
  Stop,
} from '@phosphor-icons/react';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useApi } from '../../api/index.ts';
import { t } from '../../i18n/index.ts';
import { useAppearance } from '../../lib/appearance.ts';
import { cx } from '../../lib/cx.ts';
import { middleTruncate } from '../../lib/format.ts';
import { usePanicState } from '../../shell/panic.tsx';
import { Screen, SplitView } from '../../shell/Screen.tsx';
import { useHasDetail } from '../../shell/ScreenStub.tsx';
import { Badge, Eyebrow } from '../../ui/Meta.tsx';
import { inactiveDays } from './DevicesSection.tsx';

export interface SettingsSectionMeta {
  id: string;
  title: string;
  slug: string;
  group: 'Trust' | 'Data' | 'This app' | 'Kill switch';
  icon: Icon;
}

export const SETTINGS_SECTIONS: SettingsSectionMeta[] = [
  {
    id: 'devices',
    title: 'Devices',
    slug: t('settings.settings.pairedPhonesAndBrowsers'),
    group: 'Trust',
    icon: DeviceMobile,
  },
  {
    id: 'identity',
    title: t('settings.section.identity'),
    slug: t('settings.settings.ownerKeyAgentKeys'),
    group: 'Trust',
    icon: IdentificationBadge,
  },
  {
    id: 'owners',
    title: t('settings.section.owners'),
    slug: t('settings.settings.coOwnersQuorumLinked'),
    group: 'Trust',
    icon: Crown,
  },
  {
    id: 'secrets',
    title: 'Secrets',
    slug: t('settings.settings.apiKeysAndTokens'),
    group: 'Trust',
    icon: Key,
  },
  {
    id: 'retention',
    title: t('settings.section.retention'),
    slug: t('settings.settings.transcripts30DAudit'),
    group: 'Data',
    icon: ClockCounterClockwise,
  },
  {
    id: 'notifications',
    title: 'Notifications',
    slug: t('settings.settings.pushAlertsNostrDm'),
    group: 'This app',
    icon: Bell,
  },
  {
    id: 'updates',
    title: 'Updates',
    slug: t('settings.settings.beamhopCatalogCloudDaemons'),
    group: 'This app',
    icon: ArrowsClockwise,
  },
  {
    id: 'appearance',
    title: 'Appearance',
    slug: t('settings.settings.themeContrastMotionHaptics'),
    group: 'This app',
    icon: Palette,
  },
  {
    id: 'stop',
    title: t('settings.section.stop'),
    slug: t('settings.settings.killSwitchAndHistory'),
    group: 'Kill switch',
    icon: Stop,
  },
];

const THEME_WORD = { system: 'System', light: 'Paper', dark: 'Night shift' } as const;

/** Live, cheap status per section. Falls back to the static slug while loading. */
const useLiveSlugs = (): Record<string, { text: string; flag?: ReactNode }> => {
  const devices = useApi('device.list');
  const identity = useApi('identity.get');
  const secrets = useApi('secret.list');
  const status = useApi('system.status');
  const [prefs] = useAppearance();
  const { panic } = usePanicState();
  const now = Date.now();
  const out: Record<string, { text: string; flag?: ReactNode }> = {};
  if (devices.data) {
    const n = devices.data.devices.length;
    const stale = devices.data.devices.filter((d) => inactiveDays(d, now) >= 90).length;
    out.devices = {
      text: `${n} ${n === 1 ? 'device' : 'devices'}${stale ? ` · ${stale} inactive` : ''}`,
      flag: stale ? <Badge tone="caution">{stale} inactive</Badge> : undefined,
    };
  }
  if (identity.data?.npub) {
    const unattested = identity.data.agents.filter((a) => a.attested === false).length;
    out.identity = {
      text: `${middleTruncate(identity.data.npub, 16)} · ${identity.data.agents.length} agents${unattested ? ` · ${unattested} not attested` : ''}`,
    };
  }
  if (secrets.data) {
    out.secrets = {
      text: `${secrets.data.secrets.length} names · ${secrets.data.backend.replace(/ \(.*\)/, '')}`,
    };
  }
  if (status.data) out.updates = { text: `beamhopd ${status.data.version} · up to date` };
  out.appearance = {
    text: `${THEME_WORD[prefs.theme]} · contrast ${prefs.contrast} · motion ${prefs.motion}`,
  };
  if (panic)
    out.stop = { text: t('settings.settings.everythingIsStopped'), flag: <Badge tone="stop">stopped</Badge> };
  if (typeof Notification !== 'undefined')
    out.notifications = {
      text: `push ${Notification.permission === 'granted' ? 'on' : 'off'} on this device`,
    };
  return out;
};

export const SettingsScreen = () => {
  const hasDetail = useHasDetail('/settings');
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const live = useLiveSlugs();
  const groups = [...new Set(SETTINGS_SECTIONS.map((s) => s.group))];
  return (
    <SplitView
      hasDetail={hasDetail}
      list={
        <Screen title={t('settings.settings.settings')} pane="list">
          <nav aria-label={t('settings.settings.settingsSections')} className="flex flex-col gap-4">
            {groups.map((g) => (
              <section key={g} aria-labelledby={`set-${g.replace(/\s/g, '')}`}>
                <Eyebrow id={`set-${g.replace(/\s/g, '')}`}>{g}</Eyebrow>
                <ul className="-mx-2 flex flex-col">
                  {SETTINGS_SECTIONS.filter((s) => s.group === g).map((s) => {
                    const href = `/settings/${s.id}`;
                    const active = pathname === href;
                    const Ico = s.icon;
                    return (
                      <li key={s.id}>
                        <Link
                          to={href}
                          aria-current={active ? 'page' : undefined}
                          className={cx(
                            'flex min-h-14 items-center gap-3 rounded-md px-2 py-2 outline-none focus-visible:outline-2 focus-visible:outline-focus',
                            active ? 'bg-flare-wash' : 'hover:bg-sunken',
                          )}
                        >
                          <Ico
                            size={22}
                            weight={active ? 'bold' : 'regular'}
                            aria-hidden="true"
                            className={s.id === 'stop' ? 'text-stop-text' : 'text-ink-2'}
                          />
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate type-title-3 text-ink">{s.title}</span>
                            <span className="truncate type-meta text-ink-2">
                              {live[s.id]?.text ?? s.slug}
                            </span>
                          </span>
                          {live[s.id]?.flag}
                          <CaretRight size={16} aria-hidden="true" className="shrink-0 text-ink-3" />
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </nav>
        </Screen>
      }
    >
      <Outlet />
    </SplitView>
  );
};
