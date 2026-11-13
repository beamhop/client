/**
 * "Open at login". The app starts hidden (`--hidden`): it brings the daemon up and sits in the menu
 * bar / tray without opening a window.
 *
 *  - macOS: a per-user LaunchAgent (~/Library/LaunchAgents). Unlike Electron's login-item API it can
 *    pass `--hidden`, and the user can see and remove it in System Settings → Login Items.
 *  - Linux: an XDG autostart entry (~/.config/autostart).
 *  - Windows: the registry Run key, through Electron's `app.setLoginItemSettings` (see main.ts).
 *
 * File-based platforms are implemented here without Electron so they can be tested.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const HIDDEN_FLAG = '--hidden';
export const LAUNCH_AGENT_LABEL = 'dev.beamhop.desktop';

const xmlEscape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const launchAgentPlist = (exe: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(exe)}</string>
    <string>${HIDDEN_FLAG}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`;

/** Desktop Entry `Exec` quoting: double quotes, with `"`, `` ` ``, `$` and `\` escaped. */
const desktopExecQuote = (s: string): string => `"${s.replace(/(["`$\\])/g, '\\$1')}"`;

export const autostartDesktopEntry = (exe: string): string => `[Desktop Entry]
Type=Application
Name=beamhop
Comment=Start beamhop in the tray at login
Exec=${desktopExecQuote(exe)} ${HIDDEN_FLAG}
Terminal=false
X-GNOME-Autostart-enabled=true
`;

export interface FileAutostart {
  file: string;
  render(exe: string): string;
}

export const fileAutostart = (platform: NodeJS.Platform, home = homedir()): FileAutostart | undefined => {
  if (platform === 'darwin')
    return {
      file: join(home, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`),
      render: launchAgentPlist,
    };
  if (platform === 'linux') {
    const config = process.env.XDG_CONFIG_HOME || join(home, '.config');
    return { file: join(config, 'autostart', 'beamhop.desktop'), render: autostartDesktopEntry };
  }
  return undefined;
};

/** Enabled = the entry exists and still points at this executable (an old install's entry does not count). */
export const isFileAutostartEnabled = (a: FileAutostart, exe: string): boolean => {
  if (!existsSync(a.file)) return false;
  try {
    return readFileSync(a.file, 'utf8') === a.render(exe);
  } catch {
    return false;
  }
};

export const setFileAutostart = (a: FileAutostart, exe: string, enabled: boolean): void => {
  if (!enabled) {
    rmSync(a.file, { force: true });
    return;
  }
  mkdirSync(dirname(a.file), { recursive: true });
  writeFileSync(a.file, a.render(exe), { mode: 0o644 });
};
