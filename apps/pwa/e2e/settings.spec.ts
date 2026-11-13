/** Settings journeys: devices (pair with safety phrase on this side, remove), secrets, NIP-05, purge, kill switch. */
import { expect, test } from '@playwright/test';
import { expectAccessible, open } from './helpers.ts';

test('section list carries live status', async ({ page }) => {
  await open(page, '/settings');
  const nav = page.getByRole('navigation', { name: 'Settings sections' });
  await expect(nav.getByRole('link', { name: /Devices.*3 devices · 1 inactive/ })).toBeVisible();
  await expect(nav.getByRole('link', { name: /Secrets.*8 names/ })).toBeVisible();
  await nav.getByRole('link', { name: /Owners & people/ }).click();
  await expect(page).toHaveURL(/\/settings\/owners/);
  await expect(page.getByRole('heading', { name: 'Approval quorum' })).toBeVisible();
});

test('owners: you from whoami, quorum and linked identities come from the daemon', async ({ page }) => {
  await open(page, '/settings/owners');
  await expectAccessible(page);
  await expect(
    page
      .getByRole('heading', { name: 'You' })
      .or(page.getByText('You', { exact: true }))
      .first(),
  ).toBeVisible();
  // Quorum: N of the approver pool (owners + roles that can approve).
  const quorum = page.getByRole('radiogroup', { name: 'Approvals needed' });
  await quorum.getByRole('radio', { name: /^2 of / }).click({ force: true });
  await expect(
    page.getByRole('region', { name: 'Notifications' }).getByText(/Quorum · 2 of \d/),
  ).toBeVisible();
  await expect(quorum.getByRole('radio', { name: /^2 of / })).toBeChecked();
  // Linked identities: link, then unlink.
  await page.getByRole('textbox', { name: 'Person' }).fill('bob');
  await page.getByRole('textbox', { name: 'Account' }).fill('telegram:4242');
  await page.getByRole('button', { name: 'Link' }).click();
  await expect(page.getByText('telegram:4242').first()).toBeVisible();
  await page.getByRole('button', { name: 'Actions for telegram:4242' }).click();
  await page.getByRole('menuitem', { name: 'Unlink from bob' }).click();
  await expect(
    page.getByRole('region', { name: 'Notifications' }).getByText('Unlinked · telegram:4242'),
  ).toBeVisible();
});

