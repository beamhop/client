import { defineConfig, devices } from '@playwright/test';
import { CONTROL_PORT, DAEMON_PORT } from './ports.ts';

/**
 * E2E against a REAL beamhopd (apps/daemon) serving the production build of the PWA, with a fake
 * channel plugin and a scripted fake harness (apps/daemon/test/test-daemon.ts). The global setup
 * builds the PWA if `dist` is missing and starts the daemon as a child process on its own ports
 * (never reused: the run fails if a port is taken). Every test starts from a fresh daemon home.
 *
 * One daemon serves every test, so tests run serially (workers: 1). Run: `pnpm run test:e2e:real`.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  timeout: 45_000,
  expect: { timeout: 7_000 },
  globalSetup: './global-setup.ts',
  outputDir: '../test-results/e2e-real',
  use: {
    baseURL: `http://127.0.0.1:${DAEMON_PORT}`,
    trace: 'retain-on-failure',
    colorScheme: 'light',
    serviceWorkers: 'block',
  },
  metadata: { daemonPort: DAEMON_PORT, controlPort: CONTROL_PORT },
  projects: [
    {
      name: 'mobile',
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
      use: { browserName: 'chromium', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
    },
  ],
});
