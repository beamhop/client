# `@beamhop/nostr`

Nostr protocol layer for Beamhop. Covers key management, relay I/O, event encoding/decoding, and NIP-04/NIP-44/NIP-51 helpers. No React. No DOM at runtime (DOM is only touched by `keys.ts` identity persistence via `localStorage`).

## Install

```ts
// package.json — consumed by workspace siblings automatically
"@beamhop/nostr": "workspace:*"
```

## API

### Key management

```ts
import { createLocalIdentity, importNsec, encodeNpub, persist, loadPersisted } from "@beamhop/nostr";
import type { Identity } from "@beamhop/nostr";

// Generate a fresh keypair
const identity = createLocalIdentity();

// Import from nsec string
const imported = importNsec("nsec1...");

// Encode the public key for display
encodeNpub(identity.pubkey); // "npub1..."

// Persist / restore across page loads (uses localStorage)
persist(identity);
const restored: Identity | null = loadPersisted();
```

### Event building

```ts
import { buildNote, buildReaction, buildRepost, buildLongForm } from "@beamhop/nostr";

const noteTemplate = buildNote("Hello Nostr!");
const reactionTemplate = buildReaction(targetEvent, "+");
const repostTemplate = buildRepost(targetEvent, ["wss://relay.example"]);
```

### Client (relay I/O)

```ts
import { NostrClient } from "@beamhop/nostr";

const client = new NostrClient();
await client.connect(["wss://relay.damus.io", "wss://nos.lol"]);

// One-shot query
const events = await client.list(relays, { kinds: [1], authors: [pubkey] });

// Publish (fan-out; resolves on first relay acceptance)
const event = await client.publish(relays, identity, buildNote("hi"));

// Live subscription
const unsub = client.subscribe(relays, { kinds: [1] }, (event) => {
  console.log(event.content);
});
unsub(); // stop
```

### DMs (NIP-04)

```ts
import { buildDm, encryptDm, decodeDm, decryptDm } from "@beamhop/nostr";

const draft = buildDm(recipientPubkey, "secret message");
const encrypted = await encryptDm(draft, identity);
await client.publish(relays, identity, encrypted);

// Receive side
const dm = decodeDm(event, myPubkey);
const plaintext = await decryptDm(dm, identity);
```

### NIP-44 encryption

```ts
import { encrypt, decrypt } from "@beamhop/nostr";

const ciphertext = await encrypt("hello", identity);
const plaintext = await decrypt(ciphertext, identity);
```

### NIP-51 mute / follow / bookmark lists

```ts
import { buildMuteList, parseMuteList, buildFollowSet, parseFollowSet } from "@beamhop/nostr";

const muteEvent = await buildMuteList(identity, muteSettings);
const restored = parseMuteList(muteEvent, identity);
```

### Relays

```ts
import { loadRelays, saveRelays, DEFAULT_RELAYS } from "@beamhop/nostr";
import type { RelayInfo } from "@beamhop/nostr";

const relays: RelayInfo[] = loadRelays(); // reads localStorage, falls back to defaults
saveRelays(relays);
```

## Testing

```bash
bun test src
```
