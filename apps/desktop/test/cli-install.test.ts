import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type CliInstallContext,
  cliStatus,
  installCli,
  profileFile,
  SHIM_MARK,
  shimScript,
  stripBlock,
  uninstallCli,
} from '../src/cli-install.ts';

const posix = process.platform !== 'win32';

describe.skipIf(!posix)('cli-install', () => {
  let home: string;
  let ctx: CliInstallContext;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'bh-cli-'));
    ctx = {
      platform: 'darwin',
      home,
      binDir: join(home, '.beamhop', 'bin'),
      exe: "/Applications/beam'hop.app/Contents/MacOS/beamhop",
      entry: '/Applications/beamhop.app/Contents/Resources/daemon/bin/beamhop.js',
      shell: '/bin/zsh',
      shellPath: '/usr/bin:/bin',
    };
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('writes an executable launcher and a PATH block in the zsh profile', () => {
    const r = installCli(ctx);
    const shim = join(ctx.binDir, 'beamhop');
    expect(r.status).toEqual({ state: 'installed', path: shim, onPath: false });
    expect(r.profile).toBe(join(home, '.zprofile'));
    expect(readFileSync(shim, 'utf8')).toBe(shimScript(ctx.exe, ctx.entry));
    expect(readFileSync(join(home, '.zprofile'), 'utf8')).toContain('export PATH="$HOME/.beamhop/bin:$PATH"');

    // Idempotent: a second launch adds nothing.
    expect(installCli(ctx).profile).toBeUndefined();
    expect(readFileSync(join(home, '.zprofile'), 'utf8').match(/export PATH/g)).toHaveLength(1);
  });

  it('quotes paths so the launcher is valid shell', () => {
    expect(shimScript(ctx.exe, ctx.entry)).toContain(
      `exe='/Applications/beam'\\''hop.app/Contents/MacOS/beamhop'`,
    );
    expect(shimScript(ctx.exe, ctx.entry).split('\n')[1]).toBe(SHIM_MARK);
  });

  it('skips the profile when the directory is already on PATH', () => {
    const r = installCli({ ...ctx, shellPath: `${ctx.binDir}:/usr/bin` });
    expect(r.status).toMatchObject({ state: 'installed', onPath: true });
    expect(r.profile).toBeUndefined();
    expect(existsSync(join(home, '.zprofile'))).toBe(false);
  });

  it('leaves another beamhop on PATH alone', () => {
    const other = join(home, 'brew', 'bin');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'beamhop'), '#!/bin/sh\n');
    chmodSync(join(other, 'beamhop'), 0o755);
    const r = installCli({ ...ctx, shellPath: `${other}:/usr/bin` });
    expect(r.status).toEqual({ state: 'other', path: join(other, 'beamhop') });
    expect(existsSync(join(ctx.binDir, 'beamhop'))).toBe(false);
  });

  it('never overwrites a beamhop it did not write', () => {
    mkdirSync(ctx.binDir, { recursive: true });
    writeFileSync(join(ctx.binDir, 'beamhop'), '#!/bin/sh\necho mine\n');
    expect(installCli(ctx).status.state).toBe('other');
    expect(readFileSync(join(ctx.binDir, 'beamhop'), 'utf8')).toContain('echo mine');
  });

  it('uninstall removes the launcher and only our profile lines', () => {
    writeFileSync(join(home, '.zprofile'), 'eval "$(/opt/homebrew/bin/brew shellenv)"\n');
    installCli(ctx);
    uninstallCli(ctx);
    expect(existsSync(join(ctx.binDir, 'beamhop'))).toBe(false);
    expect(readFileSync(join(home, '.zprofile'), 'utf8')).toBe('eval "$(/opt/homebrew/bin/brew shellenv)"\n');
    expect(cliStatus(ctx).state).toBe('absent');
  });

  it('picks the profile per shell', () => {
    expect(profileFile({ ...ctx, shell: '/bin/bash' })).toBe(join(home, '.bash_profile'));
    expect(profileFile({ ...ctx, platform: 'linux', shell: '/usr/bin/bash' })).toBe(join(home, '.bashrc'));
    expect(profileFile({ ...ctx, shell: '/opt/homebrew/bin/fish' })).toBe(
      join(home, '.config', 'fish', 'conf.d', 'beamhop.fish'),
    );
    expect(profileFile({ ...ctx, shell: undefined })).toBe(join(home, '.profile'));
  });

  it('reports Windows and AppImage as unsupported', () => {
    expect(cliStatus({ ...ctx, platform: 'win32' }).state).toBe('unsupported');
    expect(installCli({ ...ctx, platform: 'linux', appImage: '/x.AppImage' }).status.state).toBe(
      'unsupported',
    );
  });

  it('stripBlock keeps surrounding text', () => {
    const block =
      '# >>> beamhop desktop: command line >>>\nexport PATH=x\n# <<< beamhop desktop: command line <<<\n';
    expect(stripBlock(`a\n\n${block}b\n`)).toBe('a\nb\n');
    expect(stripBlock(block)).toBe('');
  });
});
