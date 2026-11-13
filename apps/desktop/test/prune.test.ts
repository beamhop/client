import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM build script without type declarations
import { pruneDaemonDeps, prunePlan } from '../scripts/prune.mjs';

const FILES = [
  '@microsoft/mxc-sdk/bin/x64/mxc.exe',
  '@microsoft/mxc-sdk/package.json',
  'node-pty/prebuilds/darwin-arm64/pty.node',
  'koffi/package.json',
  '@koromix/koffi-darwin-arm64/koffi.node',
  '@anthropic-ai/sandbox-runtime/vendor/seccomp/x64/apply-seccomp',
  '@anthropic-ai/sandbox-runtime/vendor/seccomp/arm64/apply-seccomp',
  '@anthropic-ai/sandbox-runtime/vendor/srt-win/x64/srt-win.exe',
  '@anthropic-ai/sandbox-runtime/vendor/srt-win/arm64/srt-win.exe',
  '@anthropic-ai/sandbox-runtime/vendor/java-proxy-agent/agent.jar',
  '@anthropic-ai/sandbox-runtime/dist/index.js',
  '@anthropic-ai/sandbox-runtime/dist/index.js.map',
  '@anthropic-ai/sandbox-runtime/dist/index.d.ts',
  '@napi-rs/keyring/index.js',
  '@napi-rs/keyring/index.d.ts',
];

let nm: string;
beforeEach(() => {
  nm = join(mkdtempSync(join(tmpdir(), 'bh-prune-')), 'node_modules');
  for (const f of FILES) {
    mkdirSync(dirname(join(nm, f)), { recursive: true });
    writeFileSync(join(nm, f), 'x'.repeat(100));
  }
});
afterEach(() => rmSync(dirname(nm), { recursive: true, force: true }));

const has = (f: string) => existsSync(join(nm, f));
const vendor = '@anthropic-ai/sandbox-runtime/vendor';

describe('pruneDaemonDeps', () => {
  it('macOS: drops the mxc backend, Linux/Windows helpers, maps and typings; keeps runtime code', () => {
    const freed = pruneDaemonDeps(nm, 'darwin', 'arm64');
    expect(freed).toBeGreaterThan(0);
    for (const gone of [
      '@microsoft/mxc-sdk',
      'node-pty',
      'koffi',
      '@koromix',
      `${vendor}/seccomp`,
      `${vendor}/srt-win`,
    ])
      expect(has(gone), gone).toBe(false);
    expect(has('@anthropic-ai/sandbox-runtime/dist/index.js.map')).toBe(false);
    expect(has('@napi-rs/keyring/index.d.ts')).toBe(false);
    expect(has('@anthropic-ai/sandbox-runtime/dist/index.js')).toBe(true);
    expect(has('@napi-rs/keyring/index.js')).toBe(true);
    expect(has(`${vendor}/java-proxy-agent/agent.jar`)).toBe(true);
  });

  it('Linux: keeps the seccomp helper for this arch only', () => {
    pruneDaemonDeps(nm, 'linux', 'arm64');
    expect(has(`${vendor}/seccomp/arm64/apply-seccomp`)).toBe(true);
    expect(has(`${vendor}/seccomp/x64`)).toBe(false);
    expect(has(`${vendor}/srt-win`)).toBe(false);
  });

  it('Windows: keeps srt-win for this arch only; mxc still goes (beamhop uses srt-win)', () => {
    pruneDaemonDeps(nm, 'win32', 'x64');
    expect(has(`${vendor}/srt-win/x64/srt-win.exe`)).toBe(true);
    expect(has(`${vendor}/srt-win/arm64`)).toBe(false);
    expect(has(`${vendor}/seccomp`)).toBe(false);
    expect(has('@microsoft/mxc-sdk')).toBe(false);
  });

  it('is idempotent', () => {
    pruneDaemonDeps(nm, 'darwin', 'arm64');
    expect(pruneDaemonDeps(nm, 'darwin', 'arm64')).toBe(0);
    expect(prunePlan(nm, 'darwin', 'arm64')).toEqual([]);
  });
});
