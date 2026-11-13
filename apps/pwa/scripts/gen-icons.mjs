// Generates the PWA icons (DESIGN §3.10) as SVG and rasterizes them to PNG with headless Chromium.
// Run: pnpm --filter @beamhop/pwa icons   (outputs to public/icons + public/favicon.svg; commit the results)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const out = join(root, 'icons');
mkdirSync(out, { recursive: true });

const FLARE = '#f6641b';
const INK = '#1b1612';
const PAPER = '#f8f5f1';

// The mark (DESIGN §3.10): a transmission slip with the two perforation notches, a hop meter in the
// "what is asked" zone and the carrier square (the wordmark's ■) in the "decision" zone. One beam line
// crosses the tile diagonally *behind* the slip, so it reads as a signal passing through.
// Everything that matters sits inside the 80% maskable safe circle (r = 205 of 512).
const SLIP =
  'M160 100 h192 a20 20 0 0 1 20 20 v160 a24 24 0 0 0 0 48 v84 a20 20 0 0 1 -20 20 h-192 a20 20 0 0 1 -20 -20 v-84 a24 24 0 0 0 0 -48 v-160 a20 20 0 0 1 20 -20 z';
const BEAM = 'M58 454 L454 58';
// Cut-outs drawn in `cut` (or black inside a mask): perforation, 4 ascending hop bars, carrier square.
const cuts = (cut) => `
  <path d="M176 304 H336" stroke="${cut}" stroke-width="6" stroke-dasharray="12 10"/>
  <rect x="180" y="226" width="26" height="36" rx="3" fill="${cut}"/>
  <rect x="222" y="198" width="26" height="64" rx="3" fill="${cut}"/>
  <rect x="264" y="170" width="26" height="92" rx="3" fill="${cut}"/>
  <rect x="306" y="142" width="26" height="120" rx="3" fill="${cut}"/>
  <rect x="180" y="342" width="34" height="34" rx="3" fill="${cut}"/>`;
const mark = (fill, cut, beam) => `
  <path d="${BEAM}" stroke="${beam}" stroke-width="16" stroke-linecap="square"/>
  <path d="${SLIP}" fill="${fill}"/>${cuts(cut)}`;

const icon = (bg, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">${bg}${body}</svg>`;

const svgs = {
  // any: rounded flare tile
  'icon.svg': icon(`<rect width="512" height="512" rx="112" fill="${FLARE}"/>`, mark(INK, FLARE, PAPER)),
  // maskable: full-bleed flare square (platform applies its own mask)
  'maskable.svg': icon(`<rect width="512" height="512" fill="${FLARE}"/>`, mark(INK, FLARE, PAPER)),
  // monochrome (iOS 18 tinted / Android themed): one white silhouette on transparent, cut-outs punched
  'monochrome.svg': icon(
    `<defs><mask id="m"><rect width="512" height="512" fill="#fff"/>${cuts('#000')}</mask></defs>`,
    `<g mask="url(#m)">${mark('#fff', '#fff', '#fff')}</g>`,
  ),
  'shortcut-stop.svg': icon(
    `<rect width="512" height="512" rx="112" fill="${INK}"/>`,
    `<rect x="166" y="166" width="180" height="180" rx="10" fill="${FLARE}"/>`,
  ),
  'shortcut-inbox.svg': icon(
    `<rect width="512" height="512" rx="112" fill="${PAPER}"/>`,
    mark(INK, PAPER, FLARE),
  ),
};

for (const [name, svg] of Object.entries(svgs)) writeFileSync(join(out, name), svg);
// Favicon: at 16px the full mark's hop bars merge into a block, so the tab gets its own glyph drawn on a
// 16-unit pixel grid — slip, three 1px hop bars with 1px gaps and the carrier square; no beam, no
// perforation. Every edge lands on a whole pixel at 16 and 32px (crispEdges).
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" shape-rendering="crispEdges">
  <rect width="16" height="16" rx="3" fill="${FLARE}" shape-rendering="geometricPrecision"/>
  <rect x="4" y="2" width="9" height="12" fill="${INK}"/>
  <rect x="6" y="6" width="1" height="2" fill="${FLARE}"/>
  <rect x="8" y="5" width="1" height="3" fill="${FLARE}"/>
  <rect x="10" y="4" width="1" height="4" fill="${FLARE}"/>
  <rect x="6" y="10" width="2" height="2" fill="${FLARE}"/>
</svg>`;
writeFileSync(join(root, 'favicon.svg'), FAVICON);

const rasters = [
  ['icon.svg', 'icon-192.png', 192],
  ['icon.svg', 'icon-512.png', 512],
  ['maskable.svg', 'maskable-512.png', 512],
  ['maskable.svg', 'apple-touch-icon.png', 180],
  ['monochrome.svg', 'monochrome-512.png', 512],
  ['shortcut-stop.svg', 'shortcut-stop-96.png', 96],
  ['shortcut-inbox.svg', 'shortcut-inbox-96.png', 96],
];

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const [src, dest, size] of rasters) {
  const svg = svgs[src].replace('width="512" height="512"', `width="${size}" height="${size}"`);
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
  await page.locator('svg').screenshot({ path: join(out, dest), omitBackground: true });
}
await browser.close();
console.log(`icons written to ${out}`);
