import { describe, expect, it } from 'vitest';
import {
  DESKTOP_KEYCHAIN_ENV,
  KEYCHAIN_RELAUNCHED_ENV,
  keychainRelaunch,
  keychainSwitches,
} from '../src/keychain.ts';

const none = () => false;

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

describe('keychain relaunch', () => {
  it('relaunches once with the switch, keeping the other arguments', () => {
    expect(keychainRelaunch('darwin', {}, ['--hidden'], none)).toEqual(['--hidden', '--use-mock-keychain']);
  });
  it('goes on when the switch is already on the command line', () => {
    expect(keychainRelaunch('darwin', {}, ['--use-mock-keychain'], (s) => s === 'use-mock-keychain')).toBe(
      undefined,
    );
  });
  it('never loops: a relaunched process goes on even without the switch', () => {
    expect(keychainRelaunch('darwin', { [KEYCHAIN_RELAUNCHED_ENV]: '1' }, [], none)).toBe(undefined);
  });
  it('does not relaunch when the system keychain is asked for, or off macOS', () => {
    expect(keychainRelaunch('darwin', { [DESKTOP_KEYCHAIN_ENV]: '1' }, [], none)).toBe(undefined);
    expect(keychainRelaunch('linux', {}, [], none)).toBe(undefined);
  });
});
