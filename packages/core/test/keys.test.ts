import { describe, test, expect } from 'bun:test';
import {
  generateKeyPair,
  encodeNpub,
  encodeNsec,
  encodeNote,
  encodeNevent,
  eventIdFromBech32,
  keyPairFromNsec,
  pubkeyFromNpub,
  normalizePubkey,
  publicKeyFromSecret,
  secretKeyToHex,
  secretKeyFromHex,
} from '../src/keys.js';

describe('keys', () => {
  test('generated keypair derives a 64-char hex pubkey', () => {
    const kp = generateKeyPair();
    expect(kp.secretKey).toBeInstanceOf(Uint8Array);
    expect(kp.secretKey.length).toBe(32);
    expect(kp.publicKey).toMatch(/^[0-9a-f]{64}$/);
  });

  test('nsec round-trips to the same keypair', () => {
    const kp = generateKeyPair();
    const nsec = encodeNsec(kp.secretKey);
    expect(nsec.startsWith('nsec1')).toBe(true);
    const restored = keyPairFromNsec(nsec);
    expect(restored.publicKey).toBe(kp.publicKey);
    expect(secretKeyToHex(restored.secretKey)).toBe(secretKeyToHex(kp.secretKey));
  });

  test('npub round-trips to the same pubkey', () => {
    const kp = generateKeyPair();
    const npub = encodeNpub(kp.publicKey);
    expect(npub.startsWith('npub1')).toBe(true);
    expect(pubkeyFromNpub(npub)).toBe(kp.publicKey);
  });

  test('publicKeyFromSecret matches generation', () => {
    const kp = generateKeyPair();
    expect(publicKeyFromSecret(kp.secretKey)).toBe(kp.publicKey);
  });

  test('normalizePubkey accepts hex and npub', () => {
    const kp = generateKeyPair();
    expect(normalizePubkey(kp.publicKey)).toBe(kp.publicKey);
    expect(normalizePubkey(kp.publicKey.toUpperCase())).toBe(kp.publicKey);
    expect(normalizePubkey(encodeNpub(kp.publicKey))).toBe(kp.publicKey);
  });

  test('normalizePubkey rejects garbage', () => {
    expect(() => normalizePubkey('not-a-key')).toThrow();
  });

  test('keyPairFromNsec rejects an npub', () => {
    const kp = generateKeyPair();
    expect(() => keyPairFromNsec(encodeNpub(kp.publicKey))).toThrow();
  });

  test('secret key hex round-trips', () => {
    const kp = generateKeyPair();
    const hex = secretKeyToHex(kp.secretKey);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    expect(secretKeyToHex(secretKeyFromHex(hex))).toBe(hex);
  });

  test('secretKeyFromHex validates length', () => {
    expect(() => secretKeyFromHex('abc')).toThrow();
  });

  const EVENT = 'a'.repeat(64);

  test('nevent round-trips to the same event id', () => {
    const nevent = encodeNevent(EVENT);
    expect(nevent.startsWith('nevent1')).toBe(true);
    expect(eventIdFromBech32(nevent)).toBe(EVENT);
  });

  test('nevent carries an optional author hint and still resolves the id', () => {
    const kp = generateKeyPair();
    const nevent = encodeNevent(EVENT, kp.publicKey, ['wss://relay.example.com']);
    expect(eventIdFromBech32(nevent)).toBe(EVENT);
  });

  test('eventIdFromBech32 accepts note1, raw hex, and rejects garbage', () => {
    expect(eventIdFromBech32(encodeNote(EVENT))).toBe(EVENT);
    expect(eventIdFromBech32(EVENT)).toBe(EVENT);
    expect(eventIdFromBech32(EVENT.toUpperCase())).toBe(EVENT);
    expect(eventIdFromBech32('not-an-id')).toBeNull();
    expect(eventIdFromBech32(encodeNpub(kpPub()))).toBeNull();
  });
});

function kpPub(): string {
  return generateKeyPair().publicKey;
}
