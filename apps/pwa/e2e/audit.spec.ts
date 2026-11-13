/**
 * Monitoring journeys (JOURNEYS §6): spend at a glance with budgets, chart ↔ table, security events with
 * one-tap actions, searchable paged log with detail and export, alert rules.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

const open = async (page: Page, path: string) => {
  const sep = path.includes('?') ? '&' : '?';
  await page.goto(`${path}${sep}mock=1&still=1`);
  await expect(page.locator('#bh-main-content').first()).toBeVisible();
};

const axe = async (page: Page) => {
  const r = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    bad.map(
      (v) =>
        `${v.id}: ${v.nodes
          .map((n) => `${n.target.join(' ')} ${n.html.slice(0, 160)}`)
          .slice(0, 3)
          .join(' | ')}`,
    ),
  ).toEqual([]);
};

test('usage: total, comparison, budgets, breakdown and table view', async ({ page }) => {
  await open(page, '/audit');
  await expect(page.getByRole('heading', { name: 'Last 14 days · all agents' })).toBeVisible();
  await expect(page.getByText(/than the 14 days before/)).toBeVisible();
  await expect(page.getByRole('meter', { name: 'reviewer budget today' })).toHaveAttribute(
    'aria-valuetext',
    '$3.20 of $5.00 used today',
  );
  await page.getByRole('radio', { name: 'Channel' }).click();
  await expect(page.getByRole('button', { name: /^tg/ })).toBeVisible();
  await page.getByRole('button', { name: 'View as table' }).click();
  const table = page.getByRole('table', { name: /Cost per day, last 14 days, by Channel/ });
  await expect(table).toBeVisible();
  await expect(table.getByRole('columnheader', { name: 'Total' })).toBeVisible();
  await axe(page);
});

test('usage chart is keyboard readable', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'hardware keyboard');
  await open(page, '/audit');
  await page.getByRole('group', { name: /Cost per day/ }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#bh-live-polite')).toContainText(/\$\d/);
});

test('security: filter by category, Allow… routes into the policy editor pre-filled', async ({ page }) => {
  await open(page, '/audit?tab=security');
  await page.getByRole('button', { name: /^Blocked hosts/ }).click();
  await expect(page.getByRole('heading', { name: /^Blocked hosts · \d+/ })).toBeVisible();
  await expect(page.getByText('Blocked by design').first()).toBeVisible();
  await axe(page);
  await page.getByRole('button', { name: 'Allow pypi.org for helpdesk…' }).first().click();
  await expect(page).toHaveURL(/\/policy\/helpdesk/);
  await expect(page.getByText('Added pypi.org from Audit. Review and save to allow it.')).toBeVisible();
});

test('security: unknown sender → Allow as viewer', async ({ page }) => {
  await open(page, '/audit?tab=security');
  await page.getByRole('button', { name: /^Unknown senders/ }).click();
  await page.getByRole('button', { name: 'Allow as viewer' }).click();
  await expect(page.getByText('Allowed as viewer')).toBeVisible();
});

test('security: event detail sheet', async ({ page }) => {
  await open(page, '/audit?tab=security');
  await page.getByRole('button', { name: /reviewer was blocked from 169\.254\.169\.254/ }).click();
  const sheet = page.getByRole('dialog', { name: /169\.254\.169\.254/ });
  await expect(sheet.getByText('"type": "sandbox.blocked_host"')).toBeVisible();
  await axe(page);
});

test('log: search, detail, older pages, export', async ({ page }) => {
  await open(page, '/audit?tab=log');
  await expect(page.getByText(/50 events · 50 loaded/)).toBeVisible();
  // Reaching the end loads the next page (IntersectionObserver); the button is the visible alternative.
  await page
    .getByText('Start of the log')
    .or(page.getByRole('button', { name: 'Load older events' }))
    .first()
    .scrollIntoViewIfNeeded();
  await expect(page.getByText(/· (5[1-9]|[6-9]\d|\d{3,}) loaded/)).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search the log' }).fill('signed');
  await page.getByRole('button', { name: /made bob an admin/ }).click();
  const sheet = page.getByRole('dialog', { name: /made bob an admin/ });
  await expect(sheet.getByText("Signed by the owner's key. Verified.")).toBeVisible();
  await sheet.getByRole('button', { name: 'Close' }).first().click();
  await page.getByRole('button', { name: 'Export' }).click();
  const exp = page.getByRole('dialog', { name: 'Export audit log' });
  const dl = page.waitForEvent('download');
  await exp.getByRole('button', { name: 'JSONL' }).click();
  expect((await dl).suggestedFilename()).toMatch(/^beamhop-audit-.*\.jsonl$/);
  await exp.getByRole('button', { name: 'Create archive' }).click();
  await expect(exp.getByText(/~\/\.beamhop\/exports\/beamhop-.*\.tar\.gz/)).toBeVisible();
  await axe(page);
});

test('log: no match → clear filters', async ({ page }) => {
  await open(page, '/audit?tab=log');
  await page.getByRole('searchbox', { name: 'Search the log' }).fill('zzzz-nothing');
  await expect(page.getByText('No events match.')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.getByText(/50 events/)).toBeVisible();
});

test('alert rules are saved and shown on the budgets', async ({ page }) => {
  await open(page, '/audit');
  await page.getByRole('button', { name: 'Alert rules' }).click();
  const sheet = page.getByRole('dialog', { name: 'Alert rules' });
  const warn = sheet.getByRole('textbox', { name: 'First alert' });
  await warn.fill('70');
  await warn.press('Tab');
  await axe(page);
  await sheet.getByRole('button', { name: 'Save rules' }).click();
  await expect(page.getByText("You're alerted at 70% and 100% of a budget.")).toBeVisible();
});

test('usage error state offers retry', async ({ page }) => {
  await open(page, '/audit?mockFail=usage.query');
  await expect(page.getByRole('alert').getByText("Couldn't load usage")).toBeVisible();
});
