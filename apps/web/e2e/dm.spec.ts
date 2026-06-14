import { test, expect } from '@playwright/test';
import { createIdentity, readNpub, unique } from './helpers.js';

test.describe('encrypted direct messages (cross-client)', () => {
  test('Alice sends an encrypted DM that Bob receives on real relays', async ({ browser }) => {
    test.setTimeout(120_000);

    // --- Bob: create identity, grab npub, sit on the Messages view ---
    const bobCtx = await browser.newContext();
    const bob = await bobCtx.newPage();
    await createIdentity(bob);
    const bobNpub = await readNpub(bob);
    await bob.getByTestId('nav-messages').click();

    // --- Alice: create identity, find Bob, send a secret message ---
    const aliceCtx = await browser.newContext();
    const alice = await aliceCtx.newPage();
    await createIdentity(alice);
    await alice.getByTestId('nav-explore').click();
    await alice.getByTestId('explore-search').fill(bobNpub);
    await alice.getByTestId('explore-search').press('Enter');
    await alice.getByTestId('message-person').first().click();

    await expect(alice.getByTestId('view-title')).toHaveText('Messages');
    const secret = unique('encrypted-hello');
    await alice.getByTestId('dm-input').fill(secret);
    await alice.getByTestId('dm-send').click();

    // Alice sees her own message immediately.
    await expect(alice.getByTestId('dm-message').filter({ hasText: secret }).first()).toBeVisible({ timeout: 15_000 });

    // --- Bob: the message arrives over the relays and decrypts ---
    const bobConversation = bob.getByTestId('conversation-row').first();
    await expect(bobConversation).toBeVisible({ timeout: 90_000 });
    await bobConversation.click();
    await expect(bob.getByTestId('dm-message').filter({ hasText: secret }).first()).toBeVisible({ timeout: 30_000 });

    // --- Bob replies, Alice receives ---
    const reply = unique('got-it');
    await bob.getByTestId('dm-input').fill(reply);
    await bob.getByTestId('dm-send').click();
    await expect(alice.getByTestId('dm-message').filter({ hasText: reply }).first()).toBeVisible({ timeout: 90_000 });

    await aliceCtx.close();
    await bobCtx.close();
  });
});
