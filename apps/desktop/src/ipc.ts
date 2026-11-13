/** IPC channels between the app window's preload and the main process (no arguments on any of them). */
export const CHANNELS = {
  cliStatus: 'beamhop:cli:status',
  cliInstall: 'beamhop:cli:install',
  cliUninstall: 'beamhop:cli:uninstall',
  daemonRestart: 'beamhop:daemon:restart',
  openLog: 'beamhop:daemon:open-log',
} as const;
