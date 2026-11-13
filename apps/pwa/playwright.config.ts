import { defineConfig, devices } from '@playwright/test';

/**
 * E2E against the production build served by `vite preview` (mock daemon via `?mock=1`).
 * `pnpm test:e2e` builds first. Projects: mobile (390×844 touch) and desktop (1280×800), chromium only.
 */
const PORT = Number(process.env.PW_PORT ?? 4173);

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  timeout: 30_000,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    colorScheme: 'light',
  },
  projects: [
    {
      name: 'mobile',
      testIgnore: /perf\.spec\.ts/,
      use: {
        ...devices['iPhone 13'],
        browserName: 'chromium',
        defaultBrowserType: 'chromium',
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 1,
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: 'desktop',
      testIgnore: /perf\.spec\.ts/,
      use: { browserName: 'chromium', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
    },
    // Load budgets (LCP/CLS) run after everything else, one at a time, so parallel workers don't skew them.
    {
      name: 'perf-mobile',
      testMatch: /perf\.spec\.ts/,
      dependencies: ['mobile', 'desktop'],
      fullyParallel: false,
      use: {
        ...devices['iPhone 13'],
        browserName: 'chromium',
        defaultBrowserType: 'chromium',
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 1,
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: 'perf-desktop',
      testMatch: /perf\.spec\.ts/,
      dependencies: ['perf-mobile'],
      fullyParallel: false,
      use: { browserName: 'chromium', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
    },
  ],
  webServer: {
    command: `pnpm exec vite preview --port ${PORT} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
