/**
 * The core loop against the real daemon: an owner DM on the fake channel starts a session that shows
 * up live in Sessions, its transcript streams, the harness' permission request lands in the Inbox in
 * real time, the owner approves in the UI (undo window included), the harness gets the decision and
 * the reply is delivered back to the channel. Plus the deny path and the auto-deny timeout.
 */
import { axe, expect, isMobile, test } from './fixtures.ts';

const COMMAND = 'git push origin main';

test('owner DM → live session → streamed transcript', async ({ page, bh }) => {
  await bh.open(page, '/sessions');
  await expect(page.getByRole('heading', { name: /No sessions/i }).first()).toBeVisible();
  await bh.inject({ text: 'STREAM 8' });
  const row = page.getByRole('link', { name: /STREAM 8/ }).first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.getByText(/chunk-2/).first()).toBeVisible();
  // Still streaming: the last chunk has not arrived yet when the first ones show.
  await expect(page.getByText(/chunk-8/).first()).toBeVisible({ timeout: 10_000 });
  await expect.poll(async () => (await bh.sentTo('alice')).join(' ')).toContain('chunk-8');
  await axe(page);
});

test('permission request → Inbox live → approve with undo → harness gets it → reply delivered', async ({
  page,
  bh,
}, info) => {
  await bh.open(page, '/inbox');
  await expect(page.getByRole('heading', { name: 'Inbox clear.' })).toBeVisible();
  await bh.inject({ text: `ASK ${COMMAND}` });
  const allow = page.getByRole('button', { name: /^Allow… \(choose scope\): bot/ }).first();
  await expect(allow).toBeVisible();
  await axe(page);
  if (isMobile(info.project.name)) await expect(page.getByText(COMMAND).first()).toBeVisible();

  // Approve once, then undo inside the window: the daemon puts it back to pending.
  await allow.click();
  const sheet = page.getByRole('dialog', { name: /Allow/ });
  await expect(sheet).toBeVisible();
  await axe(page);
  await sheet.getByRole('button', { name: 'Allow once' }).click();
  const region = page.getByRole('region', { name: 'Notifications' });
  await expect(region.getByText(/Allowed once/)).toBeVisible();
  await region.getByRole('button', { name: 'Undo' }).click();
  await expect
    .poll(async () => (await bh.rpc<{ approvals: unknown[] }>('approval.list')).approvals.length)
    .toBe(1);
  await expect(allow).toBeVisible();
  expect(Object.keys((await bh.snapshot()).harness[0]?.decisions ?? {})).toEqual([]);

  // Approve for real and let the undo window pass.
  await allow.click();
  await sheet.getByRole('button', { name: 'Allow once' }).click();
  await expect(region.getByText(/Allowed once/)).toBeVisible();
  await expect
    .poll(async () => (await bh.snapshot()).harness[0]?.decisions, { timeout: 15_000 })
    .toEqual({ p1: { allow: true } });
  await expect.poll(async () => (await bh.sentTo('alice')).join('\n')).toContain(`allowed: ${COMMAND}`);
  const all = await bh.rpc<{ approvals: { status: string; decidedBy?: string }[] }>('approval.list', {
    status: 'all',
  });
  expect(all.approvals[0]).toMatchObject({ status: 'approved' });
  await expect(page.getByRole('heading', { name: 'Inbox clear.' })).toBeVisible();
});

test('deny path: the harness is refused and the agent says so', async ({ page, bh }) => {
  await bh.open(page, '/inbox');
  await bh.inject({ text: `ASK ${COMMAND}` });
  await page
    .getByRole('button', { name: /^Deny: bot/ })
    .first()
    .click();
  const region = page.getByRole('region', { name: 'Notifications' });
  await expect(region.getByText(/Denied/)).toBeVisible();
  await expect
    .poll(async () => (await bh.snapshot()).harness[0]?.decisions.p1?.allow, { timeout: 15_000 })
    .toBe(false);
  await expect.poll(async () => (await bh.sentTo('alice')).join('\n')).toContain('refused: denied by');
  await axe(page);
});

