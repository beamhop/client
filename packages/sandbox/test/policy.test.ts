import { join } from 'node:path';
import { ALWAYS_DENY_READ, type DoctorCheck } from '@beamhop/core';
import { describe, expect, it } from 'vitest';
import {
  compilePolicy,
  createSandbox,
  expandPath,
  isWithin,
  LLM_PROVIDER_HOSTS,
  linuxPackageManager,
  METADATA_HOSTS,
  packageInstallArgv,
  parseViolationLine,
  probeSandbox,
  sandboxActions,
  scrubEnv,
  toSrtConfig,
  toWslPath,
} from '../src/index.ts';

const home = '/home/tester';
const opts = { home, cwd: '/work' };

describe('compilePolicy', () => {
  const mounts = [
    { path: '~/proj', mode: 'rw' as const },
    { path: '/data/docs', mode: 'ro' as const },
  ];

  it('strict: mounts read-only, no writes, only LLM hosts, ignores widening overrides', () => {
    const p = compilePolicy(
      'strict',
      mounts,
      {
        fs: { write: ['/etc'], deny: ['~/proj/secret'] },
        net: { allow: ['evil.com'], deny: ['openrouter.ai'] },
      },
      opts,
    );
    expect(p.fs.write).toEqual([]);
    expect(p.fs.read).toEqual([join(home, 'proj'), '/data/docs']);
    expect(p.net.allow).not.toContain('evil.com');
    expect(p.net.allow).toContain('api.anthropic.com');
    expect(p.net.allow).not.toContain('openrouter.ai'); // deny wins
    expect(p.net.allow).not.toContain('github.com');
    expect(p.fs.deny).toContain(join(home, 'proj/secret'));
    expect(p.net.denyPrivateIps).toBe(true);
  });

  it('workspace: rw mounts writable, dev hosts allowed, overrides merged', () => {
    const p = compilePolicy(
      'workspace',
      mounts,
      { net: { allow: ['Example.com'] }, fs: { write: ['/tmp/x'] } },
      opts,
    );
    expect(p.fs.write).toEqual([join(home, 'proj'), '/tmp/x']);
    expect(p.fs.read).toEqual(['/data/docs']);
    for (const h of ['github.com', 'registry.npmjs.org', 'pypi.org', 'example.com', ...LLM_PROVIDER_HOSTS]) {
      expect(p.net.allow).toContain(h);
    }
  });

  it('custom: uses the user policy but always forces deny list + denyPrivateIps', () => {
    const p = compilePolicy(
      'custom',
      [{ path: 'rel/dir', mode: 'rw' }],
      { net: { allow: ['a.example'], denyPrivateIps: false }, env: { passthrough: ['PATH'] } },
      opts,
    );
    expect(p.net.allow).toEqual(['a.example']);
    expect(p.net.denyPrivateIps).toBe(true);
    expect(p.fs.write).toEqual(['/work/rel/dir']);
    expect(p.env.passthrough).toEqual(['PATH']);
  });

  it('always merges ALWAYS_DENY_READ (expanded) into fs.deny', () => {
    for (const profile of ['strict', 'workspace', 'custom'] as const) {
      const p = compilePolicy(profile, [], {}, opts);
      for (const d of ALWAYS_DENY_READ) expect(p.fs.deny).toContain(expandPath(d, opts));
      expect(p.fs.deny.every((d) => !d.includes('~'))).toBe(true);
    }
  });

  it('deny wins: mounts inside a denied path are dropped', () => {
    const p = compilePolicy(
      'workspace',
      [
        { path: '~/.ssh', mode: 'rw' },
        { path: '~/.aws/x', mode: 'ro' },
      ],
      {},
      opts,
    );
    expect(p.fs.write).toEqual([]);
    expect(p.fs.read).toEqual([]);
  });
});

describe('path helpers', () => {
  it('expands ~ and normalizes', () => {
    expect(expandPath('~', opts)).toBe(home);
    expect(expandPath('~/a/../b/', opts)).toBe(join(home, 'b'));
    expect(expandPath('x', opts)).toBe('/work/x');
  });
  it('isWithin', () => {
    expect(isWithin('/a/b', '/a')).toBe(true);
    expect(isWithin('/a', '/a')).toBe(true);
    expect(isWithin('/ab', '/a')).toBe(false);
    expect(isWithin('/', '/a')).toBe(false);
  });
  it('toWslPath', () => {
    expect(toWslPath('C:\\Users\\me\\x.json')).toBe('/mnt/c/Users/me/x.json');
  });
});

