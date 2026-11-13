/**
 * Coverage for Connections (/channels + the add wizard), AI accounts (/harnesses) and Cloud (/deploy)
 * paths the per-screen specs don't reach: owner pairing from the channel page (confirm, unpair, expired
 * code), empty/error states, full Slack / Discord / Nostr wizard runs, Back / Pair later / default role,
 * harness scan, job cancel + retry + output copy, deploy stop / plan copy / fresh-agent apply / apply failure.
 * Outcomes are checked in the mock daemon's state (rpc), the toast region, the live region and the URL.
 */
import { expect, type Page, test } from '@playwright/test';
import { open, rpc } from './helpers.ts';

// Built at runtime so no token-shaped literal is committed.
const tgToken = () => `${'7'.repeat(9)}:${'Ab3_'.repeat(9)}`;
const slackToken = (kind: 'xapp' | 'xoxb') =>
  kind === 'xapp'
    ? ['xapp', '1', 'A0TEST', '1234', 'f'.repeat(24)].join('-')
    : ['xoxb', '1234', '5678', 'x'.repeat(24)].join('-');
// First segment is base64("1301928374655123456"), so the wizard can derive the application id.
const discordToken = () => ['MTMwMTkyODM3NDY1NTEyMzQ1Ng', 'GxAbCd', 'z'.repeat(27)].join('.');

/** Everything written to the polite live region from now on (later messages replace earlier ones). */
const recordAnnouncements = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __said: string[] };
    w.__said = [];
    const el = document.getElementById('bh-live-polite')!;
    new MutationObserver(() => {
      if (el.textContent) w.__said.push(el.textContent);
    }).observe(el, { childList: true, characterData: true, subtree: true });
  });
const announced = (page: Page) => page.evaluate(() => (window as unknown as { __said: string[] }).__said);

const toasts = (page: Page) => page.getByRole('region', { name: 'Notifications' });
const main = (page: Page) => page.locator('#bh-main-content');

/** Record clipboard writes (headless clipboard permissions differ between projects). */
const captureClipboard = (page: Page) =>
  page.addInitScript(() => {
    const w = window as unknown as { __copied: string[] };
    w.__copied = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (v: string) => {
          w.__copied.push(v);
        },
        readText: async () => '',
      },
    });
  });
const copied = (page: Page) => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied);

type MockWindow = {
  __beamhop: {
    mock: { daemon: { state: Record<string, unknown>; pairTimers: Map<string, unknown> } };
    runtime: { queryClient: { invalidateQueries: (f: unknown) => Promise<void> } };
    router: { navigate: (o: unknown) => Promise<void> };
  };
};

/** Navigate inside the SPA (a page.goto would reload and reset the in-memory mock daemon). */
const go = (page: Page, to: string) =>
  page.evaluate((path) => (window as unknown as MockWindow).__beamhop.router.navigate({ to: path }), to);

/** Refetch everything after changing the mock's state directly (test setup only). */
const refetch = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as MockWindow).__beamhop.runtime.queryClient.invalidateQueries({ queryKey: ['bh'] }),
  );

type Membership = { target: string; defaultRole: string; triggers: string[] };
type Agents = { agents: Array<{ config: { name: string; memberships: Membership[] } }> };
const membershipsOn = async (page: Page, channel: string) =>
  (await rpc<Agents>(page, 'agent.list')).agents.flatMap((a) =>
    a.config.memberships
      .filter((m) => m.target.startsWith(`${channel}:`))
      .map((m) => ({ agent: a.config.name, ...m })),
  );
type Channels = {
  channels: Array<{
    config: { name: string; provider: string; settings: Record<string, unknown> };
    status: string;
    self?: { principal: string };
  }>;
};
const channelNamed = async (page: Page, name: string) =>
  (await rpc<Channels>(page, 'channel.list')).channels.find((c) => c.config.name === name);

// ─────────────────────────── Connections: channel page ───────────────────────────

