/**
 * TODO(harnesses builder): Harnesses — SCREENS §6, JOURNEYS §1.02.
 * Owns: src/screens/harnesses/**. Route: /harnesses.
 * Build: catalog slug, rows (tile · name · version · lamp · hint), needs-login command + Check,
 * Install… sheet, REMOTE section per cloud daemon, `+ Add ACP agent`, Scan (pull-to-refresh).
 * Data: useApi('harness.list'), useMutationApi('harness.scan' | 'harness.add').
 */
import { harnessLamp, harnessMonogram, useApi } from '../../api/index.ts';
import { Screen } from '../../shell/Screen.tsx';
import { ScreenStub } from '../../shell/ScreenStub.tsx';
import { StubList } from '../../shell/StubList.tsx';
import { MetaLine } from '../../ui/Meta.tsx';

const WORD: Record<string, string> = { ready: 'ready', 'needs-login': 'login', 'not-installed': 'not installed', 'unsupported-version': 'unsupported', error: 'error' };

export const HarnessesScreen = () => {
  const q = useApi('harness.list');
  return (
    <Screen title="Harnesses" slug={<MetaLine items={['Catalog v2026.11.12', { value: 'signed ✓', tone: 'go' }]} />}>
      <StubList
        label="Harnesses"
        loading={q.isPending}
        items={(q.data?.harnesses ?? []).map((h) => ({
          id: h.id,
          href: '/harnesses',
          title: h.displayName,
          tile: harnessMonogram(h.id),
          slug: [h.version ?? '—', h.message ?? h.protocol],
          lamp: harnessLamp(h),
          lampLabel: WORD[h.status],
        }))}
      />
      <div className="mt-6">
        <ScreenStub spec="SCREENS §6" owner="src/screens/harnesses/" outline={['Row tap → detail: binary path, supported range, ACP capabilities', 'Install… sheet with package-manager commands', 'REMOTE · fly-ams-1 scans']} cli="beamhop harness scan" />
      </div>
    </Screen>
  );
};
