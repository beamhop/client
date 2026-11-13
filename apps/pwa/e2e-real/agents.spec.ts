/** New Agent flow against the real daemon: the agent exists on the daemon and as YAML on disk. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { axe, expect, test } from './fixtures.ts';

test('create an agent with the New Agent flow → agent.get + agents/<name>.yaml', async ({ page, bh }) => {
  await bh.open(page, '/agents/new');
  await axe(page);
  await page.getByRole('textbox', { name: 'Name' }).fill('scout');
  await page.getByRole('button', { name: 'Continue · Harness' }).click();
  await expect(page.getByRole('heading', { name: 'Which harness runs it?' })).toBeVisible();
  await page.getByText('Fake Harness', { exact: true }).first().click();
  await axe(page);
  await page.getByRole('button', { name: 'Continue · Folders' }).click();
  await axe(page);
  await page.getByRole('button', { name: /Skip · Review|Continue · Review/ }).click();
  await expect(page.getByRole('heading', { name: 'Check and create' })).toBeVisible();
  await axe(page);
  await page.getByRole('button', { name: 'Create scout', exact: true }).click();
  await expect(page).toHaveURL(/\/agents\/scout/);
  await expect(page.getByRole('region', { name: 'Notifications' }).getByText(/Created scout/)).toBeVisible();

  const a = await bh.rpc<{ config: { name: string; harness: string }; status: string }>('agent.get', {
    name: 'scout',
  });
  expect(a.config).toMatchObject({ name: 'scout', harness: 'fake' });
  const yaml = readFileSync(join(bh.home, 'agents', 'scout.yaml'), 'utf8');
  expect(yaml).toMatch(/^name: scout$/m);
  expect(yaml).toMatch(/^harness: fake$/m);
  await axe(page);
});

test('a name the daemon already has is caught before creating', async ({ page, bh }) => {
  await bh.open(page, '/agents/new');
  await page.getByRole('textbox', { name: 'Name' }).fill('bot');
  await page.getByRole('button', { name: 'Continue · Harness' }).click();
  await expect(page.getByText(/bot already exists/).first()).toBeVisible();
  const { agents } = await bh.rpc<{ agents: unknown[] }>('agent.list');
  expect(agents).toHaveLength(1);
});