describe('scrubEnv', () => {
  it('keeps only passthrough + explicit', () => {
    const env = scrubEnv(
      ['PATH', 'MISSING'],
      { ANTHROPIC_API_KEY: 'placeholder' },
      { PATH: '/bin', SECRET_TOKEN: 's' },
    );
    expect(env).toEqual({ PATH: '/bin', ANTHROPIC_API_KEY: 'placeholder' });
  });
});

describe('toSrtConfig', () => {
  const p = compilePolicy(
    'workspace',
    [{ path: '~/proj', mode: 'rw' }],
    { net: { deny: ['bad.com'] } },
    opts,
  );

  it('maps fs and network', () => {
    const c = toSrtConfig(p, { home });
    expect(c.filesystem.allowWrite).toEqual([join(home, 'proj')]);
    expect(c.filesystem.denyRead).toContain(join(home, '.ssh'));
    expect(c.filesystem.denyWrite).toContain(join(home, '.ssh'));
    expect(c.filesystem.allowRead).toEqual([]);
    expect(c.network.allowedDomains).toContain('github.com');
    expect(c.network.deniedDomains).toContain('bad.com');
    for (const m of METADATA_HOSTS) expect(c.network.deniedDomains).toContain(m);
    expect(c.network.deniedResolvedAddresses).toContain('10.0.0.0/8');
    expect(c.network.parentProxy).toBeUndefined();
  });

  it('isolateHome denies HOME and re-allows mounts within it', () => {
    const c = toSrtConfig(p, { home, isolateHome: true });
    expect(c.filesystem.denyRead).toContain(home);
    expect(c.filesystem.allowRead).toEqual([join(home, 'proj')]);
  });

  it('isolateHome is a no-op when a mount is the home itself', () => {
    const q = compilePolicy('workspace', [{ path: '~', mode: 'ro' }], {}, opts);
    const c = toSrtConfig(q, { home, isolateHome: true });
    expect(c.filesystem.denyRead).not.toContain(home);
  });

  it('trustd only when a harness declares it, and only on macOS', () => {
    expect(toSrtConfig(p, { home })).not.toHaveProperty('enableWeakerNetworkIsolation');
    const c = toSrtConfig(p, { home, macosTrustd: true });
    if (process.platform === 'darwin') expect(c).toMatchObject({ enableWeakerNetworkIsolation: true });
    else expect(c).not.toHaveProperty('enableWeakerNetworkIsolation');
  });

  it('localAllow and parentProxy', () => {
    const c = toSrtConfig(p, { localAllow: ['127.0.0.1:4000'], parentProxy: { https: 'http://proxy:8080' } });
    expect(c.network.allowedDomains).toContain('127.0.0.1:4000');
    expect(c.network.parentProxy?.noProxy).toContain('127.0.0.1');
  });
});

