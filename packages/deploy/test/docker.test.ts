import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);
const posix = process.platform !== 'win32';

describe('Dockerfile (ghcr.io/beamhop/agent)', async () => {
  const df = await readFile(join(pkg, 'Dockerfile'), 'utf8');
  const lines = df
    .replace(/\\\n/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  const instr = (name: string) => lines.filter((l) => l.toUpperCase().startsWith(`${name} `));

  it('is based on node:22-slim', () => {
    expect(instr('FROM')).toEqual(['FROM node:22-slim']);
  });

  it('installs srt prerequisites with no-install-recommends and cleans apt lists in the same layer', () => {
    const apt = instr('RUN').find((l) => l.includes('apt-get install'))!;
    for (const p of ['bubblewrap', 'socat', 'ripgrep', 'tini']) expect(apt).toContain(p);
    expect(apt).toContain('--no-install-recommends');
    expect(apt).toContain('rm -rf /var/lib/apt/lists/*');
  });

  it('pins the beamhop version through a required build arg', () => {
    expect(df).toContain(`"beamhop@\${BEAMHOP_VERSION}"`);
    expect(df).toMatch(/test -n "\$BEAMHOP_VERSION"/);
  });

  it('runs as a non-root user with a healthcheck, an entrypoint and no exposed ports', () => {
    const user = instr('USER');
    expect(user).toHaveLength(1);
    expect(user[0]).not.toMatch(/\b(root|0)(:|$)/);
    expect(lines.indexOf(user[0]!)).toBeGreaterThan(
      lines.findIndex((l) => l.startsWith('RUN') && l.includes('useradd')),
    );
    expect(instr('HEALTHCHECK')[0]).toContain('healthcheck');
    expect(instr('ENTRYPOINT')[0]).toContain('/usr/bin/tini');
    expect(instr('EXPOSE')).toEqual([]);
    expect(instr('VOLUME')[0]).toContain('/home/beamhop/.beamhop');
  });

  it('declares no secret-looking ARG/ENV and uses no ADD of remote URLs', () => {
    for (const l of [...instr('ARG'), ...instr('ENV')]) {
      expect(l).not.toMatch(/TOKEN|SECRET|PASSWORD|NSEC|API_KEY|PRIVATE/i);
    }
    expect(instr('ADD')).toEqual([]);
    expect(df).not.toMatch(/curl[^\n]*\|\s*(ba)?sh/);
  });
});

describe('docker/entrypoint.sh', () => {
  const ep = join(pkg, 'docker', 'entrypoint.sh');

  it('is a strict POSIX sh script', async () => {
    const src = await readFile(ep, 'utf8');
    expect(src.startsWith('#!/bin/sh\n')).toBe(true);
    expect(src).toContain('set -eu');
    expect(src).toContain('exec beamhop daemon --foreground');
    expect(src).toMatch(/refusing to run the daemon as root/);
    if (posix) await run('sh', ['-n', ep]);
  });

  it.runIf(posix)('healthcheck fails without the daemon socket and passes with it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'bh-'));
    await expect(
      run('sh', [ep, 'healthcheck'], { env: { ...process.env, BEAMHOP_HOME: home } }),
    ).rejects.toThrow();
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(join(home, 'beamhop.sock'), r));
    try {
      await run('sh', [ep, 'healthcheck'], { env: { ...process.env, BEAMHOP_HOME: home } });
    } finally {
      srv.close();
    }
  });

  const isRoot = posix && process.getuid?.() === 0;

  it.runIf(posix)('refuses to start the daemon as root', async () => {
    const bin = await mkdtemp(join(tmpdir(), 'bh-bin-'));
    await writeFile(join(bin, 'id'), '#!/bin/sh\necho 0\n', { mode: 0o755 }); // pretend to be root
    const err = await run('sh', [ep, 'daemon'], {
      env: { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: bin },
    }).catch((e) => e);
    expect(err.code).toBe(1);
    expect(err.stderr).toMatch(/refusing to run the daemon as root/);
  });

  it.runIf(posix)('scrubs secret-looking env vars and probes the sandbox before exec', async () => {
    // Runs as an unprivileged user; when the test runner is root, drop to nobody via setpriv.
    const dir = await mkdtemp(join(tmpdir(), 'bh-ep-'));
    await chmod(dir, 0o755);
    const home = join(dir, 'home');
    await mkdir(home, { mode: 0o777 });
    await chmod(home, 0o777);
    await writeFile(join(dir, 'beamhop'), '#!/bin/sh\nenv\n', { mode: 0o755 });
    await copyFile(ep, join(dir, 'entrypoint.sh'));
    await chmod(join(dir, 'entrypoint.sh'), 0o755);
    const argv = [join(dir, 'entrypoint.sh'), 'daemon'];
    const [cmd, args] = isRoot
      ? ['setpriv', ['--reuid=65534', '--regid=65534', '--clear-groups', 'sh', ...argv]]
      : ['sh', argv];
    const { stdout, stderr } = await run(cmd as string, args as string[], {
      env: {
        PATH: `${dir}:${process.env.PATH ?? ''}`,
        HOME: home,
        BEAMHOP_HOME: join(home, '.beamhop'),
        GITHUB_TOKEN: 'ghp_shouldnotsurvive',
        BEAMHOP_PROVISIONING_PUBKEY: 'abc',
      },
    });
    expect(stdout).not.toContain('ghp_shouldnotsurvive');
    expect(stdout).toContain('BEAMHOP_PROVISIONING_PUBKEY=abc');
    expect(stdout).toMatch(/BEAMHOP_SANDBOX_FS=(srt|container)/);
    expect(stderr).toContain('ignoring secret-looking env var GITHUB_TOKEN');
    expect(stderr).not.toContain('ghp_shouldnotsurvive');
  });

  it.runIf(posix)('rejects invalid harness package specs', async () => {
    const bin = await mkdtemp(join(tmpdir(), 'bh-bin-'));
    await writeFile(join(bin, 'id'), '#!/bin/sh\necho 1000\n', { mode: 0o755 });
    const err = await run('sh', [ep, 'daemon'], {
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HOME: bin,
        BEAMHOP_HOME: join(bin, '.beamhop'),
        BEAMHOP_HARNESS_PACKAGES: 'ok-pkg bad;rm',
      },
    }).catch((e) => e);
    expect(err.code).toBe(64);
  });
});
