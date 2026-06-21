import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = (rel: string): string => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));

describe("committed PWA icon assets", () => {
  const icons = [
    "public/icons/icon-192.png",
    "public/icons/icon-512.png",
    "public/icons/icon-512-maskable.png",
    "public/icons/apple-touch-icon-180.png",
  ];

  for (const icon of icons) {
    it(`ships ${icon}`, () => {
      expect(existsSync(repoRoot(icon))).toBe(true);
    });
  }
});

describe("build script emits the manifest", () => {
  it("references manifest.webmanifest and copies public/ into dist", async () => {
    const build = await Bun.file(repoRoot("scripts/build.ts")).text();
    expect(build).toContain("manifest.webmanifest");
    expect(build).toContain("MANIFEST_JSON");
    expect(build).toContain('cp(PUBLIC_DIR, OUTDIR, { recursive: true })');
  });
});
