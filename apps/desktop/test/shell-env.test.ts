import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MARK, mergeShellEnv, parseShellEnv, resolveShellEnv } from '../src/shell-env.ts';

const posix = process.platform !== 'win32';

describe('parseShellEnv', () => {
  it('reads NUL-separated env between the markers and ignores shell noise', () => {
    const out = `Last login: Thu\n\u001b]0;title\u0007 welcome!\n${MARK}PATH=/a:/b\0MULTI=line1\nline2\0EMPTY=\0${MARK}bye\n`;
    expect(parseShellEnv(out)).toEqual({ PATH: '/a:/b', MULTI: 'line1\nline2', EMPTY: '' });
  });

  it('returns undefined without both markers', () => {
    expect(parseShellEnv('PATH=/a')).toBeUndefined();
    expect(parseShellEnv(`${MARK}PATH=/a`)).toBeUndefined();
  });
});

describe('mergeShellEnv', () => {
  it("puts the shell's PATH first, keeps app-only dirs, and imports only tool-manager vars", () => {
    const merged = mergeShellEnv(
      { PATH: '/usr/bin:/bin:/app/only', HOME: '/h' },
      {
        PATH: '/h/.nvm/versions/node/v24/bin:/opt/homebrew/bin:/usr/bin',
        NVM_BIN: '/h/.nvm/versions/node/v24/bin',
        GH_TOKEN: 'gho_secret',
        AWS_SECRET_ACCESS_KEY: 'x',
      },
    );
    expect(merged.PATH).toBe('/h/.nvm/versions/node/v24/bin:/opt/homebrew/bin:/usr/bin:/bin:/app/only');
    expect(merged.NVM_BIN).toBe('/h/.nvm/versions/node/v24/bin');
    // Secrets in the shell env are never imported into the daemon.
    expect(merged.GH_TOKEN).toBeUndefined();
    expect(merged.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it('leaves the env alone when the shell could not be read, and never overrides app-set vars', () => {
    expect(mergeShellEnv({ PATH: '/usr/bin' }, undefined)).toEqual({ PATH: '/usr/bin' });
    expect(mergeShellEnv({ NVM_BIN: '/mine' }, { NVM_BIN: '/shell' }).NVM_BIN).toBe('/mine');
  });
});

describe.runIf(posix)('resolveShellEnv', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bh-shell-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A fake login shell: prints noise, then runs the `-ilc` command with a PATH like nvm's. */
  const fakeShell = (body: string) => {
    const p = join(dir, 'fake-shell');
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  };

  it('reads the environment of an interactive login shell', async () => {
    const shell = fakeShell(
      'echo "oh-my-zsh says hi"\nexport PATH="/fake/nvm/bin:$PATH" NVM_BIN=/fake/nvm/bin\nexec /bin/sh -c "$2"',
    );
    const env = await resolveShellEnv({ shell, env: { PATH: '/usr/bin:/bin' } });
    expect(env?.PATH?.split(':')[0]).toBe('/fake/nvm/bin');
    expect(env?.NVM_BIN).toBe('/fake/nvm/bin');
    expect(env?.BEAMHOP_RESOLVING_SHELL_ENV).toBe('1');
  });

  it('gives up after the timeout instead of blocking app start', async () => {
    const shell = fakeShell('sleep 5');
    const t = Date.now();
    expect(await resolveShellEnv({ shell, timeoutMs: 300, env: { PATH: '/usr/bin:/bin' } })).toBeUndefined();
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it('returns undefined for a missing or failing shell', async () => {
    expect(await resolveShellEnv({ shell: join(dir, 'nope'), timeoutMs: 2000 })).toBeUndefined();
    expect(await resolveShellEnv({ shell: fakeShell('exit 1'), timeoutMs: 2000 })).toBeUndefined();
  });
});
