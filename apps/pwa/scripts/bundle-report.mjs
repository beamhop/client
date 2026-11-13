#!/usr/bin/env node
/**
 * Boot-path size report for the built PWA (`pnpm build` first).
 *
 * "Main" = the entry script plus every chunk it imports statically (what the browser must download
 * before first render, i.e. index.html's entry + modulepreload links). Lazy chunks are listed apart.
 * Usage: node scripts/bundle-report.mjs [distDir] [--budget=350]
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const args = process.argv.slice(2);
const dist = resolve(args.find((a) => !a.startsWith('--')) ?? 'dist');
const budget = Number(args.find((a) => a.startsWith('--budget='))?.split('=')[1] ?? 350);

const html = readFileSync(join(dist, 'index.html'), 'utf8');
const entry = [...html.matchAll(/<script[^>]+type="module"[^>]+src="\/?([^"]+)"/g)].map((m) => m[1]);
const preloads = [...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="\/?([^"]+)"/g)].map((m) => m[1]);
const css = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="\/?([^"]+)"/g)].map((m) => m[1]);

// Follow static `import … from "./x.js"` edges too (covers chunks Vite did not preload-link).
const seen = new Set();
const walk = (file) => {
  if (seen.has(file)) return;
  seen.add(file);
  const src = readFileSync(join(dist, file), 'utf8');
  for (const m of src.matchAll(/(?:^|[;\s}])import\s*(?:[\w*{}\s,$]+from\s*)?["']\.\/([^"']+\.js)["']/g)) {
    walk(join('assets', m[1]));
  }
};
for (const f of [...entry, ...preloads]) walk(f);

const gz = (f) => gzipSync(readFileSync(join(dist, f)), { level: 9 }).length;
const kb = (n) => `${(n / 1000).toFixed(1)} kB`;
const rows = [...seen].map((f) => [f, gz(f)]).sort((a, b) => b[1] - a[1]);
const mainJs = rows.reduce((s, [, n]) => s + n, 0);
const cssGz = css.reduce((s, f) => s + gz(f), 0);

console.log('Boot path (gzip -9):');
for (const [f, n] of rows) console.log(`  ${kb(n).padStart(10)}  ${f}`);
console.log(`  ${kb(mainJs).padStart(10)}  = main JS`);
console.log(`  ${kb(cssGz).padStart(10)}  CSS (${css.join(', ')})`);

const lazy = readdirSync(join(dist, 'assets'))
  .filter((f) => f.endsWith('.js') && !seen.has(join('assets', f)))
  .map((f) => [f, gz(join('assets', f))])
  .sort((a, b) => b[1] - a[1])
  .slice(0, 12);
console.log('\nLargest lazy chunks:');
for (const [f, n] of lazy) console.log(`  ${kb(n).padStart(10)}  ${f}`);

if (mainJs / 1000 > budget) {
  console.error(`\nmain JS ${kb(mainJs)} is over the ${budget} kB budget`);
  process.exit(1);
}
