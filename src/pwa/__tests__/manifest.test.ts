import { describe, expect, it } from "bun:test";
import { MANIFEST_JSON, manifest } from "../manifest.ts";

describe("web app manifest", () => {
  it("uses a relative start_url so the PWA opens the app root, not a hash route", () => {
    expect(manifest.start_url).toBe(".");
  });

  it("scopes the whole origin", () => {
    expect(manifest.scope).toBe("/");
  });

  it("requests a standalone (installed) display mode", () => {
    expect(manifest.display).toBe("standalone");
  });

  it("carries identity + color fields matching the light theme default", () => {
    expect(manifest.name).toBe("Verity");
    expect(manifest.short_name).toBe("Verity");
    expect(manifest.id).toBe("/");
    expect(manifest.orientation).toBe("portrait");
    expect(manifest.background_color).toBe("#f4f5f7");
    expect(manifest.theme_color).toBe("#f4f5f7");
  });

  it("ships 192 + 512 'any' icons and a maskable icon", () => {
    const sizes = manifest.icons.map((icon) => icon.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");

    const has192 = manifest.icons.some((i) => i.sizes === "192x192" && i.purpose === "any");
    const has512 = manifest.icons.some((i) => i.sizes === "512x512" && i.purpose === "any");
    const hasMaskable = manifest.icons.some((i) => i.purpose === "maskable");
    expect(has192).toBe(true);
    expect(has512).toBe(true);
    expect(hasMaskable).toBe(true);

    for (const icon of manifest.icons) {
      expect(icon.type).toBe("image/png");
      expect(icon.src.startsWith("/icons/")).toBe(true);
    }
  });

  it("MANIFEST_JSON round-trips back to the manifest object", () => {
    expect(JSON.parse(MANIFEST_JSON)).toEqual(manifest);
  });
});
