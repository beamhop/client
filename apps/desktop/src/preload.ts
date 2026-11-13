/**
 * Preload for the app window: exposes `window.beamhopDesktop` so the web UI knows it runs in the desktop
 * app and can reach the few things only the app can do (the `beamhop` command, restarting its daemon).
 *
 * Runs sandboxed with context isolation: only `contextBridge` and `ipcRenderer` are used, and every call
 * is a fixed channel with no arguments. The main process checks the sender is the app window.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS } from './ipc.ts';

const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

contextBridge.exposeInMainWorld('beamhopDesktop', {
  version: arg('beamhop-version') ?? '',
  platform: process.platform,
  cli: {
    status: () => ipcRenderer.invoke(CHANNELS.cliStatus),
    install: () => ipcRenderer.invoke(CHANNELS.cliInstall),
    uninstall: () => ipcRenderer.invoke(CHANNELS.cliUninstall),
  },
  daemon: {
    restart: () => ipcRenderer.invoke(CHANNELS.daemonRestart),
    openLog: () => ipcRenderer.invoke(CHANNELS.openLog),
  },
});
