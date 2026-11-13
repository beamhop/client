/**
 * The beamhop version: one number for the CLI, the daemon, the desktop app and the web UI (semver).
 * Every package.json in the repo carries it; `node scripts/version.mjs` bumps and checks them together.
 * Imported (not read from disk) so bundlers inline it.
 */
import pkg from '../package.json' with { type: 'json' };

export const VERSION: string = pkg.version;
