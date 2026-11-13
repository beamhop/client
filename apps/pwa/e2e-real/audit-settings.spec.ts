/**
 * Audit (usage / security / log tabs), Settings → Devices and secrets against the real daemon.
 * Real events come from a real turn (harness usage, $0.02) and the seed (channel added, agent created).
 */
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { axe, expect, test } from './fixtures.ts';

const main = (page: import('@playwright/test').Page) => page.locator('#bh-main-content').last();

test('usage tab shows the spend of a real turn', async ({ page, bh }) => {
  await bh.inject({ text: 'hello' });
  await expect.poll(async () => (await bh.sentTo('alice')).join('\n')).toContain('reply: hello');
  const { rows } = await bh.rpc<{ rows: { agent: string; usd: number }[] }>('usage.query', { days: 14 });
  expect(rows.reduce((s, r) => s + r.usd, 0)).toBeCloseTo(0.02, 5);
  await bh.open(page, '/audit');
  await expect(page.getByRole('heading', { name: 'Last 14 days · all agents' })).toBeVisible();
  await expect(main(page).getByText('$0.02').first()).toBeVisible();
  await axe(page);
});

test('log tab lists the daemon’s audit events, live', async ({ page, bh }) => {
  const { events } = await bh.rpc<{ events: { summary: string }[] }>('audit.query', { limit: 50 });
  expect(events.some((e) => e.summary.startsWith('Agent bot created'))).toBe(true);
  await bh.open(page, '/audit?tab=log');
  await expect(
    main(page)
      .getByText(/Agent bot created/)
      .first(),
  ).toBeVisible();
  await axe(page);
  // A new event shows up live in the open log.
  await bh.rpc('agent.create', { config: { name: 'later', harness: 'fake' } });
  await expect(
    main(page)
      .getByText(/Agent later created/)
      .first(),
  ).toBeVisible();
});

test('security tab: the daemon’s sandbox blocks and unknown senders land in their categories', async ({
  page,
  bh,
}) => {
  // A live session (so a sandbox exists), then a blocked host from it and a stranger's DM.
  await bh.inject({ text: 'hello' });
  await expect.poll(async () => (await bh.sentTo('alice')).join('\n')).toContain('reply: hello');
  expect(await bh.violate({ kind: 'net.allow', value: 'pypi.org' })).toBeGreaterThan(0);
  await bh.inject({
    text: 'let me in',
    from: { principal: 'fake:eve', displayName: 'Eve' },
    conversation: { kind: 'dm', id: 'eve' },
  });
  await expect
    .poll(async () =>
      (await bh.rpc<{ events: { type: string }[] }>('audit.query', { limit: 50 })).events.map((e) => e.type),
    )
    .toEqual(expect.arrayContaining(['sandbox.violation', 'sender.unknown']));

  await bh.open(page, '/audit?tab=security');
  await page.getByRole('button', { name: /^Blocked hosts/ }).click();
  await expect(
    main(page)
      .getByText(/Sandbox blocked network access to pypi\.org/)
      .first(),
  ).toBeVisible();
  await expect(
    main(page)
      .getByRole('button', { name: /Allow pypi\.org for bot|^Allow/ })
      .first(),
  ).toBeVisible();
  await axe(page);
  await page.getByRole('button', { name: /^Unknown senders/ }).click();
  await expect(
    main(page)
      .getByText(/fake:eve/)
      .first(),
  ).toBeVisible();
  await axe(page);
});

