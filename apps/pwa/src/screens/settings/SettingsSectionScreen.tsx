/**
 * Settings sections — SCREENS §10. Route: /settings/$section. Each section lives in its own file;
 * `appearance` (theme/contrast/motion/haptics, persisted in `bh.appearance`) is from the foundation.
 */
import { useParams } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { t } from '../../i18n/index.ts';
import { useAppearance } from '../../lib/appearance.ts';
import { Screen } from '../../shell/Screen.tsx';
import { LinkButton } from '../../ui/Button.tsx';
import { SegmentedControl, Switch } from '../../ui/Choice.tsx';
import { EmptyState } from '../../ui/States.tsx';
import { DangerSection } from './DangerSection.tsx';
import { DevicesSection } from './DevicesSection.tsx';
import { IdentitySection } from './IdentitySection.tsx';
import { NotificationsSection } from './NotificationsSection.tsx';
import { OwnersSection } from './OwnersSection.tsx';
import { RetentionSection } from './RetentionSection.tsx';
import { SecretsSection } from './SecretsSection.tsx';
import { SETTINGS_SECTIONS } from './SettingsScreen.tsx';
import { UpdatesSection } from './UpdatesSection.tsx';

const BODY: Record<string, () => ReactNode> = {
  devices: DevicesSection,
  identity: IdentitySection,
  owners: OwnersSection,
  secrets: SecretsSection,
  retention: RetentionSection,
  notifications: NotificationsSection,
  updates: UpdatesSection,
  appearance: () => <AppearanceSettings />,
  stop: DangerSection,
};

export const AppearanceSettings = () => {
  const [prefs, resolved, set] = useAppearance();
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <span className="type-label text-ink">{t('settings.settingsSection.theme')}</span>
        <SegmentedControl
          label={t('settings.settingsSection.theme')}
          value={prefs.theme}
          onChange={(theme) => set({ theme })}
          options={[
            { id: 'system', label: 'System' },
            { id: 'light', label: 'Paper' },
            { id: 'dark', label: t('settings.settingsSection.nightShift') },
          ]}
        />
        <p className="type-meta text-ink-2">
          {t('settings.settingsSection.showing', {
            theme:
              resolved.theme === 'dark'
                ? t('settings.settingsSection.nightShift')
                : t('settings.settingsSection.paper'),
          })}
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <span className="type-label text-ink">{t('settings.settingsSection.contrast')}</span>
        <SegmentedControl
          label={t('settings.settingsSection.contrast')}
          value={prefs.contrast}
          onChange={(contrast) => set({ contrast })}
          options={[
            { id: 'system', label: 'System' },
            { id: 'more', label: 'More' },
          ]}
        />
      </div>
      <div className="flex flex-col gap-2">
        <span className="type-label text-ink">{t('settings.settingsSection.motion')}</span>
        <SegmentedControl
          label={t('settings.settingsSection.motion')}
          value={prefs.motion}
          onChange={(motion) => set({ motion })}
          options={[
            { id: 'system', label: 'System' },
            { id: 'reduced', label: 'Reduced' },
          ]}
        />
      </div>
      <Switch
        isSelected={prefs.haptics}
        onChange={(haptics) => set({ haptics })}
        description={t('settings.settingsSection.shortVibrationsWhenA')}
      >
        {t('settings.settingsSection.haptics')}
      </Switch>
      <p className="type-body-sm text-ink-2">{t('settings.settingsSection.textSizeFollowsYour')}</p>
    </div>
  );
};

export const SettingsSectionScreen = () => {
  const { section } = useParams({ strict: false }) as { section: string };
  const meta = SETTINGS_SECTIONS.find((s) => s.id === section);
  const title = meta?.title ?? 'Not found';
  const Body = BODY[section];
  return (
    <Screen
      title={title}
      back={{ href: '/settings', label: 'Settings' }}
      pane="detail"
      maxWidth="form"
      crumbs={[{ label: 'Settings', href: '/settings' }, { label: title }]}
    >
      {Body ? (
        <Body />
      ) : (
        <EmptyState
          title={t('settings.settingsSection.noSection', { section })}
          action={
            <LinkButton href="/settings" variant="secondary">
              {t('settings.settingsSection.allSettings')}
            </LinkButton>
          }
        >
          {t('settings.settingsSection.itMayHaveMoved')}
        </EmptyState>
      )}
    </Screen>
  );
};
