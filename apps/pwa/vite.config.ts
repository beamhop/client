import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const shim = fileURLToPath(new URL('./src/shims/node-empty.ts', import.meta.url));

/**
 * Content-Security-Policy for the built app (review wave C PWA-1). The hosted copy (static hosting,
 * no response headers) holds the device key in IndexedDB, so it carries its own policy as a meta
 * tag; the daemon's header policy still applies on top for the local copy. Build only: the dev
 * server injects inline scripts. `frame-ancestors` cannot be set from a meta tag; static hosts
 * should send it as a header.
 */
export const PWA_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' ws: wss: https:",
  "font-src 'self' data:",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const cspMeta = (): Plugin => ({
  name: 'beamhop-csp-meta',
  apply: 'build',
  transformIndexHtml: () => [
    {
      tag: 'meta',
      attrs: { 'http-equiv': 'Content-Security-Policy', content: PWA_CSP },
      injectTo: 'head-prepend',
    },
  ],
});

export default defineConfig({
  plugins: [
    cspMeta(),
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['boot.js', 'push-sw.js', 'favicon.svg', 'icons/*.png', 'icons/*.svg'],
      manifest: {
        id: '/',
        name: 'beamhop',
        short_name: 'beamhop',
        description: 'Control panel for your AI agents: sessions, approvals, channels and sandbox policy.',
        lang: 'en',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#f8f5f1',
        theme_color: '#f8f5f1',
        categories: ['developer', 'productivity', 'utilities'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icons/monochrome-512.png', sizes: '512x512', type: 'image/png', purpose: 'monochrome' },
          { src: 'icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
        shortcuts: [
          {
            name: 'Stop everything',
            short_name: 'Stop',
            description: 'Stop every agent, session, schedule and channel',
            url: '/panic',
            icons: [{ src: 'icons/shortcut-stop-96.png', sizes: '96x96', type: 'image/png' }],
          },
          {
            name: 'Inbox',
            short_name: 'Inbox',
            description: 'Approvals waiting on you',
            url: '/inbox',
            icons: [{ src: 'icons/shortcut-inbox-96.png', sizes: '96x96', type: 'image/png' }],
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,webmanifest}'],
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/rpc/, /^\/ws/, /^\/healthz/],
        cleanupOutdatedCaches: true,
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        // Web Push `push` / `notificationclick` handlers (public/push-sw.js, see src/api/push.ts).
        importScripts: ['push-sw.js'],
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: {
      // @beamhop/core re-exports paths.ts (node:os / node:path). The PWA never calls it;
      // these shims keep the browser bundle free of node built-ins.
      'node:os': shim,
      'node:path': shim,
    },
  },
  server: { port: 5173, host: '127.0.0.1' },
  preview: { port: 4173, host: '127.0.0.1' },
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
});
