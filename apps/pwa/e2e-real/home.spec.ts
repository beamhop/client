/** Home + Agents against the real daemon: real data, agent list matches `agent.list`. */
import { axe, expect, test, watchErrors } from './fixtures.ts';

test('home loads real data from the daemon', async ({ page, bh }) => {
  const errors = watchErrors(page);
  await bh.open(page, '/');
  await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeAttached();
  await expect(page.getByRole('heading', { name: 'bot' }).first()).toBeVisible();
  await axe(page);
  expect(errors).toEqual([]);
});

test('agent list matches the daemon', async ({ page, bh }) => {
  await bh.rpc('agent.create', { config: { name: 'helper', harness: 'fake' } });
  const { agents } = await bh.rpc<{ agents: { config: { name: string } }[] }>('agent.list');
  await bh.open(page, '/agents');
  for (const a of agents)
    await expect(page.getByRole('link', { name: new RegExp(a.config.name) }).first()).toBeVisible();
  await axe(page);
});