test('updates and notification rules are daemon settings', async ({ page }) => {
  await open(page, '/settings/updates');
  const cat = page.getByRole('switch', { name: 'Update the catalog automatically' });
  await expect(cat).toBeChecked();
  await page.getByText('Update the catalog automatically', { exact: true }).click();
  await expect(cat).not.toBeChecked();
  await open(page, '/settings/notifications');
  const quiet = page.getByRole('switch', { name: /Quiet hours/ });
  await expect(quiet).not.toBeChecked();
  await page.getByText('Quiet hours', { exact: true }).click();
  await expect(quiet).toBeChecked();
  await expect(page.getByText(/22:00–07:00 on your computer's clock/)).toBeVisible();
  await expect(page.getByText(/browser only|this device only|Saved on this device/i)).toHaveCount(0);
});

test('pair a device: QR, phone answers, compare words here, confirm', async ({ page }) => {
  await open(page, '/settings/devices');
  await page.getByRole('button', { name: 'Pair a device' }).first().click();
  const sheet = page.getByRole('dialog', { name: 'Pair a device' });
  await expect(sheet.getByRole('img', { name: /QR code to pair your phone/ })).toBeVisible();
  await expect(sheet.getByText('Waiting for your phone…')).toBeVisible();
  await expectAccessible(page);
  await sheet.getByRole('button', { name: 'Show code instead' }).click();
  await expect(sheet.getByText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)).toBeVisible();
  // The demo phone answers after a few seconds; the 4 words appear on THIS (trusted) side.
  await expect(sheet.getByText('Does iPhone · Safari show these words?')).toBeVisible({ timeout: 12_000 });
  await expect(sheet.getByText(/Safety phrase: \w+, \w+, \w+, \w+\./)).toBeAttached();
  await sheet.getByRole('button', { name: 'Yes, pair iPhone · Safari' }).click();
  await expect(sheet.getByText('Paired · iPhone · Safari')).toBeVisible();
  await sheet.getByRole('button', { name: 'Close' }).click();
  await expect(
    page.getByRole('heading', { name: 'iPhone · Safari' }).or(page.getByText('iPhone · Safari')).first(),
  ).toBeVisible();
});

test('a phrase mismatch cancels the pairing', async ({ page }) => {
  await open(page, '/settings/devices');
  await page.getByRole('button', { name: 'Pair a device' }).first().click();
  const sheet = page.getByRole('dialog', { name: 'Pair a device' });
  await sheet.getByRole('button', { name: 'No, cancel' }).click({ timeout: 12_000 });
  await expect(sheet.getByText('Pairing cancelled. Nothing was paired.')).toBeVisible();
});

test('remove an inactive device from its row menu', async ({ page }) => {
  await open(page, '/settings/devices');
  await expect(page.getByText(/Pixel · Chrome hasn't been seen for \d+ days/)).toBeVisible();
  await page.getByRole('button', { name: 'Actions for Pixel · Chrome' }).click();
  await page.getByRole('menuitem', { name: 'Remove…' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Remove Pixel · Chrome?' });
  await expect(dialog.getByText(/won't be able to control your agents/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Remove Pixel · Chrome' }).click();
  await expect(
    page.getByRole('region', { name: 'Notifications' }).getByText('Removed · Pixel · Chrome'),
  ).toBeVisible();
  await expect(page.getByText('INACTIVE 94 D', { exact: false })).toHaveCount(0);
});

test('secrets: names only; add, then delete', async ({ page }) => {
  await open(page, '/settings/secrets');
  await expect(page.getByText('ANTHROPIC_API_KEY')).toBeVisible();
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Add a secret' });
  await sheet.getByLabel('Name').fill('bad name');
  await sheet.getByLabel('Value', { exact: true }).fill(['val', 'x'.repeat(20)].join('-'));
  await sheet.getByRole('button', { name: 'Save to keychain' }).click();
  await expect(sheet.getByText(/Use letters, digits/)).toBeVisible();
  await sheet.getByLabel('Name').fill('SENTRY_DSN');
  await sheet.getByRole('button', { name: 'Save to keychain' }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByText('SENTRY_DSN', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Actions for SENTRY_DSN' }).click();
  await page.getByRole('menuitem', { name: 'Delete…' }).click();
  await page
    .getByRole('alertdialog', { name: 'Delete SENTRY_DSN?' })
    .getByRole('button', { name: 'Delete SENTRY_DSN' })
    .click();
  await expect(page.getByText('SENTRY_DSN', { exact: true })).toHaveCount(0);
});

test('identity: NIP-05 generator produces nostr.json and hosting snippets', async ({ page }) => {
  await open(page, '/settings/identity');
  await expect(page.getByRole('heading', { name: 'Owner key' })).toBeVisible();
  await page.getByLabel('Domain').fill('https://Example.com/');
  await page.getByRole('button', { name: 'Generate nostr.json' }).click();
  await expect(
    page.getByRole('region', { name: 'https://example.com/.well-known/nostr.json' }),
  ).toBeVisible();
  await expect(page.getByRole('tab', { name: 'nginx' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Check reviewer@example.com/ })).toBeVisible();
});

test('retention: purge requires typing the target', async ({ page }) => {
  await open(page, '/settings/retention');
  await page.getByRole('button', { name: 'Purge…' }).click();
  const sheet = page.getByRole('alertdialog', { name: 'Purge data?' });
  const go = sheet.getByRole('button', { name: 'Purge everything' });
  await expect(go).toBeDisabled();
  await sheet.getByLabel('Type everything to confirm').fill('everything');
  await go.click();
  await expect(
    page.getByRole('region', { name: 'Notifications' }).getByText(/Purged · \d+ records deleted/),
  ).toBeVisible();
});

test('kill switch section opens the one-confirm panic sheet', async ({ page }) => {
  await open(page, '/settings/stop');
  await expect(page.getByRole('heading', { name: 'What stops' })).toBeVisible();
  await page.locator('#bh-main-content').getByRole('button', { name: 'Stop everything' }).click();
  await expect(page.getByRole('alertdialog', { name: 'Stop everything?' })).toBeVisible();
});
