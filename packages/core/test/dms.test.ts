import { describe, test, expect } from 'bun:test';
import { finalizeEvent } from 'nostr-tools/pure';
import * as nip04 from 'nostr-tools/nip04';
import { generateKeyPair } from '../src/keys.js';
import { LocalSigner } from '../src/signer.js';
import { now } from '../src/events.js';
import { sealDirectMessage, openGiftWrap, openLegacyDm, conversationPeer } from '../src/dms.js';
import { Kind } from '../src/types.js';

function legacyEvent(senderSk: Uint8Array, recipientPk: string, ciphertext: string) {
  return finalizeEvent(
    { kind: Kind.LegacyDirectMessage, created_at: now(), tags: [['p', recipientPk]], content: ciphertext },
    senderSk,
  );
}

describe('NIP-17 direct messages', () => {
  test('round-trips an encrypted message to the recipient', async () => {
    const alice = new LocalSigner(generateKeyPair());
    const bob = new LocalSigner(generateKeyPair());
    const bobPk = await bob.getPublicKey();

    const { wraps } = await sealDirectMessage(alice, [bobPk], 'hello bob, this is secret');
    // one wrap for bob, one for alice's own copy
    expect(wraps).toHaveLength(2);
    for (const wrap of wraps) {
      expect(wrap.kind).toBe(Kind.GiftWrap);
      // ciphertext must not leak plaintext
      expect(wrap.content).not.toContain('secret');
    }

    // Bob can open his wrap.
    const bobWrap = wraps.find((w) => w.tags.some((t) => t[0] === 'p' && t[1] === bobPk));
    expect(bobWrap).toBeDefined();
    const message = await openGiftWrap(bob, bobWrap!);
    expect(message).not.toBeNull();
    expect(message!.content).toBe('hello bob, this is secret');
    expect(message!.from).toBe(await alice.getPublicKey());
    expect(message!.to).toContain(bobPk);
  });

  test('sender keeps a readable copy of the message', async () => {
    const alice = new LocalSigner(generateKeyPair());
    const bob = new LocalSigner(generateKeyPair());
    const alicePk = await alice.getPublicKey();
    const bobPk = await bob.getPublicKey();

    const { wraps } = await sealDirectMessage(alice, [bobPk], 'self copy');
    const selfWrap = wraps.find((w) => w.tags.some((t) => t[0] === 'p' && t[1] === alicePk));
    expect(selfWrap).toBeDefined();
    const message = await openGiftWrap(alice, selfWrap!);
    expect(message!.content).toBe('self copy');
  });

  test('a third party cannot decrypt the wrap', async () => {
    const alice = new LocalSigner(generateKeyPair());
    const bob = new LocalSigner(generateKeyPair());
    const eve = new LocalSigner(generateKeyPair());
    const bobPk = await bob.getPublicKey();

    const { wraps } = await sealDirectMessage(alice, [bobPk], 'not for eve');
    const bobWrap = wraps.find((w) => w.tags.some((t) => t[0] === 'p' && t[1] === bobPk))!;
    const opened = await openGiftWrap(eve, bobWrap);
    expect(opened).toBeNull();
  });

  test('conversationPeer resolves the other participant', async () => {
    const alicePk = (await new LocalSigner(generateKeyPair()).getPublicKey());
    const bobPk = (await new LocalSigner(generateKeyPair()).getPublicKey());
    const incoming = { id: '1', from: alicePk, to: [bobPk], content: 'x', createdAt: 0, wrapId: 'w' };
    expect(conversationPeer(incoming, bobPk)).toBe(alicePk);
    const outgoing = { id: '2', from: bobPk, to: [alicePk], content: 'x', createdAt: 0, wrapId: 'w' };
    expect(conversationPeer(outgoing, bobPk)).toBe(alicePk);
  });

  test('subject is carried through the rumor tags path', async () => {
    const alice = new LocalSigner(generateKeyPair());
    const bob = new LocalSigner(generateKeyPair());
    const bobPk = await bob.getPublicKey();
    const { wraps } = await sealDirectMessage(alice, [bobPk], 'body', 'Greetings');
    const bobWrap = wraps.find((w) => w.tags.some((t) => t[0] === 'p' && t[1] === bobPk))!;
    const message = await openGiftWrap(bob, bobWrap);
    expect(message!.content).toBe('body');
  });

  test('gift-wrapped messages are not flagged legacy', async () => {
    const alice = new LocalSigner(generateKeyPair());
    const bob = new LocalSigner(generateKeyPair());
    const bobPk = await bob.getPublicKey();
    const { wraps } = await sealDirectMessage(alice, [bobPk], 'hi');
    const bobWrap = wraps.find((w) => w.tags.some((t) => t[0] === 'p' && t[1] === bobPk))!;
    const message = await openGiftWrap(bob, bobWrap);
    expect(message!.legacy).toBe(false);
  });
});

describe('legacy (less-secure) direct messages', () => {
  test('decrypts a received legacy DM and flags it as legacy', async () => {
    const alice = new LocalSigner(generateKeyPair());
    const bob = new LocalSigner(generateKeyPair());
    const alicePk = await alice.getPublicKey();
    const bobPk = await bob.getPublicKey();

    const ciphertext = await nip04.encrypt(alice.secretKey, bobPk, 'legacy hello');
    expect(ciphertext).not.toContain('legacy hello'); // ciphertext doesn't leak
    const event = legacyEvent(alice.secretKey, bobPk, ciphertext);

    const msg = await openLegacyDm(bob, event, bobPk);
    expect(msg).not.toBeNull();
    expect(msg!.content).toBe('legacy hello');
    expect(msg!.from).toBe(alicePk);
    expect(msg!.to).toContain(bobPk);
    expect(msg!.legacy).toBe(true);
  });

  test('a third party cannot decrypt a legacy DM', async () => {
    const alice = new LocalSigner(generateKeyPair());
    const bob = new LocalSigner(generateKeyPair());
    const eve = new LocalSigner(generateKeyPair());
    const bobPk = await bob.getPublicKey();
    const evePk = await eve.getPublicKey();

    const ciphertext = await nip04.encrypt(alice.secretKey, bobPk, 'not for eve');
    const event = legacyEvent(alice.secretKey, bobPk, ciphertext);
    expect(await openLegacyDm(eve, event, evePk)).toBeNull();
  });

  test('ignores non-kind-4 events', async () => {
    const bob = new LocalSigner(generateKeyPair());
    const bobPk = await bob.getPublicKey();
    const note = finalizeEvent({ kind: Kind.Text, created_at: now(), tags: [], content: 'hi' }, generateKeyPair().secretKey);
    expect(await openLegacyDm(bob, note, bobPk)).toBeNull();
  });
});
