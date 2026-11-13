/**
 * Settings sections — SCREENS §10. Route: /settings/$section. Each section lives in its own file;
 * `appearance` (theme/contrast/motion/haptics, persisted in `bh.appearance`) is from the foundation.
 */
import { useParams } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { t } from '../../i18n/index.ts';
import { useAppearance } from '../../lib/appearance.ts';
import { Screen } from '../../shell/Screen.tsx';
import { buttonClass, LinkButton } from '../../ui/Button.tsx';
import { SegmentedControl, Switch } from '../../ui/Choice.tsx';
import { Perforation } from '../../ui/glyphs/index.tsx';
import { Readout } from '../../ui/Meta.tsx';
import { EmptyState } from '../../ui/States.tsx';

import { AboutSection } from './AboutSection.tsx';
import { StatusDot } from '../../ui/Status.tsx';
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
  about: AboutSection,
  stop: DangerSection,
};

/**
 * A live specimen of the current look: lamp, slug line, an agent sentence and the decision pair on
 * a perforated slip. Built from the real tokens, so theme, contrast and motion changes show at once.
 */
const AppearancePreview = ({ caption }: { caption: string }) => (
  <figure className="flex flex-col gap-2">
    <div aria-hidden="true" className="overflow-hidden rounded-lg border border-line bg-surface">
      <div className="flex items-center justify-between gap-3 px-4 pt-3">
        <span className="type-meta text-ink-2">{t('settings.preview.slug')}</span>
        <StatusDot state="live" />
      </div>
      <p className="px-4 pt-1.5 pb-3 type-body text-ink">{t('settings.preview.line')}</p>
      <Perforation />
      <div className="flex items-center justify-between gap-2 bg-sunken/60 px-4 py-2.5">
        <Readout size="md">{t('settings.preview.clock')}</Readout>
        <span className="flex gap-2">
          <span className={buttonClass('deny', 'sm', 'pointer-events-none h-9!')}>
            {t('settings.preview.deny')}
          </span>
          <span className={buttonClass('allow', 'sm', 'pointer-events-none h-9!')}>
            {t('settings.preview.allow')}
          </span>
        </span>
      </div>
    </div>
    <figcaption className="type-meta text-ink-2">{caption}</figcaption>
  </figure>
);

export const AppearanceSettings = () => {
  const [prefs, resolved, set] = useAppearance();
  const themeWord =
    resolved.theme === 'dark'
      ? t('settings.settingsSection.nightShift')
      : t('settings.settingsSection.paper');
  return (
    <div className="flex flex-col gap-6">
      <AppearancePreview
        caption={t('settings.preview.caption', {
          theme: themeWord,
          contrast: prefs.contrast === 'more' ? 'more' : 'system',
          motion: prefs.motion === 'reduced' ? 'reduced' : 'system',
        })}
      />
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
