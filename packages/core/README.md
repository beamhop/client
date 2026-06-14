# @verity/core

Framework-agnostic Nostr domain logic powering the Verity client. Handles keys,
relays, event building/signing, profiles, contacts, posts, replies, mentions,
reactions, reposts, bookmarks, and NIP-17 encrypted direct messages.

It is pure TypeScript with a single runtime dependency
([`nostr-tools`](https://github.com/nbd-wtf/nostr-tools)) for vetted secp256k1,
bech32, and NIP-44 cryptography.

## Install

```sh
bun add @verity/core
```

## Quick start

```ts
import { NostrClient, LocalSigner, generateKeyPair } from '@verity/core';

// 1. An identity + signer (in-memory key, or a NIP-07 extension via Nip07Signer)
const signer = new LocalSigner(generateKeyPair());

// 2. A client wired to the default relay set
const client = new NostrClient({ signer });

// 3. Publish a note (mentions in `nostr:` form are auto-tagged, NIP-27)
const { event } = await client.publishNote('hello nostr 👋');

// 4. Read it back
const notes = await client.fetchNotes({ authors: [event.pubkey] });

// 5. Social actions
await client.like(event);
await client.repost(event);
await client.follow('npub… or hex pubkey');
await client.setProfile({ name: 'Maya', nip05: 'maya@aperture.co' });

client.destroy();
```

## Encrypted direct messages (NIP-17 / NIP-44)

```ts
import { NostrClient, LocalSigner, generateKeyPair } from '@verity/core';

const alice = new NostrClient({ signer: new LocalSigner(generateKeyPair()) });
const bobPk = '…bob hex pubkey…';

await alice.sendDirectMessage(bobPk, 'this is end-to-end encrypted');

// On Bob's client:
const inbox = await bob.fetchDirectMessages();          // one-shot
const sub = bob.subscribeDirectMessages((m) => {        // live
  console.log(m.from, m.content);
});
```

Gift wrapping is implemented through the `Signer` interface, so it works with
both in-memory keys and NIP-07 extensions.

## Live subscriptions

```ts
const sub = client.subscribeFeed(['…author pubkeys…'], (event) => {
  console.log('new feed event', event.id);
});
// later
sub.close();
```

## API surface

- **Keys** — `generateKeyPair`, `keyPairFromNsec`, `encodeNpub`, `encodeNsec`,
  `normalizePubkey`, `pubkeyFromBech32`, `encodeNote`
- **Signers** — `Signer`, `LocalSigner`, `Nip07Signer`, `detectNip07`
- **Client** — `NostrClient` (publish/read/subscribe)
- **Relays** — `RelayPool`, `DEFAULT_RELAYS`
- **Helpers** — `parseProfile`, `parseContacts`, `parseBookmarks`,
  `buildReplyTags`, `extractMentions`, `buildReactionTags`, `buildRepostTags`,
  `sealDirectMessage`, `openGiftWrap`

## Testing

```sh
bun test                 # fast, offline unit tests (crypto round-trips, parsing)
bun run test:integration # talks to real public relays
```
