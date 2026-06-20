/** Production build: bundle the HTML entry (TS/TSX/CSS) into dist/. */
import { access, copyFile, cp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MANIFEST_JSON } from "../src/pwa/manifest.ts";

const OUTDIR = "dist";

await rm(OUTDIR, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: ["src/index.html"],
  outdir: OUTDIR,
  minify: true,
  sourcemap: "linked",
  naming: "[dir]/[name]-[hash].[ext]",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const htmlFiles = (await readdir(OUTDIR)).filter((file) => file.endsWith(".html"));
if (htmlFiles.length !== 1) {
  console.error(`Expected one HTML entrypoint in ${OUTDIR}/, found ${htmlFiles.length}`);
  process.exit(1);
}

const bundledHtml = join(OUTDIR, htmlFiles[0] ?? "");
const indexHtml = join(OUTDIR, "index.html");
if (bundledHtml !== indexHtml) await rename(bundledHtml, indexHtml);

await copyFile(indexHtml, join(OUTDIR, "404.html"));
await writeFile(join(OUTDIR, "CNAME"), "app.beamhop.com\n");
await writeFile(join(OUTDIR, ".nojekyll"), "");

// PWA: emit the web app manifest and copy the static public/ tree (icons, …).
// The manifest <link> + apple-touch-icon are injected at runtime in main.tsx, so
// the HTML entry stays free of asset hrefs Bun's bundler would fail to resolve.
await writeFile(join(OUTDIR, "manifest.webmanifest"), MANIFEST_JSON);

const PUBLIC_DIR = "public";
const hasPublic = await access(PUBLIC_DIR).then(
  () => true,
  () => false,
);
if (hasPublic) await cp(PUBLIC_DIR, OUTDIR, { recursive: true });

const outputs = await readdir(OUTDIR);
console.log(`Built ${outputs.length} artifacts into ${OUTDIR}/`);
for (const out of outputs) console.log(`  ${join(OUTDIR, out)}`);
