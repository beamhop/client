import { describe, expect, it } from "bun:test";

const html = await Bun.file(new URL("../../index.html", import.meta.url)).text();
const mainTsx = await Bun.file(new URL("../../main.tsx", import.meta.url)).text();

describe("index.html PWA head tags", () => {
  it("opts into iOS standalone web-app mode", () => {
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
    expect(html).toContain('name="mobile-web-app-capable" content="yes"');
  });

  it("covers the notch via viewport-fit=cover", () => {
    expect(html).toContain("viewport-fit=cover");
  });

  it("sets a static theme-color (runtime updater swaps it per theme)", () => {
    expect(html).toContain('name="theme-color"');
    expect(html).toContain('content="#f4f5f7"');
  });
});

describe("runtime-injected PWA links (main.tsx)", () => {
  it("links the web app manifest at runtime", () => {
    expect(mainTsx).toContain("/manifest.webmanifest");
    expect(mainTsx).toContain('addHeadLink("manifest"');
  });

  it("declares an apple-touch-icon at runtime", () => {
    expect(mainTsx).toContain('addHeadLink("apple-touch-icon"');
    expect(mainTsx).toContain("/icons/apple-touch-icon-180.png");
  });
});
