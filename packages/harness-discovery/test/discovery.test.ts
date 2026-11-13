import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadCatalog } from '@beamhop/harness-catalog';
import { unsafePassthroughSandbox, writeFakeAcpAgent, writeFakeBin } from '@beamhop/harness-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  detectAuth,
  executableNames,
  expandPath,
  findExecutable,
  probeAcpCommand,
  scanHarnesses,
  searchDirs,
} from '../src/index.ts';

const FAKE_KEY = ['fake', 'key', 'x'.repeat(8)].join('-');
let root: string;
let bin: string;
let home: string;
let env: Record<string, string>;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'beamhop-disc-'));
  bin = path.join(root, 'bin');
  home = path.join(root, 'home');
  mkdirSync(bin);
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  writeFileSync(path.join(home, '.claude', '.credentials.json'), '{}');
  writeFakeBin(bin, 'claude', `console.log('2.1.0 (Claude Code)');`);
  writeFakeBin(bin, 'codex', `console.log('codex-cli 0.1.0');`);
  writeFakeBin(bin, 'gemini', `setTimeout(() => {}, 60000);`);
  writeFakeBin(bin, 'pi', `console.log('0.73.1');`);
  writeFakeAcpAgent(bin, 'opencode');
  writeFakeAcpAgent(bin, 'custom-agent');
  env = { PATH: bin, HOME: home, USERPROFILE: home, OPENROUTER_API_KEY: '' };
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('scanHarnesses', () => {
  it('finds fake binaries, versions and auth state', async () => {
    const res = await scanHarnesses({
      env: { ...env, OPENROUTER_API_KEY: FAKE_KEY },
      home,
      versionTimeoutMs: 1500,
      extraDirs: [],
    });
    const by = Object.fromEntries(res.map((r) => [r.id, r]));
    expect(by.claude).toMatchObject({ status: 'ready', version: '2.1.0', protocol: 'claude-sdk' });
    expect(by.claude!.path).toBe(path.join(bin, process.platform === 'win32' ? 'claude.cmd' : 'claude'));
    expect(by.codex).toMatchObject({ status: 'unsupported-version', version: '0.1.0' });
    expect(by.gemini!.status).toBe('error');
    expect(by.gemini!.message).toMatch(/timed out/);
    expect(by.opencode).toMatchObject({ status: 'ready', version: '1.2.3', protocol: 'acp' });
    expect(by.opencode!.message).toMatch(/OPENROUTER_API_KEY/);
    expect(by.pi).toMatchObject({ status: 'ready', version: '0.73.1' });
    expect(by.goose).toMatchObject({ status: 'not-installed' });
    expect(by.goose!.install?.brew).toBe('block-goose-cli');
  });

  it('reports needs-login when no credentials exist', async () => {
    const res = await scanHarnesses({ env, home, only: ['opencode', 'pi'], platform: process.platform });
    for (const r of res) expect(r.status).toBe('needs-login');
  });

  it('can omit missing harnesses and restrict ids', async () => {
    const res = await scanHarnesses({ env, home, includeMissing: false, only: ['goose', 'claude'] });
    expect(res.map((r) => r.id)).toEqual(['claude']);
  });

  it('probes ACP capabilities and custom ACP commands', async () => {
    const res = await scanHarnesses({
      env: { ...env, OPENROUTER_API_KEY: FAKE_KEY },
      home,
      only: ['opencode'],
      probeAcp: true,
      sandbox: unsafePassthroughSandbox(),
      extraAcp: [
        {
          id: 'mine',
          command: path.join(bin, process.platform === 'win32' ? 'custom-agent.cmd' : 'custom-agent'),
        },
      ],
    });
    expect(res[0]!.capabilities).toEqual({
      streaming: true,
      permissions: true,
      resume: true,
      mcp: true,
      images: true,
    });
    expect(res[1]).toMatchObject({ id: 'mine', status: 'ready', displayName: 'Fake ACP', version: '1.2.3' });
  });

  it('marks failing custom ACP commands as error', async () => {
    const res = await scanHarnesses({
      env,
      home,
      only: [],
      extraAcp: [{ id: 'bad', command: path.join(bin, 'does-not-exist') }],
    });
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ id: 'bad', status: 'error', protocol: 'acp' });
  });
});

