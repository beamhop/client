import { describe, expect, test } from "bun:test";
import {
  PALETTES,
  PALETTE_ORDER,
  applyPalette,
  loadPalette,
  loadTheme,
  paletteBanner,
  savePalette,
  saveTheme,
} from "../theme.ts";

describe("theme persistence", () => {
  test("defaults to light when nothing is stored", () => {
    expect(loadTheme()).toBe("light");
  });

  test("round-trips the theme mode through localStorage", () => {
    saveTheme("dark");
    expect(loadTheme()).toBe("dark");
    saveTheme("light");
    expect(loadTheme()).toBe("light");
  });

  test("an unrecognized stored theme falls back to light", () => {
    localStorage.setItem("beamhop.theme.v1", "neon");
    expect(loadTheme()).toBe("light");
  });
});

describe("palette persistence", () => {
  test("defaults to White when nothing is stored", () => {
    expect(loadPalette()).toBe("White");
  });

  test("round-trips a valid palette id", () => {
    savePalette("Cobalt");
    expect(loadPalette()).toBe("Cobalt");
  });

  test("an unknown stored palette falls back to White", () => {
    localStorage.setItem("beamhop.palette.v1", "Chartreuse");
    expect(loadPalette()).toBe("White");
  });

  test("every id in PALETTE_ORDER has a defined palette", () => {
    for (const id of PALETTE_ORDER) expect(PALETTES[id]).toBeDefined();
  });
});

describe("palette rendering", () => {
  test("paletteBanner returns the palette's banner gradient", () => {
    expect(paletteBanner("Cobalt")).toBe(PALETTES.Cobalt.banner);
  });

  test("applyPalette writes the light tones as CSS custom properties", () => {
    const el = document.createElement("div");
    applyPalette(el, "Pine", "light");
    expect(el.style.getPropertyValue("--accent")).toBe(PALETTES.Pine.light.a);
    expect(el.style.getPropertyValue("--accent-soft")).toBe(PALETTES.Pine.light.soft);
    expect(el.style.getPropertyValue("--accent-ink")).toBe(PALETTES.Pine.light.ink);
    // Pine has no onAccent override, so it falls back to white.
    expect(el.style.getPropertyValue("--on-accent")).toBe("#ffffff");
  });

  test("applyPalette uses dark tones and honors an onAccent override", () => {
    const el = document.createElement("div");
    applyPalette(el, "White", "dark");
    expect(el.style.getPropertyValue("--accent")).toBe(PALETTES.White.dark.a);
    expect(el.style.getPropertyValue("--on-accent")).toBe(PALETTES.White.dark.onAccent ?? "#ffffff");
  });
});
