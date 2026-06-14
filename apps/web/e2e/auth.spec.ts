import { test, expect } from '@playwright/test';
import { createIdentity, readNpub } from './helpers.js';

test.describe('authentication & identity', () => {
  test('creates a new identity and persists it across reloads', async ({ page }) => {
    await createIdentity(page);

    const npub = await readNpub(page);
    expect(npub.startsWith('npub1')).toBeTruthy();

    // Reload — the session should be restored, no login screen.
    await page.reload();
    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('login')).toHaveCount(0);
  });

  test('reveals and hides the private key', async ({ page }) => {
    await createIdentity(page);
    await page.getByTestId('nav-security').click();
    const nsec = page.getByTestId('nsec-value');
    await expect(nsec).toHaveText(/nsec1/);

    // Hidden by default (blurred).
    await expect(nsec).toHaveCSS('filter', /blur/);
    await page.getByTestId('reveal-key').click();
    await expect(nsec).toHaveCSS('filter', 'none');
  });

  test('signs out and returns to login', async ({ page }) => {
    await createIdentity(page);
    await page.getByTestId('nav-security').click();
    await page.getByTestId('logout').click();
    await expect(page.getByTestId('login')).toBeVisible();
  });

  test('imports an invalid nsec and shows an error', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('nsec-input').fill('nsec1nonsense');
    await page.getByTestId('import-nsec').click();
    await expect(page.getByTestId('login-error')).toBeVisible();
  });
});
