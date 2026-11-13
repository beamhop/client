#!/usr/bin/env node
// Smoke-test a packed beamhop tarball the way users get it:
//
//   node apps/cli/scripts/smoke.mjs [path/to/beamhop-x.y.z.tgz]
//
// Packs apps/cli/dist when no tarball is given, installs it globally into a temp prefix
// (`npm i -g --prefix <tmp> <tgz>`), starts `beamhop daemon` in the background with a temp
// BEAMHOP_HOME, runs `--help`, `status`, `doctor`, `harness ls`, checks the web UI is served and the
// bundled plugins loaded, then stops the daemon. Exits non-zero on the first failure.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const win = process.platform === 'win32';
const tmp = mkdtempSync(join(tmpdir(), 'beamhop-smoke-'));
const prefix = join(tmp, 'prefix');
const home = join(tmp, 'home');
const port = String(20000 + Math.floor(Math.random() * 20000));

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: win, ...opts });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};
const must = (label, r, test = () => true) => {
  const ok = r.status === 0 && test(r.out);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label} (exit ${r.status})`);
  const lines = r.out.trimEnd().split('\n');
  const shown = lines.length > 25 ? [...lines.slice(0, 25), `… (${lines.length - 25} more lines)`] : lines;
  console.log(shown.map((l) => `    ${l}`).join('\n'));
  if (!ok) {
    cleanup();
    process.exit(1);
  }
};

let tgz = process.argv[2];
if (!tgz) {
  const r = run('npm', ['pack', join(CLI_DIR, 'dist'), '--pack-destination', tmp]);
  if (r.status !== 0) throw new Error(`npm pack failed:\n${r.out}`);
  tgz = join(
    tmp,
    readdirSync(tmp).find((f) => f.endsWith('.tgz')),
  );
}
tgz = resolve(tgz);
must(
  'npm i -g --prefix <tmp> <tgz>',
  run('npm', ['i', '-g', '--no-fund', '--no-audit', '--prefix', prefix, tgz]),
);

const binDir = win ? prefix : join(prefix, 'bin');
const beamhop = join(binDir, win ? 'beamhop.cmd' : 'beamhop');
const env = {
  ...process.env,
  PATH: `${binDir}${win ? ';' : ':'}${process.env.PATH}`,
  BEAMHOP_HOME: home,
  BEAMHOP_PORT: port,
  // Keep the smoke test offline: no Nostr relay connections for the control plane.
  BEAMHOP_NO_CONTROL_PLANE: '1',
};
const cli = (...args) => run(beamhop, args, { env });

let daemon;
const cleanup = () => {
  if (daemon && daemon.exitCode === null) daemon.kill('SIGTERM');
};

must('beamhop --help', cli('--help'), (o) => o.includes('Usage: beamhop'));
must('beamhop --version', cli('--version'), (o) => /\d+\.\d+\.\d+/.test(o));

let log = '';
daemon = spawn(beamhop, ['daemon'], { env, shell: win, stdio: ['ignore', 'pipe', 'pipe'] });
daemon.stdout.on('data', (d) => (log += d));
daemon.stderr.on('data', (d) => (log += d));
const deadline = Date.now() + 30_000;
while (!/api listening/.test(log)) {
  if (Date.now() > deadline || daemon.exitCode !== null) {
    console.log(`FAIL daemon did not start:\n${log}`);
    cleanup();
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 200));
}
console.log('PASS beamhop daemon (background) started');
const loaded = /plugins loaded (\{.*\})/.exec(log)?.[1];
const plugins = loaded ? JSON.parse(loaded).loaded : [];
console.log(`    plugins loaded: ${plugins.join(', ')}`);
if (plugins.length < 10) {
  console.log('FAIL expected all 10 built-in plugins to load');
  cleanup();
  process.exit(1);
}

must('beamhop status', cli('status'), (o) => o.includes('running'));
must('beamhop doctor', cli('doctor'));
must('beamhop harness ls', cli('harness', 'ls'));
must('beamhop --json channel providers', cli('--json', 'channel', 'providers'), (o) =>
  ['nostr', 'telegram', 'slack', 'discord'].every((p) => o.includes(p)),
);

const res = await fetch(`http://127.0.0.1:${port}/`);
const html = await res.text();
const uiOk = res.ok && html.includes('<title>beamhop</title>');
console.log(`${uiOk ? 'PASS' : 'FAIL'} web UI served at / (HTTP ${res.status})`);

const pkgRoot = win
  ? join(prefix, 'node_modules', 'beamhop')
  : join(prefix, 'lib', 'node_modules', 'beamhop');
for (const f of [
  'runtime/packages/sandbox/src/runner.mjs',
  'runtime/packages/mcp/dist/bin/beamhop-mcp.js',
  'runtime/packages/harness-catalog/catalog.json',
  'runtime/packages/harness-pi/extension/beamhop-gate.mjs',
  'runtime/apps/pwa/dist/index.html',
]) {
  const ok = existsSync(join(pkgRoot, f));
  console.log(`${ok ? 'PASS' : 'FAIL'} ships ${f}`);
  if (!ok) process.exitCode = 1;
}
JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));

daemon.kill('SIGTERM');
await new Promise((r) => daemon.once('exit', r));
console.log(`PASS daemon stopped (${daemon.signalCode ?? daemon.exitCode})`);
if (!uiOk) process.exitCode = 1;
if (!process.env.BEAMHOP_SMOKE_KEEP) rmSync(tmp, { recursive: true, force: true });
else console.log(`kept ${tmp}`);
