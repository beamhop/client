/**
 * TODO(channels builder): Add a channel — provider picker, SCREENS §5 "Add — provider picker".
 * Route: /channels/add → each row links to /channels/add/$provider/1.
 */
import { Screen } from '../../shell/Screen.tsx';
import { ScreenStub } from '../../shell/ScreenStub.tsx';

export const AddChannelScreen = () => (
  <Screen
    title="Add a channel"
    back={{ href: '/channels', label: 'Channels' }}
    pane="detail"
    maxWidth="form"
    crumbs={[{ label: 'Channels', href: '/channels' }, { label: 'Add' }]}
  >
    <ScreenStub
      spec="SCREENS §5 provider picker"
      owner="src/screens/channels/"
      outline={[
        'TG Telegram · Bot token · 2 min',
        'SL Slack · App from manifest · 4 min',
        'DC Discord · Developer Portal · 4 min',
        'NS Nostr group (NIP-29) · Plugin channel…',
      ]}
      calls={[{ method: 'channel.providers' }]}
      cli="beamhop channel add telegram"
    />
  </Screen>
);
