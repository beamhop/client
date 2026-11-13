#!/usr/bin/env node
// Bundle beamhop (CLI + daemon + MCP entry + runtime assets + built PWA) into apps/cli/dist,
// a self-contained npm package directory:
//
//   node apps/cli/scripts/build.mjs [--skip-pwa]     then   npm pack apps/cli/dist
//
// Layout of dist/ (= the published package root):
//
//   package.json            generated: name "beamhop", bins, only the native/external deps
//   bin/beamhop.js          CLI entry (ESM, node22). Lazily imports the daemon chunk.
//   bin/beamhopd.js         daemon entry
//   bin/chunk-*.js          shared code-split chunks
//   runtime/<repo path>     files workspace packages look up at runtime, mirrored at their repo path:
//     packages/harness-catalog/catalog.json
//     packages/sandbox/src/runner.mjs              (host-side srt runner, spawned with node)
//     packages/harness-pi/extension/beamhop-gate.mjs
//     packages/harness-kit/fixtures/fake-acp-agent.mjs
//     packages/mcp/dist/bin/beamhop-mcp.js        (self-contained MCP stdio server bundle)
//     apps/pwa/dist/**                            (built PWA, served by the daemon)
//
// Runtime path resolution: workspace sources find their files with `new URL('../x', import.meta.url)`.
// When bundled, `import.meta.url` would point at bin/*.js, so the `runtime-paths` esbuild plugin below
// rewrites `import.meta.url` in every workspace module to the URL that module *would* have under
// runtime/<repo path>. Every relative lookup (catalog, runner, pi gate, MCP entry via mcpServerSpec,
// PWA dist via defaultStaticDir, createRequire bases) then resolves inside the package unchanged.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const CLI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = resolve(CLI_DIR, '..', '..');
export const DIST = join(CLI_DIR, 'dist');
const BIN = join(DIST, 'bin');
const RUNTIME = join(DIST, 'runtime');

/**
 * Not bundled: native addons / packages that locate their own files or platform binaries at runtime.
 * They become regular `dependencies` of the published package.
 */
export const EXTERNAL_DEPS = [
  '@napi-rs/keyring', // N-API addon, per-platform optional packages
  '@anthropic-ai/sandbox-runtime', // srt: imported by runner.mjs, ships vendored helpers
  '@anthropic-ai/claude-agent-sdk', // resolves its bundled CLI and per-platform binaries
];
/**
 * Externals the daemon degrades without, published as optionalDependencies so a failed install of
 * one (no prebuilt addon for the platform, blocked download) does not fail `npm i -g beamhop`:
 * the keychain falls back to the encrypted vault / memory, and the Claude harness plugin is skipped
 * (its chunk fails to load, which the registry treats as "not installed").
 */
const OPTIONAL_EXTERNAL = new Set(['@napi-rs/keyring', '@anthropic-ai/claude-agent-sdk']);
/** Optional peer/native accelerators some deps try to `require` (absent is fine). */
const OPTIONAL_NATIVE = [
  'bufferutil',
  'utf-8-validate',
  'zlib-sync',
  'erlpack',
  '@discordjs/opus',
  'ffmpeg-static',
  'sodium-native',
  'libsodium-wrappers',
];

/** Runtime assets (repo-relative), copied to runtime/<same path>. */
export const RUNTIME_FILES = [
  'packages/harness-catalog/catalog.json',
  'packages/sandbox/src/runner.mjs',
  'packages/harness-pi/extension/beamhop-gate.mjs',
  'packages/harness-kit/fixtures/fake-acp-agent.mjs',
];
const PWA_DIST = 'apps/pwa/dist';
const MCP_OUT = 'packages/mcp/dist/bin/beamhop-mcp.js';

const toPosix = (p) => p.split(sep).join('/');

/**
 * esbuild plugin: rewrite `import.meta.url` in workspace sources (not node_modules) to the module's
 * mirrored location under runtime/. `outDir` is the directory the importing output file lives in;
 * with code splitting every chunk sits in the same directory as the entries, so one base works.
 */
export const runtimePathsPlugin = (outDir, runtimeDir = RUNTIME) => ({
  name: 'runtime-paths',
  setup(b) {
    b.onLoad({ filter: /\.(ts|mts|js|mjs)$/ }, (args) => {
      if (args.path.includes(`${sep}node_modules${sep}`)) return undefined;
      if (!args.path.startsWith(REPO + sep)) return undefined;
      const src = readFileSync(args.path, 'utf8');
      if (!src.includes('import.meta.url')) return undefined;
      const mirrored = join(runtimeDir, relative(REPO, args.path));
      const rel = toPosix(relative(outDir, mirrored));
      const contents = src.replaceAll(
        'import.meta.url',
        `new URL(${JSON.stringify(rel)}, import.meta.url).href`,
      );
      return { contents, loader: /\.m?ts$/.test(args.path) ? 'ts' : 'js' };
    });
  },
});

