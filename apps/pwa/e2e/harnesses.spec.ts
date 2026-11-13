/**
 * Harnesses (SCREENS §6, JOURNEYS §1.02): grouped discovery results, login command + Check again,
 * Install… sheet with per-OS commands, details, rescan, custom ACP command with a live handshake result.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

const open = async (page: Page, path: string) => {
  await page.goto(`${path}?mock=1&still=1`);
  await expect(page.locator('#bh-main-content').first()).toBeVisible();
};

const axe = async (page: Page) => {
  const r = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
};

const shot = async (page: Page, name: string, project: string) => {
  if (!process.env.BH_SHOTS) return;
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `screenshots/${project}/${name}.png` });
};

test('groups results and shows the exact login command', async ({ page }, info) => {
  await open(page, '/harnesses');
  await expect(page.getByRole('heading', { name: /Needs you · 2/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Ready · 3/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Not installed · 1/ })).toBeVisible();
  await expect(page.locator('code', { hasText: 'codex login' }).first()).toBeVisible();
  await expect(page.getByText(/3\/6 ready/)).toBeVisible();
  await axe(page);
  await shot(page, 'harnesses', info.project.name);
  await page.getByRole('button', { name: 'Check again: Codex' }).click();
  await expect(page.getByText(/Still not logged in at/)).toBeVisible();
  await expect(page.getByText(/scanned \d\d:\d\d/)).toBeVisible();
});

test('install sheet offers per-OS package manager commands', async ({ page }, info) => {
  await open(page, '/harnesses');
  await page.getByRole('button', { name: 'Install Copilot CLI' }).first().click();
  const sheet = page.getByRole('dialog', { name: 'Install Copilot CLI' });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('radio', { name: /macOS/ }).click();
  await expect(sheet.locator('code').first()).toContainText('brew install copilot-cli');
  await sheet.getByRole('radio', { name: /Linux/ }).click();
  await expect(sheet.locator('code').first()).toContainText('npm i -g @github/copilot');
  await axe(page);
  await shot(page, 'harnesses_install', info.project.name);
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
});

test('row opens details with binary path and agents using it', async ({ page }) => {
  await open(page, '/harnesses');
  await page.getByRole('button', { name: /^Claude Code/ }).click();
  await expect(page.getByText('/usr/local/bin/claude')).toBeVisible();
  await expect(page.getByRole('link', { name: 'reviewer' })).toBeVisible();
});

test('add a custom ACP command: failing then passing handshake', async ({ page }, info) => {
  await open(page, '/harnesses');
  await page.getByRole('button', { name: 'Add ACP agent' }).click();
  const sheet = page.getByRole('dialog', { name: 'Add an ACP agent' });
  await sheet.getByLabel('Command', { exact: true }).fill('nonexistent-agent --acp');
  await expect(sheet.getByText(/id acp:nonexistent-agent/)).toBeVisible();
  await sheet.getByRole('button', { name: 'Test handshake' }).click();
  await expect(sheet.getByText("The handshake didn't work")).toBeVisible();
  await expect(sheet.getByText(/command not found on PATH/)).toBeVisible();
  await sheet.getByLabel('Command', { exact: true }).fill('goose acp');
  await sheet.getByRole('button', { name: 'Test handshake' }).click();
  await expect(sheet.getByText('Handshake ok · added as acp:goose')).toBeVisible();
  await axe(page);
  await shot(page, 'harnesses_acp', info.project.name);
  await sheet.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('button', { name: /^goose/ })).toBeVisible();
});
