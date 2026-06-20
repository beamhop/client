/** Production build: bundle the HTML entry (TS/TSX/CSS) into dist/. */
import { rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: ["src/index.html"],
  outdir: "dist",
  minify: true,
  sourcemap: "linked",
  naming: "[dir]/[name]-[hash].[ext]",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

console.log(`Built ${result.outputs.length} artifacts into dist/`);
for (const out of result.outputs) console.log(`  ${out.path.replace(process.cwd() + "/", "")}`);
