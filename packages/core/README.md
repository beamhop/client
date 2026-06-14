# @beamhop/core

Framework-agnostic Nostr domain logic — the engine behind the Verity client, with
no UI and no framework assumptions. It gives you a high-level `NostrClient` for
the common things (publish, read, react, follow, DM) and a set of small, pure,
fully-typed helpers for everything underneath.

- **One runtime dependency** — [`nostr-tools`](https://github.com/nbd-wtf/nostr-tools)
  for vetted secp256k1, bech32, NIP-44 and NIP-04 cryptography. Everything else is
  plain TypeScript.
- **ESM-only**, strict types (no `any`, no non-null assertions), immutable helpers.
- **Signer-based** — works the same with an in-memory key or a NIP-07 browser
  extension; the library never touches a private key it doesn't own.
- **Two layers** — reach for `NostrClient` for app logic; drop to `RelayPool` and
  the pure helpers when you need control.

### Supported NIPs

| NIP | What | Where |
| --- | --- | --- |
| 01 | Events, kind-0 metadata, filters | `parseProfile`, `fetchNotes` |
| 02 | Contact lists (follows) | `fetchContacts`, `follow`/`unfollow` |
| 04 | Legacy encrypted DMs (**read-only**, flagged less secure) | `openLegacyDm`, `fetch/subscribeLegacyDirectMessages` |
| 07 | Browser-extension signer | `Nip07Signer`, `detectNip07` |
| 09 | Event deletion | `deleteEvents` |
| 10 | Reply threading (`e`/`p` markers) | `reply`, `buildReplyTags` |
| 17 | Private DMs via sealed gift wraps | `sendDirectMessage`, `openGiftWrap` |
| 18 | Reposts | `repost`, `buildRepostTags` |
| 19 | bech32 entities (`npub`/`nsec`/`note`/`nevent`/`nprofile`) | `keys` module |
| 25 | Reactions (likes) | `like`, `isLike` |
| 27 | `nostr:` mentions | `publishNote`, `extractMentions` |
| 44 | Modern payload encryption | `Signer.nip44Encrypt/Decrypt` |
| 50 | Full-text search | `searchNotes`, `searchProfiles` |
| 51 | Bookmark lists | `bookmark`/`unbookmark` |

## Install

```sh
bun add @beamhop/core
# or: npm i @beamhop/core / pnpm add @beamhop/core
```

## Quick start

```ts
import { NostrClient, LocalSigner, generateKeyPair } from '@beamhop/core';

// 1. An identity + signer (in-memory key here; see "Signers" for NIP-07)
const signer = new LocalSigner(generateKeyPair());

// 2. A client wired to the default relay set
const client = new NostrClient({ signer });

// 3. Publish a note — `nostr:npub…` mentions are auto-tagged (NIP-27)
const { event } = await client.publishNote('hello nostr 👋');

// 4. Read notes back with a standard filter
const notes = await client.fetchNotes({ authors: [event.pubkey], limit: 20 });

// 5. Social actions
await client.like(event);
await client.repost(event);
await client.follow('npub1…');               // accepts npub or hex
await client.setProfile({ name: 'Maya', nip05: 'maya@aperture.co' });

// 6. Clean up sockets when done
client.destroy();
```

## Core concepts

**Signer** — abstracts *how* events are signed and payloads encrypted. Pass one to
`NostrClient`. Two implementations ship in the box: `LocalSigner` (in-memory key)
and `Nip07Signer` (delegates to a `window.nostr` browser extension). The client
never sees a raw secret key unless you hand it a `LocalSigner`.

**NostrClient → RelayPool** — `NostrClient` is the high-level API. It owns a
`RelayPool` (a typed wrapper over nostr-tools' `SimplePool`) which manages the
relay connections. Use the client for app features; use `client.pool` (or your own
`RelayPool`) for raw subscriptions and queries.

**Events & kinds** — every event is a `NostrEvent` (re-exported from nostr-tools).
The `Kind` map names the kinds this library understands:

```ts
import { Kind } from '@beamhop/core';
// Metadata 0 · Text 1 · Contacts 3 · LegacyDirectMessage 4 · Deletion 5
// Repost 6 · Reaction 7 · Seal 13 · DirectMessage 14 · GiftWrap 1059
// RelayList 10002 · BookmarkList 10003
```

---

## Identity & keys

```ts
import {
  generateKeyPair, publicKeyFromSecret,
  encodeNpub, encodeNsec, encodeNote, encodeNevent,
  keyPairFromNsec, pubkeyFromNpub, pubkeyFromBech32, eventIdFromBech32,
  normalizePubkey, secretKeyToHex, secretKeyFromHex,
} from '@beamhop/core';

const kp = generateKeyPair();             // { secretKey: Uint8Array, publicKey: hex }
const npub = encodeNpub(kp.publicKey);    // "npub1…"
const nsec = encodeNsec(kp.secretKey);    // "nsec1…"

// Restore from a saved nsec
const restored = keyPairFromNsec(nsec);

// Accept anything a user might paste and normalize to hex
normalizePubkey('npub1…');                // → hex (also accepts nprofile1… and raw hex)
pubkeyFromBech32('nprofile1…');           // → hex | null (never throws)

// Event identifiers
encodeNote(event.id);                     // "note1…"
encodeNevent(event.id, event.pubkey);     // "nevent1…" (optional author/relay hints)
eventIdFromBech32('nevent1…');            // → hex id | null (accepts note1/nevent/hex)
```

| Function | Purpose |
| --- | --- |
| `generateKeyPair()` | Fresh random `KeyPair`. |
| `publicKeyFromSecret(sk)` | Derive hex pubkey from secret bytes. |
| `encodeNpub` / `pubkeyFromNpub` | hex ⇄ `npub1…` (throws on bad input). |
| `encodeNsec` / `keyPairFromNsec` | secret ⇄ `nsec1…`. |
| `encodeNote` / `encodeNevent` | event id → `note1…` / `nevent1…`. |
| `eventIdFromBech32` | `note1`/`nevent`/hex → hex id, or `null`. |
| `pubkeyFromBech32` | `npub`/`nprofile` → hex, or `null` (safe). |
| `normalizePubkey` | npub/nprofile/hex → hex (throws if unparseable). |
| `secretKeyToHex` / `secretKeyFromHex` | secret bytes ⇄ hex. |

## Signers

```ts
import { LocalSigner, Nip07Signer, detectNip07, generateKeyPair } from '@beamhop/core';

// In-memory key
const local = new LocalSigner(generateKeyPair());

// Browser extension (Alby, nos2x, …). Returns undefined if none is installed.
const provider = detectNip07();
const signer = provider ? new Nip07Signer(provider) : local;
```

Every signer implements the `Signer` interface:

```ts
interface Signer {
  getPublicKey(): Promise<Pubkey>;
  signEvent(template: NostrEventTemplate): Promise<NostrEvent>;
  nip44Encrypt(peerPubkey: Pubkey, plaintext: string): Promise<string>;
  nip44Decrypt(peerPubkey: Pubkey, ciphertext: string): Promise<string>;
  legacyDecrypt(peerPubkey: Pubkey, ciphertext: string): Promise<string>; // NIP-04 (read)
}
```

Implement it yourself to back the client with a hardware signer, remote bunker
(NIP-46), etc. — everything in `NostrClient` flows through this interface.

## Publishing

Every publish returns `{ event, results }`, where `results` is a
`PromiseSettledResult` per relay so you can tell which relays accepted it.

```ts
await client.publishNote('gm', /* extraTags */ [['t', 'coffee']]);
await client.reply(parentEvent, 'well said');         // NIP-10 threading
await client.like(targetEvent);                       // NIP-25 "+"
await client.repost(targetEvent);                     // NIP-18
await client.deleteEvents([myEvent], 'oops');         // NIP-09 request
await client.setProfile({ name: 'Maya', about: 'building things', nip05: 'maya@x.co' });
await client.follow('npub1…');                        // updates kind-3 list
await client.unfollow('npub1…');
await client.bookmark(event.id);                      // NIP-51
await client.unbookmark(event.id);
```

> Deletion is a *request* (NIP-09): well-behaved relays and clients honor it, but
> propagation isn't guaranteed.

## Reading

```ts
const profile  = await client.fetchProfile('hex-pubkey');     // Profile | null
const contacts = await client.fetchContacts('hex-pubkey');    // ContactList
const marks    = await client.fetchBookmarks('hex-pubkey');   // BookmarkList

// Any NIP-01 filter; defaults to kind 1 if you omit `kinds`
const notes = await client.fetchNotes({ authors: ['hex'], limit: 50 });

// NIP-50 full-text search (routed to search-capable relays)
const posts  = await client.searchNotes('bitcoin', 30);
const people = await client.searchProfiles('maya', 20);
```

## Subscriptions

All subscriptions return a `{ close() }` handle — call it to stop and free sockets.

```ts
// Live feed of text notes + reposts from a set of authors
const feed = client.subscribeFeed(authorPubkeys, (event) => render(event), { limit: 80 });

// Replies / reactions / reposts referencing given note ids (for live counts)
const eng = client.subscribeEngagement([note.id], (event) => bump(event));

feed.close();
eng.close();
```

## Direct messages

Sending always uses the **secure** sealed gift-wrap scheme (NIP-17 over NIP-44).
The library can also **read** legacy (NIP-04) DMs from older clients — those come
back with `legacy: true` so you can flag them as less secure in your UI.

```ts
// Send (encrypted to the recipient; a copy is wrapped for yourself too)
const { rumorId } = await client.sendDirectMessage('bob-hex-pubkey', 'for your eyes only');

// History (secure + legacy), oldest first
const secure = await client.fetchDirectMessages();
const legacy = await client.fetchLegacyDirectMessages();

// Live
const a = client.subscribeDirectMessages((m) => console.log(m.from, m.content));
const b = client.subscribeLegacyDirectMessages((m) => {
  if (m.legacy) markLessSecure(m);
});
```

Each decrypted message is a `DirectMessage`:

```ts
interface DirectMessage {
  id: string; from: Pubkey; to: readonly Pubkey[];
  content: string; createdAt: number;
  wrapId: string;     // gift-wrap (or source) event id
  legacy: boolean;    // true = delivered over the older, less-secure scheme
}

// Find the other participant in a 1:1 thread:
import { conversationPeer } from '@beamhop/core';
const peer = conversationPeer(message, myPubkey);
```

## Low-level relay access

`RelayPool` is exposed for when you need raw control (custom kinds, multi-relay
queries, your own subscription lifecycle). `NostrClient` is built entirely on it.

```ts
import { RelayPool, DEFAULT_RELAYS, SEARCH_RELAYS } from '@beamhop/core';

const pool = new RelayPool(DEFAULT_RELAYS);

const events  = await pool.list([{ kinds: [1], limit: 10 }]);   // one-shot, stops at EOSE
const latest  = await pool.getLatest({ kinds: [0], authors: ['hex'] }); // newest or null
const results = await pool.collect({ kinds: [1], search: 'nostr' },     // keeps streaming
  { relays: SEARCH_RELAYS, waitMs: 4000, limit: 50 });

const sub = pool.subscribe([{ kinds: [1] }], { onEvent: (e) => {}, onEose: () => {} });
await pool.publish(signedEvent);   // → PromiseSettledResult<string>[] per relay

pool.setRelays(['wss://relay.example.com']);  // swap relay set (closes dropped sockets)
sub.close();
pool.destroy();
```

## Pure helpers (no network)

These are side-effect-free and trivial to unit test — useful for building events,
parsing replaceable events, and inspecting tags.

```ts
import {
  // events / tags
  now, firstTagValue, tagValues, dedupeTags,
  buildReplyTags, buildMentionTags, extractMentions,
  // profiles
  parseProfile, displayName, buildProfileContent,
  // contacts (kind 3)
  parseContacts, addFollow, removeFollow, isFollowing, buildContactTags,
  // bookmarks (kind 10003)
  parseBookmarks, addBookmark, removeBookmark, isBookmarked, buildBookmarkTags,
  // interactions
  buildReactionTags, reactionTargetId, buildRepostTags, repostTargetId,
  buildDeletionTags, isLike, emptyEngagement,
} from '@beamhop/core';

displayName(profile, 'anon');             // display_name → name → fallback
extractMentions('gm nostr:npub1…');       // → ['hex-pubkey']
reactionTargetId(reactionEvent);          // the note a like points at

// Immutable list edits (return new arrays; pair with follow/bookmark publishing)
const next = addFollow(contacts, 'hex');
```

## Building & signing events manually

Need a kind the client doesn't wrap? Compose tags with the helpers and sign
through the `Signer`:

```ts
import { now, dedupeTags, buildMentionTags } from '@beamhop/core';

const template = {
  kind: 1,
  created_at: now(),
  tags: dedupeTags([...buildMentionTags(content), ['t', 'intro']]),
  content,
};
const event = await signer.signEvent(template);
await client.pool.publish(event);
```

## API reference

**Client** — `NostrClient` · `ClientOptions` · `PublishResult`
&nbsp; methods: `publishNote` `reply` `like` `repost` `deleteEvents` `setProfile`
`follow` `unfollow` `bookmark` `unbookmark` `sendDirectMessage` · `fetchProfile`
`fetchContacts` `fetchBookmarks` `fetchNotes` `searchNotes` `searchProfiles` ·
`subscribeFeed` `subscribeEngagement` `subscribeDirectMessages`
`fetchDirectMessages` `subscribeLegacyDirectMessages` `fetchLegacyDirectMessages` ·
`pubkey` `setRelays` `destroy` · getters `pool` `signer` `relays`

**Relays** — `RelayPool` (`subscribe` `list` `collect` `getLatest` `publish`
`setRelays` `destroy`) · `DEFAULT_RELAYS` · `SEARCH_RELAYS` · `Subscription` ·
`SubscribeHandlers`

**Signers** — `Signer` · `LocalSigner` · `Nip07Signer` · `Nip07Provider` ·
`detectNip07`

**Keys & identifiers** — `KeyPair` · `generateKeyPair` `publicKeyFromSecret` ·
`encodeNpub` `pubkeyFromNpub` · `encodeNsec` `keyPairFromNsec` · `encodeNote`
`encodeNevent` `eventIdFromBech32` · `pubkeyFromBech32` `normalizePubkey` ·
`secretKeyToHex` `secretKeyFromHex`

**Events** — `Tag` · `now` `firstTagValue` `tagValues` `dedupeTags`
`buildReplyTags` `buildMentionTags` `extractMentions`

**Profiles** — `parseProfile` `displayName` `buildProfileContent`

**Contacts** — `ContactList` · `parseContacts` `addFollow` `removeFollow`
`isFollowing` `buildContactTags`

**Bookmarks** — `BookmarkList` · `parseBookmarks` `addBookmark` `removeBookmark`
`isBookmarked` `buildBookmarkTags`

**Interactions** — `EngagementCounts` · `LIKE_CONTENT` · `buildReactionTags`
`reactionTargetId` `buildRepostTags` `repostTargetId` `buildDeletionTags`
`isLike` `emptyEngagement`

**DMs** — `DirectMessage` · `SealedDirectMessage` · `sealDirectMessage`
`createGiftWrap` `openGiftWrap` `openLegacyDm` `conversationPeer`

**Types** — `NostrEvent` · `NostrEventTemplate` · `Pubkey` · `Profile` ·
`ProfileMetadata` · `Kind` · `KindValue`

## Testing

```sh
bun test                 # fast, offline unit tests (crypto round-trips, parsing)
bun run test:integration # *.itest.ts — talks to real public relays
```

## License

Part of the Verity monorepo.
