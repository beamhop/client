/**
 * Builds the PWA when `dist` is missing, then starts the test daemon (apps/daemon/test/
 * test-daemon-server.ts) as a child process via tsx. Fails fast when a port is already taken: this
 * suite never attaches to a server it did not start. Returns the teardown.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTROL_PORT, DAEMON_PORT } from './ports.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pwa = resolve(here, '..');
const root = resolve(pwa, '..', '..');
const dist = join(pwa, 'dist');

const portFree = (port: number) =>
  new Promise<boolean>((res) => {
    const s = createServer();
    s.once('error', () => res(false));
    s.listen(port, '127.0.0.1', () => s.close(() => res(true)));
  });

const bin = (name: string) =>
  join(root, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (!existsSync(join(dist, 'index.html'))) {
    process.stdout.write('[e2e-real] building the PWA (dist missing)…\n');
    execFileSync(bin('vite'), ['build'], { cwd: pwa, stdio: 'inherit', shell: process.platform === 'win32' });
  }
  for (const p of [DAEMON_PORT, CONTROL_PORT])
    if (!(await portFree(p)))
      throw new Error(`[e2e-real] port ${p} is in use; stop whatever runs there (servers are never reused)`);

  // `node --import tsx` (not the tsx CLI wrapper) so signals reach the daemon process itself.
  const script = join(root, 'apps/daemon/test/test-daemon-server.ts');
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', script], {
    cwd: root,
    env: {
      ...process.env,
      BH_E2E_PORT: String(DAEMON_PORT),
      BH_E2E_CONTROL_PORT: String(CONTROL_PORT),
      BH_E2E_STATIC_DIR: dist,
      NODE_NO_WARNINGS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (c: Buffer) => {
    stderr += c.toString();
    if (process.env.BH_E2E_DEBUG) process.stderr.write(c);
  });
  await new Promise<void>((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`[e2e-real] daemon did not start:\n${stderr}`)), 60_000);
    let out = '';
    child.stdout?.on('data', (c: Buffer) => {
      out += c.toString();
      if (out.includes('BH_E2E_READY')) {
        clearTimeout(timer);
        res();
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      rej(new Error(`[e2e-real] daemon exited (${code}):\n${stderr}`));
    });
  });
  process.env.BH_E2E_CONTROL = `http://127.0.0.1:${CONTROL_PORT}`;
  return async () => {
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    await new Promise<void>((r) => {
      const t = setTimeout(() => {
        child.kill('SIGKILL');
        r();
      }, 10_000);
      child.once('exit', () => {
        clearTimeout(t);
        r();
      });
    });
  };
}
