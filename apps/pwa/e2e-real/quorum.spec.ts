/**
 * N-of-M approvals against the real daemon: a second owner (`fake:bob`, linked as person "bob") on
 * the fake channel, quorum 2 set from Settings → Owners (`approval.quorumSet`). Alice (an owner)
 * asks, so her own vote does not count: the pool is you (`local:owner`) and bob. You approve in the
 * Inbox → "Waiting on others", 1 of 2 (`ApprovalView.quorum` / `votes` from beamhopd); bob's
 * `/approve` on the fake channel completes it and the harness gets the decision.
 */
import { axe, expect, test } from './fixtures.ts';

const COMMAND = 'git push origin main';

interface Approval {
  id: string;
  status: string;
  decidedBy?: string;
  quorum?: { needed: number; pool: number };
  votes?: { by: string; allow: boolean }[];
}

test('N-of-M approval: quorum and votes come from the daemon; a second owner completes it', async ({
  page,
  bh,
}) => {
  await bh.rpc('owner.add', { principal: 'fake:bob' });
  await bh.rpc('principal.link', { person: 'bob', principal: 'fake:bob' });
  expect(await bh.rpc('approval.quorumGet')).toEqual({ quorum: 1, approvers: 3 });

  // Settings → Owners: you, alice and bob can approve; require 2.
  await bh.open(page, '/settings/owners');
  const owners = page.getByRole('region', { name: 'Owners' });
  await expect(owners.getByText('You', { exact: true })).toBeVisible();
  await expect(owners.getByText('bob', { exact: true })).toBeVisible();
  await page.getByRole('radio', { name: '2 of 3' }).click({ force: true });
  await expect(
    page.getByRole('region', { name: 'Notifications' }).getByText('Quorum · 2 of 3'),
  ).toBeVisible();
  expect(await bh.rpc('approval.quorumGet')).toEqual({ quorum: 2, approvers: 3 });
  await axe(page);

  await bh.open(page, '/inbox');
  await bh.inject({ text: `ASK ${COMMAND}` });
  const approve = page.getByRole('button', { name: /^Approve \(choose scope\): bot/ }).first();
  await expect(approve).toBeVisible();
  await expect(page.getByText('0 of 2 owners approved').first()).toBeVisible();
  const [pending] = (await bh.rpc<{ approvals: Approval[] }>('approval.list')).approvals;
  expect(pending).toMatchObject({ status: 'pending', quorum: { needed: 2, pool: 2 } });
  await axe(page);

  await approve.click();
  const sheet = page.getByRole('dialog', { name: /Allow/ });
  await expect(sheet.getByText('This needs 2 owners.', { exact: false })).toBeVisible();
  await axe(page);
  await sheet.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Notifications' }).getByText('Approved · waiting for others'),
  ).toBeVisible();
  const waiting = page.getByRole('region', { name: /^Waiting on others/ });
  await expect(waiting.getByText('1 of 2 owners approved').first()).toBeVisible();
  await axe(page);

  // The daemon holds your vote; nothing reached the harness yet.
  const mid = (await bh.rpc<{ approvals: Approval[] }>('approval.list')).approvals[0]!;
  expect(mid).toMatchObject({ id: pending!.id, status: 'pending' });
  expect(mid.votes).toEqual([expect.objectContaining({ by: 'local:owner', allow: true })]);
  expect((await bh.snapshot()).harness[0]?.decisions).toEqual({});

  // Bob approves from his own DM on the fake channel.
  await bh.inject({
    text: `/approve ${pending!.id}`,
    from: { principal: 'fake:bob', displayName: 'Bob' },
    conversation: { kind: 'dm', id: 'bob' },
  });
  await expect
    .poll(async () => {
      const all = await bh.rpc<{ approvals: Approval[] }>('approval.list', { status: 'all' });
      return all.approvals.find((a) => a.id === pending!.id)?.status;
    })
    .toBe('approved');
  const done = (await bh.rpc<{ approvals: Approval[] }>('approval.list', { status: 'all' })).approvals.find(
    (a) => a.id === pending!.id,
  )!;
  expect(done.votes?.map((v) => v.by)).toEqual(['local:owner', 'bob']);
  expect(done.decidedBy?.split(',').sort()).toEqual(['fake:bob', 'local:owner']);

  await expect
    .poll(async () => (await bh.snapshot()).harness[0]?.decisions, { timeout: 15_000 })
    .toEqual({ p1: { allow: true } });
  await expect.poll(async () => (await bh.sentTo('alice')).join('\n')).toContain(`allowed: ${COMMAND}`);
  await expect(waiting).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Inbox clear.' })).toBeVisible();
  await axe(page);
});
