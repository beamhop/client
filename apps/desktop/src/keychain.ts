/**
 * Keep the desktop app out of the macOS keychain unless asked. Chromium creates a "beamhop Safe Storage"
 * keychain item on launch to encrypt cookies; the app stores nothing there (the secret vault keeps its key
 * in a file by default, the keychain is an opt-in in Settings), but every rebuild with a new signature
 * makes macOS ask for the login password to read that item. The mock keychain avoids the item entirely.
 * `BEAMHOP_DESKTOP_KEYCHAIN=1` restores Chromium's default.
 */
export const DESKTOP_KEYCHAIN_ENV = 'BEAMHOP_DESKTOP_KEYCHAIN';

/** Chromium command-line switches to apply before the app is ready. */
export const keychainSwitches = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] =>
  platform === 'darwin' && env[DESKTOP_KEYCHAIN_ENV] !== '1' ? ['use-mock-keychain'] : [];
