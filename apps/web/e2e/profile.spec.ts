import { test, expect } from '@playwright/test';
import { createIdentity, unique } from './helpers.js';

// A syntactically valid npub used as a follow target (no profile required).
const TARGET_NPUB = 'npub17zk2w6t7cmf32zumdnqcs7ae8cx7p2k9y3suc6fc0utpnegrkghqxt0djj';

test.describe('profile management', () => {
  test('edits and publishes profile metadata', async ({ page }) => {
    await createIdentity(page);
    await page.getByTestId('nav-profile').click();
    await page.getByTestId('edit-profile').click();

    await expect(page.getByTestId('edit-modal')).toBeVisible();
    const name = unique('Maya');
    const bio = unique('Building verifiable identity');
    await page.getByTestId('field-name').fill(name);
    await page.getByTestId('field-about').fill(bio);
    await page.getByTestId('field-nip05').fill('maya@aperture.co');
    await page.getByTestId('save-profile').click();

    await expect(page.getByTestId('edit-modal')).toHaveCount(0);
    await expect(page.getByTestId('profile-name')).toHaveText(name, { timeout: 20_000 });
    await expect(page.getByTestId('profile-bio')).toHaveText(bio);
  });

  test('persists profile to relays across a reload', async ({ page }) => {
    await createIdentity(page);
    await page.getByTestId('nav-profile').click();
    await page.getByTestId('edit-profile').click();
    const name = unique('Persisted Name');
    await page.getByTestId('field-name').fill(name);
    await page.getByTestId('save-profile').click();
    await expect(page.getByTestId('profile-name')).toHaveText(name, { timeout: 20_000 });

    await page.reload();
    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('nav-profile').click();
    await expect(page.getByTestId('profile-name')).toHaveText(name, { timeout: 30_000 });
  });

  test('follows a person from Explore', async ({ page }) => {
    await createIdentity(page);
    await page.getByTestId('nav-explore').click();
    await page.getByTestId('explore-search').fill(TARGET_NPUB);
    await page.getByTestId('explore-search').press('Enter');

    const row = page.getByTestId('explore-person').first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.getByTestId('follow-button').click();
    await expect(row.getByTestId('follow-button')).toHaveText('Following', { timeout: 20_000 });
  });

  test('the banner does not cover the profile avatar', async ({ page }) => {
    await createIdentity(page);
    await page.getByTestId('nav-profile').click();
    const avatar = page.getByTestId('profile-avatar');
    await expect(avatar).toBeVisible();
    const box = await avatar.boundingBox();
    expect(box).not.toBeNull();
    // Sample a point near the top of the avatar — the part that overlaps the
    // banner. The topmost element there must be the avatar, not the banner.
    const x = box!.x + box!.width / 2;
    const y = box!.y + 6;
    const topMost = await page.evaluate(
      ({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        if (el?.closest('[data-testid="profile-avatar"]')) return 'avatar';
        if (el?.closest('[data-testid="profile-banner"]')) return 'banner';
        return 'other';
      },
      { x, y },
    );
    expect(topMost).toBe('avatar');
  });

  test('toggles dark mode', async ({ page }) => {
    await createIdentity(page);
    const shell = page.getByTestId('app-shell');
    await expect(shell).toHaveAttribute('data-theme', 'light');
    await page.getByTestId('theme-toggle').click();
    await expect(shell).toHaveAttribute('data-theme', 'dark');
  });

  test('toggles key governance settings in Security', async ({ page }) => {
    await createIdentity(page);
    await page.getByTestId('nav-security').click();
    await page.getByTestId('toggle-hardware').click();
    await expect(page.getByTestId('toggle-hardware')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('export-audit').click();
    await expect(page.getByTestId('toast').filter({ hasText: 'Audit log exported' })).toBeVisible();
  });
});
