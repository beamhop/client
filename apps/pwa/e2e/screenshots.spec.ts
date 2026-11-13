/**
 * Screenshots of every route on mobile + desktop for the owner's review → apps/pwa/screenshots/.
 * Mock mode with frozen timers (`still=1`) so images are stable. Run: `pnpm --filter @beamhop/pwa screenshots`.
 */
import { expect, test } from '@playwright/test';
import { SMOKE_PATHS } from './paths.ts';

const slug = (p: string) => (p === '/' ? 'home' : p.replace(/^\//, '').replace(/[/?=&]+/g, '_'));

for (const path of SMOKE_PATHS) {
  test(`screenshot ${path}`, async ({ page }, info) => {
    const sep = path.includes('?') ? '&' : '?';
    await page.goto(`${path}${sep}mock=1&still=1`);
    await expect(page.locator('#bh-main-content').first()).toBeVisible();
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(600);
    await page.screenshot({ path: `screenshots/${info.project.name}/${slug(path)}.png`, fullPage: false });
  });
}

test('screenshot dark home + kitchen', async ({ page }, info) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  for (const [path, name] of [
    ['/', 'home-dark'],
    ['/_kitchen', 'kitchen-dark'],
    ['/inbox', 'inbox-dark'],
  ] as const) {
    await page.goto(`${path}?mock=1&still=1`);
    await expect(page.locator('#bh-main-content').first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(600);
    await page.screenshot({ path: `screenshots/${info.project.name}/${name}.png` });
  }
});

test('screenshot dark deploy, settings, setup, pair', async ({ page }, info) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  for (const [path, name] of [
    ['/deploy/new?agent=reviewer', 'deploy_new-dark'],
    ['/deploy/dep_fly_ams1', 'deploy_detail-dark'],
    ['/settings/devices', 'settings_devices-dark'],
    ['/settings/identity', 'settings_identity-dark'],
    ['/setup/doctor', 'setup_doctor-dark'],
    ['/setup/phone', 'setup_phone-dark'],
    ['/pair', 'pair-dark'],
  ] as const) {
    const sep = path.includes('?') ? '&' : '?';
    await page.goto(`${path}${sep}mock=1&still=1`);
    await expect(page.locator('#bh-main-content').first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(900);
    await page.screenshot({ path: `screenshots/${info.project.name}/${name}.png` });
  }
});

test('screenshot pairing safety check (trusted side)', async ({ page }, info) => {
  await page.goto('/setup/phone?mock=1&still=1');
  await expect(page.getByText(/Does iPhone · Safari show these words\?/)).toBeVisible({ timeout: 12_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `screenshots/${info.project.name}/setup_phone-confirm.png` });
});

test('screenshot panic band', async ({ page }, info) => {
  await page.goto('/?mock=1&still=1');
  await page.evaluate(async () => {
    const w = window as unknown as {
      __beamhop: { runtime: { client: { call: (m: string, p?: unknown) => Promise<unknown> } } };
    };
    await w.__beamhop.runtime.client.call('system.panic', {});
  });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `screenshots/${info.project.name}/home-panic.png` });
  await page.getByRole('link', { name: 'Review & resume' }).first().click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `screenshots/${info.project.name}/panic-resume.png` });
});
