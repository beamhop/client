/**
 * Web App Manifest for installable PWA (online-only — no service worker).
 *
 * Served at /manifest.webmanifest in both dev (src/server.ts) and prod
 * (scripts/build.ts writes it into dist/). Colors mirror the LIGHT theme
 * default (tokens.css `--bg-base` #fafafa); a runtime <meta name="theme-color">
 * updater (owned by another agent) swaps the live tag per active theme.
 */

type ManifestPurpose = "any" | "maskable" | "monochrome";

interface ManifestIcon {
  readonly src: string;
  readonly sizes: string;
  readonly type: string;
  readonly purpose: ManifestPurpose;
}

interface WebAppManifest {
  readonly name: string;
  readonly short_name: string;
  readonly description: string;
  readonly id: string;
  readonly start_url: string;
  readonly scope: string;
  readonly display: "standalone" | "fullscreen" | "minimal-ui" | "browser";
  readonly orientation: "portrait" | "landscape" | "any";
  readonly background_color: string;
  readonly theme_color: string;
  readonly icons: readonly ManifestIcon[];
}

export const manifest: WebAppManifest = {
  name: "Beamhop",
  short_name: "Beamhop",
  description: "Nostr, signed and clear",
  id: "/",
  start_url: ".",
  scope: "/",
  display: "standalone",
  orientation: "portrait",
  background_color: "#fafafa",
  theme_color: "#fafafa",
  icons: [
    { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    {
      src: "/icons/icon-512-maskable.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "maskable",
    },
  ],
};

export const MANIFEST_JSON: string = JSON.stringify(manifest);
