/** Phone side of pairing (JOURNEYS §9): open the QR link, compare words, send, confirm there, install + push. */
import { expect, test } from '@playwright/test';
import { expectAccessible, open, rpc } from './helpers.ts';

test('code entry validates, then compare → send → confirm on the computer → install + notifications', async ({ page }) => {
  await open(page, '/pair');
  await expect(page.getByRole('heading', { name: 'Pair this device' })).toBeVisible();
  await page.getByLabel('Pairing code').fill('abc');
  await page.getByRole('button', { name: 'Continue · Compare words' }).click();
  await expect(page.getByText('The code is 8 letters and digits, like AMBR-RLY8.')).toBeVisible();
  await page.getByLabel('Pairing code').fill('ambr rly8');
  await page.getByRole('button', { name: 'Continue · Compare words' }).click();

  await expect(page.getByRole('heading', { name: 'Pair with your computer' })).toBeVisible();
  await expect(page.getByText(/Safety phrase: \w+, \w+, \w+, \w+\./)).toBeAttached();
  await expect(page.getByLabel('Device name')).not.toHaveValue('');
  await expectAccessible(page);
  await page.getByLabel('Device name').fill('Test phone');
  await page.getByRole('button', { name: 'Send pairing request' }).click();

  await expect(page.getByRole('heading', { name: 'Confirm on your computer' })).toBeVisible();
  await page.getByRole('button', { name: 'Confirmed · Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Paired · Test phone' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Get approvals on this phone\?|Notifications on/ })).toBeVisible();
  await expectAccessible(page);
});

test('a QR link names the computer; the token leaves the address bar', async ({ page }) => {
  await open(page, '/settings');
  const start = await rpc<{ uri: string }>(page, 'device.pairStart', { name: 'New device', requireConfirm: true });
  const payload = start.uri.slice(start.uri.indexOf('#') + 1);
  await open(page, `/pair#${payload}`);
  await expect(page.getByRole('heading', { name: "Pair with alice's MacBook" })).toBeVisible();
  await expect(page).not.toHaveURL(/#/);
  await page.getByRole('button', { name: 'Send pairing request' }).click();
  await expect(page.getByRole('heading', { name: 'Confirm on your computer' })).toBeVisible();
  await page.getByRole('button', { name: 'The words differ' }).click();
  await expect(page.getByRole('heading', { name: 'Pairing cancelled.' })).toBeVisible();
  await page.getByRole('button', { name: 'Start again' }).click();
  await expect(page.getByRole('heading', { name: 'Pair this device' })).toBeVisible();
});

test('a broken link explains itself and offers code entry', async ({ page }) => {
  await open(page, '/pair#definitely-not-a-payload');
  await expect(page.getByText(/isn’t a pairing link/)).toBeVisible();
  await expect(page.getByLabel('Pairing code')).toBeVisible();
});
