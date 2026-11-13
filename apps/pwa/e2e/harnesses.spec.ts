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

test('groups results; a harness without a login for agents gets Log in, checked for real', async ({
  page,
}, info) => {
  await open(page, '/harnesses');
  await expect(page.getByRole('heading', { name: /Needs you · 2/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Ready · 3/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Not installed · 1/ })).toBeVisible();
  await expect(page.getByText(/is not logged in for agents/).first()).toBeVisible();
  await expect(page.getByText(/3\/6 ready/)).toBeVisible();
  await axe(page);
  await shot(page, 'harnesses', info.project.name);

  await page
    .getByRole('button', { name: /^Log in: Codex/ })
    .first()
    .click();
  const sheet = page.getByRole('dialog', { name: /^Log Codex.* in$/ });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText(/Agents never see it/)).toBeVisible();
  await sheet.getByLabel('OpenAI API key', { exact: true }).fill('bad-key-value');
  await sheet.getByRole('button', { name: 'Save and check' }).click();
  await expect(sheet.getByRole('alert')).toContainText('rejected');
  // Let the sheet finish its entrance: axe measures contrast mid-fade otherwise.
  await page.waitForTimeout(800);
  await axe(page);
  await sheet.getByLabel('OpenAI API key', { exact: true }).fill('sk-proj-good-key');
  await sheet.getByRole('button', { name: 'Save and check' }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByRole('heading', { name: /Ready · 4/ })).toBeVisible();
});

test('details: login status, check and log out', async ({ page }) => {
  await open(page, '/harnesses');
  await page.getByRole('button', { name: /^OpenCode/ }).click();
  const login = page.getByRole('region', { name: 'Login for agents' }).last();
  await expect(login.getByText('not checked yet')).toBeVisible();
  await login.getByRole('button', { name: 'Check', exact: true }).click();
  await expect(login.getByText('logged in', { exact: true })).toBeVisible();
  await login.getByRole('button', { name: 'Log out', exact: true }).click();
  await page
    .getByRole('alertdialog', { name: /Log OpenCode out\?/ })
    .getByRole('button', { name: 'Log out' })
    .click();
  await expect(login.getByText('not logged in', { exact: true })).toBeVisible();
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
