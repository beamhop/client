import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { DoctorCheck } from '@beamhop/core';
import { UNSAFE_NO_SANDBOX_ENV } from './sandbox.ts';

export interface ProbeDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  which(cmd: string): boolean;
  run(cmd: string, args: string[]): { status: number | null; stderr: string };
  readFile(path: string): string | undefined;
  srtVersion(): string | undefined;
}

const defaultDeps = (): ProbeDeps => ({
  platform: process.platform,
  env: process.env,
  which: (cmd) => {
    try {
      return (
        spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' }).status === 0
      );
    } catch {
      return false;
    }
  },
  run: (cmd, args) => {
    try {
      const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 10_000 });
      return { status: r.status, stderr: (r.stderr ?? '') + (r.error ? String(r.error) : '') };
    } catch (e) {
      return { status: null, stderr: String(e) };
    }
  },
  readFile: (p) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return undefined;
    }
  },
  srtVersion: () => {
    try {
      const req = createRequire(import.meta.url);
      return (req('@anthropic-ai/sandbox-runtime/package.json') as { version: string }).version;
    } catch {
      return undefined;
    }
  },
});

const INSTALL_HINT: Record<string, string> = {
  bwrap:
    'Install bubblewrap: `sudo apt install bubblewrap` (Debian/Ubuntu), `sudo dnf install bubblewrap` (Fedora).',
  socat: 'Install socat: `sudo apt install socat` / `sudo dnf install socat`.',
  rg: 'Install ripgrep: `sudo apt install ripgrep` / `sudo dnf install ripgrep`.',
};

/** Doctor checks for the sandbox (§7 prerequisites). */
export const probeSandbox = async (overrides: Partial<ProbeDeps> = {}): Promise<DoctorCheck[]> => {
  const d: ProbeDeps = { ...defaultDeps(), ...overrides };
  const checks: DoctorCheck[] = [];
  const supported = ['linux', 'darwin', 'win32'].includes(d.platform);
  checks.push({
    id: 'sandbox.platform',
    title: 'Platform',
    status: d.platform === 'win32' ? 'warn' : supported ? 'ok' : 'fail',
    message:
      d.platform === 'win32'
        ? 'Windows sandboxing is alpha (srt-win); WSL2 + srt is the fallback.'
        : supported
          ? `${d.platform} is supported`
          : `${d.platform} is not supported`,
    ...(d.platform === 'win32'
      ? { fix: 'Run `srt windows-install` once, or install WSL2 with srt inside.' }
      : {}),
  });

  const ver = d.srtVersion();
  checks.push({
    id: 'sandbox.srt',
    title: 'sandbox-runtime (srt)',
    status: ver ? 'ok' : 'fail',
    message: ver ? `@anthropic-ai/sandbox-runtime ${ver}` : 'sandbox-runtime library not found',
    ...(ver ? {} : { fix: 'Reinstall beamhop (`npm i -g beamhop`); the sandbox runtime ships with it.' }),
  });

  if (d.platform === 'linux') {
    const tools = { bwrap: 'bubblewrap', socat: 'socat', rg: 'ripgrep' } as const;
    for (const [bin, name] of Object.entries(tools)) {
      const ok = d.which(bin);
      checks.push({
        id: `sandbox.${bin}`,
        title: name,
        status: ok ? 'ok' : 'fail',
        message: ok ? `${bin} found` : `${bin} not found on PATH`,
        ...(ok ? {} : { fix: INSTALL_HINT[bin] }),
      });
    }

    const apparmor = d.readFile('/proc/sys/kernel/apparmor_restrict_unprivileged_userns')?.trim();
    const restricted = apparmor === '1';
    let userns: DoctorCheck;
    if (!d.which('bwrap')) {
      userns = {
        id: 'sandbox.userns',
        title: 'Unprivileged user namespaces',
        status: 'skip',
        message: 'bubblewrap missing; cannot test',
      };
    } else {
      const r = d.run('bwrap', [
        '--ro-bind',
        '/',
        '/',
        '--dev',
        '/dev',
        '--unshare-user',
        '--unshare-net',
        '--',
        'true',
      ]);
      const ok = r.status === 0;
      userns = {
        id: 'sandbox.userns',
        title: 'Unprivileged user namespaces',
        status: ok ? 'ok' : 'fail',
        message: ok
          ? 'bubblewrap can create user namespaces'
          : `bubblewrap failed: ${r.stderr.trim().slice(0, 300)}`,
        ...(ok
          ? {}
          : {
              fix: restricted
                ? 'Ubuntu restricts unprivileged user namespaces via AppArmor. Fix: `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` (persist in /etc/sysctl.d/60-beamhop.conf), or add an AppArmor profile allowing `userns` for /usr/bin/bwrap.'
                : 'Enable unprivileged user namespaces (`sudo sysctl -w kernel.unprivileged_userns_clone=1` / `user.max_user_namespaces=15000`). In containers without user namespaces (some PaaS), set BEAMHOP_UNSAFE_NO_SANDBOX=1 and rely on the container boundary.',
            }),
      };
    }
    checks.push(userns);
    checks.push({
      id: 'sandbox.apparmor-userns',
      title: 'AppArmor userns restriction',
      status: apparmor === undefined ? 'skip' : restricted ? (userns.status === 'ok' ? 'ok' : 'fail') : 'ok',
      message:
        apparmor === undefined
          ? 'kernel.apparmor_restrict_unprivileged_userns not present'
          : restricted
            ? userns.status === 'ok'
              ? 'restriction is on, but bubblewrap is permitted (AppArmor profile present)'
              : 'kernel.apparmor_restrict_unprivileged_userns=1 blocks bubblewrap'
            : 'not restricted',
      ...(restricted && userns.status !== 'ok'
        ? {
            fix: 'Run `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` and persist it with `echo kernel.apparmor_restrict_unprivileged_userns=0 | sudo tee /etc/sysctl.d/60-beamhop.conf`.',
          }
        : {}),
    });
  } else if (d.platform === 'darwin') {
    const ok = d.which('sandbox-exec');
    checks.push({
      id: 'sandbox.seatbelt',
      title: 'Seatbelt (sandbox-exec)',
      status: ok ? 'ok' : 'fail',
      message: ok ? 'sandbox-exec available' : 'sandbox-exec not found',
      ...(ok ? {} : { fix: 'sandbox-exec ships with macOS at /usr/bin/sandbox-exec; check PATH.' }),
    });
  } else if (d.platform === 'win32') {
    const wsl = d.which('wsl.exe');
    checks.push({
      id: 'sandbox.wsl2',
      title: 'WSL2 fallback',
      status: wsl ? 'ok' : 'warn',
      message: wsl ? 'wsl.exe found' : 'WSL not installed',
      ...(wsl
        ? {}
        : { fix: 'Install WSL2 (`wsl --install`) and `npm i -g @anthropic-ai/sandbox-runtime` inside it.' }),
    });
  }

  if (d.env[UNSAFE_NO_SANDBOX_ENV] === '1') {
    checks.push({
      id: 'sandbox.unsafe',
      title: 'Unsandboxed mode',
      status: 'warn',
      message: `${UNSAFE_NO_SANDBOX_ENV}=1: harnesses may run without a sandbox if srt is unavailable.`,
      fix: `Unset ${UNSAFE_NO_SANDBOX_ENV} unless this is a PaaS container without user namespaces.`,
    });
  }
  return checks;
};
