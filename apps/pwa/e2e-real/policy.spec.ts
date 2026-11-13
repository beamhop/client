/**
 * Policy against the real daemon: a host chip saved from the UI reaches the effective policy; custom
 * roles are defined / deleted on the daemon (`role.define` / `role.delete`) and offered where roles
 * are picked (the channel wizard's Join step).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { axe, expect, isMobile, test } from './fixtures.ts';

interface Policy {
  profile: string;
  effective: { net: { allow: string[] } };
}

interface RoleList {
  roles: { name: string; canPrompt: boolean; canApprove: boolean; description: string }[];
}

/** Open a role's editor from /policy/roles (table header on desktop, disclosure on compact). */
const editRole = async (page: Page, name: string, mobile: boolean) => {
  if (mobile) await page.getByRole('button', { name: new RegExp(`^${name}`) }).click();
  await page.getByRole('button', { name: `Edit ${name}` }).click();
  return page.getByRole('dialog', { name: `Edit ${name}` });
};

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

test('Policy → Roles: define a custom role; the daemon stores it and the Join step offers it', async ({
  page,
  bh,
}, info) => {
  const mobile = isMobile(info.project.name);
  await bh.open(page, '/policy/roles');
  await axe(page);
  await page.getByRole('button', { name: 'New role' }).click();
  const sheet = page.getByRole('dialog', { name: 'New role' });
  await sheet.getByRole('textbox', { name: 'Name' }).fill('reviewer-guest');
  await sheet.getByRole('textbox', { name: "What it's for" }).fill('Reads and reviews, may talk');
  await sheet.getByText('Can approve other people’s requests', { exact: true }).click();
  await expect(sheet.getByRole('switch', { name: 'Can approve other people’s requests' })).toBeChecked();
  await axe(page);
  await sheet.getByRole('button', { name: 'Create role' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Create the reviewer-guest role?' });
  await expect(confirm.getByText('Can approve other people’s requests: no → yes')).toBeVisible();
  await confirm.getByRole('button', { name: 'Create role' }).click();
  await expect(
    page.getByRole('region', { name: 'Notifications' }).getByText('Created · reviewer-guest'),
  ).toBeVisible();

  const { roles } = await bh.rpc<RoleList>('role.list');
  expect(roles.find((r) => r.name === 'reviewer-guest')).toMatchObject({
    canPrompt: true,
    canApprove: true,
    description: 'Reads and reviews, may talk',
  });
  expect(readFileSync(join(bh.home, 'config.yaml'), 'utf8')).toMatch(/name: reviewer-guest/);
  await expect(page.getByText('reviewer-guest').first()).toBeVisible();

  // The channel wizard's Join step offers the new role; pick it for bot's DMs on a new channel.
  await bh.open(page, '/channels/add/fake/1');
  await page.getByLabel('Token', { exact: true }).fill(`good-${Math.random().toString(36).slice(2, 8)}`);
  await page.getByRole('button', { name: /^Connect / }).click({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Continue · Pair' }).click();
  await page.getByRole('button', { name: 'Pair later' }).click();
  await expect(page.getByRole('heading', { name: 'Choose who answers here' })).toBeVisible();
  const radio = page.getByRole('radio', { name: /^reviewer-guest/ });
  await expect(radio).toBeVisible();
  await axe(page);
  await page.getByText('reviewer-guest', { exact: true }).click();
  await expect(radio).toBeChecked();
  await page.getByRole('checkbox', { name: /bot/ }).first().check({ force: true });
  await page.getByRole('button', { name: /^Finish/ }).click();
  const { channels } = await bh.rpc<{ channels: { config: { name: string } }[] }>('channel.list');
  const added = channels.find((c) => c.config.name !== 'fk')!.config.name;
  await expect
    .poll(async () => {
      const a = await bh.rpc<{ config: { memberships: { target: string; defaultRole: string }[] } }>(
        'agent.get',
        { name: 'bot' },
      );
      return a.config.memberships.find((m) => m.target === `${added}:dm`)?.defaultRole;
    })
    .toBe('reviewer-guest');

  // Now in use: the editor says where and offers no delete (the daemon would refuse it).
  await bh.open(page, '/policy/roles');
  const editor = await editRole(page, 'reviewer-guest', mobile);
  await expect(editor.getByText(`In use by bot on ${added}:dm.`, { exact: false })).toBeVisible();
  await expect(editor.getByRole('button', { name: 'Delete role' })).toHaveCount(0);
  await axe(page);
  await expect(bh.rpc('role.delete', { name: 'reviewer-guest' })).rejects.toThrow();
});

test('Policy → Roles: delete an unused custom role (role.delete)', async ({ page, bh }, info) => {
  await bh.rpc('role.define', { role: { name: 'temp-helper', description: 'For a week', canPrompt: true } });
  await bh.open(page, '/policy/roles');
  const editor = await editRole(page, 'temp-helper', isMobile(info.project.name));
  await expect(editor.getByText("Nobody has this role. Deleting it can't be undone.")).toBeVisible();
  await editor.getByRole('button', { name: 'Delete role' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Delete the temp-helper role?' });
  await axe(page);
  await confirm.getByRole('button', { name: 'Delete role' }).click();
  await expect(
    page.getByRole('region', { name: 'Notifications' }).getByText('Deleted · temp-helper'),
  ).toBeVisible();
  const { roles } = await bh.rpc<RoleList>('role.list');
  expect(roles.map((r) => r.name)).not.toContain('temp-helper');
  expect(readFileSync(join(bh.home, 'config.yaml'), 'utf8')).not.toMatch(/temp-helper/);
  await expect(page.locator('#bh-main-content').last().getByText('temp-helper')).toHaveCount(0);
});
