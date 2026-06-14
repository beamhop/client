import { test, expect } from '@playwright/test';
import { createIdentity, readNpub, unique } from './helpers.js';

test.describe('unread badge persistence', () => {
  test('unread badge appears, clears on read, and stays cleared after reload', async ({ browser }) => {
    test.setTimeout(120_000);

    // Bob waits on Home (not Messages) so the message counts as unread.
    const bobCtx = await browser.newContext();
    const bob = await bobCtx.newPage();
    await createIdentity(bob);
    const bobNpub = await readNpub(bob);
    await bob.getByTestId('nav-home').click();

    // Alice sends Bob a message.
    const aliceCtx = await browser.newContext();
    const alice = await aliceCtx.newPage();
    await createIdentity(alice);
    await alice.getByTestId('nav-explore').click();
    await alice.getByTestId('explore-search').fill(bobNpub);
    await alice.getByTestId('explore-search').press('Enter');
    await alice.getByTestId('message-person').first().click();
    const secret = unique('unread-test');
    await alice.getByTestId('dm-input').fill(secret);
    await alice.getByTestId('dm-send').click();

    // Bob sees the unread badge.
    await expect(bob.getByTestId('dm-unread-badge')).toBeVisible({ timeout: 90_000 });

    // Bob reads the conversation.
    await bob.getByTestId('nav-messages').click();
    await bob.getByTestId('conversation-row').first().click();
    await expect(bob.getByTestId('dm-message').filter({ hasText: secret }).first()).toBeVisible({ timeout: 30_000 });

    // Badge clears.
    await expect(bob.getByTestId('dm-unread-badge')).toHaveCount(0, { timeout: 10_000 });

    // After a reload, the read state persists — no unread badge.
    await bob.reload();
    await expect(bob.getByTestId('app-shell')).toBeVisible({ timeout: 30_000 });
    await expect(bob.getByTestId('dm-unread-badge')).toHaveCount(0, { timeout: 15_000 });

    // Bob navigates away, then Alice sends a SECOND message. Because the read
    // marker is the first message's timestamp (not wall-clock), the new message
    // must re-raise the unread badge.
    await bob.getByTestId('nav-home').click();
    const secret2 = unique('second-msg');
    await alice.getByTestId('dm-input').fill(secret2);
    await alice.getByTestId('dm-send').click();
    await expect(bob.getByTestId('dm-unread-badge')).toBeVisible({ timeout: 90_000 });

    await aliceCtx.close();
    await bobCtx.close();
  });
});
