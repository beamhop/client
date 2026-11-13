import { Screen } from '../shell/Screen.tsx';
import { LinkButton } from '../ui/Button.tsx';
import { EmptyState } from '../ui/States.tsx';

export const NotFound = () => (
  <Screen title="Not found" back={{ href: '/', label: 'Home' }}>
    <EmptyState title="Nothing at this address." action={<LinkButton href="/">Go to Home</LinkButton>}>
      The link may be from an older version of beamhop, or the item was removed.
    </EmptyState>
  </Screen>
);
