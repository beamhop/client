/**
 * TODO(channels builder): Channel detail — SCREENS §5 "Channel detail".
 * Route: /channels/$id. Status + transport + last event, memberships, owner pairings, Replace token,
 * Disconnect, Remove (ConfirmDialog). Nostr: relay list with latency + NIP-11 status, Add relay, Blossom.
 */
import { useParams } from '@tanstack/react-router';
import { Screen } from '../../shell/Screen.tsx';
import { ScreenStub } from '../../shell/ScreenStub.tsx';

export const ChannelDetailScreen = () => {
  const { id } = useParams({ strict: false }) as { id: string };
  return (
    <Screen title={id} back={{ href: '/channels', label: 'Channels' }} pane="detail" crumbs={[{ label: 'Channels', href: '/channels' }, { label: id }]}>
      <ScreenStub
        spec="SCREENS §5 Channel detail"
        owner="src/screens/channels/"
        outline={['Status, transport, last event time', 'Memberships: which agents, which chats', 'Owner pairings · Replace token · Disconnect · Remove channel']}
        calls={[{ method: 'channel.list' }, { method: 'agent.list' }]}
        cli={`beamhop channel show ${id}`}
      />
    </Screen>
  );
};
