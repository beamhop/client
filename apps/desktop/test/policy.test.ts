import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeExecEnv } from '@beamhop/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  autostartDesktopEntry,
  fileAutostart,
  isFileAutostartEnabled,
  LAUNCH_AGENT_LABEL,
  launchAgentPlist,
  setFileAutostart,
} from '../src/autostart.ts';
import { isAllowedPermission, isAppUrl, isSafeExternalUrl } from '../src/links.ts';

const DAEMON = 'http://127.0.0.1:7878';

describe('window navigation policy', () => {
  it('keeps only the daemon origin in the app', () => {
    expect(isAppUrl('http://127.0.0.1:7878/agents/x', DAEMON)).toBe(true);
    expect(isAppUrl('http://127.0.0.1:7879/', DAEMON)).toBe(false);
    expect(isAppUrl('http://localhost:7878/', DAEMON)).toBe(false);
    expect(isAppUrl('https://127.0.0.1:7878/', DAEMON)).toBe(false);
    expect(isAppUrl('not a url', DAEMON)).toBe(false);
  });

  it('hands only web and mail links to the system', () => {
    expect(isSafeExternalUrl('https://github.com/beamhop/client')).toBe(true);
    expect(isSafeExternalUrl('mailto:someone@example.com')).toBe(true);
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeExternalUrl('smb://host/share')).toBe(false);
  });

  it('grants the UI only the permissions it uses, only on the daemon origin', () => {
    expect(isAllowedPermission('notifications', `${DAEMON}/inbox`, DAEMON)).toBe(true);
    expect(isAllowedPermission('media', `${DAEMON}/`, DAEMON)).toBe(true);
    expect(isAllowedPermission('geolocation', `${DAEMON}/`, DAEMON)).toBe(false);
    expect(isAllowedPermission('notifications', 'https://evil.example/', DAEMON)).toBe(false);
  });
});

describe('open at login', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'bh-autostart-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('macOS: a LaunchAgent that starts the app hidden, with the path XML-escaped', () => {
    const plist = launchAgentPlist('/Applications/a & b/beamhop.app/Contents/MacOS/beamhop');
    expect(plist).toContain(`<string>${LAUNCH_AGENT_LABEL}</string>`);
    expect(plist).toContain('<string>/Applications/a &amp; b/beamhop.app/Contents/MacOS/beamhop</string>');
    expect(plist).toContain('<string>--hidden</string>');
    expect(fileAutostart('darwin', home)?.file).toBe(
      join(home, 'Library/LaunchAgents/dev.beamhop.desktop.plist'),
    );
  });

  it('Linux: an XDG autostart entry with a quoted Exec line', () => {
    const entry = autostartDesktopEntry('/opt/beam hop/beamhop');
    expect(entry).toContain('Exec="/opt/beam hop/beamhop" --hidden');
    expect(autostartDesktopEntry('/tmp/$x"y')).toContain('Exec="/tmp/\\$x\\"y" --hidden');
  });

  it('Windows uses the login-item API instead of a file', () => {
    expect(fileAutostart('win32', home)).toBeUndefined();
  });

  it('enables, detects and disables; an entry for another executable does not count', () => {
    const a = fileAutostart('darwin', home)!;
    expect(isFileAutostartEnabled(a, '/A/beamhop')).toBe(false);
    setFileAutostart(a, '/A/beamhop', true);
    expect(isFileAutostartEnabled(a, '/A/beamhop')).toBe(true);
    expect(isFileAutostartEnabled(a, '/B/beamhop')).toBe(false);
    expect(readFileSync(a.file, 'utf8')).toContain('/A/beamhop');
    setFileAutostart(a, '/A/beamhop', false);
    expect(isFileAutostartEnabled(a, '/A/beamhop')).toBe(false);
    writeFileSync(a.file, 'garbage');
    expect(isFileAutostartEnabled(a, '/A/beamhop')).toBe(false);
  });
});

describe('nodeExecEnv', () => {
  it('asks Electron to run as Node only when running under Electron', () => {
    expect(nodeExecEnv({ ...process.versions, electron: '45.1.0' } as NodeJS.ProcessVersions)).toEqual({
      ELECTRON_RUN_AS_NODE: '1',
    });
    expect(
      nodeExecEnv({ ...process.versions, electron: undefined } as unknown as NodeJS.ProcessVersions),
    ).toEqual({});
  });
});
