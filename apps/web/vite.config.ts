import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  // Relative asset paths so the build works under any GitHub Pages subpath
  // (e.g. https://user.github.io/repo/). Hash routing handles in-app routes.
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@verity/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
    },
  },
  server: { port: 5173 },
  preview: { port: 4173 },
});
