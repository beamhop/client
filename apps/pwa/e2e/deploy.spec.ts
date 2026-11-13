/** Deploy journeys (JOURNEYS §7): list, move to cloud with plan preview, PaaS token + sandbox ack, destroy. */
import { expect, test } from '@playwright/test';
import { expectAccessible, open } from './helpers.ts';

test('list shows cloud agents with cost and opens the detail', async ({ page }) => {
  await open(page, '/deploy');
  await expect(page.getByText('2 cloud agents')).toBeVisible();
  await page.getByRole('link', { name: /ci-bot @ fly ams/ }).click();
  await expect(page).toHaveURL(/\/deploy\/dep_fly_ams1/);
  await expect(page.getByRole('img', { name: /Route: you to relays to ci-bot@ams/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Destroy…' })).toBeVisible();
});

test('move reviewer to Hetzner: provider → size → files → plan diff → deploy → apply timeline', async ({
  page,
}) => {
  await open(page, '/deploy/new?agent=reviewer');
  await expect(page.getByRole('heading', { name: 'Move reviewer to the cloud' }).first()).toBeAttached();
  await expect(page.getByRole('radio', { name: /^reviewer/ })).toBeChecked();
  await page.getByRole('button', { name: 'Continue · Provider' }).click();

  await page.getByRole('radio', { name: /Hetzner Cloud/ }).check({ force: true });
  await expect(page.getByText(/bubblewrap namespaces/).first()).toBeVisible();
  await page.getByRole('button', { name: 'Continue · Size' }).click();

  await expect(page.getByRole('radio', { name: /cx22/ })).toBeChecked();
  await page.getByRole('radio', { name: /cx32/ }).check({ force: true });
  await page.getByText('Helsinki (hel1)').click();
  await expect(page.getByRole('radio', { name: /Helsinki/ })).toBeChecked();
  await page.getByRole('button', { name: 'Continue · Files' }).click();

  // Mount sync choices: the git repo (fs.list) defaults to a clone, a plain folder to a copy.
  await expect(
    page.getByRole('button', { name: /Clone from git.*How ~\/code\/app gets to the server/ }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: /Copy once.*How ~\/notes gets to the server/ }),
  ).toBeVisible();
  await page.getByText('Subscription login on the server').click();
  await expect(page.getByRole('radio', { name: /Subscription login/ })).toBeChecked();
  await page.getByRole('button', { name: 'Continue · Plan' }).click();

  const plan = page.locator('[data-plan]').first();
  await expect(plan.getByRole('button', { name: /create server/ })).toBeVisible();
  await expect(plan.getByRole('button', { name: /move identity/ })).toBeVisible();
  await expect(plan.getByRole('button', { name: /stop local agent/ })).toBeVisible();
  await expect(plan.getByText('$8.20/mo')).toBeVisible();
  await expectAccessible(page);

  await page.getByRole('button', { name: 'Deploy · $8.20/mo' }).click();
  await expect(page).toHaveURL(/\/deploy\/dep_hetzner_/);
  await expect(page.getByRole('heading', { name: 'Apply' })).toBeVisible();
  await expect(page.getByText('You can leave this screen.', { exact: false })).toBeVisible();
  // The mock finishes after ~8 s; the lamp turns to running.
  await expect(page.getByText('running').first()).toBeVisible({ timeout: 15_000 });
});

test('PaaS: token goes to the keychain, sandbox warning must be acknowledged', async ({ page }) => {
  await open(page, '/deploy/new?mode=new');
  await page.getByLabel('Agent name').fill('night-shift');
  await page.getByRole('button', { name: 'Continue · Provider' }).click();
  await page.getByRole('radio', { name: /Render/ }).check({ force: true });
  const next = page.getByRole('button', { name: 'Continue · Size' });
  await expect(next).toBeDisabled();
  await page.getByLabel('Render API token', { exact: true }).fill(['rnd', 'x'.repeat(24)].join('_'));
  await page.getByRole('button', { name: 'Save token' }).click();
  await expect(page.getByText('token saved').first()).toBeVisible();
  await next.click();
  await page.getByRole('button', { name: 'Continue · Files' }).click();
  await expect(page.getByRole('radio', { name: /API key from this computer/ })).toBeChecked();
  await page.getByRole('button', { name: 'Continue · Plan' }).click();
  await expect(page.getByText(/filesystem isolation = container only/).first()).toBeVisible();
  const deploy = page.getByRole('button', { name: /^Deploy/ });
  await expect(deploy).toBeDisabled();
  await page.getByRole('checkbox', { name: /I understand/ }).check({ force: true });
  await expect(deploy).toBeEnabled();
});

test('destroy needs the agent name typed exactly', async ({ page }) => {
  await open(page, '/deploy/dep_fly_ams1');
  await page.getByRole('button', { name: 'Destroy…' }).click();
  const sheet = page.getByRole('alertdialog', { name: /Destroy ci-bot on fly/ });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('group', { name: 'Destroy plan' })).toBeVisible();
  const go = sheet.getByRole('button', { name: 'Destroy ci-bot' });
  await expect(go).toBeDisabled();
  await sheet.getByLabel('Type ci-bot to confirm').fill('CI-BOT');
  await expect(go).toBeDisabled();
  await expectAccessible(page);
  await sheet.getByLabel('Type ci-bot to confirm').fill('ci-bot');
  await go.click();
  await expect(sheet).toBeHidden();
  await expect(
    page.getByRole('region', { name: 'Notifications' }).getByText(/Destroyed · ci-bot/),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Destroyed', exact: true })).toBeVisible();
});