test('settings → devices lists the daemon’s paired devices; remove revokes it', async ({ page, bh }) => {
  const start = await bh.rpc<{ code: string }>('device.pairStart', { name: 'Test phone' });
  const pubkey = getPublicKey(generateSecretKey());
  await bh.rpc('device.pairComplete', { code: start.code, pubkey, name: 'Test phone' });
  const { devices } = await bh.rpc<{ devices: { id: string; name: string }[] }>('device.list');
  expect(devices.map((d) => d.name)).toEqual(['Test phone']);
  await bh.open(page, '/settings/devices');
  await expect(main(page).getByText('Test phone').first()).toBeVisible();
  await axe(page);
  await page.getByRole('button', { name: 'Actions for Test phone' }).click();
  await page.getByRole('menuitem', { name: 'Remove…' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Remove Test phone?' });
  await dialog.getByRole('button', { name: 'Remove Test phone' }).click();
  await expect(
    page.getByRole('region', { name: 'Notifications' }).getByText('Removed · Test phone'),
  ).toBeVisible();
  await expect.poll(async () => (await bh.rpc<{ devices: unknown[] }>('device.list')).devices.length).toBe(0);
});

test('settings → secrets: set a secret; only the name ever comes back', async ({ page, bh }) => {
  const value = ['val', Math.random().toString(36).slice(2, 12), 'x'.repeat(12)].join('-');
  const frames: string[] = [];
  page.on('websocket', (ws) => ws.on('framereceived', (f) => frames.push(String(f.payload))));
  await bh.open(page, '/settings/secrets');
  await axe(page);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Add a secret' });
  await sheet.getByLabel('Name').fill('SENTRY_DSN');
  await sheet.getByLabel('Value', { exact: true }).fill(value);
  await sheet.getByRole('button', { name: 'Save to keychain' }).click();
  await expect(sheet).toBeHidden();
  await expect(main(page).getByText('SENTRY_DSN', { exact: true })).toBeVisible();
  const list = await bh.rpc<{ secrets: { name: string }[] }>('secret.list');
  expect(list.secrets.map((s) => s.name)).toContain('SENTRY_DSN');
  expect(JSON.stringify(list)).not.toContain(value);
  expect(JSON.stringify(await bh.rpc('audit.query', { limit: 200 }))).not.toContain(value);
  expect(await page.content()).not.toContain(value);
  expect(frames.join('\n')).not.toContain(value);
  await axe(page);
});

test('replace a channel token: saved under the daemon’s name, value never echoed back', async ({
  page,
  bh,
}) => {
  const value = `good-${Math.random().toString(36).slice(2, 12)}`;
  const before = await bh.rpc<{ secrets: { name: string; updatedAt?: string }[] }>('secret.list');
  expect(before.secrets.map((s) => s.name)).toContain('channel.fk.token');
  const rpcBodies: string[] = [];
  page.on('websocket', (ws) => ws.on('framereceived', (f) => rpcBodies.push(String(f.payload))));
  await bh.open(page, '/channels/fk');
  await page.getByRole('button', { name: 'Replace token' }).first().click();
  const sheet = page.getByRole('dialog', { name: 'Replace token' });
  await expect(sheet).toBeVisible();
  await axe(page);
  await sheet.getByLabel('token', { exact: true }).fill(value);
  await sheet.getByRole('button', { name: 'Check & save' }).click();
  await expect(
    page.getByRole('region', { name: 'Notifications' }).getByText(/New token saved/),
  ).toBeVisible();

  const after = await bh.rpc<{ secrets: { name: string; updatedAt?: string }[] }>('secret.list');
  expect(after.secrets.map((s) => s.name).sort()).toEqual(before.secrets.map((s) => s.name).sort());
  expect(JSON.stringify(after)).not.toContain(value);
  const { channels } = await bh.rpc<{ channels: { config: { secretRefs: string[] }; status: string }[] }>(
    'channel.list',
  );
  expect(channels[0]?.config.secretRefs).toEqual(['channel.fk.token']);
  await expect
    .poll(async () => (await bh.rpc<{ channels: { status: string }[] }>('channel.list')).channels[0]?.status)
    .toBe('connected');
  const audit = await bh.rpc('audit.query', { limit: 200 });
  expect(JSON.stringify(audit)).not.toContain(value);
  expect(await page.content()).not.toContain(value);
  expect(rpcBodies.join('\n')).not.toContain(value);
  // The reconnected channel still delivers.
  await bh.inject({ text: 'still there?' });
  await expect.poll(async () => (await bh.sentTo('alice')).join('\n')).toContain('reply: still there?');
});
