import { test, expect } from '@playwright/test';
import { createIdentity, publishNote, readNpub, unique } from './helpers.js';

test.describe('posting & interactions', () => {
  test('publishes a note that appears in the feed and profile', async ({ page }) => {
    await createIdentity(page);
    const text = unique('Verity e2e post');
    await publishNote(page, text);

    // Shows on the profile Posts tab too.
    await page.getByTestId('nav-profile').click();
    await expect(page.getByTestId('post').filter({ hasText: text }).first()).toBeVisible({ timeout: 20_000 });
  });

  test('replies to a post and increments the reply count', async ({ page }) => {
    await createIdentity(page);
    const text = unique('Parent post');
    await publishNote(page, text);

    const post = page.getByTestId('post').filter({ hasText: text }).first();
    await post.getByTestId('action-reply').click();

    await expect(page.getByTestId('compose-modal')).toBeVisible();
    const reply = unique('My threaded reply');
    await page.getByTestId('compose-input').fill(reply);
    await page.getByTestId('compose-submit').click();

    await expect(page.getByTestId('compose-modal')).toHaveCount(0);
    // The parent now reports one reply.
    await expect(post.getByTestId('action-reply')).toContainText('1');
  });

  test('mentions another identity with a nostr: reference', async ({ page }) => {
    await createIdentity(page);
    const npub = await readNpub(page);
    await page.getByTestId('nav-home').click();

    const marker = unique('Shout out to');
    const text = `${marker} nostr:${npub}`;
    await page.getByTestId('composer-input').fill(text);
    await page.getByTestId('composer-post').click();

    const post = page.getByTestId('post').filter({ hasText: marker }).first();
    await expect(post).toBeVisible({ timeout: 20_000 });
    await expect(post.getByTestId('mention').first()).toBeVisible();
    await expect(post.getByTestId('mention').first()).toContainText('@');
  });

  test('likes, reposts and bookmarks a post', async ({ page }) => {
    await createIdentity(page);
    const text = unique('Engagement target');
    await publishNote(page, text);
    const post = page.getByTestId('post').filter({ hasText: text }).first();

    await post.getByTestId('action-like').click();
    await expect(post.getByTestId('action-like')).toContainText('1');

    await post.getByTestId('action-repost').click();
    await expect(page.getByTestId('toast').filter({ hasText: 'Reposted' })).toBeVisible();

    await post.getByTestId('action-bookmark').click();
    await expect(page.getByTestId('toast').filter({ hasText: 'bookmarks' })).toBeVisible();
  });

  test('unlike stays unliked even after the relay echoes the original like', async ({ page }) => {
    await createIdentity(page);
    const text = unique('Unlike target');
    await publishNote(page, text);
    const post = page.getByTestId('post').filter({ hasText: text }).first();

    await post.getByTestId('action-like').click();
    await expect(post.getByTestId('action-like')).toContainText('1');
    // Toggle off.
    await post.getByTestId('action-like').click();
    await expect(post.getByTestId('action-like')).toContainText('0');
    // Wait long enough for the original like to echo back from relays; it must
    // not silently revert the unlike.
    await page.waitForTimeout(4000);
    await expect(post.getByTestId('action-like')).toContainText('0');
  });

  test('deletes own post after confirmation; it disappears from the feed', async ({ page }) => {
    await createIdentity(page);
    const text = unique('Delete me');
    await publishNote(page, text);
    const post = page.getByTestId('post').filter({ hasText: text }).first();

    await post.getByTestId('action-delete').click();
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    await page.getByTestId('confirm-accept').click();

    await expect(page.getByTestId('toast').filter({ hasText: 'deleted' })).toBeVisible();
    await expect(page.getByTestId('post').filter({ hasText: text })).toHaveCount(0);
  });

  test('opens the compose modal from the New post button', async ({ page }) => {
    await createIdentity(page);
    await page.getByTestId('new-post').click();
    await expect(page.getByTestId('compose-modal')).toBeVisible();
    const text = unique('Posted from modal');
    await page.getByTestId('compose-input').fill(text);
    await page.getByTestId('compose-submit').click();
    await expect(page.getByTestId('compose-modal')).toHaveCount(0);
    await expect(page.getByTestId('post').filter({ hasText: text }).first()).toBeVisible({ timeout: 20_000 });
  });
});
