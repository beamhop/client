#!/usr/bin/env node
// One semver version for all of beamhop: the CLI (npm package and standalone binary), the daemon, the
// desktop app and the web UI ship together, so every package.json in the repo carries the same version.
// The code reads it from @beamhop/core (packages/core/src/version.ts); the desktop build stamps it on
// the app; the release workflow checks the vX.Y.Z tag against it.
//
//   node scripts/version.mjs                  print the version
//   node scripts/version.mjs check            fail if any package.json differs or is not semver
//   node scripts/version.mjs set 1.2.3        set every package.json to 1.2.3
//   node scripts/version.mjs patch|minor|major  bump from the current version
//
// It never tags or publishes: tag `vX.Y.Z` yourself once the release commit is on main (the tag starts
// the release workflow, which publishes).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = 'apps/cli/package.json';
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

export const manifests = (repo = REPO) =>
  ['apps', 'packages']
    .flatMap((dir) =>
      readdirSync(join(repo, dir), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => join(repo, dir, e.name, 'package.json')),
    )
    .filter((p) => {
      try {
        readFileSync(p);
        return true;
      } catch {
        return false;
      }
    });

const read = (p) => JSON.parse(readFileSync(p, 'utf8'));

export const bump = (v, kind) => {
  const m = SEMVER.exec(v);
  if (!m) throw new Error(`${v} is not a semver version`);
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (kind === 'major') return `${maj + 1}.0.0`;
  if (kind === 'minor') return `${maj}.${min + 1}.0`;
  if (kind === 'patch') return `${maj}.${min}.${pat + 1}`;
  throw new Error(`unknown bump ${kind}`);
};

/** Problems with the versions under `repo` (empty when they are all the same semver version). */
export const problems = (repo = REPO) => {
  const want = read(join(repo, SOURCE)).version;
  const out = [];
  if (!SEMVER.test(want ?? '')) out.push(`${SOURCE}: "${want}" is not a semver version`);
  for (const p of manifests(repo)) {
    const v = read(p).version;
    if (v !== want) out.push(`${relative(repo, p)}: ${v} (expected ${want})`);
  }
  return out;
};

const setAll = (version, repo = REPO) => {
  if (!SEMVER.test(version)) throw new Error(`${version} is not a semver version (x.y.z)`);
  for (const p of manifests(repo)) {
    const raw = readFileSync(p, 'utf8');
    // Replace only the top-level "version" field, keeping the file's own formatting.
    const next = raw.replace(/^(\s*"version":\s*)"[^"]*"/m, `$1"${version}"`);
    if (next === raw && read(p).version !== version) throw new Error(`${p}: no "version" field to set`);
    writeFileSync(p, next);
  }
};

const main = () => {
  const [cmd, arg] = process.argv.slice(2);
  const current = read(join(REPO, SOURCE)).version;
  if (!cmd) return console.log(current);
  if (cmd === 'check') {
    const bad = problems();
    if (bad.length) {
      console.error(`versions differ (run: node scripts/version.mjs set ${current}):\n  ${bad.join('\n  ')}`);
      process.exit(1);
    }
    return console.log(`all packages at ${current}`);
  }
  const next = cmd === 'set' ? arg : bump(current, cmd);
  if (!next) throw new Error('usage: node scripts/version.mjs [check | set x.y.z | patch | minor | major]');
  setAll(next);
  console.log(
    `${current} -> ${next} (${manifests().length} packages). Update CHANGELOG.md, commit, then tag v${next}.`,
  );
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
}