/** ESM bundles that pull in CommonJS deps need a real `require` (for node builtins). */
const BANNER = [
  "import { createRequire as __bhCreateRequire } from 'node:module';",
  'const require = __bhCreateRequire(import.meta.url);',
].join('\n');

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
  external: [...EXTERNAL_DEPS, ...OPTIONAL_NATIVE],
  banner: { js: BANNER },
  // Workspace packages export TS sources; prefer ESM entry points of deps.
  mainFields: ['module', 'main'],
  conditions: ['node', 'import'],
};

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

/** Version range of an external dep, as declared by the workspace package that depends on it. */
const declaredRange = (dep) => {
  const dirs = ['apps/cli', 'apps/daemon', ...listPackages()];
  for (const d of dirs) {
    const pj = join(REPO, d, 'package.json');
    if (!existsSync(pj)) continue;
    const range = readJson(pj).dependencies?.[dep];
    if (range) return range;
  }
  throw new Error(`no workspace package declares ${dep}`);
};
const listPackages = () => readdirSync(join(REPO, 'packages')).map((n) => `packages/${n}`);

const ensurePwa = (skip) => {
  if (existsSync(join(REPO, PWA_DIST, 'index.html'))) return;
  if (skip) {
    console.warn('warning: apps/pwa/dist missing; the bundle will ship without the web UI');
    return;
  }
  console.log('building PWA…');
  const r = spawnSync('pnpm', ['--filter', '@beamhop/pwa', 'run', 'build'], {
    cwd: REPO,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (r.status !== 0) throw new Error('PWA build failed');
};

export const buildBundle = async ({ skipPwa = false } = {}) => {
  ensurePwa(skipPwa);
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(BIN, { recursive: true });

  // 1. CLI + daemon, code-split so `beamhop --help` does not load the daemon.
  await build({
    ...common,
    entryPoints: {
      beamhop: join(REPO, 'apps/cli/src/main.ts'),
      beamhopd: join(REPO, 'apps/daemon/src/main.ts'),
    },
    outdir: BIN,
    splitting: true,
    entryNames: '[name]',
    chunkNames: 'chunk-[hash]',
    plugins: [runtimePathsPlugin(BIN)],
  });

  // 2. MCP stdio server: one self-contained file (it runs inside the sandbox).
  const mcpOut = join(RUNTIME, MCP_OUT);
  await build({
    ...common,
    entryPoints: [join(REPO, 'packages/mcp/bin/beamhop-mcp.ts')],
    outfile: mcpOut,
    plugins: [runtimePathsPlugin(dirname(mcpOut))],
  });

  // 3. Runtime assets.
  for (const f of RUNTIME_FILES) {
    mkdirSync(dirname(join(RUNTIME, f)), { recursive: true });
    cpSync(join(REPO, f), join(RUNTIME, f));
  }
  if (existsSync(join(REPO, PWA_DIST)))
    cpSync(join(REPO, PWA_DIST), join(RUNTIME, PWA_DIST), { recursive: true });

  // 4. Package manifest + docs.
  const src = readJson(join(CLI_DIR, 'package.json'));
  const manifest = {
    name: 'beamhop',
    version: src.version,
    description: src.description,
    license: 'Apache-2.0',
    type: 'module',
    homepage: 'https://github.com/beamhop/client#readme',
    repository: { type: 'git', url: 'git+https://github.com/beamhop/client.git' },
    bugs: { url: 'https://github.com/beamhop/client/issues' },
    keywords: [
      'ai',
      'agents',
      'nostr',
      'telegram',
      'slack',
      'discord',
      'sandbox',
      'mcp',
      'acp',
      'claude',
      'codex',
    ],
    engines: { node: '>=22.12' },
    bin: {
      beamhop: 'bin/beamhop.js',
      beamhopd: 'bin/beamhopd.js',
      'beamhop-mcp': `runtime/${MCP_OUT}`,
    },
    files: ['bin', 'runtime', 'README.md', 'LICENSE'],
    dependencies: Object.fromEntries(
      EXTERNAL_DEPS.filter((d) => !OPTIONAL_EXTERNAL.has(d)).map((d) => [d, declaredRange(d)]),
    ),
    optionalDependencies: Object.fromEntries([...OPTIONAL_EXTERNAL].map((d) => [d, declaredRange(d)])),
    publishConfig: { access: 'public' },
  };
  writeFileSync(join(DIST, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const f of ['README.md', 'LICENSE'])
    if (existsSync(join(REPO, f))) cpSync(join(REPO, f), join(DIST, f));
  return manifest;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const m = await buildBundle({ skipPwa: process.argv.includes('--skip-pwa') });
  console.log(`built ${m.name}@${m.version} -> ${toPosix(relative(REPO, DIST))}`);
}
