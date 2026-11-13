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
  Info,
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
import { inactiveDays, useThisDevice } from './DevicesSection.tsx';

export interface SettingsSectionMeta {
  id: string;
  title: string;
  slug: string;
  group: 'trust' | 'data' | 'app' | 'kill';
  icon: Icon;
}

export const SETTINGS_SECTIONS: SettingsSectionMeta[] = [
  {
    id: 'devices',
    title: t('settings.section.devices'),
    slug: t('settings.settings.pairedPhonesAndBrowsers'),
    group: 'trust',
    icon: DeviceMobile,
  },
  {
    id: 'identity',
    title: t('settings.section.identity'),
    slug: t('settings.settings.ownerKeyAgentKeys'),
    group: 'trust',
    icon: IdentificationBadge,
  },
  {
    id: 'owners',
    title: t('settings.section.owners'),
    slug: t('settings.settings.coOwnersQuorumLinked'),
    group: 'trust',
    icon: Crown,
  },
  {
    id: 'secrets',
    title: t('settings.section.secrets'),
    slug: t('settings.settings.apiKeysAndTokens'),
    group: 'trust',
    icon: Key,
  },
  {
    id: 'retention',
    title: t('settings.section.retention'),
    slug: t('settings.settings.transcripts30DAudit'),
    group: 'data',
    icon: ClockCounterClockwise,
  },
  {
    id: 'notifications',
    title: t('settings.section.notifications'),
    slug: t('settings.settings.pushAlertsNostrDm'),
    group: 'app',
    icon: Bell,
  },
  {
    id: 'updates',
    title: t('settings.section.updates'),
    slug: t('settings.settings.beamhopCatalogCloudDaemons'),
    group: 'app',
    icon: ArrowsClockwise,
  },
  {
    id: 'appearance',
    title: t('settings.section.appearance'),
    slug: t('settings.settings.themeContrastMotionHaptics'),
    group: 'app',
    icon: Palette,
  },
  {
    id: 'about',
    title: t('settings.section.about'),
    slug: t('settings.settings.aboutSlug'),
    group: 'app',
    icon: Info,
  },
  {
    id: 'stop',
    title: t('settings.section.stop'),
    slug: t('settings.settings.killSwitchAndHistory'),
    group: 'kill',
    icon: Stop,
  },
];

const THEME_WORD = { system: 'System', light: 'Paper', dark: 'Night shift' } as const;

/** Live, cheap status per section. Falls back to the static slug while loading. */
const useLiveSlugs = (): Record<string, { text: string; flag?: ReactNode }> => {
  const devices = useApi('device.list');
  const me = useThisDevice(devices.data?.devices);
  const identity = useApi('identity.get');
  const secrets = useApi('secret.list');
  const status = useApi('system.status');
  const whoami = useApi('system.whoami');
  const [prefs] = useAppearance();
  const { panic } = usePanicState();
  const now = Date.now();
  const out: Record<string, { text: string; flag?: ReactNode }> = {};
  if (devices.data) {
    const n = devices.data.devices.length;
    const stale = devices.data.devices.filter((d) => inactiveDays(d, now) >= 90).length;
    out.devices = {
      text: stale
        ? t('settings.live.devicesStale', { count: n, stale })
        : t('settings.live.devices', { count: n }),
      flag: stale ? <Badge tone="caution">{t('settings.live.inactive', { count: stale })}</Badge> : undefined,
    };
  }
  if (identity.data?.npub) {
    const unattested = identity.data.agents.filter((a) => a.attested === false).length;
    out.identity = {
      text: t(unattested ? 'settings.live.identityUnattested' : 'settings.live.identity', {
        npub: middleTruncate(identity.data.npub, 16),
        count: identity.data.agents.length,
        unattested,
      }),
    };
  }
  if (secrets.data) {
    out.secrets = {
      text: t('settings.live.secrets', {
        count: secrets.data.secrets.length,
        backend: secrets.data.backend.replace(/ \(.*\)/, ''),
      }),
    };
  }
  if (status.data) out.updates = { text: t('settings.live.updates', { version: status.data.version }) };
  if (whoami.data)
    out.about = { text: `${whoami.data.principal} · ${whoami.data.role} · via ${whoami.data.via}` };
  out.appearance = {
    text: t('settings.live.appearance', {
      theme: THEME_WORD[prefs.theme],
      contrast: prefs.contrast,
      motion: prefs.motion,
    }),
  };
  if (panic)
    out.stop = {
      text: t('settings.settings.everythingIsStopped'),
      flag: <Badge tone="stop">{t('settings.live.stopped')}</Badge>,
    };
  // Same rule as Settings → Notifications: on = the browser allows it AND the daemon has a subscription.
  if (typeof Notification !== 'undefined') {
    const on = Notification.permission === 'granted' && (me?.pushEnabled ?? true);
    out.notifications = { text: on ? t('settings.live.pushOn') : t('settings.live.pushOff') };
  }
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
              <section key={g} aria-labelledby={`set-${g}`}>
                <Eyebrow id={`set-${g}`}>{t(`settings.group.${g}`)}</Eyebrow>
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
