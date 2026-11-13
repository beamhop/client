/** Policy edit against the real daemon: a host chip saved from the UI reaches the effective policy. */
import { axe, expect, test } from './fixtures.ts';

interface Policy {
  profile: string;
  effective: { net: { allow: string[] } };
}

test('add a host chip, review, save → the daemon’s effective policy allows it', async ({ page, bh }) => {
  const before = await bh.rpc<Policy>('policy.get', { name: 'bot' });
  expect(before.effective.net.allow).not.toContain('docs.example.org');
  await bh.open(page, '/policy/bot');
  await axe(page);
  const input = page.getByRole('textbox', { name: 'Add host' });
  await input.fill('https://docs.example.org/guide');
  await input.press('Enter');
  await expect(page.getByText('Added docs.example.org (from https://docs.example.org/guide)')).toBeVisible();
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: "Review bot's sandbox" });
  await expect(sheet.getByText('bot will also be able to reach docs.example.org.')).toBeVisible();
  await axe(page);
  await sheet.getByRole('button', { name: 'Widen access' }).click();
  await expect(page.getByRole('region', { name: 'Notifications' }).getByText(/Widened/)).toBeVisible();

  const after = await bh.rpc<Policy>('policy.get', { name: 'bot' });
  expect(after.effective.net.allow).toContain('docs.example.org');
  // Everything the agent could reach before is still there (nothing silently dropped).
  for (const h of before.effective.net.allow) expect(after.effective.net.allow).toContain(h);
  // Reload: the UI reads the saved policy back from the daemon.
  await bh.open(page, '/policy/bot');
  await expect(page.getByRole('button', { name: 'Remove docs.example.org' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review', exact: true })).toHaveCount(0);
  await axe(page);
});