test('deny with a reason: the reason reaches the harness', async ({ page, bh }) => {
  await bh.open(page, '/inbox');
  await bh.inject({ text: `ASK ${COMMAND}` });
  await page
    .getByRole('button', { name: /^Deny: bot/ })
    .first()
    .click();
  const region = page.getByRole('region', { name: 'Notifications' });
  await region.getByRole('button', { name: 'Add reason' }).click();
  const sheet = page.getByRole('dialog', { name: 'Tell the agent why' });
  await sheet.getByRole('button', { name: 'Use a read-only approach' }).click();
  await expect(region.getByText(/Denied with reason/)).toBeVisible();
  await expect
    .poll(async () => (await bh.snapshot()).harness[0]?.decisions.p1?.reason ?? '', { timeout: 15_000 })
    .toContain('read-only');
});

test('auto-deny: an unanswered request times out and the slip leaves the Inbox', async ({ page, bh }) => {
  await bh.open(page, '/inbox');
  await bh.inject({ text: `ASK ${COMMAND}` });
  await expect(page.getByRole('button', { name: /^Deny: bot/ }).first()).toBeVisible();
  // The seeded agent uses approvalTimeoutMinutes: 1; jump the daemon clock past it.
  await bh.advance(61_000);
  await expect(page.getByText(/Auto-denied at .* the agent was told/).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /^Deny: bot/ })).toHaveCount(0);
  await expect
    .poll(async () => (await bh.snapshot()).harness[0]?.decisions.p1)
    .toEqual({ allow: false, reason: 'denied: timed out' });
  const all = await bh.rpc<{ approvals: { status: string }[] }>('approval.list', { status: 'all' });
  expect(all.approvals[0]?.status).toBe('expired');
  await expect
    .poll(async () => (await bh.sentTo('alice')).join('\n'))
    .toContain('refused: denied: timed out');
});

test('session view: composer sends via session.send, inline approval, stop ends the session', async ({
  page,
  bh,
}) => {
  await bh.inject({ text: 'hello' });
  await expect.poll(async () => (await bh.sentTo('alice')).join('\n')).toContain('reply: hello');
  const { sessions } = await bh.rpc<{ sessions: { id: string }[] }>('session.list');
  await bh.open(page, `/sessions/${sessions[0]!.id}`);
  const log = page.getByRole('log', { name: 'Transcript with bot' });
  await expect(log.getByText('reply: hello')).toBeVisible();

  // Composer → session.send → harness → the reply streams into the open transcript.
  const box = page.getByRole('textbox', { name: 'Message bot' });
  await box.fill('from the app');
  await box.press('Enter');
  await expect(box).toHaveValue('');
  await expect(log.getByText('reply: from the app')).toBeVisible();
  await expect.poll(async () => (await bh.snapshot()).harness[0]?.prompts.at(-1)).toBe('from the app');
  await axe(page);

  // A permission request shows inline in the transcript; deny it there.
  await box.fill(`ASK ${COMMAND}`);
  await box.press('Enter');
  await log.getByRole('button', { name: `Deny: ${COMMAND}` }).click();
  await expect(page.getByRole('region', { name: 'Notifications' }).getByText(/Denied/)).toBeVisible();
  await expect
    .poll(async () => (await bh.snapshot()).harness[0]?.decisions.p3?.allow, { timeout: 15_000 })
    .toBe(false);
  await expect(log.getByText(/refused: denied by/)).toBeVisible();

  // While a turn runs, Stop is one tap; the daemon ends the session and cancels the harness.
  await box.fill('HANG on');
  await box.press('Enter');
  await expect(log.getByText('working…')).toBeVisible();
  await page.getByRole('button', { name: 'Stop bot' }).click();
  await expect.poll(async () => (await bh.snapshot()).harness[0]?.cancelled ?? 0).toBeGreaterThan(0);
  await expect(page.getByRole('heading', { name: 'Session ended' })).toBeVisible();
  await expect
    .poll(async () => (await bh.rpc<{ sessions: { status: string }[] }>('session.list')).sessions[0]?.status)
    .toBe('ended');
  await axe(page);
});
