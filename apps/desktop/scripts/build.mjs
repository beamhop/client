#!/usr/bin/env node
// Stage the desktop app for electron-builder (or `electron build/app` in development):
//
//   node apps/desktop/scripts/build.mjs [--skip-daemon-install]
//
//   build/app/            the Electron app (packed into app.asar)
//     main.js             main process, bundled with esbuild (electron external)
//     package.json        generated: name, version, main
//     assets/             app + tray icons
//   build/daemon/         the daemon payload, shipped unpacked as <resources>/daemon
//     bin/, runtime/      the same bundle as the npm package / standalone binary (apps/cli/scripts/build.mjs)
//     node_modules/       its production deps for *this* platform (native addons, srt helpers,
//                         the Claude Agent SDK's per-platform binary)
//
// The daemon runs on the app's own Electron binary in Node mode (ELECTRON_RUN_AS_NODE), so the user
// installs nothing else. Native deps are platform-specific: build each OS/arch on that OS/arch
// (see .github/workflows/release.yml).
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { buildBundle, DIST as CLI_DIST, REPO } from '../../cli/scripts/build.mjs';
import { pruneDaemonDeps } from './prune.mjs';

const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(DESKTOP, 'build');
const APP = join(OUT, 'app');
const DAEMON = join(OUT, 'daemon');
const skipInstall = process.argv.includes('--skip-daemon-install');
const win = process.platform === 'win32';

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const sh = (cmd, argv, opts = {}) => {
  const r = spawnSync(cmd, argv, { stdio: 'inherit', shell: win, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${argv.join(' ')} failed (${r.status})`);
};

// 1. Daemon bundle (CLI + daemon + MCP + runtime assets + built PWA).
const manifest = await buildBundle();

// 2. Stage the daemon payload. Reuse an existing node_modules in development (--skip-daemon-install)
//    when the external deps have not changed.
const depsKey = JSON.stringify([
  manifest.dependencies,
  manifest.optionalDependencies,
  process.platform,
  process.arch,
]);
const stampFile = join(DAEMON, '.deps-stamp');
const reuseDeps =
  skipInstall &&
  existsSync(join(DAEMON, 'node_modules')) &&
  existsSync(stampFile) &&
  readFileSync(stampFile, 'utf8') === depsKey;
if (reuseDeps) {
  for (const f of ['bin', 'runtime']) rmSync(join(DAEMON, f), { recursive: true, force: true });
} else {
  rmSync(DAEMON, { recursive: true, force: true });
}
mkdirSync(DAEMON, { recursive: true });
for (const f of ['bin', 'runtime', 'package.json', 'LICENSE'])
  if (existsSync(join(CLI_DIST, f))) cpSync(join(CLI_DIST, f), join(DAEMON, f), { recursive: true });
if (!reuseDeps) {
  // No install scripts: only node-pty and koffi have any, and prune removes both (srt's unused Windows
  // mxc backend). Everything else ships prebuilt (N-API addon, per-platform packages).
  sh('npm', ['install', '--omit=dev', '--no-package-lock', '--no-fund', '--no-audit', '--ignore-scripts'], {
    cwd: DAEMON,
  });
  writeFileSync(stampFile, depsKey);
}
const freed = pruneDaemonDeps(join(DAEMON, 'node_modules'));
if (freed)
  console.log(
    `pruned ${(freed / 1048576).toFixed(1)} MB the daemon never loads on ${process.platform}-${process.arch}`,
  );

// 3. Main process.
rmSync(APP, { recursive: true, force: true });
mkdirSync(APP, { recursive: true });
await build({
  entryPoints: [join(DESKTOP, 'src/main.ts')],
  outfile: join(APP, 'main.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  // Workspace packages export TS sources.
  conditions: ['node', 'import'],
  mainFields: ['module', 'main'],
  legalComments: 'none',
  logLevel: 'warning',
});

// A new id for every build: the app replaces a daemon left running by another build (see supervisor.ts).
writeFileSync(join(DAEMON, 'BUILD_ID'), `${new Date().toISOString()}-${randomBytes(4).toString('hex')}\n`);

// Window preload (sandboxed: only `electron` may be required, so everything else is bundled in).
await build({
  entryPoints: [join(DESKTOP, 'src/preload.ts')],
  outfile: join(APP, 'preload.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  legalComments: 'none',
  logLevel: 'warning',
});

// 4. App manifest + assets.
const desktop = readJson(join(DESKTOP, 'package.json'));
const cli = readJson(join(REPO, 'apps/cli/package.json'));
writeFileSync(
  join(APP, 'package.json'),
  `${JSON.stringify(
    {
      name: 'beamhop',
      productName: 'beamhop',
      // One version for the npm package, the standalone binary and the app.
      version: cli.version,
      description: desktop.description,
      license: 'Apache-2.0',
      author: { name: 'beamhop' },
      homepage: 'https://github.com/beamhop/client#readme',
      main: 'main.js',
    },
    null,
    2,
  )}\n`,
);
cpSync(join(DESKTOP, 'assets'), join(APP, 'assets'), { recursive: true });

console.log(
  `staged beamhop desktop ${cli.version} -> ${relative(REPO, OUT)} (daemon deps ${reuseDeps ? 'reused' : 'installed'})`,
);
