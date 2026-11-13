/**
 * TODO(settings builder): Settings sections — SCREENS §10.
 * Route: /settings/$section. `appearance` is implemented by the foundation (theme/contrast/motion/haptics,
 * persisted in localStorage `bh.appearance`); everything else is a placeholder.
 */
import { useParams } from '@tanstack/react-router';
import { useAppearance } from '../../lib/appearance.ts';
import { Screen } from '../../shell/Screen.tsx';
import { ScreenStub } from '../../shell/ScreenStub.tsx';
import { SegmentedControl, Switch } from '../../ui/Choice.tsx';
import { SETTINGS_SECTIONS } from './SettingsScreen.tsx';

export const AppearanceSettings = () => {
  const [prefs, resolved, set] = useAppearance();
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <span className="type-label text-ink">Theme</span>
        <SegmentedControl
          label="Theme"
          value={prefs.theme}
          onChange={(theme) => set({ theme })}
          options={[
            { id: 'system', label: 'System' },
            { id: 'light', label: 'Paper' },
            { id: 'dark', label: 'Night shift' },
          ]}
        />
        <p className="type-meta text-ink-2">Showing {resolved.theme === 'dark' ? 'Night shift' : 'Paper'}.</p>
      </div>
      <div className="flex flex-col gap-2">
        <span className="type-label text-ink">Contrast</span>
        <SegmentedControl
          label="Contrast"
          value={prefs.contrast}
          onChange={(contrast) => set({ contrast })}
          options={[
            { id: 'system', label: 'System' },
            { id: 'more', label: 'More' },
          ]}
        />
      </div>
      <div className="flex flex-col gap-2">
        <span className="type-label text-ink">Motion</span>
        <SegmentedControl
          label="Motion"
          value={prefs.motion}
          onChange={(motion) => set({ motion })}
          options={[
            { id: 'system', label: 'System' },
            { id: 'reduced', label: 'Reduced' },
          ]}
        />
      </div>
      <Switch isSelected={prefs.haptics} onChange={(haptics) => set({ haptics })} description="Short vibrations when a swipe commits. Android and iPhone (Safari 18+) only.">
        Haptics
      </Switch>
      <p className="type-body-sm text-ink-2">Text size follows your system setting.</p>
    </div>
  );
};

export const SettingsSectionScreen = () => {
  const { section } = useParams({ strict: false }) as { section: string };
  const meta = SETTINGS_SECTIONS.find((s) => s.id === section);
  const title = meta?.title ?? section;
  return (
    <Screen title={title} back={{ href: '/settings', label: 'Settings' }} pane="detail" maxWidth="form" crumbs={[{ label: 'Settings', href: '/settings' }, { label: title }]}>
      {section === 'appearance' ? (
        <AppearanceSettings />
      ) : (
        <ScreenStub
          spec={`SCREENS §10 · ${title}`}
          owner="src/screens/settings/"
          outline={[meta?.slug ?? 'Section content']}
          calls={section === 'devices' ? [{ method: 'device.list' }] : section === 'identity' ? [{ method: 'identity.get' }, { method: 'role.list' }] : section === 'retention' ? [{ method: 'secret.list' }] : []}
        />
      )}
    </Screen>
  );
};
