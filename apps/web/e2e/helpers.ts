import { expect, type Page } from '@playwright/test';

/** Load the app and create a fresh in-app identity, landing on the home shell. */
export async function createIdentity(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('login')).toBeVisible();
  await page.getByTestId('create-identity').click();
  await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('view-title')).toHaveText('Home');
}

/** Read the logged-in user's npub from the Keys & Security view. */
export async function readNpub(page: Page): Promise<string> {
  await page.getByTestId('nav-security').click();
  await expect(page.getByTestId('view-title')).toHaveText('Keys & Security');
  const npub = await page.getByTestId('npub-value').innerText();
  return npub.trim();
}

/** Publish a note via the inline home composer. */
export async function publishNote(page: Page, text: string): Promise<void> {
  await page.getByTestId('nav-home').click();
  await page.getByTestId('composer-input').fill(text);
  await page.getByTestId('composer-post').click();
  // The post is added optimistically.
  await expect(page.getByTestId('post').filter({ hasText: text }).first()).toBeVisible({ timeout: 20_000 });
}

const UNIQUE = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export function unique(prefix: string): string {
  return `${prefix} ${UNIQUE()}`;
}
