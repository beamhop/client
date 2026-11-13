/**
 * New Agent flow against the real daemon: the agent exists on the daemon and as YAML on disk; the
 * Folders step browses the daemon's real directories (`fs.list`, under its home directory).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

test('New Agent → Folders → Browse lists the daemon’s real directories (fs.list) and mounts one', async ({
  page,
  bh,
}) => {
  // Directories the test creates under the daemon's home: one plain, one a git repo, one hidden,
  // and a file (never listed: fs.list returns directories only).
  mkdirSync(join(bh.userHome, 'projects', 'site'), { recursive: true });
  mkdirSync(join(bh.userHome, 'projects', 'api', '.git'), { recursive: true });
  mkdirSync(join(bh.userHome, 'projects', '.secret'), { recursive: true });
  writeFileSync(join(bh.userHome, 'projects', 'notes.txt'), 'not a folder\n');
  const listed = await bh.rpc<{ path: string; entries: { path: string; git: boolean }[] }>('fs.list', {
    path: '~/projects',
  });
  expect(listed.entries).toEqual([
    { name: 'api', path: '~/projects/api', git: true },
    { name: 'site', path: '~/projects/site', git: false },
  ]);

  await bh.open(page, '/agents/new');
  await page.getByRole('textbox', { name: 'Name' }).fill('reader');
  await page.getByRole('button', { name: 'Continue · Harness' }).click();
  await page.getByText('Fake Harness', { exact: true }).first().click();
  await page.getByRole('button', { name: 'Continue · Folders' }).click();
  await page.getByRole('button', { name: 'Add folder' }).click();
  await page.getByRole('button', { name: 'Browse' }).click();

  const sheet = page.getByRole('dialog', { name: 'Choose a folder' });
  await expect(sheet.getByRole('button', { name: 'projects' })).toBeVisible();
  await axe(page);
  await sheet.getByRole('button', { name: 'projects' }).click();
  await expect(sheet.getByRole('button', { name: /^api/ })).toContainText('git');
  await expect(sheet.getByRole('button', { name: /^site/ })).toBeVisible();
  await expect(sheet.getByText('.secret')).toHaveCount(0);
  await expect(sheet.getByText('notes.txt')).toHaveCount(0);
  await expect(sheet.getByRole('navigation', { name: 'Folder path' })).toContainText('projects');
  await sheet.getByRole('button', { name: /^site/ }).click();
  await expect(sheet.getByText('No folders here.')).toBeVisible();
  await axe(page);
  await sheet.getByRole('button', { name: 'Use ~/projects/site' }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByRole('combobox', { name: 'Folder' })).toHaveValue('~/projects/site');
  await page.getByRole('button', { name: 'Add folder' }).click();
  await expect(page.getByRole('list', { name: /folder/i }).getByText('~/projects/site')).toBeVisible();
  await axe(page);

  await page.getByRole('button', { name: 'Continue · Review' }).click();
  await page.getByRole('button', { name: 'Create reader', exact: true }).click();
  await expect(page).toHaveURL(/\/agents\/reader/);
  const a = await bh.rpc<{ config: { mounts: { path: string; mode: string }[] } }>('agent.get', {
    name: 'reader',
  });
  expect(a.config.mounts).toEqual([expect.objectContaining({ path: '~/projects/site', mode: 'ro' })]);
  const yaml = readFileSync(join(bh.home, 'agents', 'reader.yaml'), 'utf8');
  expect(yaml).toMatch(/path: ~\/projects\/site/);
  expect(yaml).toMatch(/mode: ro/);
});
