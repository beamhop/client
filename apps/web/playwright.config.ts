import { defineConfig, devices } from '@playwright/test';

/**
 * E2E tests run against a real Vite dev server and REAL public Nostr relays.
 * Kept separate from unit tests (`bun run test:e2e`). Generous timeouts absorb
 * relay propagation latency.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    actionTimeout: 20_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'bun run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
