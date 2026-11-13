/**
 * Channels against the real daemon: add a channel through the wizard with the test daemon's fake
 * channel plugin (`fake`, its `validate()` accepts tokens starting with "good"), pair an owner on it by sending
 * `/pair CODE` through the fake channel, confirm, join an agent, and check the daemon's view.
 */
import { axe, expect, test } from './fixtures.ts';

interface ChannelView {
  config: { name: string; provider: string; secretRefs: string[]; settings: Record<string, unknown> };
  status: string;
}

test('add a plugin channel via the wizard, pair an owner, join an agent', async ({ page, bh }) => {
  await bh.open(page, '/channels/add');
  await page.getByRole('link', { name: /^Fake/ }).click();
  await expect(page).toHaveURL(/\/channels\/add\/fake\/1/);
  await axe(page);

  // Credentials: the plugin's own secret field ("Token") is shown and validated live.
  const token = `good-${Math.random().toString(36).slice(2, 8)}`;
  await page.getByLabel('Token', { exact: true }).fill(token);
  const connect = page.getByRole('button', { name: /^Connect / });
  await expect(connect).toBeVisible({ timeout: 10_000 });
  await connect.click();

  // Saved on the daemon, secret in the vault under the daemon's naming, connected.
  await expect
    .poll(async () => {
      const { channels } = await bh.rpc<{ channels: ChannelView[] }>('channel.list');
      return channels.filter((c) => c.config.name !== 'fk').map((c) => [c.config.provider, c.status]);
    })
    .toEqual([['fake', 'connected']]);
  const { channels } = await bh.rpc<{ channels: ChannelView[] }>('channel.list');
  const added = channels.find((c) => c.config.name !== 'fk')!;
  expect(added.config.secretRefs).toEqual([`channel.${added.config.name}.token`]);

  // The token is never kept by the app (draft hints show no characters of a short secret).
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(stored).not.toContain(token);
  expect(await page.content()).not.toContain(token);

  // Validate + Connect fill on their own; Continue waits when focus has left the step.
  await page.getByRole('button', { name: 'Continue · Pair' }).click();

  // Pair: the wizard shows a code; the owner sends it to the bot from their account.
  await expect(page).toHaveURL(/\/channels\/add\/fake\/4/);
  await expect(page.getByText(/Waiting for \/pair/).first()).toBeVisible();
  const main = (await page.locator('#bh-main-content').last().textContent()) ?? '';
  const code = /\/pair\s*([A-Z2-9]{6})/.exec(main)?.[1] ?? '';
  expect(code).toMatch(/^[A-Z2-9]{6}$/);
  await axe(page);
  await bh.inject({
    channel: added.config.name,
    text: `/pair ${code}`,
    from: { principal: 'fake:carol', displayName: 'Carol' },
    conversation: { kind: 'dm', id: 'carol' },
  });
  await expect(page.getByText('Paired with Carol')).toBeVisible();
  await page
    .getByRole('button', { name: /This is me|Continue/ })
    .first()
    .click();
  await expect.poll(async () => (await bh.sentTo('carol', added.config.name)).join('\n')).toContain('Paired');
  // The daemon recorded the pairing on the channel (what the wizard waited for).
  const paired = await bh.rpc<{ channels: ChannelView[] }>('channel.list');
  expect(paired.channels.find((c) => c.config.name === added.config.name)?.config.settings.pairings).toEqual([
    expect.objectContaining({ principal: 'fake:carol', role: 'owner' }),
  ]);

  // Join: pick the seeded agent for DMs on the new channel and finish.
  await expect(page.getByRole('heading', { name: 'Choose who answers here' })).toBeVisible();
  await axe(page);
  await page.getByRole('checkbox', { name: /bot/ }).first().check({ force: true });
  await page.getByRole('button', { name: /^Finish/ }).click();
  await expect(page).toHaveURL(new RegExp(`/channels/${added.config.name}`));
  const agent = await bh.rpc<{ config: { memberships: { target: string }[] } }>('agent.get', { name: 'bot' });
  expect(agent.config.memberships.map((m) => m.target)).toContain(`${added.config.name}:dm`);
  await axe(page);
});

test('a wrong token is rejected by the plugin and nothing is saved', async ({ page, bh }) => {
  await bh.open(page, '/channels/add/fake/1');
  await page.getByLabel('Token', { exact: true }).fill('nope');
  await expect(page.getByRole('alert').filter({ hasText: 'bad token' })).toBeVisible({ timeout: 10_000 });
  const { channels } = await bh.rpc<{ channels: ChannelView[] }>('channel.list');
  expect(channels.map((c) => c.config.name)).toEqual(['fk']);
});
