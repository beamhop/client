/**
 * Shell integration: ⌘K command palette, the `?` shortcut sheet, Web Push wiring in Settings →
 * Notifications, and the unpaired (no daemon) connection state.
 */
import { expect, test } from '@playwright/test';
import { expectAccessible, open, rpc } from './helpers.ts';

test('command palette: Ctrl K, filter by CLI verb, run', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'hardware keyboard');
  await open(page, '/');
  await page.keyboard.press('Control+k');
  const dialog = page.getByRole('dialog', { name: 'Command palette' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('searchbox')).toBeFocused();
  await expectAccessible(page);
  await page.keyboard.type('channel add');
  await expect(dialog.getByRole('menuitem', { name: /Add channel/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/channels\/add/);
  await expect(dialog).toBeHidden();

  // Live objects: agents by name.
  await page.keyboard.press('Control+k');
  await page.keyboard.type('helpdesk');
  await dialog
    .getByRole('menuitem', { name: /^helpdesk/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/agents\/helpdesk/);
});

test('command palette on a phone: More → Search', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'compact entry point');
  await open(page, '/more');
  await page.getByRole('button', { name: /Search agents, sessions, settings/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Command palette' });
  await expect(dialog).toBeVisible();
  await page.keyboard.type('appearance');
  await dialog.getByRole('menuitem', { name: /Appearance/ }).click();
  await expect(page).toHaveURL(/\/settings\/appearance/);
});

test('? opens one shortcut sheet, with the screen’s own keys first', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'hardware keyboard');
  await open(page, '/inbox');
  await page.keyboard.press('?');
  const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(sheet).toBeVisible();
  const headings = sheet.getByRole('heading', { level: 3 });
  await expect(headings.first()).toHaveText('Inbox');
  await expect(sheet.getByText('Search and run commands')).toBeVisible();
  await expectAccessible(page);
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
});

test('notifications: turning push on registers with the daemon; alert types are daemon prefs', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['notifications']);
  // Headless Chromium reports notifications as denied regardless; stand in for a browser that allows them.
  await page.addInitScript(() => {
    const FakeNotification = Object.assign(() => undefined, {
      permission: 'granted',
      requestPermission: async () => 'granted',
    });
    Object.defineProperty(window, 'Notification', { value: FakeNotification, configurable: true });
  });
  await open(page, '/more');
  // The demo picks the most recently seen device as "this device"; start with push off there.
  // (The demo daemon lives in the page, so set it up first and navigate in-app, no reload.)
  const { devices } = await rpc<{
    devices: Array<{ id: string; lastSeenAt?: string; pushEnabled: boolean }>;
  }>(page, 'device.list');
  const me = [...devices].sort((a, b) => (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? ''))[0]!;
  await rpc(page, 'device.pushSubscribe', { id: me.id, subscription: null });
  await page.evaluate(() =>
    (
      window as unknown as { __beamhop: { router: { navigate: (o: { to: string }) => Promise<void> } } }
    ).__beamhop.router.navigate({ to: '/settings/notifications' }),
  );

  if (test.info().project.name === 'mobile') {
    // The mobile project is an iPhone UA in a browser tab: iOS only pushes to installed apps.
    await expect(page.getByText(/iPhone sends alerts only to the installed app/)).toBeVisible();
  } else {
    await page.getByRole('button', { name: 'Turn on notifications' }).click();
    await expect(page.getByText('push on', { exact: true }).first()).toBeVisible();
    await expect
      .poll(async () => {
        const r = await rpc<{ devices: Array<{ id: string; pushEnabled: boolean }> }>(page, 'device.list');
        return r.devices.find((d) => d.id === me.id)?.pushEnabled;
      })
      .toBe(true);
  }

  const crash = page.getByRole('switch', { name: /Agent stopped unexpectedly/ });
  await expect(crash).toBeChecked();
  await crash.click({ force: true });
  await expect(crash).not.toBeChecked();
  await expect
    .poll(
      async () =>
        (await rpc<{ prefs: Record<string, boolean> }>(page, 'device.pushPrefs', { id: me.id })).prefs.crash,
    )
    .toBe(false);
});

test('a browser that was never paired says so and offers pairing', async ({ page }) => {
  // No ?mock=1 and nothing saved: a production build has nothing to talk to.
  await page.goto('/');
  await expect(page.locator('#bh-main-content').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Connect this browser to your computer' })).toBeVisible();
  await expect(page.getByText('Offline.')).toHaveCount(0);
  await expectAccessible(page);
  await page.getByRole('link', { name: 'Pair this browser' }).click();
  await expect(page).toHaveURL(/\/pair/);
});
