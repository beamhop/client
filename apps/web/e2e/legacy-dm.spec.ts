import { test, expect } from '@playwright/test';
import { SimplePool } from 'nostr-tools/pool';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import * as nip04 from 'nostr-tools/nip04';
import * as nip19 from 'nostr-tools/nip19';
import { createIdentity, readNpub } from './helpers.js';

const RELAYS = ['wss://nos.lol', 'wss://relay.damus.io'];

// Simulates a legacy (kind-4 / NIP-04) DM arriving from an older client and
// asserts the client decrypts it and flags it as less secure.
test('a legacy encrypted DM is received and flagged as less secure', async ({ page }) => {
  test.setTimeout(120_000);
  await createIdentity(page);
  const bobNpub = await readNpub(page);
  const bobPk = nip19.decode(bobNpub).data as string;
  await page.getByTestId('nav-messages').click();

  // Publish a kind-4 DM to Bob from a throwaway "old client" identity.
  const senderSk = generateSecretKey();
  const content = await nip04.encrypt(senderSk, bobPk, 'ping from an older, less secure client');
  const event = finalizeEvent(
    { kind: 4, created_at: Math.floor(Date.now() / 1000), tags: [['p', bobPk]], content },
    senderSk,
  );
  const pool = new SimplePool();
  await Promise.any(pool.publish(RELAYS, event));

  const conv = page.getByTestId('conversation-row').first();
  await expect(conv).toBeVisible({ timeout: 90_000 });
  await conv.click();

  // The decrypted message and its "less secure" marker both show.
  await expect(page.getByTestId('dm-message').filter({ hasText: 'older, less secure client' }).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('dm-insecure').first()).toBeVisible();
  await page.screenshot({ path: 'test-results/legacy-dm.png' });
  pool.close(RELAYS);
});