describe('probeAcpCommand', () => {
  const agent = () => path.join(bin, process.platform === 'win32' ? 'custom-agent.cmd' : 'custom-agent');

  it('reads initialize result', async () => {
    const r = await probeAcpCommand(agent(), [], { env: { PATH: process.env.PATH ?? '' } });
    expect(r.ok).toBe(true);
    expect(r.protocolVersion).toBe(1);
    expect(r.agentInfo).toMatchObject({ name: 'fake-acp' });
  });

  it('times out on a silent agent', async () => {
    const r = await probeAcpCommand(agent(), [], {
      env: { PATH: process.env.PATH ?? '', FAKE_ACP_SILENT: '1' },
      timeoutMs: 500,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timed out/);
  });

  it('reports an agent that exits early', async () => {
    const quitter = writeFakeBin(bin, 'quitter', `console.error('boom: no config'); process.exit(2);`);
    const r = await probeAcpCommand(quitter, [], { env: { PATH: process.env.PATH ?? '' } });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/exited|closed/);
  });

  it('reports spawn failures', async () => {
    const r = await probeAcpCommand(path.join(bin, 'nope'), []);
    expect(r.ok).toBe(false);
  });

  it('rejects non-ACP output', async () => {
    const chatty = writeFakeBin(
      bin,
      'chatty',
      `process.stdout.write('hello world\\n'); setTimeout(() => {}, 5000);`,
    );
    const r = await probeAcpCommand(chatty, [], { timeoutMs: 600 });
    expect(r.ok).toBe(false);
  });
});

describe('paths', () => {
  it('expands tokens per platform', () => {
    const linux = { platform: 'linux' as const, env: {}, home: '/h' };
    expect(expandPath('~/.claude', linux)).toBe('/h/.claude');
    expect(expandPath('$XDG_DATA_HOME/opencode', linux)).toBe('/h/.local/share/opencode');
    expect(expandPath('$XDG_CONFIG_HOME/goose', { ...linux, env: { XDG_CONFIG_HOME: '/x' } })).toBe(
      '/x/goose',
    );
    expect(expandPath('%APPDATA%/npm', linux)).toBeUndefined();
    const win = { platform: 'win32' as const, env: { APPDATA: 'C:\\U\\AppData\\Roaming' }, home: 'C:\\U' };
    expect(expandPath('%APPDATA%/Block/goose', win)).toBe('C:\\U\\AppData\\Roaming\\Block\\goose');
  });

  it('applies PATHEXT on Windows only', () => {
    expect(executableNames('claude', { platform: 'linux', env: {}, home: '/' })).toEqual(['claude']);
    const w = executableNames('claude', { platform: 'win32', env: { PATHEXT: '.EXE;.CMD' }, home: 'C:\\' });
    expect(w).toEqual(['claude.exe', 'claude.cmd']);
    expect(
      executableNames('claude.cmd', { platform: 'win32', env: { PATHEXT: '.EXE;.CMD' }, home: 'C:\\' }),
    ).toEqual(['claude.cmd']);
  });

  it('builds de-duplicated search dirs', () => {
    const dirs = searchDirs({ platform: 'linux', env: { PATH: '/a:/b:/a', PNPM_HOME: '/p' }, home: '/h' }, [
      '~/.opencode/bin',
    ]);
    expect(dirs.slice(0, 2)).toEqual(['/a', '/b']);
    expect(dirs).toContain('/p');
    expect(dirs).toContain('/h/.bun/bin');
    expect(dirs).toContain('/h/.opencode/bin');
    expect(dirs.filter((d) => d === '/a')).toHaveLength(1);
    const wdirs = searchDirs({
      platform: 'win32',
      env: { Path: 'C:\\x', APPDATA: 'C:\\U\\R' },
      home: 'C:\\U',
    });
    expect(wdirs).toContain('C:\\U\\R\\npm');
  });

  it('ignores non-executable files', () => {
    if (process.platform === 'win32') return;
    writeFileSync(path.join(bin, 'plainfile'), 'x', { mode: 0o644 });
    const host = { platform: process.platform, env: {}, home };
    expect(findExecutable(['plainfile'], [bin], host)).toBeUndefined();
    expect(findExecutable(['missing', 'claude'], [bin], host)).toBe(path.join(bin, 'claude'));
  });
});

describe('detectAuth', () => {
  const cat = loadCatalog();
  const entry = (id: string) => cat.harnesses.find((h) => h.id === id)!;
  it('treats keychain platforms as unverified-ready', () => {
    expect(
      detectAuth(entry('cursor-agent'), { platform: 'linux', env: {}, home: '/nonexistent' }).status,
    ).toBe('ready');
    expect(detectAuth(entry('claude'), { platform: 'linux', env: {}, home: '/nonexistent' }).status).toBe(
      'needs-login',
    );
    expect(
      detectAuth(entry('claude'), { platform: 'darwin', env: {}, home: '/nonexistent' }).message,
    ).toMatch(/keychain/);
  });
  it('never echoes env values', () => {
    const r = detectAuth(entry('claude'), {
      platform: 'linux',
      env: { ANTHROPIC_API_KEY: FAKE_KEY },
      home: '/',
    });
    expect(JSON.stringify(r)).not.toContain(FAKE_KEY);
  });
});
