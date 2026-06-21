# `@beamhop/state`

React context and data hooks for Beamhop. Bridges `@beamhop/nostr` relay I/O to React component trees via a central store.

## Install

```ts
// package.json — consumed by workspace siblings automatically
"@beamhop/state": "workspace:*"
```

## API

### Provider

Mount once at the app root. Pass a `NostrClient` instance so tests can inject a fake.

```tsx
import { StoreProvider } from "@beamhop/state";
import { NostrClient } from "@beamhop/nostr";

const client = new NostrClient();

function App() {
  return (
    <StoreProvider client={client}>
      <Router />
    </StoreProvider>
  );
}
```

### Identity & session

```ts
import { useStore, useIdentity, useRelays } from "@beamhop/state";

function Profile() {
  const { identity, signIn, signOut } = useIdentity();
  // identity is null (logged out) or { kind: "local" | "nip07", pubkey }
}

function RelayList() {
  const { relays, addRelay, removeRelay } = useRelays();
}
```

### Feed hooks

```ts
import { useFeed, useProfile, useEngagement } from "@beamhop/state";

function Feed() {
  const { notes, loading, refresh } = useFeed({ kinds: [1], limit: 50 });
}

function UserCard({ pubkey }: { pubkey: string }) {
  const profile = useProfile(pubkey);
  return <span>{profile?.name ?? pubkey.slice(0, 8)}</span>;
}

function PostActions({ note }: { note: Note }) {
  const { reactions, reposts, zaps, reply } = useEngagement(note);
}
```

### Navigation

```ts
import { useNav, useStore } from "@beamhop/state";

function Sidebar() {
  const { currentView, navigate } = useNav();
  return <button onClick={() => navigate("home")}>Home</button>;
}
```

### Mute

```ts
import { useMuteList } from "@beamhop/state";

function MuteSettings() {
  const { settings, addRule, removeRule, updateFlags } = useMuteList();
}
```

## Testing

The package ships a `test/render.tsx` helper for testing components that depend on the store:

```tsx
// packages/state/src/__tests__/my.test.tsx
import { renderWithStore, screen } from "../../test/render.tsx";
import { MyComponent } from "../MyComponent.tsx";

test("shows the user profile", async () => {
  renderWithStore(<MyComponent pubkey="abc..." />, { identity: myIdentity });
  await screen.findByText("Alice");
});
```

```bash
bun test src
```
