/**
 * beamhop desktop: the same web UI the daemon serves, in an app window, with the daemon bundled.
 *
 * Needs nothing installed: the daemon runs on this app's own Electron binary in Node mode
 * (ELECTRON_RUN_AS_NODE). If a daemon for the same home already runs (`beamhop daemon` from the CLI),
 * the app attaches to it instead and leaves it running on quit.
 *
 * Closing the window keeps beamhop in the menu bar (tray) so agents keep answering; "Quit beamhop"
 * (or Cmd+Q) stops the daemon the app started.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { createClient, httpTransport } from '@beamhop/client';
import { paths } from '@beamhop/core';
import {
  app,
  BrowserWindow,
  dialog,
  type IpcMainInvokeEvent,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  Notification,
  nativeImage,
  session,
  shell,
  Tray,
} from 'electron';
import { fileAutostart, HIDDEN_FLAG, isFileAutostartEnabled, setFileAutostart } from './autostart.ts';
import { type CliInstallContext, cliStatus, installCli, uninstallCli } from './cli-install.ts';
import { CHANNELS } from './ipc.ts';
import { KEYCHAIN_RELAUNCHED_ENV, keychainRelaunch } from './keychain.ts';
import { isAllowedPermission, isAppUrl, isSafeExternalUrl } from './links.ts';
import { mergeShellEnv, resolveShellEnv } from './shell-env.ts';
import { type DaemonState, DaemonSupervisor } from './supervisor.ts';

const isMac = process.platform === 'darwin';
const startHidden = process.argv.includes(HIDDEN_FLAG);

// No keychain item, so no password prompt after a rebuild (see keychain.ts). The switch must be on the
// real command line, so relaunch once with it, before the single-instance lock or any window.
const relaunchArgs = keychainRelaunch(process.platform, process.env, process.argv.slice(1), (s) =>
  app.commandLine.hasSwitch(s),
);
if (relaunchArgs) {
  process.env[KEYCHAIN_RELAUNCHED_ENV] = '1';
  app.relaunch({ args: relaunchArgs });
  app.exit(0);
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Only the check above needs it; keep it out of the daemon's and the harnesses' environment.
  delete process.env[KEYCHAIN_RELAUNCHED_ENV];
  void run();
}

async function run(): Promise<void> {
  const home = paths();
  const daemonUrl = process.env.BEAMHOP_URL ?? `http://127.0.0.1:${process.env.BEAMHOP_PORT ?? '7878'}`;
  // Packaged: <resources>/daemon. Development (`electron build/app`): build/daemon next to the app dir.
  const daemonDir = app.isPackaged
    ? join(process.resourcesPath, 'daemon')
    : (process.env.BEAMHOP_DESKTOP_DAEMON_DIR ?? join(app.getAppPath(), '..', 'daemon'));
  const assets = join(app.getAppPath(), 'assets');

  // Opened from Finder/the Dock, the app has none of the shell's PATH: harnesses installed via nvm,
  // Homebrew, npm… would be invisible (and Node-script ones could not find `node`).
  const shellEnv = await resolveShellEnv();
  if (!shellEnv && process.platform !== 'win32')
    console.warn('beamhop desktop: could not read the login shell environment; using the app PATH');
  const supervisor = new DaemonSupervisor({
    url: daemonUrl,
    command: process.execPath,
    args: [join(daemonDir, 'bin', 'beamhopd.js')],
    env: { ...mergeShellEnv(process.env, shellEnv), ELECTRON_RUN_AS_NODE: '1' },
    tokenFile: home.token,
    logFile: join(home.logs, 'desktop-daemon.log'),
    markerFile: join(home.home, 'desktop-daemon.json'),
    buildId: daemonBuildId(daemonDir),
  });

  let win: BrowserWindow | undefined;
  let tray: Tray | undefined;
  let quitting = false;

  // ── small persisted UI state (userData/state.json) ──
  const stateFile = join(app.getPath('userData'), 'state.json');
  type UiState = { closeNoticeShown?: boolean };
  const uiState = (): UiState => {
    try {
      return JSON.parse(readFileSync(stateFile, 'utf8'));
    } catch {
      return {};
    }
  };
  const saveUiState = (s: UiState) => {
    mkdirSync(app.getPath('userData'), { recursive: true });
    writeFileSync(stateFile, JSON.stringify(s));
  };

  // ── open at login ──
  const exe = app.getPath('exe');
  const fileAuto = fileAutostart(process.platform);
  const autostartEnabled = (): boolean =>
    fileAuto
      ? isFileAutostartEnabled(fileAuto, exe)
      : app.getLoginItemSettings({ args: [HIDDEN_FLAG] }).openAtLogin;
  const setAutostart = (on: boolean) => {
    if (fileAuto) setFileAutostart(fileAuto, exe, on);
    else app.setLoginItemSettings({ openAtLogin: on, args: [HIDDEN_FLAG] });
  };

  // ── `beamhop` command line (macOS/Linux; see cli-install.ts) ──
  const cliCtx: CliInstallContext = {
    platform: process.platform,
    home: homedir(),
    binDir: join(home.home, 'bin'),
    exe: process.execPath,
    entry: join(daemonDir, 'bin', 'beamhop.js'),
    shell: shellEnv?.SHELL ?? process.env.SHELL ?? safeShell(),
    shellPath: shellEnv?.PATH ?? process.env.PATH,
    appImage: process.env.APPIMAGE,
  };
  /** Only the app window, showing the daemon's UI, may call the bridge. */
  const fromAppWindow = (e: IpcMainInvokeEvent): boolean =>
    !!win &&
    !win.isDestroyed() &&
    e.sender === win.webContents &&
    isAppUrl(e.senderFrame?.url ?? '', daemonUrl);
  const handle = (channel: string, fn: () => unknown) =>
    ipcMain.handle(channel, async (e) => {
      if (!fromAppWindow(e)) throw new Error('not allowed');
      return fn();
    });
  // The `beamhop` command is opt-in (Settings → Advanced); nothing is installed unless asked.
  handle(CHANNELS.cliStatus, () => cliStatus(cliCtx));
  handle(CHANNELS.cliInstall, () => {
    if (!existsSync(cliCtx.entry)) throw new Error('this build has no bundled command line');
    return installCli(cliCtx);
  });
  handle(CHANNELS.cliUninstall, () => uninstallCli(cliCtx));
  handle(CHANNELS.daemonRestart, async () => {
    if (supervisor.state === 'running' || supervisor.state === 'external') {
      if (!supervisor.owned)
        throw new Error('beamhop was started outside the app; restart it where it was started');
      await supervisor.restart();
    } else await supervisor.ensure();
  });
  handle(CHANNELS.openLog, () => shell.openPath(join(home.logs, 'desktop-daemon.log')));

  // ── window ──
  const showDock = (on: boolean) => {
    if (!isMac || !app.dock) return;
    if (on) void app.dock.show();
    else app.dock.hide();
  };

  const showWindow = async () => {
    if (supervisor.state !== 'running' && supervisor.state !== 'external') {
      if (!(await startDaemon())) return;
    }
    if (win && !win.isDestroyed()) {
      showDock(true);
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      return;
    }
    win = createWindow();
    showDock(true);
  };

  const createWindow = (): BrowserWindow => {
    const w = new BrowserWindow({
      width: 1280,
      height: 840,
      minWidth: 380,
      minHeight: 520,
      show: false,
      title: 'beamhop',
      backgroundColor: '#f8f5f1',
      ...(isMac ? {} : { icon: join(assets, 'icon.png') }),
      webPreferences: {
        preload: join(app.getAppPath(), 'preload.js'),
        additionalArguments: [`--beamhop-version=${app.getVersion()}`],
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webviewTag: false,
        spellcheck: true,
      },
    });
    w.once('ready-to-show', () => w.show());

    // Daemon pages stay in the window; anything else opens in the system browser.
    w.webContents.setWindowOpenHandler(({ url }) => {
      if (isSafeExternalUrl(url) && !isAppUrl(url, daemonUrl)) void shell.openExternal(url);
      else if (isAppUrl(url, daemonUrl)) void w.loadURL(url);
      return { action: 'deny' };
    });
    w.webContents.on('will-navigate', (e, url) => {
      if (isAppUrl(url, daemonUrl)) return;
      e.preventDefault();
      if (isSafeExternalUrl(url)) void shell.openExternal(url);
    });

    w.on('close', (e) => {
      if (quitting) return;
      // Keep running in the menu bar / tray: agents keep answering while the window is closed.
      e.preventDefault();
      w.hide();
      showDock(false);
      const s = uiState();
      if (!s.closeNoticeShown && Notification.isSupported()) {
        new Notification({
          title: 'beamhop is still running',
          body: `Your agents keep working. Open beamhop from the ${isMac ? 'menu bar' : 'tray'}, or quit it there.`,
        }).show();
        saveUiState({ ...s, closeNoticeShown: true });
      }
    });

    try {
      void w.loadURL(supervisor.uiUrl());
    } catch (e) {
      void dialog.showMessageBox({ type: 'error', message: 'Could not open beamhop', detail: String(e) });
    }
    return w;
  };

  // ── daemon ──
  const startDaemon = async (): Promise<boolean> => {
    for (;;) {
      try {
        await supervisor.ensure();
        return true;
      } catch {
        const { response } = await dialog.showMessageBox({
          type: 'error',
          message: 'beamhop could not start',
          detail: supervisor.lastError ?? 'Unknown error',
          buttons: ['Try again', 'Open log', 'Quit'],
          defaultId: 0,
          cancelId: 2,
        });
        if (response === 1) void shell.openPath(join(home.logs, 'desktop-daemon.log'));
        if (response === 2) {
          quitting = true;
          app.quit();
          return false;
        }
        if (response === 1) return false;
      }
    }
  };

  // Paused by Stop everything (from here, the CLI or a phone): the tray offers Resume instead.
  let paused = false;
  const api = () => createClient(httpTransport(daemonUrl, supervisor.token()));
  const refreshPaused = async () => {
    try {
      const was = paused;
      paused = (await api().call('system.status')).panic;
      if (was !== paused) refreshTray();
    } catch {
      /* daemon not reachable yet */
    }
  };
  const resume = async () => {
    try {
      await api().call('system.resume');
      paused = false;
      refreshTray();
    } catch (e) {
      void dialog.showMessageBox({ type: 'error', message: 'Resume failed', detail: String(e) });
    }
  };

  const stopEverything = async () => {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      message: 'Stop everything?',
      detail:
        'Kills every agent session, pauses schedules and disconnects channels. Resume later from the app or the menu bar.',
      buttons: ['Stop everything', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    });
    if (response !== 0) return;
    try {
      await api().call('system.panic', { reason: 'desktop app: Stop everything' });
      paused = true;
      refreshTray();
    } catch (e) {
      void dialog.showMessageBox({ type: 'error', message: 'Stop everything failed', detail: String(e) });
    }
  };

  // ── tray / menu bar ──
  const statusLabel = (s: DaemonState): string =>
    ({
      idle: 'Starting…',
      starting: 'Starting…',
      running: `Running · ${new URL(daemonUrl).host}`,
      external: `Running (started outside the app) · ${new URL(daemonUrl).host}`,
      stopping: 'Stopping…',
      stopped: 'Stopped',
      failed: 'Not running — see the log',
    })[s];

  const refreshTray = () => {
    if (!tray) return;
    const s = supervisor.state;
    const up = s === 'running' || s === 'external';
    const template: MenuItemConstructorOptions[] = [
      { label: `beamhop — ${statusLabel(s)}`, enabled: false },
      { type: 'separator' },
      { label: 'Open beamhop', click: () => void showWindow() },
      paused
        ? { label: 'Resume', enabled: up, click: () => void resume() }
        : { label: 'Stop everything…', enabled: up, click: () => void stopEverything() },
      { type: 'separator' },
      up
        ? {
            label: supervisor.owned ? 'Restart daemon' : 'Daemon is managed outside the app',
            enabled: supervisor.owned,
            click: () => void supervisor.restart().catch(() => void startDaemon()),
          }
        : { label: 'Start daemon', click: () => void startDaemon() },
      {
        label: 'Open at login',
        type: 'checkbox',
        checked: autostartEnabled(),
        click: (i) => setAutostart(i.checked),
      },
      { label: 'Show logs', click: () => void shell.openPath(home.logs) },
      { type: 'separator' },
      { label: 'Quit beamhop', click: () => app.quit() },
    ];
    tray.setContextMenu(Menu.buildFromTemplate(template));
    tray.setToolTip(`beamhop — ${statusLabel(s)}`);
  };

  const createTray = () => {
    const icon = nativeImage.createFromPath(join(assets, isMac ? 'trayTemplate.png' : 'tray.png'));
    if (isMac) icon.setTemplateImage(true);
    tray = new Tray(icon);
    // Windows/Linux: a left click opens the window (macOS shows the menu).
    if (!isMac) tray.on('click', () => void showWindow());
    refreshTray();
    // Stop everything may come from the CLI or a phone: check before the menu opens (and every minute).
    tray.on('mouse-enter', () => void refreshPaused());
    setInterval(() => void refreshPaused(), 60_000).unref();
  };

  // ── app menu (standard roles; DevTools only in development) ──
  const appMenu = (): Menu =>
    Menu.buildFromTemplate([
      ...(isMac ? [{ role: 'appMenu' as const }] : [{ role: 'fileMenu' as const }]),
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' as const }]),
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      { role: 'windowMenu' },
    ]);

  // ── lifecycle ──
  app.on('second-instance', () => void showWindow());
  app.on('activate', () => void showWindow()); // macOS dock click
  app.on('window-all-closed', () => {
    /* stay in the tray */
  });
  app.on('before-quit', (e) => {
    if (quitting) return;
    quitting = true;
    if (!supervisor.owned) return;
    e.preventDefault();
    void supervisor.stop().finally(() => app.quit());
  });

  supervisor.on('state', () => {
    refreshTray();
    void refreshPaused();
  });

  await app.whenReady();
  if (isMac && startHidden) showDock(false);
  Menu.setApplicationMenu(appMenu());

  // Web UI permissions: only the daemon origin, only what the UI uses.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) =>
    cb(isAllowedPermission(permission, wc.getURL(), daemonUrl)),
  );
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) =>
    isAllowedPermission(permission, origin, daemonUrl),
  );

  // The UI is the daemon's PWA. Its service worker would keep serving the screens cached by an earlier
  // build (it only offers a "Reload" toast), but here the UI and the daemon always update together:
  // drop its worker and caches so every launch shows this build's UI. Local storage (the session) stays.
  await session.defaultSession
    .clearStorageData({ origin: new URL(daemonUrl).origin, storages: ['serviceworkers', 'cachestorage'] })
    .catch((e: Error) => console.warn(`beamhop desktop: could not clear the UI cache: ${e.message}`));

  if (!existsSync(join(daemonDir, 'bin', 'beamhopd.js')))
    console.warn(`beamhop desktop: no bundled daemon at ${daemonDir}; can only attach to a running one`);

  createTray();
  if (!(await startDaemon())) return;
  if (!startHidden) await showWindow();
}

function safeShell(): string | undefined {
  try {
    return userInfo().shell ?? undefined;
  } catch {
    return undefined;
  }
}

/** Identifies the bundled daemon build (`BUILD_ID`, stamped by scripts/build.mjs): differs between builds. */
function daemonBuildId(daemonDir: string): string {
  try {
    return readFileSync(join(daemonDir, 'BUILD_ID'), 'utf8').trim();
  } catch {
    try {
      return createHash('sha256')
        .update(readFileSync(join(daemonDir, 'bin', 'beamhopd.js')))
        .digest('hex')
        .slice(0, 16);
    } catch {
      return '';
    }
  }
}
