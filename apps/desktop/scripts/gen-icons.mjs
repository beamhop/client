// Rasterize the desktop app icons from the PWA's SVG mark (apps/pwa/public/icons) with headless Chromium.
// Run: pnpm --filter @beamhop/desktop icons   (writes apps/desktop/assets; commit the results)
//
//   icon.png               1024×1024 app icon (macOS grid: the tile is 824 px with transparent margin;
//                          electron-builder derives .icns / .ico / Linux sizes from it)
//   trayTemplate.png(@2x)  macOS menu bar template: black + alpha, 18 pt
//   tray.png(@2x)          Windows / Linux tray: the colored tile, 16 / 32 px
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const PWA_ICONS = join(REPO, 'apps/pwa/public/icons');
const OUT = join(HERE, '..', 'assets');
mkdirSync(OUT, { recursive: true });

// Playwright is a dev dependency of the PWA; reuse it rather than adding another copy.
const { chromium } = createRequire(join(REPO, 'apps/pwa/package.json'))('@playwright/test');

const svg = (name) => readFileSync(join(PWA_ICONS, name), 'utf8');
/** monochrome.svg is white-on-transparent (Android); a macOS template image must be black + alpha. Keep the mask as is. */
const blackMono = () => {
  const [defs, body] = svg('monochrome.svg').split('</defs>');
  return `${defs}</defs>${body.replaceAll('#fff', '#000')}`;
};
/** Re-frame an SVG: show `viewBox` of the original, drawn at `size` px inside a `canvas` px square. */
const framed = (src, { viewBox, size, canvas }) => {
  const inner = src.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  const off = (canvas - size) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas}" height="${canvas}" viewBox="0 0 ${canvas} ${canvas}">
    <svg x="${off}" y="${off}" width="${size}" height="${size}" viewBox="${viewBox}">${inner}</svg></svg>`;
};

const jobs = [
  { file: 'icon.png', src: framed(svg('icon.svg'), { viewBox: '0 0 512 512', size: 824, canvas: 1024 }) },
  // The mark spans roughly 58..454 of the 512 grid; crop to it so it reads at menu bar size.
  ...[1, 2].map((s) => ({
    file: s === 1 ? 'trayTemplate.png' : 'trayTemplate@2x.png',
    src: framed(blackMono(), { viewBox: '48 48 416 416', size: 18 * s, canvas: 18 * s }),
  })),
  ...[1, 2].map((s) => ({
    file: s === 1 ? 'tray.png' : 'tray@2x.png',
    src: framed(svg('icon.svg'), { viewBox: '0 0 512 512', size: 16 * s, canvas: 16 * s }),
  })),
];

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const { file, src } of jobs) {
    const px = Number(/width="(\d+)"/.exec(src)[1]);
    await page.setViewportSize({ width: px, height: px });
    await page.setContent(
      `<html><body style="margin:0;background:transparent">${src.replace('<svg ', '<svg style="display:block" ')}</body></html>`,
    );
    await page.screenshot({
      path: join(OUT, file),
      omitBackground: true,
      clip: { x: 0, y: 0, width: px, height: px },
    });
    console.log(`wrote assets/${file} (${px}px)`);
  }
} finally {
  await browser.close();
}
