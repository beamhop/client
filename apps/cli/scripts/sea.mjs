#!/usr/bin/env node
// Build a standalone beamhop for the *current* platform with Node SEA (single executable application):
//
//   node apps/cli/scripts/build.mjs && node apps/cli/scripts/sea.mjs [--out <dir>] [--no-archive]
//
// Output: dist/standalone/beamhop-<version>-<os>-<arch>/ (repo root, git- and lint-ignored) plus a .tar.gz (.zip on Windows):
//
//   beamhop[.exe]     Node runtime + an embedded launcher (the SEA blob). No Node install needed.
//   lib/              the same bundle as the npm package (bin/, runtime/, package.json) and its
//                     production node_modules for this platform (native addons included).
//
// Why a lib/ directory next to the binary: Node SEA embeds exactly one CommonJS script. It cannot
// embed native addons (`@napi-rs/keyring`'s .node file), srt's vendored helpers, the Claude Agent
// SDK's per-platform Claude Code binary, or files that must exist on disk because they are run as
// separate processes (the sandbox runner, the MCP stdio server, inside the sandbox). So the launcher
// imports the on-disk ESM bundle from lib/, and these ship alongside.
//
// "node-compat" mode: beamhop re-launches `process.execPath <script.mjs> ...` for the sandbox runner
// and the MCP server. In a SEA, process.execPath is this binary, so the launcher runs such a script
// itself — but only scripts inside its own lib/ directory, so the binary is not a general-purpose
// Node interpreter.
//
// Cross-platform: run this on each target OS (see .github/workflows/release.yml). macOS needs
// `codesign` (ad-hoc re-sign after injection; notarization happens in CI), Windows uses the
// unsigned binary (sign in CI with signtool).
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(CLI_DIR, 'dist');
const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const OUT_ROOT = outIdx >= 0 ? resolve(args[outIdx + 1]) : join(CLI_DIR, '..', '..', 'dist', 'standalone');
const archive = !args.includes('--no-archive');

const plat = { linux: 'linux', darwin: 'macos', win32: 'windows' }[process.platform] ?? process.platform;
const win = process.platform === 'win32';
const mac = process.platform === 'darwin';
const SENTINEL = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const sh = (cmd, argv, opts = {}) => {
  const r = spawnSync(cmd, argv, { stdio: 'inherit', shell: win && !cmd.includes('\\'), ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${argv.join(' ')} failed (${r.status})`);
};

if (!existsSync(join(DIST, 'package.json'))) throw new Error('run apps/cli/scripts/build.mjs first');
const pkg = JSON.parse(readFileSync(join(DIST, 'package.json'), 'utf8'));
const name = `beamhop-${pkg.version}-${plat}-${process.arch}`;
const out = join(OUT_ROOT, name);
const lib = join(out, 'lib');
const work = join(OUT_ROOT, `.sea-${plat}-${process.arch}`);
rmSync(out, { recursive: true, force: true });
rmSync(work, { recursive: true, force: true });
mkdirSync(lib, { recursive: true });
mkdirSync(work, { recursive: true });

// 1. Payload: the npm bundle + production deps for this platform.
for (const f of ['bin', 'runtime', 'package.json', 'README.md', 'LICENSE'])
  if (existsSync(join(DIST, f))) cpSync(join(DIST, f), join(lib, f), { recursive: true });
sh(
  'npm',
  ['install', '--omit=dev', '--no-package-lock', '--no-fund', '--no-audit', '--ignore-scripts=false'],
  {
    cwd: lib,
  },
);

// 2. Launcher (CommonJS; the only code embedded in the blob).
const launcher = `'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const lib = real(path.join(path.dirname(process.execPath), 'lib'));
const inside = (p) => { const r = path.relative(lib, p); return r !== '' && !r.startsWith('..') && !path.isAbsolute(r); };
const fail = (m) => { process.stderr.write('beamhop: ' + m + '\\n'); process.exit(1); };
if (!fs.existsSync(path.join(lib, 'bin', 'beamhop.js'))) fail('missing ' + path.join(lib, 'bin') + ' (keep lib/ next to the binary)');
// argv in a SEA: [execPath, execPath, ...userArgs]
const first = process.argv[2];
let entry;
if (first && /\\.(c|m)?js$/.test(first) && path.isAbsolute(first) && inside(real(first))) {
  // node-compat: \`beamhop <lib script> ...\` (sandbox runner, MCP server)
  process.argv.splice(1, 2, real(first));
  entry = real(first);
} else {
  const daemonOnly = /^beamhopd(\\.exe)?$/i.test(path.basename(process.execPath));
  entry = path.join(lib, 'bin', daemonOnly ? 'beamhopd.js' : 'beamhop.js');
  process.argv[1] = entry;
}
import(pathToFileURL(entry).href).catch((e) => fail(e && e.stack ? e.stack : String(e)));
`;
writeFileSync(join(work, 'launcher.cjs'), launcher);
writeFileSync(
  join(work, 'sea-config.json'),
  JSON.stringify({
    main: join(work, 'launcher.cjs'),
    output: join(work, 'sea-prep.blob'),
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
    useSnapshot: false,
  }),
);
sh(process.execPath, ['--experimental-sea-config', join(work, 'sea-config.json')]);

// 3. Inject into a copy of this node binary.
const exe = join(out, win ? 'beamhop.exe' : 'beamhop');
cpSync(process.execPath, exe);
if (!win) chmodSync(exe, 0o755);
if (mac) sh('codesign', ['--remove-signature', exe]);
const postject = createRequire(import.meta.url).resolve('postject/dist/cli.js');
sh(process.execPath, [
  postject,
  exe,
  'NODE_SEA_BLOB',
  join(work, 'sea-prep.blob'),
  '--sentinel-fuse',
  SENTINEL,
  ...(mac ? ['--macho-segment-name', 'NODE_SEA'] : []),
]);
if (mac) sh('codesign', ['--sign', '-', exe]);
rmSync(work, { recursive: true, force: true });

// 4. Smoke: the binary must start and print its version.
const v = spawnSync(exe, ['--version'], { encoding: 'utf8' });
if (v.status !== 0 || v.stdout.trim() !== pkg.version)
  throw new Error(`standalone binary self-test failed: ${v.status} ${v.stdout}${v.stderr}`);
console.log(`built ${exe} (${pkg.version})`);

// 5. Archive.
if (archive) {
  if (win) {
    sh('powershell', [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path '${out}' -DestinationPath '${out}.zip' -Force`,
    ]);
    console.log(`archive ${out}.zip`);
  } else {
    sh('tar', ['-czf', `${name}.tar.gz`, name], { cwd: OUT_ROOT, shell: false });
    console.log(`archive ${join(OUT_ROOT, `${name}.tar.gz`)}`);
  }
}