describe('own dirs (session dir + worktrees inside the denied beamhop home)', () => {
  const bh = join(home, '.beamhop');
  const sessions = join(bh, 'sessions');
  const worktrees = join(bh, 'worktrees');
  const sessionDir = join(sessions, 'ses_1');
  const own = { dirs: [sessionDir], beamhopHome: bh };
  const session = { fs: { read: [sessionDir], write: [sessionDir] } };

  it('without a carve-out, deny wins and the session dir is dropped (the bug: the harness cannot read its cwd)', () => {
    const p = compilePolicy('workspace', [], session, opts);
    expect(p.fs.write).not.toContain(sessionDir);
    expect(p.fs.own).toEqual([]);
  });

  it('keeps exactly the session dir; the rest of the beamhop home stays denied', () => {
    const p = compilePolicy('workspace', [], session, { ...opts, own });
    expect(p.fs.write).toEqual([sessionDir]);
    expect(p.fs.own).toEqual([sessionDir]);
    expect(p.fs.deny).toContain(bh);

    const c = toSrtConfig(p, { home });
    expect(c.filesystem.denyRead).toContain(bh);
    expect(c.filesystem.allowRead).toEqual([sessionDir]);
    expect(c.filesystem.allowWrite).toEqual([sessionDir]);
    // denyWrite has no carve-outs in srt, so the region holding the own dir is left to default-deny writes.
    expect(c.filesystem.denyWrite).not.toContain(bh);
    expect(c.filesystem.denyWrite).toContain(join(home, '.ssh'));
  });

  it('a worktree mount inside the beamhop home survives as a writable mount', () => {
    const wt = join(worktrees, 'ses_1');
    const p = compilePolicy(
      'workspace',
      [{ path: join(wt, 'app'), mode: 'rw' }],
      {},
      {
        ...opts,
        own: { dirs: [wt], beamhopHome: bh },
      },
    );
    expect(p.fs.write).toEqual([join(wt, 'app')]);
  });

  it('keeps the beamhop home write-denied when a broad writable mount covers it', () => {
    const p = compilePolicy('workspace', [{ path: '~', mode: 'rw' }], session, { ...opts, own });
    const c = toSrtConfig(p, { home });
    expect(c.filesystem.denyWrite).toContain(bh);
    expect(c.filesystem.denyRead).toContain(bh);
  });

  it('refuses carve-outs outside sessions/worktrees, of a root itself, or into another denied path', () => {
    const bad =
      (dirs: string[], beamhopHome = bh, fs: { deny?: string[] } = {}) =>
      () =>
        compilePolicy('workspace', [], { fs }, { ...opts, own: { dirs, beamhopHome } });
    expect(bad([bh])).toThrow(/is not inside/);
    expect(bad([join(bh, 'api-token')])).toThrow(/is not inside/);
    expect(bad([sessions])).toThrow(/is not inside/);
    expect(bad([worktrees])).toThrow(/is not inside/);
    expect(bad([join(sessions, '..', 'vault.age')])).toThrow(/is not inside/);
    // A "beamhop home" inside ~/.ssh cannot be used to reopen it.
    expect(bad([join(home, '.ssh', 'sessions', 'x')], join(home, '.ssh'))).toThrow(/inside protected path/);
    expect(bad([join(home, '.aws', 'bh', 'sessions', 'x')], join(home, '.aws', 'bh'))).toThrow(
      /inside protected path/,
    );
    // A deny the user put inside the home also wins.
    expect(bad([sessionDir], bh, { deny: [sessionDir] })).toThrow(/would reopen denied path/);
  });

  it('agent config cannot set own dirs (custom profile, overrides)', () => {
    const p = compilePolicy('custom', [], { fs: { own: [bh] } } as never, opts);
    expect(p.fs.own).toEqual([]);
    expect(toSrtConfig(p, { home }).filesystem.allowRead).toEqual([]);
  });
});

describe('parseViolationLine', () => {
  it.each([
    ['deny network-outbound example.com:443 (not in allowlist)', { kind: 'net.allow', value: 'example.com' }],
    ['allow network-outbound Foo.Example:80 (learning)', { kind: 'net.allow', value: 'foo.example' }],
    [
      'deny network-outbound [::1]:443 (resolved to a loopback address)',
      { kind: 'net.allow', value: '[::1]' },
    ],
    ['deny openat /etc/passwd', { kind: 'fs.write', value: '/etc/passwd' }],
    [
      'Sandbox: cat(12) deny(1) file-read-data /Users/x/.ssh/id_rsa',
      { kind: 'fs.read', value: '/Users/x/.ssh/id_rsa' },
    ],
    ['bash(1) deny(1) file-write-create /private/x', { kind: 'fs.write', value: '/private/x' }],
  ])('%s', (line, expected) => {
    expect(parseViolationLine(line)).toMatchObject(expected);
  });
  it('ignores junk and unix sockets', () => {
    expect(parseViolationLine('hello')).toBeNull();
    expect(parseViolationLine('deny network-outbound /var/run/docker.sock')).toBeNull();
  });
});

describe('createSandbox backend=none', () => {
  const p = compilePolicy('strict', [], {}, opts);
  it('refuses without BEAMHOP_UNSAFE_NO_SANDBOX=1', async () => {
    await expect(createSandbox(p, { backend: 'none', sourceEnv: {} })).rejects.toThrow(
      /BEAMHOP_UNSAFE_NO_SANDBOX/,
    );
  });
  it('allowed with the flag: loud warning, env still scrubbed', async () => {
    const s = await createSandbox(p, {
      backend: 'none',
      sourceEnv: { BEAMHOP_UNSAFE_NO_SANDBOX: '1', PATH: '/bin', SECRET_TOKEN: 'x' },
      env: { FOO: 'bar' },
    });
    expect(s.backend).toBe('none');
    expect(s.warnings.join(' ')).toMatch(/WITHOUT a sandbox/);
    const w = await s.wrap('echo', ['hi']);
    expect(w).toEqual({ cmd: 'echo', args: ['hi'], env: { PATH: '/bin', FOO: 'bar' } });
  });
  it('rejects an invalid srt policy early', async () => {
    const bad = compilePolicy('custom', [], { net: { allow: ['not a domain!'] } }, opts);
    await expect(createSandbox(bad, { backend: 'srt', sourceEnv: {} })).rejects.toThrow(
      /Invalid sandbox policy/,
    );
  });
});

