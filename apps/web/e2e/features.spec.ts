import { test, expect } from '@playwright/test';
import { createIdentity, publishNote, unique } from './helpers.js';

const TARGET_NPUB = 'npub17zk2w6t7cmf32zumdnqcs7ae8cx7p2k9y3suc6fc0utpnegrkghqxt0djj';

test.describe('navigation to user profiles', () => {
  test('clicking a search result opens that user profile', async ({ page }) => {
    await createIdentity(page);
    await page.getByTestId('nav-explore').click();
    await page.getByTestId('explore-search').fill(TARGET_NPUB);
    await page.getByTestId('explore-search').press('Enter');

    const row = page.getByTestId('explore-person').first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.locator('[role="link"]').first().click();

    await expect(page.getByTestId('view-title')).toHaveText('Profile');
    // Another user's profile shows Follow + Message (not Edit).
    await expect(page.getByTestId('profile-follow')).toBeVisible();
    await expect(page.getByTestId('profile-message')).toBeVisible();
    await expect(page.getByTestId('edit-profile')).toHaveCount(0);
  });

  test('clicking a post author opens their profile', async ({ page }) => {
    await createIdentity(page);
    const text = unique('Author nav post');
    await publishNote(page, text);
    const post = page.getByTestId('post').filter({ hasText: text }).first();
    await post.getByTestId('post-author').click();
    await expect(page.getByTestId('view-title')).toHaveText('Profile');
    // It's our own post → our profile → Edit button present.
    await expect(page.getByTestId('edit-profile')).toBeVisible();
  });
});

test.describe('relay management', () => {
  test('adds and removes a relay', async ({ page }) => {
    await createIdentity(page);
    await page.getByTestId('nav-security').click();
    await page.getByTestId('open-relays').click();
    await expect(page.getByTestId('relays-modal')).toBeVisible();

    const before = await page.getByTestId('relay-row').count();
    await page.getByTestId('relay-input').fill('wss://relay.snort.social');
    await page.getByTestId('add-relay').click();
    await expect(page.getByTestId('relay-row')).toHaveCount(before + 1);

    await page.getByTestId('save-relays').click();
    await expect(page.getByTestId('relays-modal')).toHaveCount(0);
    await expect(page.getByTestId('relay-count')).toContainText(String(before + 1));
  });

  test('rejects an invalid relay URL', async ({ page }) => {
    await createIdentity(page);
    await page.getByTestId('nav-security').click();
    await page.getByTestId('open-relays').click();
    await page.getByTestId('relay-input').fill('not a url');
    await page.getByTestId('add-relay').click();
    await expect(page.getByTestId('toast').filter({ hasText: 'valid' })).toBeVisible();
  });
});

test.describe('command palette & keyboard', () => {
  test('opens with Ctrl+K and navigates', async ({ page }) => {
    await createIdentity(page);
    await page.keyboard.press('Control+k');
    await expect(page.getByTestId('command-palette')).toBeVisible();
    await page.getByTestId('palette-input').fill('explore');
    await page.getByTestId('palette-input').press('Enter');
    await expect(page.getByTestId('command-palette')).toHaveCount(0);
    await expect(page.getByTestId('view-title')).toHaveText('Explore');
  });

  test('g-then-key navigation works', async ({ page }) => {
    await createIdentity(page);
    await page.keyboard.press('g');
    await page.keyboard.press('m');
    await expect(page.getByTestId('view-title')).toHaveText('Messages');
    await page.keyboard.press('g');
    await page.keyboard.press('e');
    await expect(page.getByTestId('view-title')).toHaveText('Explore');
  });

  test('n opens the composer', async ({ page }) => {
    await createIdentity(page);
    await page.keyboard.press('n');
    await expect(page.getByTestId('compose-modal')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('compose-modal')).toHaveCount(0);
  });

  test('signs out from the command palette', async ({ page }) => {
    await createIdentity(page);
    await page.keyboard.press('Control+k');
    await page.getByTestId('palette-input').fill('sign out');
    await page.getByTestId('palette-input').press('Enter');
    await expect(page.getByTestId('login')).toBeVisible();
  });
});

test.describe('search', () => {
  test('full-text search returns posts from relays', async ({ page }) => {
    await createIdentity(page);
    await page.getByTestId('nav-explore').click();
    await page.getByTestId('explore-search').fill('nostr');
    await page.getByTestId('explore-search').press('Enter');
    await expect(page.getByTestId('search-results')).toBeVisible({ timeout: 25_000 });
    await expect(page.getByTestId('post').first()).toBeVisible({ timeout: 25_000 });
  });
});
