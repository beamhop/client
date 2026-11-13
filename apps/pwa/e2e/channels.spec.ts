/**
 * Channels journeys (JOURNEYS §4): list → detail → replace token / pair / remove; the Telegram wizard end to
 * end (live validation → connect → deep-link pairing → confirm → join → finish); resume after leaving;
 * Slack wrong-field detection; axe on every wizard step. Screenshots for review with BH_SHOTS=1.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { settle } from './helpers.ts';

// Built at runtime so no token-shaped literal is committed.
const tgToken = () => `${'7'.repeat(9)}:${'Ab3_'.repeat(9)}`;
const slackToken = (kind: 'xapp' | 'xoxb') =>
  kind === 'xapp'
    ? ['xapp', '1', 'A0TEST', '1234', 'f'.repeat(24)].join('-')
    : ['xoxb', '1234', '5678', 'x'.repeat(24)].join('-');

const open = async (page: Page, path: string) => {
  const sep = path.includes('?') ? '&' : '?';
  await page.goto(`${path}${sep}mock=1&still=1`);
  await expect(page.locator('#bh-main-content').first()).toBeVisible();
};

const axe = async (page: Page) => {
  await settle(page);
  const r = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    bad.map(
      (v) => `${v.id}: ${v.nodes.map((n) => `${n.target.join(' ')} ${n.html.slice(0, 160)}`).join(', ')}`,
    ),
  ).toEqual([]);
};

const shot = async (page: Page, name: string, project: string) => {
  if (!process.env.BH_SHOTS) return;
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `screenshots/${project}/${name}.png` });
};

test('list groups channels, shows relay bars and the error row with Replace token', async ({
  page,
}, info) => {
  await open(page, '/channels');
  await expect(page.getByRole('heading', { name: /Needs you/ })).toBeVisible();
  const err = page.getByRole('link', { name: /beamhop-ops/ }).first();
  await expect(err).toContainText('Token rejected (401)');
  await expect(page.getByRole('link', { name: /Nostr.*3\/4 relays/ })).toBeVisible();
  await axe(page);
  await page.getByRole('link', { name: /Replace token for beamhop-ops/ }).click();
  await expect(page.getByRole('dialog', { name: 'Replace token' })).toBeVisible();
  await page
    .getByLabel('Bot token', { exact: true })
    .fill(['MTMwMTkyODM3NDY1NTEyMzQ1Ng', 'GxAbCd', 'z'.repeat(27)].join('.'));
  await page.getByRole('button', { name: 'Check & save' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByText(/New token saved/).first()).toBeVisible();
  if (info.project.name === 'desktop')
    await expect(page.getByRole('link', { name: /beamhop-ops.*ready/ })).toBeVisible({ timeout: 5000 });
});

test('channel detail: identity, owners, memberships with undo, remove', async ({ page }, info) => {
  await open(page, '/channels/tg');
  await expect(page.getByRole('heading', { name: '@reviewer_alice_bot', level: 1 })).toBeAttached();
  await expect(page.getByRole('heading', { name: /Owner pairings · 1/ })).toBeVisible();
  await expect(page.getByText('telegram:7712345')).toBeVisible();
  await axe(page);
  await shot(page, 'channels_tg', info.project.name);
  await page.getByRole('button', { name: /Leave: reviewer on tg:group\/-100123/ }).click();
  await expect(page.getByText(/reviewer left/).first()).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('button', { name: /Leave: reviewer on tg:group\/-100123/ })).toBeVisible();
  await page.getByRole('button', { name: 'Remove channel' }).click();
  const dlg = page.getByRole('alertdialog', { name: 'Remove @reviewer_alice_bot?' });
  await expect(dlg).toContainText('stop listening here');
  await dlg.getByRole('button', { name: 'Remove tg' }).click();
  await expect(page).toHaveURL(/\/channels(\?|$)/);
  await expect(page.getByRole('link', { name: /@reviewer_alice_bot/ })).toHaveCount(0);
});

test('channel detail: disconnect and reconnect with the Connected switch', async ({ page }) => {
  await open(page, '/channels/tg');
  const sw = page.getByRole('switch', { name: 'Connected' });
  await expect(sw).toBeChecked();
  await sw.click({ force: true });
  await expect(sw).not.toBeChecked();
  await expect(
    page.getByRole('region', { name: 'Notifications' }).getByText('Disconnected · @reviewer_alice_bot'),
  ).toBeVisible();
  await expect(page.getByText(/Nobody can reach agents here/)).toBeVisible();
  await sw.click({ force: true });
  await expect(sw).toBeChecked();
  await expect(
    page.getByRole('region', { name: 'Notifications' }).getByText('Connected · @reviewer_alice_bot'),
  ).toBeVisible();
});

test('nostr detail lists relays with latency and NIP-11', async ({ page }) => {
  await open(page, '/channels/nostr');
  await expect(page.getByRole('heading', { name: /Relays · 4/ })).toBeVisible();
  await expect(page.getByText('84 ms')).toBeVisible();
  await expect(page.getByText('NIP-11 timeout')).toBeVisible();
  await axe(page);
});

test('telegram wizard end to end: validate → connect → pair by deep link → join → finish', async ({
  page,
}, info) => {
  test.setTimeout(60_000);
  await open(page, '/channels/add');
  await page.getByRole('link', { name: /^Telegram/ }).click();
  await expect(page).toHaveURL(/\/channels\/add\/telegram\/1/);
  await expect(page.getByRole('heading', { name: 'Create a bot with @BotFather' })).toBeFocused();
  const bf = page.getByRole('link', { name: /Open BotFather/ });
  await expect(bf).toHaveAttribute('href', 'https://t.me/BotFather');
  await expect(bf).toHaveAttribute('target', '_blank');
  await axe(page);
  await shot(page, 'channels_add_telegram_1', info.project.name);
  await page.getByRole('button', { name: 'Continue · Credentials' }).click();

  await expect(page.getByRole('heading', { name: 'Paste the Telegram bot token' })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Check token' })).toBeDisabled();
  await page.getByLabel('Bot token', { exact: true }).fill('nope');
  await expect(page.getByText(/doesn't look like a token yet/)).toBeVisible();
  await page.getByLabel('Bot token', { exact: true }).fill(tgToken());
  await expect(page.getByText('format ✓ · Looks like a bot token')).toBeVisible();
  // live validation shows the bot's identity without pressing anything
  await expect(page.getByText('reviewer (beamhop)')).toBeVisible();
  await expect(page.getByLabel('Channel name')).toHaveValue('reviewer-alice');
  await axe(page);
  await shot(page, 'channels_add_telegram_2', info.project.name);
  await page.getByRole('button', { name: 'Connect @reviewer_alice_bot' }).click();

  // nodes 03/04 fill on their own, then the wizard moves to Pair
  await expect(page).toHaveURL(/\/channels\/add\/telegram\/5/, { timeout: 5000 });
  const deep = page.getByRole('link', { name: /Open @reviewer_alice_bot in Telegram/ });
  await expect(deep).toHaveAttribute('href', 'https://t.me/reviewer_alice_bot?start=pair-7KQ29XHD');
  await expect(page.getByText(/Code expires in/)).toBeVisible();
  await axe(page);
  await shot(page, 'channels_add_telegram_5', info.project.name);
  // the mock pairs ~5 s after the code is issued
  await expect(page.getByText('Paired with @alice').first()).toBeVisible({ timeout: 8000 });
  await shot(page, 'channels_add_telegram_5_paired', info.project.name);
  await page.getByRole('button', { name: 'This is me · Join' }).click();

  await expect(page).toHaveURL(/\/channels\/add\/telegram\/6/);
  await expect(page.getByRole('heading', { name: 'Choose who answers here' })).toBeFocused();
  await axe(page);
  await shot(page, 'channels_add_telegram_6', info.project.name);
  await page.getByRole('button', { name: 'Finish · Add Telegram' }).click();
  await expect(page).toHaveURL(/\/channels\/reviewer-alice/);
  await expect(page.getByText(/Telegram is connected/).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: /Agents here · 1/ })).toBeVisible();
});

test('leaving mid-setup is resumable from the picker', async ({ page }) => {
  await open(page, '/channels/add/telegram/1');
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    page.getByRole('link', { name: /Open BotFather/ }).click(),
  ]);
  await popup.close();
  // after opening BotFather, Continue becomes the primary action
  await page.getByRole('button', { name: 'Continue · Credentials' }).click();
  await open(page, '/channels/add');
  const resume = page.locator('#bh-main-content').getByRole('link', { name: /Resume Telegram/ });
  await expect(resume).toContainText('02 Credentials');
  await resume.click();
  await expect(page).toHaveURL(/\/channels\/add\/telegram\/2/);
  await open(page, '/channels/add');
  await page
    .locator('#bh-main-content')
    .getByRole('button', { name: 'Discard the unfinished Telegram setup' })
    .click();
  await expect(page.locator('#bh-main-content').getByRole('link', { name: /Resume Telegram/ })).toHaveCount(
    0,
  );
});

test('slack: a token pasted into the wrong field can be moved', async ({ page }) => {
  await open(page, '/channels/add/slack/2');
  await page.getByLabel('App-level token', { exact: true }).fill(slackToken('xoxb'));
  await expect(page.getByText('This looks like the Bot token.')).toBeVisible();
  await page.getByRole('button', { name: 'Move it' }).click();
  await expect(page.getByLabel('Bot token', { exact: true })).toHaveValue(slackToken('xoxb'));
  await page.getByLabel('App-level token', { exact: true }).fill(slackToken('xapp'));
  await expect(page.getByText('beamhop', { exact: true }).first()).toBeVisible();
  await axe(page);
});

test('discord create step: checklist + portal link; nostr relay step checks NIP-11', async ({ page }) => {
  await open(page, '/channels/add/discord/1');
  await expect(page.getByRole('link', { name: /Open Developer Portal/ })).toHaveAttribute(
    'href',
    'https://discord.com/developers/applications',
  );
  await page.getByText('Turn on Message Content Intent').click();
  await expect(page.getByRole('checkbox', { name: /Message Content Intent/ })).toBeChecked();
  await axe(page);
  await open(page, '/channels/add/nostr/1');
  await page.getByLabel('Relay address').fill('ws://insecure.example');
  await expect(page.getByText(/Use wss:\/\//)).toBeVisible();
  await page.getByRole('button', { name: 'groups.fiatjaf.com' }).click();
  await expect(page.getByText(/supports NIP-29 groups/)).toBeVisible();
  await axe(page);
});

test('dark screenshots of channels + harnesses for review', async ({ page }, info) => {
  test.skip(!process.env.BH_SHOTS, 'screenshots only with BH_SHOTS=1');
  await page.emulateMedia({ colorScheme: 'dark' });
  for (const [path, name] of [
    ['/channels', 'channels-dark'],
    ['/channels/tg', 'channels_tg-dark'],
    ['/channels/nostr', 'channels_nostr-dark'],
    ['/channels/add', 'channels_add-dark'],
    ['/channels/add/slack/1', 'channels_add_slack_1-dark'],
    ['/harnesses', 'harnesses-dark'],
  ] as const) {
    await open(page, path);
    await shot(page, name, info.project.name);
  }
  await open(page, '/channels/add/telegram/2');
  await page.getByLabel('Bot token', { exact: true }).fill(tgToken());
  await expect(page.getByText('reviewer (beamhop)')).toBeVisible();
  await shot(page, 'channels_add_telegram_2-dark', info.project.name);
});
