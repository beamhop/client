/**
 * The desktop app (docs/desktop-ux.md): with `window.beamhopDesktop` present and Settings → Advanced →
 * "Show command-line equivalents" off, no screen names a `beamhop …` command; commands become buttons
 * (Fix, Install, Restart beamhop); Advanced brings the command lines back and installs the command.
 */
import { expect, type Page, test } from '@playwright/test';
import { expectAccessible, open } from './helpers.ts';

const COMMAND =
  /\bbeamhop (init|ui|daemon|resume|harness|doctor|agent|secret|device|deploy|data|owner|identity|panic|approvals|status|join|role)\b/;

const fakeDesktop = async (page: Page, cli: 'absent' | 'unsupported' = 'absent') => {
  await page.addInitScript((state) => {
    const calls: string[] = [];
    let status: Record<string, unknown> = state === 'unsupported' ? { state, reason: 'test' } : { state };
    (window as unknown as { __desktopCalls: string[] }).__desktopCalls = calls;
    (window as unknown as { beamhopDesktop: unknown }).beamhopDesktop = {
      version: '0.1.0-test',
      platform: 'darwin',
      cli: {
        status: async () => status,
        install: async () => {
          calls.push('cli.install');
          status = { state: 'installed', path: '/Users/alice/.local/bin/beamhop', onPath: false };
          return { status, profile: '~/.zshrc' };
        },
        uninstall: async () => {
          calls.push('cli.uninstall');
          status = { state: 'absent' };
        },
      },
      daemon: {
        restart: async () => {
          calls.push('daemon.restart');
        },
        openLog: async () => {
          calls.push('daemon.openLog');
        },
      },
    };
  }, cli);
};

const SCREENS = [
  '/',
  '/inbox',
  '/sessions',
  '/agents',
  '/agents/reviewer',
  '/agents/new',
  '/channels',
  '/harnesses',
  '/policy',
  '/deploy',
  '/audit',
  '/settings',
  '/settings/identity',
  '/settings/secrets',
  '/settings/devices',
  '/settings/owners',
  '/settings/retention',
  '/settings/updates',
  '/settings/stop',
  '/settings/advanced',
  '/setup/doctor',
  '/setup/harnesses',
];

test('desktop app: no screen names a beamhop command while the setting is off', async ({ page }) => {
  test.setTimeout(90_000);
  await fakeDesktop(page);
  for (const path of SCREENS) {
    await open(page, path);
    // Let the mock answer and the rows settle (doctor rows reveal one after another).
    await page.waitForTimeout(1600);
    // biome-ignore lint/performance/useDomNodeTextContent: only rendered, visible text counts here
    const text = await page.evaluate(() => document.body.innerText);
    expect(text.match(COMMAND)?.[0], `${path} shows a command: ${text.match(COMMAND)?.[0]}`).toBeUndefined();
  }
});

test('desktop app: Settings → Advanced brings back command lines and installs the command', async ({
  page,
}) => {
  await fakeDesktop(page);
  await open(page, '/settings');
  await expect(page.getByRole('link', { name: /Advanced/ })).toBeVisible();
  await open(page, '/settings/advanced');
  const show = page.getByRole('switch', { name: /Show command-line equivalents/ });
  await expect(show).not.toBeChecked();
  await show.click({ force: true });
  await expect(show).toBeChecked();

  const install = page.getByRole('switch', { name: /Install the beamhop command/ });
  await expect(install).not.toBeChecked();
  await install.click({ force: true });
  await expect(install).toBeChecked();
  await expect(page.getByText('Installed. Open a new terminal window to use it.').first()).toBeVisible();
  expect(
    await page.evaluate(() => (window as unknown as { __desktopCalls: string[] }).__desktopCalls),
  ).toEqual(['cli.install']);
  await expectAccessible(page);

  await open(page, '/harnesses');
  await expect(page.getByRole('button', { name: /CLI/ }).last()).toBeVisible();
  await expect(page.getByText('beamhop harness scan').last()).toBeAttached();
});

test('desktop app: the command toggle hides when the platform is unsupported', async ({ page }) => {
  await fakeDesktop(page, 'unsupported');
  await open(page, '/settings/advanced');
  await expect(page.getByRole('switch', { name: /Show command-line equivalents/ })).toBeVisible();
  await expect(page.getByRole('switch', { name: /Install the beamhop command/ })).toHaveCount(0);
});

test('browser: no Advanced section, command lines shown', async ({ page }) => {
  await open(page, '/settings');
  await expect(page.getByRole('link', { name: /Advanced/ })).toHaveCount(0);
  await open(page, '/harnesses');
  await expect(page.getByText('beamhop harness scan').last()).toBeAttached();
});

test('desktop app: Fix flips a doctor row, with the admin prompt explained first', async ({ page }) => {
  await fakeDesktop(page);
  await open(page, '/setup/doctor');
  await expect(page.getByText(/5 checks · 4 ok · 1 attention/)).toBeVisible();
  await expect(page.getByText(/macOS will ask for your password/)).toBeVisible();
  await expect(page.getByText(/Adds an AppArmor exception for bubblewrap/)).toBeVisible();
  await page.getByRole('button', { name: 'Fix: user namespaces (AppArmor)' }).click();
  await expect(page.getByText(/5 checks · 5 ok/)).toBeVisible();
});

test('desktop app: Install from onboarding step 02 reaches Ready', async ({ page }) => {
  await fakeDesktop(page);
  await open(page, '/setup/harnesses');
  await page.getByRole('button', { name: 'Install Copilot CLI' }).first().click();
  await expect(
    page.locator('[data-harness-job="copilot"]').first().getByText('Ready', { exact: true }),
  ).toBeVisible({ timeout: 8000 });
});
