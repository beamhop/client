/**
 * Keep the desktop app out of the macOS keychain unless asked. Chromium creates a "beamhop Safe Storage"
 * keychain item on launch to encrypt cookies; the app stores nothing there (the secret vault keeps its key
 * in a file by default, the keychain is an opt-in in Settings), but every rebuild with a new signature
 * makes macOS ask for the login password to read that item. Chromium's mock keychain avoids the item.
 *
 * The switch only works on the real command line: Electron sets up the keychain before the app's code
 * runs, so `app.commandLine.appendSwitch` is too late. Without it, the app relaunches itself once with
 * the switch (`keychainRelaunch`), before it takes the single-instance lock or opens a window.
 * `BEAMHOP_DESKTOP_KEYCHAIN=1` restores Chromium's default.
 */
export const DESKTOP_KEYCHAIN_ENV = 'BEAMHOP_DESKTOP_KEYCHAIN';
/** Set on the relaunched process, so a switch that still does not show up can never loop. */
export const KEYCHAIN_RELAUNCHED_ENV = 'BEAMHOP_KEYCHAIN_RELAUNCHED';

/** Chromium switches (without `--`) that keep the app out of the keychain on this platform. */
export const keychainSwitches = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] =>
  platform === 'darwin' && env[DESKTOP_KEYCHAIN_ENV] !== '1' ? ['use-mock-keychain'] : [];

/**
 * The arguments to relaunch with when a needed switch is missing from the command line, or undefined to
 * go on. `argv` is the process's arguments after the executable (kept as they are, e.g. `--hidden`).
 */
export const keychainRelaunch = (
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  argv: string[],
  hasSwitch: (s: string) => boolean,
): string[] | undefined => {
  if (env[KEYCHAIN_RELAUNCHED_ENV] === '1') return undefined;
  const missing = keychainSwitches(platform, env).filter((s) => !hasSwitch(s));
  return missing.length ? [...argv, ...missing.map((s) => `--${s}`)] : undefined;
};
