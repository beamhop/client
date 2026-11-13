import { describe, expect, it } from 'vitest';
import { DESKTOP_KEYCHAIN_ENV, keychainSwitches } from '../src/keychain.ts';

describe('desktop keychain', () => {
  it('keeps Chromium out of the macOS keychain by default', () => {
    expect(keychainSwitches('darwin', {})).toEqual(['use-mock-keychain']);
  });
  it('uses the system keychain only when asked', () => {
    expect(keychainSwitches('darwin', { [DESKTOP_KEYCHAIN_ENV]: '1' })).toEqual([]);
  });
  it('changes nothing on other platforms', () => {
    expect(keychainSwitches('linux', {})).toEqual([]);
    expect(keychainSwitches('win32', {})).toEqual([]);
  });
});
