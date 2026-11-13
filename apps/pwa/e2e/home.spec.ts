/**
 * Home (SCREENS §1): briefing, needs-you slips with in-place risk-scaled decisions, agent cards with
 * live lamp + beam line + budget meter, spend, recent activity, signals; axe; screenshots.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

const open = async (page: Page) => {
  await page.goto('/?mock=1&still=1');
  await expect(page.locator('#bh-main-content').first()).toBeVisible();
};

const shot = async (page: Page, name: string, project: string) => {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `screenshots/${project}/${name}.png` });
};

test('briefing, sections and a11y', async ({ page }) => {
  await open(page);
  await expect(page.getByText(/need you/).first()).toBeVisible();
  for (const name of ['Needs you', 'Agents', 'Spend', 'Recent activity', 'Signals'])
    await expect(page.getByRole('heading', { name: new RegExp(`^${name}`) })).toBeAttached();
  await expect(page.getByRole('meter', { name: 'reviewer budget today' })).toBeVisible();
  await expect(page.getByRole('meter', { name: 'Spend today against daily budgets' })).toBeAttached();
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(
    results.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
  ).toEqual([]);
});

test('elevated request: Allow… opens the scope sheet in place (no detour)', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: /^Allow… ci-bot: registry\.npmjs\.org/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Allow registry.npmjs.org?' });
  await expect(sheet).toBeVisible();
  await expect(page).toHaveURL(/\/(\?.*)?$/);
  await sheet.getByRole('button', { name: 'Allow once' }).click();
  await expect(page.getByRole('region', { name: 'Notifications' }).getByText(/Allowed once/)).toBeVisible();
});

test('deny from Home with undo', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: /^Deny ci-bot: registry\.npmjs\.org/ }).click();
  const region = page.getByRole('region', { name: 'Notifications' });
  await expect(region.getByText(/Denied/)).toBeVisible();
  await region.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('button', { name: /^Deny ci-bot: registry\.npmjs\.org/ })).toBeVisible();
});

test('screenshots: home light + dark', async ({ page }, info) => {
  await open(page);
  await shot(page, 'home', info.project.name);
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'home-dark', info.project.name);
  if (info.project.name === 'mobile') {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.evaluate(() => window.scrollBy(0, 700));
    await shot(page, 'home-scrolled', info.project.name);
  }
});
