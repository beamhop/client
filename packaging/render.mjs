#!/usr/bin/env node
// Render the Homebrew formula, Scoop manifest and winget manifests from the templates in packaging/
// and a release's SHA256SUMS:
//
//   node packaging/render.mjs --version 0.1.0 --checksums assets/SHA256SUMS \
//     --repo beamhop/beamhop --out assets/manifests
//
// Placeholders: {{VERSION}}, {{REPO}} (owner/name), {{OWNER}}, {{SHA256_<TARGET>}} where TARGET is
// the archive's target upper-cased (LINUX_X64, LINUX_ARM64, MACOS_X64, MACOS_ARM64, WINDOWS_X64).
// A placeholder left unfilled (missing archive) fails the render instead of shipping a broken file.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
};

/** Parse `sha256sum` output into { LINUX_X64: '<hex>', ... } for beamhop-<version>-<target>.(tar.gz|zip). */
export const parseChecksums = (text, version) => {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([a-f0-9]{64})\s+\*?(\S+)$/.exec(line.trim());
    if (!m) continue;
    const t = new RegExp(
      `^beamhop-${version.replaceAll('.', '\\.')}-([a-z]+-[a-z0-9]+)\\.(?:tar\\.gz|zip)$`,
    ).exec(m[2]);
    if (t) out[t[1].replace('-', '_').toUpperCase()] = m[1];
  }
  return out;
};

export const render = (template, vars) =>
  template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (all, k) => (k in vars ? vars[k] : all));

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.tmpl') ? [join(dir, e.name)] : [],
  );

const main = () => {
  const version = arg('version');
  const repo = arg('repo', 'beamhop/beamhop');
  const out = arg('out', join(HERE, 'out'));
  const sums = parseChecksums(readFileSync(arg('checksums'), 'utf8'), version);
  const vars = { VERSION: version, REPO: repo, OWNER: repo.split('/')[0], ...prefix(sums) };
  let failed = false;
  for (const file of walk(HERE)) {
    const rel = relative(HERE, file).replace(/\.tmpl$/, '');
    const text = render(readFileSync(file, 'utf8'), vars);
    const left = [...text.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map((m) => m[1]);
    if (left.length) {
      console.error(`${rel}: unfilled ${[...new Set(left)].join(', ')}`);
      failed = true;
      continue;
    }
    mkdirSync(dirname(join(out, rel)), { recursive: true });
    writeFileSync(join(out, rel), text);
    console.log(`rendered ${join(out, rel)}`);
  }
  if (failed) process.exit(1);
};
const prefix = (sums) => Object.fromEntries(Object.entries(sums).map(([k, v]) => [`SHA256_${k}`, v]));

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
