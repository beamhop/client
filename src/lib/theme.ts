export type ThemeMode = "light" | "dark";
export type PaletteId = "Ember" | "White" | "Crimson" | "Pine" | "Cobalt";

type PaletteTones = { a: string; a2: string; soft: string; ink: string; onAccent?: string };
type Palette = { banner: string; light: PaletteTones; dark: PaletteTones };

export const PALETTES: Record<PaletteId, Palette> = {
  Ember: {
    banner: "linear-gradient(120deg,#e0563a,#f0913e 55%,#ef4d6b)",
    light: { a: "#e0563a", a2: "#f0913e", soft: "rgba(224,86,58,.13)", ink: "#c4452a" },
    dark: { a: "#ff7a52", a2: "#ffab63", soft: "rgba(255,122,82,.18)", ink: "#ff9270" },
  },
  White: {
    banner: "#1b1c20",
    light: { a: "#1b1c20", a2: "#1b1c20", soft: "rgba(27,28,32,.07)", ink: "#000000", onAccent: "#ffffff" },
    dark: { a: "#ffffff", a2: "#ffffff", soft: "rgba(255,255,255,.13)", ink: "#ffffff", onAccent: "#0c0d11" },
  },
  Crimson: {
    banner: "linear-gradient(120deg,#e0335f,#f5617e 55%,#f59e0b)",
    light: { a: "#e0335f", a2: "#f5617e", soft: "rgba(224,51,95,.13)", ink: "#c11d49" },
    dark: { a: "#ff5a7d", a2: "#ff8aa0", soft: "rgba(255,90,125,.18)", ink: "#ff7090" },
  },
  Pine: {
    banner: "linear-gradient(120deg,#0e8f7e,#18b89a 55%,#2f7bd0)",
    light: { a: "#0e8f7e", a2: "#18b89a", soft: "rgba(14,143,126,.14)", ink: "#0a7567" },
    dark: { a: "#2fd0b4", a2: "#4fe0c5", soft: "rgba(47,208,180,.18)", ink: "#5fe0c8" },
  },
  Cobalt: {
    banner: "linear-gradient(120deg,#2f5fe0,#1f9be0 55%,#16c8d8)",
    light: { a: "#2f5fe0", a2: "#1f9be0", soft: "rgba(47,95,224,.13)", ink: "#1d44c4" },
    dark: { a: "#5a8bff", a2: "#4fc0ff", soft: "rgba(90,139,255,.18)", ink: "#7aa0ff" },
  },
};

export const PALETTE_ORDER: readonly PaletteId[] = ["Ember", "White", "Crimson", "Pine", "Cobalt"];

export const paletteBanner = (id: PaletteId): string => PALETTES[id].banner;

/** Push the active palette's accent variables onto an element (the app root). */
export const applyPalette = (el: HTMLElement, id: PaletteId, mode: ThemeMode): void => {
  const tones = mode === "dark" ? PALETTES[id].dark : PALETTES[id].light;
  el.style.setProperty("--accent", tones.a);
  el.style.setProperty("--accent-2", tones.a);
  el.style.setProperty("--accent-soft", tones.soft);
  el.style.setProperty("--accent-ink", tones.ink);
  el.style.setProperty("--on-accent", tones.onAccent ?? "#ffffff");
  el.style.setProperty("--grad", tones.a);
};

const THEME_KEY = "verity.theme.v1";
const PALETTE_KEY = "verity.palette.v1";

export const loadTheme = (): ThemeMode => (localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light");
export const saveTheme = (mode: ThemeMode): void => localStorage.setItem(THEME_KEY, mode);

export const loadPalette = (): PaletteId => {
  const saved = localStorage.getItem(PALETTE_KEY);
  return saved && (PALETTE_ORDER as readonly string[]).includes(saved) ? (saved as PaletteId) : "Ember";
};
export const savePalette = (id: PaletteId): void => localStorage.setItem(PALETTE_KEY, id);
