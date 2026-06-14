import { describe, test, expect } from 'bun:test';
import { verifyEvent } from 'nostr-tools/pure';
import { generateKeyPair } from '../src/keys.js';
import { LocalSigner, Nip07Signer } from '../src/signer.js';
import type { Nip07Provider } from '../src/signer.js';
import { now } from '../src/events.js';

describe('LocalSigner', () => {
  test('signs verifiable events', async () => {
    const kp = generateKeyPair();
    const signer = new LocalSigner(kp);
    const event = await signer.signEvent({ kind: 1, created_at: now(), tags: [], content: 'hi' });
    expect(event.pubkey).toBe(kp.publicKey);
    expect(verifyEvent(event)).toBe(true);
  });

  test('nip44 encrypt/decrypt round-trips between two signers', async () => {
    const a = new LocalSigner(generateKeyPair());
    const b = new LocalSigner(generateKeyPair());
    const aPk = await a.getPublicKey();
    const bPk = await b.getPublicKey();
    const ciphertext = await a.nip44Encrypt(bPk, 'secret payload');
    expect(ciphertext).not.toContain('secret');
    expect(await b.nip44Decrypt(aPk, ciphertext)).toBe('secret payload');
  });
});

describe('Nip07Signer', () => {
  test('delegates to the provider', async () => {
    const kp = generateKeyPair();
    const local = new LocalSigner(kp);
    const provider: Nip07Provider = {
      getPublicKey: () => local.getPublicKey(),
      signEvent: (t) => local.signEvent(t),
      nip44: {
        encrypt: (pk, txt) => local.nip44Encrypt(pk, txt),
        decrypt: (pk, ct) => local.nip44Decrypt(pk, ct),
      },
    };
    const signer = new Nip07Signer(provider);
    expect(await signer.getPublicKey()).toBe(kp.publicKey);
    const event = await signer.signEvent({ kind: 1, created_at: now(), tags: [], content: 'x' });
    expect(verifyEvent(event)).toBe(true);
  });

  test('throws when provider lacks nip44 support', async () => {
    const kp = generateKeyPair();
    const local = new LocalSigner(kp);
    const provider: Nip07Provider = {
      getPublicKey: () => local.getPublicKey(),
      signEvent: (t) => local.signEvent(t),
    };
    const signer = new Nip07Signer(provider);
    expect(() => signer.nip44Encrypt('00'.repeat(32), 'x')).toThrow();
  });
});
