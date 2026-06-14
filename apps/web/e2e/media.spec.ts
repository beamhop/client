import { test, expect, type Page } from '@playwright/test';
import { createIdentity, unique } from './helpers.js';

/**
 * Post via the home composer and locate the resulting card by a marker only —
 * media URLs are stripped from the rendered text, so we can't match the URL.
 */
async function postWithMedia(page: Page, marker: string, url: string): Promise<void> {
  await page.getByTestId('nav-home').click();
  await page.getByTestId('composer-input').fill(`${marker} ${url}`);
  await page.getByTestId('composer-post').click();
}

test.describe('inline media rendering', () => {
  test('renders an image URL as a media block and strips it from the text', async ({ page }) => {
    await createIdentity(page);
    const marker = unique('Look at this');
    await postWithMedia(page, marker, 'https://picsum.photos/seed/verity1/600/400.jpg');

    const post = page.getByTestId('post').filter({ hasText: marker }).first();
    await expect(post).toBeVisible({ timeout: 20_000 });

    await expect(post.getByTestId('post-media')).toBeVisible();
    await expect(post.getByTestId('media-image').first()).toBeVisible();
    // The raw URL is no longer part of the post text.
    await expect(post.getByTestId('post-content')).not.toContainText('.jpg');
  });

  test('renders a YouTube link as a click-to-play facade', async ({ page }) => {
    await createIdentity(page);
    const marker = unique('Watch this');
    await postWithMedia(page, marker, 'https://youtu.be/dQw4w9WgXcQ');

    const post = page.getByTestId('post').filter({ hasText: marker }).first();
    await expect(post).toBeVisible({ timeout: 20_000 });
    await expect(post.getByTestId('embed-facade')).toBeVisible();
  });

  test('opens an image in the lightbox on click', async ({ page }) => {
    await createIdentity(page);
    const marker = unique('Gallery post');
    await postWithMedia(page, marker, 'https://picsum.photos/seed/verity2/600/400.jpg');

    const post = page.getByTestId('post').filter({ hasText: marker }).first();
    await expect(post).toBeVisible({ timeout: 20_000 });
    await post.getByTestId('media-image').first().click();

    await expect(page.getByTestId('lightbox')).toBeVisible();
    await page.getByTestId('lightbox-close').click();
    await expect(page.getByTestId('lightbox')).toHaveCount(0);
  });
});
