/**
 * First-run onboarding, outcome first: your agent (what it's for, AI account, where it listens) → say hello.
 * The machine check, AI accounts, owner key and phone are pages setup sends you to, not steps.
 */
import { expect, test } from '@playwright/test';
import { expectAccessible, open } from './helpers.ts';

test('the whole journey: setup starts at your agent and ends in a verified round trip', async ({ page }) => {
  test.setTimeout(60_000);
  await open(page, '/setup');
  await expect(page).toHaveURL(/\/setup\/agent/);
  await expect(page.getByRole('heading', { name: 'Create your first agent' })).toBeVisible();
  await expect(page.getByText(/Step 1 of 2|1 of 2/).first()).toBeVisible();
  await expectAccessible(page);

  // The machine check only speaks up when something needs a fix (the demo has one).
  await expect(page.locator('[data-setup="needs-fix"]')).toBeVisible();
  await page.getByRole('button', { name: 'See the fix' }).click();
  await expect(page.getByRole('heading', { name: 'Check this computer' })).toBeVisible();
  await expect(page.getByText('Allow it for bubblewrap only (recommended)')).toBeVisible();
  await page.getByRole('button', { name: 'Back to your agent', exact: true }).last().click();

  await expect(page).toHaveURL(/\/setup\/agent/);
  await page.getByRole('radio', { name: /Personal assistant/ }).check({ force: true });
  await expect(page.getByLabel('Name')).toHaveValue('assistant');
  await expect(page.getByRole('checkbox', { name: /Direct messages on Nostr/ })).toBeChecked();
  await page.getByRole('button', { name: 'Create assistant', exact: true }).click();
  await expect(page.locator('[data-agent="created"]')).toBeVisible();
  await page.getByRole('button', { name: 'Continue · Hello' }).click();

  await expect(page.getByRole('heading', { name: 'Say hello from your phone' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'It works.' })).toBeVisible({ timeout: 15_000 });
  // Phone pairing is offered after the first reply.
  await expect(page.getByRole('link', { name: /Pair your phone/ })).toBeVisible();
  await page.getByRole('button', { name: 'Go to Home' }).click();
  await expect(page).toHaveURL(/\/(\?.*)?$/);
});

test('unknown steps resume where you stopped; the phone page finishes setup', async ({ page }) => {
  await open(page, '/setup/nonsense');
  await expect(page).toHaveURL(/\/setup\/agent/);
  await page.goto('/setup/phone?mock=1&still=1');
  await expect(page.getByRole('img', { name: /QR code to pair your phone/ })).toBeVisible();
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await expect(page).toHaveURL(/\/setup\/next/);
});
