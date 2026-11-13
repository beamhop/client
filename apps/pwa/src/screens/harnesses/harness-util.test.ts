import { describe, expect, it } from 'vitest';
import {
  detectOs,
  idFromCommand,
  installOptions,
  loginCommand,
  splitCommand,
  supportedOses,
} from './harness-util.ts';

const copilot = { install: { npm: 'npm i -g @github/copilot', brew: 'brew install copilot-cli' } };

describe('harness helpers', () => {
  it('detects the OS from UA hints', () => {
    expect(detectOs({ userAgentData: { platform: 'Windows' } })).toBe('windows');
    expect(detectOs({ platform: 'MacIntel' })).toBe('mac');
    expect(detectOs({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' })).toBe('linux');
  });

  it('orders install commands per OS and drops managers without a command', () => {
    expect(installOptions(copilot, 'mac').map((o) => o.manager)).toEqual(['brew', 'npm']);
    expect(installOptions(copilot, 'linux').map((o) => o.manager)).toEqual(['npm', 'brew']);
    expect(installOptions(copilot, 'windows').map((o) => o.manager)).toEqual(['npm']);
    expect(supportedOses({ install: { winget: 'winget install x' } })).toEqual(['windows']);
    expect(supportedOses({})).toEqual([]);
  });

  it('extracts the login command', () => {
    expect(loginCommand({ command: 'codex', message: 'Run: codex login' })).toBe('codex login');
    expect(loginCommand({ command: 'gemini' })).toBe('gemini login');
  });

  it('splits command lines with quotes and derives ids', () => {
    expect(splitCommand('goose acp')).toEqual({ command: 'goose', args: ['acp'] });
    expect(splitCommand(`  "/opt/My Agent/bin/agent" --mode 'a b' ""`)).toEqual({
      command: '/opt/My Agent/bin/agent',
      args: ['--mode', 'a b', ''],
    });
    expect(splitCommand('')).toEqual({ command: '', args: [] });
    expect(idFromCommand('/opt/My Agent/bin/Kiro.CLI.exe')).toBe('kiro-cli');
  });
});
