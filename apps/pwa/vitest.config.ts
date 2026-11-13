import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const shim = fileURLToPath(new URL('./src/shims/node-empty.ts', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { 'node:os': shim, 'node:path': shim } },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    css: false,
    testTimeout: 15000,
  },
});
