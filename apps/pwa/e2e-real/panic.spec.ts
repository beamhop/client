/**
 * Panic against the real daemon: one confirm kills running sessions, `system.status.panic` is true,
 * every screen shows the band; Review & resume brings back only what was selected.
 */
import { axe, expect, test } from './fixtures.ts';

interface Status {
  panic: boolean;
}
interface Sessions {
  sessions: { id: string; status: string }[];
}
interface AgentView {
  config: { name: string };
  status: string;
}

test('panic from the UI kills sessions, flips system.status, shows the band; resume via checklist', async ({
  page,
  bh,
}) => {
  await bh.rpc('agent.create', { config: { name: 'helper', harness: 'fake' } });
  await bh.inject({ text: 'HANG please' });
  await expect
    .poll(async () => (await bh.rpc<Sessions>('session.list')).sessions.map((s) => s.status))
    .toEqual(['running']);

  await bh.open(page, '/more');
  await page.getByRole('button', { name: 'Stop everything' }).first().click();
  const sheet = page.getByRole('alertdialog', { name: 'Stop everything?' });
  await expect(sheet).toBeVisible();
  await axe(page);
  await sheet.getByRole('button', { name: 'Stop everything' }).click();
  await expect(sheet.getByText('Everything is stopped.')).toBeVisible();

  // The daemon really stopped: panic flag, the harness session cancelled, sessions ended.
  expect((await bh.rpc<Status>('system.status')).panic).toBe(true);
  await expect.poll(async () => (await bh.snapshot()).harness[0]?.cancelled ?? 0).toBeGreaterThan(0);
  await expect
    .poll(async () => (await bh.rpc<Sessions>('session.list')).sessions.map((s) => s.status))
    .toEqual(['ended']);

  await sheet.getByRole('button', { name: 'Close' }).first().click();
  await expect(page.getByRole('region', { name: /Everything is stopped/ })).toBeVisible();
  await axe(page);
  // The band survives a reload (state comes from the daemon, not the tab).
  await bh.open(page, '/');
  await expect(page.getByRole('region', { name: /Everything is stopped/ })).toBeVisible();

  // Review & resume: nothing pre-selected; resume only `bot`.
  await page.getByRole('link', { name: 'Review & resume' }).click();
  await expect(page.getByRole('button', { name: 'Resume without agents' })).toBeVisible();
  await axe(page);
  await page.getByRole('checkbox', { name: /^bot/ }).first().check({ force: true });
  await page.getByRole('button', { name: 'Resume 1 selected' }).click();
  await expect(page).toHaveURL(/\/(\?.*)?$/);
  await expect(page.getByRole('region', { name: /Everything is stopped/ })).toHaveCount(0);

  expect((await bh.rpc<Status>('system.status')).panic).toBe(false);
  const { agents } = await bh.rpc<{ agents: AgentView[] }>('agent.list');
  const status = Object.fromEntries(agents.map((a) => [a.config.name, a.status]));
  expect(status).toEqual({ bot: 'idle', helper: 'stopped' });
  // The resumed agent answers again on its channel.
  await bh.inject({ text: 'back?' });
  await expect.poll(async () => (await bh.sentTo('alice')).join('\n')).toContain('reply: back?');
});
