import { describe, test, expect } from 'bun:test';
import { isValidBlurhash, decodeBlurhash } from '../src/lib/blurhash.js';

// A valid 4x3-component BlurHash from the reference implementation.
const HASH = 'LEHV6nWB2yk8pyo0adR*.7kCMdnj';

describe('isValidBlurhash', () => {
  test('accepts a well-formed hash', () => {
    expect(isValidBlurhash(HASH)).toBe(true);
  });
  test('rejects empty, short, and length-mismatched hashes', () => {
    expect(isValidBlurhash('')).toBe(false);
    expect(isValidBlurhash('abc')).toBe(false);
    expect(isValidBlurhash(HASH.slice(0, -1))).toBe(false);
  });
});

describe('decodeBlurhash', () => {
  test('decodes to a correctly sized RGBA buffer', () => {
    const pixels = decodeBlurhash(HASH, 8, 6);
    expect(pixels).toBeInstanceOf(Uint8ClampedArray);
    expect(pixels.length).toBe(8 * 6 * 4);
  });
  test('produces opaque, in-range pixels', () => {
    const pixels = decodeBlurhash(HASH, 4, 4);
    for (let i = 0; i < pixels.length; i += 4) {
      expect(pixels[i]).toBeGreaterThanOrEqual(0);
      expect(pixels[i]).toBeLessThanOrEqual(255);
      expect(pixels[i + 3]).toBe(255); // alpha
    }
  });
  test('throws on an invalid hash', () => {
    expect(() => decodeBlurhash('!!', 4, 4)).toThrow();
  });
});