describe('probeSandbox (fake deps)', () => {
  const base = {
    platform: 'linux' as NodeJS.Platform,
    env: {},
    which: () => true,
    run: () => ({ status: 0, stderr: '' }),
    readFile: () => undefined,
    srtVersion: () => '0.0.82',
  };
  const byId = (cs: DoctorCheck[], id: string) => cs.find((c) => c.id === id);

  it('all good on linux', async () => {
    const cs = await probeSandbox(base);
    expect(cs.every((c) => c.status === 'ok' || c.status === 'skip')).toBe(true);
    expect(byId(cs, 'sandbox.bwrap')).toBeTruthy();
  });

  it('missing tools and AppArmor-restricted userns produce fixes', async () => {
    const cs = await probeSandbox({
      ...base,
      which: (c) => c === 'bwrap',
      run: () => ({ status: 1, stderr: 'bwrap: setting up uid map: Permission denied' }),
      readFile: () => '1\n',
    });
    expect(byId(cs, 'sandbox.socat')?.status).toBe('fail');
    expect(byId(cs, 'sandbox.rg')?.fix).toMatch(/ripgrep/);
    expect(byId(cs, 'sandbox.userns')?.status).toBe('fail');
    expect(byId(cs, 'sandbox.userns')?.fix).toMatch(/apparmor_restrict_unprivileged_userns=0/);
    expect(byId(cs, 'sandbox.apparmor-userns')?.status).toBe('fail');
  });

  it('offers fixes from a fixed table, using the distribution’s package manager', async () => {
    const cs = await probeSandbox({
      ...base,
      which: (c) => c === 'bwrap' || c === 'apt-get',
      run: () => ({ status: 1, stderr: 'Permission denied' }),
      readFile: () => '1\n',
    });
    expect(byId(cs, 'sandbox.bwrap')?.action).toBeUndefined();
    expect(byId(cs, 'sandbox.socat')?.action).toEqual({
      id: 'linux.pkg.socat',
      label: 'Install socat',
      summary: expect.stringContaining('Installs socat'),
      admin: true,
      command: ['env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', 'install', '-y', '-q', 'socat'],
    });
    expect(byId(cs, 'sandbox.apparmor-userns')?.action).toMatchObject({
      id: 'linux.apparmor-userns',
      admin: true,
      command: ['sh', '-c', expect.stringContaining('/etc/sysctl.d/60-beamhop.conf')],
    });
    // No package manager: the check still explains, but there is nothing to run.
    const none = await probeSandbox({ ...base, which: () => false });
    expect(byId(none, 'sandbox.socat')?.action).toBeUndefined();
    expect(byId(none, 'sandbox.socat')?.fix).toMatch(/socat/);
    expect(sandboxActions({ platform: 'darwin' })).toEqual({});
    expect(Object.keys(sandboxActions({ platform: 'linux', which: (c) => c === 'pacman' }))).toEqual([
      'linux.pkg.bubblewrap',
      'linux.pkg.socat',
      'linux.pkg.ripgrep',
      'linux.apparmor-userns',
    ]);
  });

  it('install commands are non-interactive for each package manager', () => {
    expect(packageInstallArgv('dnf', ['socat'])).toEqual(['dnf', 'install', '-y', 'socat']);
    expect(packageInstallArgv('pacman', ['socat'])).toEqual([
      'pacman',
      '-S',
      '--noconfirm',
      '--needed',
      'socat',
    ]);
    expect(packageInstallArgv('zypper', ['socat'])).toEqual([
      'zypper',
      '--non-interactive',
      'install',
      'socat',
    ]);
    expect(linuxPackageManager((c) => c === 'zypper')).toBe('zypper');
    expect(linuxPackageManager(() => false)).toBeUndefined();
  });

  it('warns on windows and on the unsafe flag', async () => {
    const cs = await probeSandbox({ ...base, platform: 'win32', env: { BEAMHOP_UNSAFE_NO_SANDBOX: '1' } });
    expect(byId(cs, 'sandbox.platform')?.status).toBe('warn');
    expect(byId(cs, 'sandbox.unsafe')?.status).toBe('warn');
    expect(byId(cs, 'sandbox.wsl2')).toBeTruthy();
  });

  it('real probe runs on this machine', async () => {
    const cs = await probeSandbox();
    expect(byId(cs, 'sandbox.srt')?.status).toBe('ok');
  });
});
