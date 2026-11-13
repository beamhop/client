/**
 * TODO(settings builder): Settings — SCREENS §10, JOURNEYS §9 (devices).
 * Owns: src/screens/settings/**. Routes: /settings (section list) → /settings/$section.
 * Sections: devices · identity · notifications · retention · appearance (done, foundation) · updates ·
 * plugins · stop · about. Desktop: section sub-nav (list pane) + detail.
 */
import { Outlet } from '@tanstack/react-router';
import { Screen, SplitView } from '../../shell/Screen.tsx';
import { useHasDetail } from '../../shell/ScreenStub.tsx';
import { StubList } from '../../shell/StubList.tsx';

export const SETTINGS_SECTIONS = [
  { id: 'devices', title: 'Devices', slug: 'paired phones and browsers' },
  { id: 'identity', title: 'Identity & NIP-05', slug: 'owner key, co-owners, handles' },
  { id: 'notifications', title: 'Notifications', slug: 'push, quiet hours, Nostr DM fallback' },
  { id: 'retention', title: 'Retention & data', slug: 'transcripts 30 d · audit 1 y' },
  { id: 'appearance', title: 'Appearance', slug: 'theme, contrast, motion, haptics' },
  { id: 'updates', title: 'Updates', slug: 'beamhop, catalog, cloud daemons' },
  { id: 'plugins', title: 'Plugins', slug: 'third-party channels and harnesses' },
  { id: 'stop', title: 'Stop everything', slug: 'kill switch and history' },
  { id: 'about', title: 'About', slug: 'version, connection, licenses' },
];

export const SettingsScreen = () => {
  const hasDetail = useHasDetail('/settings');
  return (
    <SplitView
      hasDetail={hasDetail}
      list={
        <Screen title="Settings" pane="list">
          <StubList
            label="Settings sections"
            items={SETTINGS_SECTIONS.map((s) => ({
              href: `/settings/${s.id}`,
              title: s.title,
              slug: [s.slug],
            }))}
          />
        </Screen>
      }
    >
      <Outlet />
    </SplitView>
  );
};
