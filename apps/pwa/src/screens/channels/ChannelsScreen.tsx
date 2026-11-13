/**
 * TODO(channels builder): Channels list — SCREENS §5, JOURNEYS §4.
 * Owns: src/screens/channels/**. Routes: /channels (layout) → /channels/$id (ChannelDetailScreen),
 * /channels/add (AddChannelScreen), /channels/add/$provider/$step (ChannelWizardScreen).
 * Build: grouped rows (tile · name · lamp · slug), error rows with `Replace token ›`, `+ Add`, CLI strip.
 * Data: useApi('channel.list'); live via 'channel.updated' events (cache patched automatically).
 */
import { Plus } from '@phosphor-icons/react';
import { Outlet } from '@tanstack/react-router';
import { channelLamp, PROVIDER_NAMES, providerMonogram, useApi } from '../../api/index.ts';
import { Screen, SplitView } from '../../shell/Screen.tsx';
import { ScreenStub, useHasDetail } from '../../shell/ScreenStub.tsx';
import { StubList } from '../../shell/StubList.tsx';
import { LinkButton } from '../../ui/Button.tsx';

export const ChannelsScreen = () => {
  const hasDetail = useHasDetail('/channels');
  const q = useApi('channel.list');
  return (
    <SplitView
      hasDetail={hasDetail}
      list={
        <Screen title="Channels" pane="list" actions={<LinkButton href="/channels/add" variant="primary" size="sm" icon={<Plus size={16} weight="bold" aria-hidden="true" />}>Add</LinkButton>}>
          <StubList
            label="Channels"
            loading={q.isPending}
            items={(q.data?.channels ?? []).map((c) => ({
              href: `/channels/${c.config.name}`,
              title: c.self?.handle ?? `${PROVIDER_NAMES[c.config.provider] ?? c.config.provider}`,
              tile: providerMonogram(c.config.provider),
              slug: [c.config.name, c.error ?? PROVIDER_NAMES[c.config.provider] ?? c.config.provider],
              lamp: channelLamp(c),
            }))}
          />
          <div className="mt-6">
            <ScreenStub spec="SCREENS §5 · JOURNEYS §4" owner="src/screens/channels/" outline={['Channel rows with status + transport', 'Error rows: reason + Replace token', 'Add a channel → provider picker → 6-step wizard']} cli="beamhop channel list" />
          </div>
        </Screen>
      }
    >
      <Outlet />
    </SplitView>
  );
};
