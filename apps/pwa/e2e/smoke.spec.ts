/**
 * Smoke + accessibility: the app loads in mock mode on mobile and desktop, navigation works, the
 * kitchen sink renders, panic works end to end, and axe finds no serious/critical violations on any route.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { settle } from './helpers.ts';
import { SMOKE_PATHS } from './paths.ts';

const open = async (page: Page, path: string) => {
  const sep = path.includes('?') ? '&' : '?';
  await page.goto(`${path}${sep}mock=1&still=1`);
  await expect(page.locator('#bh-main-content').first()).toBeVisible();
};

test('home loads with live demo data', async ({ page }) => {
  await open(page, '/');
  await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeAttached();
  await expect(page.getByRole('heading', { name: 'reviewer' })).toBeVisible();
  await expect(page.getByText(/Needs you/i).first()).toBeVisible();
  await expect(page.getByRole('meter', { name: 'reviewer budget today' })).toBeVisible();
});

test('main navigation reaches every top-level screen', async ({ page }, info) => {
  await open(page, '/');
  const nav = page.getByRole('navigation', { name: 'Main' });
  for (const [label, path] of [
    ['Inbox', '/inbox'],
    ['Conversations', '/sessions'],
    ['Agents', '/agents'],
    ['Settings', '/settings'],
    ['Home', '/'],
  ] as const) {
    await nav.getByRole('link', { name: new RegExp(`\\b${label}\\b`) }).click();
    await expect(page).toHaveURL(new RegExp(`${path === '/' ? '/(\\?.*)?$' : path}`));
    await expect(nav.getByRole('link', { name: new RegExp(`\\b${label}\\b`) })).toHaveAttribute(
      'aria-current',
      'page',
    );
  }
  // Connections, AI accounts & co live under Settings.
  await nav.getByRole('link', { name: /Settings/ }).click();
  await page.getByRole('link', { name: /Connections/ }).click();
  await expect(page).toHaveURL(/\/channels/);
  await expect(nav.getByRole('link', { name: /Settings/ })).toHaveAttribute('aria-current', 'page');
  if (info.project.name !== 'mobile') {
    // split view: list + detail side by side
    await page.getByRole('link', { name: /@reviewer_alice_bot/ }).click();
    await expect(page).toHaveURL(/\/channels\/tg/);
    await expect(page.getByRole('link', { name: /@reviewer_alice_bot/ })).toBeVisible();
  }
});

test('keyboard shortcut g i opens the inbox (desktop)', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'hardware keyboard shortcut');
  await open(page, '/');
  await page.keyboard.press('g');
  await page.keyboard.press('i');
  await expect(page).toHaveURL(/\/inbox/);
});

test('kitchen sink renders every section', async ({ page }) => {
  await open(page, '/_kitchen');
  for (const h of [
    'Type & identity',
    'Buttons',
    'Status: lamps, meters, routes',
    'Cards & transmission slips',
    'Inputs',
    'Tabs & stepper',
    'Sheets, dialogs, toasts',
    'Code, diff, CLI, QR',
    'Charts',
    'Empty, loading, error, banners',
  ]) {
    await expect(page.getByRole('heading', { name: h })).toBeAttached();
  }
  await page.getByRole('button', { name: 'Open sheet' }).click();
  const sheet = page.getByRole('dialog', { name: 'Allow git push?' });
  await expect(sheet).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  // Theme toggle switches the data attribute and persists.
  await page.getByRole('radio', { name: 'Night' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('approve from Home with undo toast', async ({ page }, info) => {
  await open(page, '/');
  const allow = page.getByRole('button', { name: /^Allow once helpdesk/ });
  test.skip(
    info.project.name === 'mobile' && !(await allow.isVisible()),
    'first slip on compact is not a LOW one',
  );
  await allow.click();
  const region = page.getByRole('region', { name: 'Notifications' });
  await expect(region.getByText(/Allowed once/)).toBeVisible();
  await region.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('button', { name: /^Allow once helpdesk/ })).toBeVisible();
});

test('panic: one confirm stops everything; band offers review & resume', async ({ page }) => {
  await open(page, '/more');
  await page.getByRole('button', { name: 'Stop everything' }).first().click();
  const sheet = page.getByRole('alertdialog', { name: 'Stop everything?' });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: 'Stop everything' }).click();
  // The sheet retitles itself once the daemon confirmed, and its ledger ticks.
  const done = page.getByRole('alertdialog', { name: 'Everything is stopped.' });
  await expect(done).toBeVisible();
  await expect(done.getByRole('list', { name: 'What will stop' }).getByText('acknowledged')).toBeVisible();
  await done.getByRole('button', { name: 'Close' }).first().click();
  await expect(page.getByRole('region', { name: /Everything is stopped/ })).toBeVisible();
  await page.getByRole('link', { name: 'Review & resume' }).click();
  await expect(page.getByRole('button', { name: 'Resume without agents' })).toBeVisible();
  await page
    .getByRole('checkbox', { name: /^reviewer/ })
    .first()
    .check({ force: true });
  await page.getByRole('button', { name: 'Resume 1 selected' }).click();
  await expect(page).toHaveURL(/\/(\?.*)?$/);
  await expect(page.getByRole('region', { name: /Everything is stopped/ })).toHaveCount(0);
});

for (const path of SMOKE_PATHS) {
  test(`a11y ${path}`, async ({ page }) => {
    await open(page, path);
    await page.waitForTimeout(300);
    // No horizontal page scroll (SCREENS §0.4); code/diff blocks scroll inside themselves.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'horizontal page overflow (px)').toBeLessThanOrEqual(0);
    await settle(page);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(
      bad.map(
        (v) =>
          `${v.id}: ${v.help} → ${v.nodes
            .map((n) => `${n.target.join(' ')} ${n.html.slice(0, 160)}`)
            .slice(0, 3)
            .join(' | ')}`,
      ),
    ).toEqual([]);
  });
}
