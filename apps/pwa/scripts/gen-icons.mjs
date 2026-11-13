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

// A transmission slip (ink, notched at the perforation) crossed by one diagonal beam line with a node.
// Everything that matters sits inside the 80% maskable safe circle (r = 205 of 512).
const slip = (fill, cut, beam) => `
  <path d="M150 112 h212 a14 14 0 0 1 14 14 v170 a22 22 0 0 0 0 44 v46 a14 14 0 0 1 -14 14 h-212 a14 14 0 0 1 -14 -14 v-46 a22 22 0 0 0 0 -44 v-170 a14 14 0 0 1 14 -14 z" fill="${fill}"/>
  <path d="M168 318 H344" stroke="${cut}" stroke-width="5" stroke-dasharray="10 12" stroke-linecap="butt"/>
  <path d="M182 172 H300 M182 214 H258 M182 256 H284" stroke="${cut}" stroke-width="16" stroke-linecap="square" opacity="0.9"/>
  <path d="M96 420 L416 100" stroke="${beam}" stroke-width="14" stroke-linecap="square"/>
  <circle cx="256" cy="260" r="24" fill="${beam}"/>
  <circle cx="256" cy="260" r="11" fill="${fill === 'none' ? beam : fill}"/>`;

const icon = (bg, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">${bg}${body}</svg>`;

const svgs = {
  // any: rounded flare tile
  'icon.svg': icon(`<rect width="512" height="512" rx="112" fill="${FLARE}"/>`, slip(INK, FLARE, PAPER)),
  // maskable: full-bleed flare square (platform applies its own mask)
  'maskable.svg': icon(`<rect width="512" height="512" fill="${FLARE}"/>`, slip(INK, FLARE, PAPER)),
  // monochrome (iOS 18 tinted / Android themed): white shapes on transparent
  'monochrome.svg': icon(
    `<defs><mask id="m"><rect width="512" height="512" fill="#fff"/>${slip('none', '#000', '#000').replace(/fill="none"/, 'fill="none"')}</mask></defs>`,
    `<g mask="url(#m)">${slip('#fff', '#fff', '#fff')}</g><path d="M96 420 L150 366 M362 154 L416 100" stroke="#fff" stroke-width="14" stroke-linecap="square"/>`,
  ),
  'shortcut-stop.svg': icon(`<rect width="512" height="512" rx="112" fill="${INK}"/>`, `<rect x="166" y="166" width="180" height="180" rx="10" fill="${FLARE}"/>`),
  'shortcut-inbox.svg': icon(`<rect width="512" height="512" rx="112" fill="${PAPER}"/>`, slip(INK, PAPER, FLARE)),
};

for (const [name, svg] of Object.entries(svgs)) writeFileSync(join(out, name), svg);
writeFileSync(join(root, 'favicon.svg'), svgs['icon.svg']);

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