test.describe('channel page', () => {
  test('"Add agent" opens Agents, where memberships are made', async ({ page }) => {
    await open(page, '/channels/tg');
    await main(page).getByRole('link', { name: 'Add agent' }).last().click();
    await expect(page).toHaveURL(/\/agents(\?|$)/);
  });

  test('Pair → "Pair a Telegram account": code, deep link, then confirm the account', async ({ page }) => {
    await open(page, '/channels/tg');
    // The seed lists @alice's pairing on the channel, but she isn't an owner on the daemon yet.
    await expect(page.getByRole('heading', { name: /Owner pairings · 1/ })).toBeVisible();
    const before = await rpc<{ owners: { principal: string }[] }>(page, 'owner.list');
    expect(before.owners.map((o) => o.principal)).not.toContain('telegram:5551');
    await page.getByRole('button', { name: 'Pair', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Pair a Telegram account' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('link', { name: /Open @reviewer_alice_bot in Telegram/ })).toHaveAttribute(
      'href',
      'https://t.me/reviewer_alice_bot?start=pair-7KQ29XHD',
    );
    await expect(sheet.getByText(/Code expires in/)).toBeVisible();
    // The mock "receives /start" ~5 s after the code was issued.
    await expect(sheet.getByText('Paired with @alice')).toBeVisible({ timeout: 9000 });
    await sheet.getByRole('button', { name: 'This is me' }).click();
    await expect(sheet).toBeHidden();
    await expect(toasts(page).getByText('@alice is now an owner')).toBeVisible();
    await expect(page.getByRole('heading', { name: /Owner pairings · 1/ })).toBeVisible();
    await expect(page.getByText('telegram:5551').first()).toBeVisible();
    const owners = await rpc<{ owners: { principal: string }[] }>(page, 'owner.list');
    expect(owners.owners.map((o) => o.principal)).toContain('telegram:5551');
  });

  test('"Not me — unpair" removes the owner and issues a fresh code', async ({ page }) => {
    await open(page, '/channels/tg');
    await page.getByRole('button', { name: 'Pair', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Pair a Telegram account' });
    await expect(sheet.getByText('Paired with @alice')).toBeVisible({ timeout: 9000 });
    // Paired means owner (and an owner grant) on the daemon until it's rejected.
    expect((await rpc<{ grants: Record<string, string> }>(page, 'role.list')).grants['telegram:5551']).toBe(
      'owner',
    );
    await sheet.getByRole('button', { name: 'Not me — unpair' }).click();
    await expect(sheet.getByText('Waiting for /start from Telegram…')).toBeVisible();
    await expect(sheet.getByText(/Code expires in/)).toBeVisible();
    await expect(sheet.getByText('Paired with @alice')).toHaveCount(0);
    const owners = await rpc<{ owners: { principal: string }[] }>(page, 'owner.list');
    expect(owners.owners.map((o) => o.principal)).not.toContain('telegram:5551');
    const roles = await rpc<{ grants: Record<string, string> }>(page, 'role.list');
    expect(roles.grants['telegram:5551']).toBeUndefined();
  });

  test('an expired pairing code offers "Get a new code"', async ({ page }) => {
    await page.clock.install();
    await open(page, '/channels/tg');
    await page.getByRole('button', { name: 'Pair', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Pair a Telegram account' });
    await expect(sheet.getByText(/Code expires in 10:00|Code expires in 9:5\d/)).toBeVisible();
    // Nobody answers this code: stop the mock's simulated /start before time jumps.
    await page.evaluate(() => {
      const d = (window as unknown as MockWindow).__beamhop.mock.daemon;
      for (const t of d.pairTimers.values()) clearTimeout(t as number);
      d.pairTimers.clear();
    });
    await page.clock.fastForward('10:30');
    await expect(sheet.getByText('This code expired. Codes last 10 minutes and work once.')).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Copy' })).toHaveCount(0);
    await sheet.getByRole('button', { name: 'Get a new code' }).click();
    await expect(sheet.getByText(/Code expires in/)).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Get a new code' })).toHaveCount(0);
  });

  test('"Copy principal" copies the bot principal', async ({ page }) => {
    await captureClipboard(page);
    await open(page, '/channels/tg');
    const principal = (await channelNamed(page, 'tg'))?.self?.principal;
    expect(principal).toBeTruthy();
    await page.getByRole('button', { name: 'Copy principal' }).click();
    expect(await copied(page)).toEqual([principal]);
  });

  test('an unknown channel says so and links back to the list', async ({ page }) => {
    await open(page, '/channels/nope');
    await expect(page.getByText('No channel named nope')).toBeVisible();
    await main(page).getByRole('link', { name: 'All channels' }).last().click();
    await expect(page).toHaveURL(/\/channels(\?|$)/);
  });
});

test.describe('channel list', () => {
  test('empty: "No channels yet." with Add channel', async ({ page }) => {
    await open(page, '/channels');
    for (const c of (await rpc<Channels>(page, 'channel.list')).channels)
      await rpc(page, 'channel.remove', { name: c.config.name });
    await refetch(page);
    await expect(page.getByText('No channels yet.')).toBeVisible();
    await page.getByRole('link', { name: 'Add channel' }).first().click();
    await expect(page).toHaveURL(/\/channels\/add/);
  });

  test('error: "Couldn\'t load channels"', async ({ page }) => {
    await open(page, '/channels?mockFail=channel.list');
    await expect(page.getByText("Couldn't load channels").first()).toBeVisible();
    await expect(page.getByRole('link', { name: /@reviewer_alice_bot/ })).toHaveCount(0);
  });
});

// ─────────────────────────── Connections: wizard ───────────────────────────

test.describe('channel wizard', () => {
  test('Slack end to end: tokens → connect → Open Slack pairing → join; resumable mid-way', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await open(page, '/channels/add/slack/1');
    await page.getByRole('button', { name: 'Continue · Credentials' }).click();
    await expect(page).toHaveURL(/\/channels\/add\/slack\/2/);
    await page.getByLabel('App-level token', { exact: true }).fill(slackToken('xapp'));
    await page.getByLabel('Bot token', { exact: true }).fill(slackToken('xoxb'));
    const connect = page.getByRole('button', { name: 'Connect @beamhop' });
    await expect(connect).toBeVisible();
    const name = await page.getByLabel('Channel name').inputValue();
    await connect.click();

    await expect(page).toHaveURL(/\/channels\/add\/slack\/5/, { timeout: 6000 });
    expect((await channelNamed(page, name))?.config.provider).toBe('slack');
    await expect(page.getByRole('heading', { name: 'Link your Slack account as owner' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Open Slack/ })).toHaveAttribute(
      'href',
      'https://app.slack.com/client',
    );
    await expect(page.getByText(/In Slack, send this to @beamhop in a DM/)).toBeVisible();

    // Leave and come back through the list's "Unfinished setups": the page says where it picked up.
    await go(page, '/channels');
    const resume = page.getByRole('link', { name: /Resume Slack/ }).first();
    await expect(resume).toBeVisible();
    await resume.click();
    await expect(page).toHaveURL(/\/channels\/add\/slack\/5/);
    await expect(page.getByText(`Picked up where you left off with ${name}.`)).toBeVisible();

    await expect(page.getByText('Paired with alice · acme.slack.com').first()).toBeVisible({
      timeout: 9000,
    });
    await page.getByRole('button', { name: 'This is me · Join' }).click();
    await expect(page).toHaveURL(/\/channels\/add\/slack\/6/);
    await expect(page.getByText(`/invite @beamhop`)).toBeVisible();
    await page.getByRole('button', { name: 'Finish · Add Slack' }).click();

    await expect(page).toHaveURL(new RegExp(`/channels/${name}(\\?|$)`));
    await expect(toasts(page).getByText(/Slack is connected/)).toBeVisible();
    const ms = await membershipsOn(page, name);
    expect(ms.map((m) => m.target)).toEqual([`${name}:dm`]);
    const pairings = (await channelNamed(page, name))?.config.settings.pairings as { principal: string }[];
    expect(pairings.map((p) => p.principal)).toContain('slack:T01ACME/U01ALICE');
    // Finishing clears the draft.
    expect(await page.evaluate(() => localStorage.getItem('bh.channelDraft.slack'))).toBeNull();
  });

  test('Discord end to end: checklist → token → connect → join with invite → pair last', async ({ page }) => {
    test.setTimeout(60_000);
    await open(page, '/channels/add/discord/1');
    await page.getByText('Turn on Message Content Intent').click();
    await expect(page.getByRole('checkbox', { name: /Message Content Intent/ })).toBeChecked();
    await page.getByRole('button', { name: 'Continue · Credentials' }).click();

    await page.getByLabel('Bot token', { exact: true }).fill(discordToken());
    const connect = page.getByRole('button', { name: 'Connect beamhop-helper#0' });
    await expect(connect).toBeVisible();
    const name = await page.getByLabel('Channel name').inputValue();
    await connect.click();

    // Discord joins before pairing.
    await expect(page).toHaveURL(/\/channels\/add\/discord\/5/, { timeout: 6000 });
    await expect(page.getByRole('heading', { name: 'Choose who answers here' })).toBeVisible();
    const invite = page.getByRole('link', { name: /Add to a Discord server/ });
    await expect(invite).toHaveAttribute('href', /client_id=1301928374655123456/);
    await page.getByRole('button', { name: 'Continue · Pair' }).click();

    await expect(page).toHaveURL(/\/channels\/add\/discord\/6/);
    await expect(page.getByText(/Send this in any channel beamhop-helper#0 can see/)).toBeVisible();
    await expect(page.getByText('Paired with @alice').first()).toBeVisible({ timeout: 9000 });
    await page.getByRole('button', { name: 'This is me · Finish' }).click();

    await expect(page).toHaveURL(new RegExp(`/channels/${name}(\\?|$)`));
    await expect(toasts(page).getByText(/Discord is connected/)).toBeVisible();
    expect((await membershipsOn(page, name)).map((m) => m.target)).toEqual([`${name}:dm`]);
    const c = await channelNamed(page, name);
    expect(c?.config.settings.intentChecked).toBe(true);
    expect(
      ((c?.config.settings.pairings ?? []) as { principal: string }[]).map((p) => p.principal),
    ).toContain('discord:220719');
  });

  test('Nostr group: relay → group id → connect → join the group', async ({ page }) => {
    test.setTimeout(45_000);
    await open(page, '/channels/add/nostr/1');
    await page.getByRole('button', { name: 'groups.fiatjaf.com' }).click();
    await expect(page.getByText(/supports NIP-29 groups/)).toBeVisible();
    await page.getByRole('button', { name: 'Continue · Group' }).click();

    await expect(page).toHaveURL(/\/channels\/add\/nostr\/2/);
    await expect(page.getByRole('heading', { name: 'Which group?' })).toBeVisible();
    const connect = page.getByRole('button', { name: 'Connect group' });
    await page.getByLabel('Group id').fill('Bad Group');
    await expect(page.getByText('Group ids use lowercase letters, digits, - and _.')).toBeVisible();
    await expect(connect).toBeDisabled();
    // A whole NIP-29 address (host'group) is accepted.
    await page.getByLabel('Group id').fill("groups.fiatjaf.com'devs");
    await page.getByLabel('Display name (optional)').fill('Dev room');
    await expect(page.getByText("groups.fiatjaf.com'devs").first()).toBeVisible();
    await expect(connect).toBeEnabled();
    await connect.click();

    await expect(page).toHaveURL(/\/channels\/add\/nostr\/3/, { timeout: 6000 });
    await page.getByRole('button', { name: /^Finish · Add Nostr group/ }).click();
    await expect(page).toHaveURL(/\/channels\/nostr-devs(\?|$)/);
    const c = await channelNamed(page, 'nostr-devs');
    expect(c?.config.settings).toMatchObject({ relay: 'wss://groups.fiatjaf.com', group: 'devs' });
    expect((await membershipsOn(page, 'nostr-devs')).map((m) => m.target)).toEqual([
      "nostr-devs:group/groups.fiatjaf.com'devs",
    ]);
  });

  test('Back goes to the previous step (and skips the automatic ones)', async ({ page }) => {
    await open(page, '/channels/add/nostr/1');
    await page.getByRole('button', { name: 'groups.fiatjaf.com' }).click();
    await page.getByRole('button', { name: 'Continue · Group' }).click();
    await expect(page).toHaveURL(/\/channels\/add\/nostr\/2/);
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page).toHaveURL(/\/channels\/add\/nostr\/1/);
    await expect(page.getByLabel('Relay address')).toHaveValue('wss://groups.fiatjaf.com');

    await open(page, '/channels/add/telegram/2');
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page).toHaveURL(/\/channels\/add\/telegram\/1/);
    await expect(page.getByRole('heading', { name: 'Create a bot with @BotFather' })).toBeVisible();
  });

  test('Pair later skips pairing; the default role chosen on Join is saved', async ({ page }) => {
    test.setTimeout(45_000);
    await open(page, '/channels/add/telegram/2');
    await page.getByLabel('Bot token', { exact: true }).fill(tgToken());
    await page.getByRole('button', { name: 'Connect @reviewer_alice_bot' }).click();
    await expect(page).toHaveURL(/\/channels\/add\/telegram\/5/, { timeout: 6000 });
    await page.getByRole('button', { name: 'Pair later' }).click();

    await expect(page).toHaveURL(/\/channels\/add\/telegram\/6/);
    const roles = page.getByRole('radiogroup', {
      name: "Default role for people the agent doesn't know yet",
    });
    // The choices come from role.list (owner is never offered).
    await expect(roles.getByRole('radio', { name: /viewer · default/ })).toBeChecked();
    await expect(roles.getByRole('radio', { name: /^admin/ })).toBeVisible();
    await expect(roles.getByRole('radio', { name: /^owner/ })).toHaveCount(0);
    await roles.getByText('user', { exact: true }).click();
    await expect(roles.getByRole('radio', { name: /^user/ })).toBeChecked();
    await page.getByRole('button', { name: 'Finish · Add Telegram' }).click();

    await expect(page).toHaveURL(/\/channels\/reviewer-alice(\?|$)/);
    const ms = await membershipsOn(page, 'reviewer-alice');
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ target: 'reviewer-alice:dm', defaultRole: 'user' });
    expect(ms[0]!.triggers).toEqual(['dm', 'mention', 'reply']);
    // Nobody paired.
    const c = await channelNamed(page, 'reviewer-alice');
    expect(c?.config.settings.pairings).toBeUndefined();
    await expect(page.getByText(/No Telegram account is paired as owner yet/)).toBeVisible();
  });
});

// ─────────────────────────── AI accounts ───────────────────────────

test.describe('harnesses', () => {
  test('Scan re-checks every harness and says how many are ready', async ({ page }) => {
    await open(page, '/harnesses');
    await recordAnnouncements(page);
    const scan = page.getByRole('button', { name: 'Scan', exact: true }).first();
    await scan.click();
    // The slug shows when the last scan finished.
    await expect(page.getByText(/scanned \d/).first()).toBeVisible({ timeout: 5000 });
    await expect(scan).toBeEnabled();
    await expect.poll(() => announced(page)).toContain('Scan done · 3 of 7 ready');
  });

  test('Cancel an install, copy its output, then Try again', async ({ page }) => {
    test.setTimeout(45_000);
    await captureClipboard(page);
    await open(page, '/harnesses');
    await page.getByRole('button', { name: 'Install Copilot CLI' }).first().click();
    const job = page.locator('[data-harness-job="copilot"]').first();
    await job.getByRole('button', { name: 'Cancel for Copilot CLI' }).click();
    await expect(job.getByText('Cancelled. Nothing was changed.')).toBeVisible();
    const jobs = await rpc<{ jobs: { harness: string; step: string }[] }>(page, 'harness.job.list');
    expect(jobs.jobs.find((j) => j.harness === 'copilot')?.step).toBe('cancelled');
    const list = await rpc<{ harnesses: { id: string; status: string }[] }>(page, 'harness.list');
    expect(list.harnesses.find((h) => h.id === 'copilot')?.status).toBe('not-installed');

    await job.getByRole('button', { name: 'Show details' }).click();
    await job.getByRole('button', { name: 'Copy the output' }).click();
    const shown = await job.getByLabel('Output', { exact: true }).textContent();
    const [out] = await copied(page);
    expect(out).toContain('$ npm i -g --prefix ~/.beamhop/harnesses/npm @github/copilot');
    expect(out).toBe(shown);

    await job.getByRole('button', { name: 'Try again: Copilot CLI' }).click();
    await expect(job.getByText('Ready', { exact: true })).toBeVisible({ timeout: 8000 });
    const after = await rpc<{ harnesses: { id: string; status: string }[] }>(page, 'harness.list');
    expect(after.harnesses.find((h) => h.id === 'copilot')?.status).not.toBe('not-installed');
  });

  test('an install the daemon refuses shows the error and Try again', async ({ page }) => {
    await open(page, '/harnesses?mockFail=harness.install');
    await page.getByRole('button', { name: 'Install Copilot CLI' }).first().click();
    const job = page.locator('[data-harness-job="copilot"]').first();
    await expect(job.getByText(/Couldn't reach the daemon for harness\.install/)).toBeVisible();
    const retry = job.getByRole('button', { name: 'Try again: Copilot CLI' });
    await expect(retry).toBeEnabled();
    await retry.click();
    await expect(job.getByText(/Couldn't reach the daemon for harness\.install/)).toBeVisible();
    const jobs = await rpc<{ jobs: unknown[] }>(page, 'harness.job.list');
    expect(jobs.jobs).toHaveLength(0);
  });

  test('"Check again: {name}" re-scans a harness that is logged in outside beamhop', async ({ page }) => {
    await open(page, '/harnesses');
    await page.evaluate(() => {
      const s = (window as unknown as MockWindow).__beamhop.mock.daemon.state as {
        harnesses: Array<Record<string, unknown>>;
      };
      const g = s.harnesses.find((h) => h.id === 'gemini')!;
      g.status = 'needs-login';
      delete g.login;
      delete g.loginFlow;
    });
    await refetch(page);
    const check = page.getByRole('button', { name: 'Check again: Gemini CLI' });
    await expect(check).toBeVisible();
    await recordAnnouncements(page);
    await check.click();
    await expect(page.getByText(/Still not logged in at/)).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(/scanned \d/).first()).toBeVisible();
    const list = await rpc<{ harnesses: { id: string; status: string }[] }>(page, 'harness.list');
    expect(list.harnesses.find((h) => h.id === 'gemini')?.status).toBe('needs-login');
    await expect.poll(() => announced(page)).toContain('Scan done · 2 of 7 ready');
  });

  test('"Change login…" switches Claude Code to a subscription token', async ({ page }) => {
    await open(page, '/harnesses');
    await page.getByRole('button', { name: /^Claude Code/ }).click();
    const login = page.getByRole('region', { name: 'Login for agents' }).last();
    await login.getByRole('button', { name: 'Change login…' }).click();
    const sheet = page.getByRole('dialog', { name: 'Log Claude Code in' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('radio', { name: /Anthropic API key/ })).toBeChecked();
    await sheet.getByRole('radio', { name: /Claude subscription/ }).dispatchEvent('click');
    await sheet
      .getByLabel('Claude subscription (Pro / Max)', { exact: true })
      .last()
      .fill('sk-ant-oat-token');
    await sheet.getByRole('button', { name: 'Save and check' }).click();
    await expect(sheet).toBeHidden();
    await expect(toasts(page).getByText('Claude Code is logged in')).toBeVisible();
    const list = await rpc<{ harnesses: { id: string; login?: { method?: string; status: string } }[] }>(
      page,
      'harness.list',
    );
    expect(list.harnesses.find((h) => h.id === 'claude')?.login).toMatchObject({
      method: 'claude-subscription',
      status: 'logged-in',
    });
  });

  test('empty: "No harnesses found." with a Scan button', async ({ page }) => {
    await open(page, '/harnesses');
    await page.evaluate(() => {
      (window as unknown as MockWindow).__beamhop.mock.daemon.state.harnesses = [];
    });
    await refetch(page);
    await expect(page.getByText('No harnesses found.')).toBeVisible();
    await expect(main(page).getByRole('button', { name: 'Scan', exact: true }).last()).toBeVisible();
  });

  test('error: "Couldn\'t load harnesses"', async ({ page }) => {
    await open(page, '/harnesses?mockFail=harness.list');
    await expect(page.getByText("Couldn't load harnesses").first()).toBeVisible();
    await expect(page.getByRole('button', { name: /^Claude Code/ })).toHaveCount(0);
  });
});

// ─────────────────────────── Cloud ───────────────────────────

test.describe('cloud', () => {
  test('deployment detail: Stop the agent, and the full audit log link', async ({ page }) => {
    await open(page, '/deploy/dep_fly_ams1');
    await page.getByRole('button', { name: 'Stop ci-bot' }).click();
    const dlg = page.getByRole('alertdialog', { name: 'Stop ci-bot?' });
    await expect(dlg).toContainText('The server stays up');
    await dlg.getByRole('button', { name: 'Stop ci-bot' }).click();
    await expect(dlg).toBeHidden();
    await expect(toasts(page).getByText(/Stopped · ci-bot/)).toBeVisible();
    expect((await rpc<{ status: string }>(page, 'agent.get', { name: 'ci-bot' })).status).toBe('stopped');
    await expect(page.getByRole('button', { name: 'Stop ci-bot' })).toHaveCount(0);

    await page.getByRole('link', { name: 'Full audit log' }).click();
    await expect(page).toHaveURL(/\/audit\?tab=log/);
  });

  test('"Copy plan as CLI" copies the equivalent command', async ({ page }) => {
    await captureClipboard(page);
    await open(page, '/deploy/new?agent=reviewer');
    await page.getByRole('button', { name: 'Continue · Provider' }).click();
    await page.getByRole('radio', { name: /Hetzner Cloud/ }).check({ force: true });
    await page.getByRole('button', { name: 'Continue · Size' }).click();
    await expect(page.getByRole('radio', { name: /cx22/ })).toBeChecked();
    await page.getByRole('button', { name: 'Continue · Files' }).click();
    await page.getByRole('button', { name: 'Continue · Plan' }).click();
    await page.getByRole('button', { name: 'Copy plan as CLI' }).click();
    expect(await copied(page)).toEqual([
      'beamhop deploy plan reviewer --provider hetzner --size cx22 --region fsn1 --json',
    ]);
  });

  test('new-deploy Back returns to the previous step with choices kept', async ({ page }) => {
    await open(page, '/deploy/new?agent=reviewer');
    await page.getByRole('button', { name: 'Continue · Provider' }).click();
    await expect(page.getByRole('heading', { name: 'Where should it run?' })).toBeVisible();
    await page.getByRole('radio', { name: /Hetzner Cloud/ }).check({ force: true });
    await page.getByRole('button', { name: 'Back to Agent' }).click();
    await expect(page.getByRole('heading', { name: 'Which agent?' })).toBeVisible();
    await expect(page.getByRole('radio', { name: /^reviewer/ })).toBeChecked();
    await page.getByRole('button', { name: 'Continue · Provider' }).click();
    await expect(page.getByRole('radio', { name: /Hetzner Cloud/ })).toBeChecked();
  });

  test('empty: "No cloud agents yet."', async ({ page }) => {
    await open(page, '/deploy');
    await page.evaluate(() => {
      (window as unknown as MockWindow).__beamhop.mock.daemon.state.deployments = [];
    });
    await refetch(page);
    await expect(page.getByText('No cloud agents yet.')).toBeVisible();
    await expect(page.getByRole('link', { name: /^ci-bot/ })).toHaveCount(0);
  });

  test('error: "Couldn\'t load deployments."', async ({ page }) => {
    await open(page, '/deploy?mockFail=deploy.list');
    await expect(page.getByText("Couldn't load deployments.").first()).toBeVisible();
  });

  test('a fresh agent on Hetzner: name → provider → size → plan → deploy → running', async ({ page }) => {
    test.setTimeout(60_000);
    await open(page, '/deploy/new?mode=new');
    await page.getByLabel('Agent name').fill('night-owl');
    await page.getByRole('button', { name: 'Continue · Provider' }).click();
    await page.getByRole('radio', { name: /Hetzner Cloud/ }).check({ force: true });
    await page.getByRole('button', { name: 'Continue · Size' }).click();
    await expect(page.getByRole('radio', { name: /cx22/ })).toBeChecked();
    await page.getByRole('button', { name: 'Continue · Files' }).click();
    await page.getByRole('button', { name: 'Continue · Plan' }).click();
    const plan = page.locator('[data-plan]').first();
    await expect(plan.getByRole('button', { name: /create server/ })).toBeVisible();
    await expect(plan.getByRole('button', { name: /move identity/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Deploy · $4.90/mo' }).click();

    await expect(page).toHaveURL(/\/deploy\/dep_hetzner_/);
    await expect(toasts(page).getByText('Deploying · night-owl to Hetzner Cloud')).toBeVisible();
    const deps = await rpc<{ deployments: { id: string; agent: string; provider: string; size?: string }[] }>(
      page,
      'deploy.list',
    );
    const dep = deps.deployments.find((d) => d.agent === 'night-owl');
    expect(dep).toMatchObject({ provider: 'hetzner', size: 'cx22' });
    expect(page.url()).toContain(dep!.id);
    await expect(page.getByText('running').first()).toBeVisible({ timeout: 15_000 });
  });

  test('a failed apply shows the error and Deploy can be pressed again', async ({ page }) => {
    await open(page, '/deploy/new?agent=reviewer&mockFail=deploy.apply');
    await page.getByRole('button', { name: 'Continue · Provider' }).click();
    await page.getByRole('radio', { name: /Hetzner Cloud/ }).check({ force: true });
    await page.getByRole('button', { name: 'Continue · Size' }).click();
    await page.getByRole('button', { name: 'Continue · Files' }).click();
    await page.getByRole('button', { name: 'Continue · Plan' }).click();
    const deploy = page.getByRole('button', { name: 'Deploy · $4.90/mo' });
    await deploy.click();
    await expect(
      toasts(page)
        .getByText(/Couldn't start the deploy/)
        .first(),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/deploy\/new/);
    await expect(deploy).toBeEnabled();
    const before = (await rpc<{ deployments: unknown[] }>(page, 'deploy.list')).deployments.length;
    expect(before).toBe(2);
    await deploy.click();
    await expect(
      toasts(page)
        .getByText(/Couldn't start the deploy/)
        .first(),
    ).toBeVisible();
    expect((await rpc<{ deployments: unknown[] }>(page, 'deploy.list')).deployments).toHaveLength(2);
  });
});
