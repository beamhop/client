/** First-run onboarding (JOURNEYS §1): doctor → harnesses → identity → phone (skip) → agent → hello round trip. */
import { expect, test } from '@playwright/test';
import { expectAccessible, open } from './helpers.ts';

test('the whole journey, with a skipped phone, ends in a verified round trip', async ({ page }) => {
  test.setTimeout(60_000);
  await open(page, '/setup/doctor');
  await expect(page.getByRole('heading', { name: 'Check this computer' })).toBeVisible();
  await expect(page.getByText(/5 checks · 4 ok · 1 attention/)).toBeVisible();
  await expect(page.getByText('Allow it for bubblewrap only (recommended)')).toBeVisible();
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Continue · Harnesses' }).click();

  await expect(page).toHaveURL(/\/setup\/harnesses/);
  await expect(page.getByText('codex login')).toBeVisible();
  await page.getByRole('button', { name: 'Continue · Identity' }).click();

  await expect(page.locator('[data-owner="ready"]')).toBeVisible();
  await page.getByRole('button', { name: "What's this key for?" }).click();
  await expect(page.getByText(/Each agent gets its own key/)).toBeVisible();
  await page.getByRole('button', { name: 'Continue · Phone' }).click();

  await expect(page.getByRole('img', { name: /QR code to pair your phone/ })).toBeVisible();
  await page.getByRole('button', { name: 'Skip for now' }).click();

  await expect(page).toHaveURL(/\/setup\/agent/);
  await page.getByRole('radio', { name: /Personal assistant/ }).check({ force: true });
  await expect(page.getByLabel('Name')).toHaveValue('assistant');
  await expect(page.getByText(/Can read/)).toBeVisible();
  await page.getByRole('button', { name: 'Create assistant', exact: true }).click();
  await expect(page.locator('[data-agent="created"]')).toBeVisible();
  await page.getByRole('button', { name: 'Continue · Hello' }).click();

  await expect(page.getByRole('heading', { name: 'Say hello from your phone' })).toBeVisible();
  await expect(page.getByRole('timer')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'It works.' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Your phone → 3 relays → assistant → back/)).toBeVisible();
  await expect(page.getByRole('link', { name: /Move assistant to the cloud/ })).toBeVisible();
  await page.getByRole('button', { name: 'Go to Home' }).click();
  await expect(page).toHaveURL(/\/(\?.*)?$/);
});

test('resumes where you stopped; unknown steps redirect there; skipped steps are offered at the end', async ({
  page,
}) => {
  await open(page, '/setup/doctor');
  await page.getByRole('button', { name: 'Continue · Harnesses' }).click();
  await expect(page).toHaveURL(/\/setup\/harnesses/);
  await page.goto('/setup/nonsense?mock=1&still=1');
  await expect(page).toHaveURL(/\/setup\/harnesses/);
  await page.goto('/setup/phone?mock=1&still=1');
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await page.goto('/setup/next?mock=1&still=1');
  await expect(page.getByRole('button', { name: 'Finish Phone' })).toBeVisible();
});
