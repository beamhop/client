/**
 * The agent-centric redesign (docs/design/desktop-ux-audit.md): the Needs-you slide-over, Settings → Your
 * setup, helpful empty panes, approval explanations, the agent page's four parts and its Chat button, the
 * create-agent form's details, and the boot splash.
 */
import { expect, test } from '@playwright/test';
import { expectAccessible, open } from './helpers.ts';

test.describe('needs-you panel', () => {
  test('opens from the strip, lists requests, and leads to the decision', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'the strip is desktop chrome');
    await open(page, '/agents');
    await page
      .getByRole('region', { name: 'Daemon status' })
      .getByRole('button', { name: /need you/ })
      .click();
    const panel = page.getByRole('dialog', { name: 'Needs you' });
    await expect(panel).toBeVisible();
    await expect(panel.getByText('registry.npmjs.org')).toBeVisible();
    await expectAccessible(page);
    await panel.getByRole('link', { name: /registry\.npmjs\.org/ }).click();
    await expect(page).toHaveURL(/\/inbox\/apr_/);
    await expect(panel).toBeHidden();
  });

  test('`n` opens it, Escape closes it, and `n` is ignored while the palette is open', async ({
    page,
  }, info) => {
    test.skip(info.project.name !== 'desktop', 'hardware keyboard');
    await open(page, '/');
    await page.locator('body').click({ position: { x: 5, y: 400 } });
    await page.keyboard.press('n');
    const panel = page.getByRole('dialog', { name: 'Needs you' });
    await expect(panel).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();
    await page.keyboard.type('new agent');
    await expect(palette).toBeVisible();
    await expect(panel).toBeHidden();
    await expect(palette.getByRole('searchbox')).toHaveValue('new agent');
  });

  test('Open Inbox goes to the full inbox', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'the strip is desktop chrome');
    await open(page, '/');
    await page
      .getByRole('region', { name: 'Daemon status' })
      .getByRole('button', { name: /need you/ })
      .click();
    await page.getByRole('dialog', { name: 'Needs you' }).getByRole('link', { name: 'Open Inbox' }).click();
    await expect(page).toHaveURL(/\/inbox/);
  });
});

test('the status strip says whether beamhop is connected; details are on hover', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'the strip is desktop chrome');
  await open(page, '/');
  const strip = page.getByRole('region', { name: 'Daemon status' });
  await expect(strip.getByText('connected')).toBeVisible();
  // Version, uptime and relays: in the tooltip (and for screen readers), not on screen.
  await expect(strip.locator('[title*="beamhopd"] .sr-only')).toHaveText(/beamhopd/);
  await expect(strip.locator('[title*="beamhopd"]')).toHaveCount(1);
});

test.describe('settings: your setup', () => {
  for (const [name, path] of [
    ['Connections', '/channels'],
    ['AI accounts', '/harnesses'],
    ['Sandboxes & roles', '/policy'],
    ['Activity', '/audit'],
    ['Cloud', '/deploy'],
  ] as const)
    test(`${name} opens ${path}, and the sidebar keeps Settings current`, async ({ page }, info) => {
      await open(page, '/settings');
      await page
        .getByRole('navigation', { name: 'Settings sections' })
        .getByRole('link', { name: new RegExp(name) })
        .click();
      await expect(page).toHaveURL(new RegExp(path));
      if (info.project.name === 'desktop')
        await expect(
          page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Settings/ }),
        ).toHaveAttribute('aria-current', 'page');
    });
});

test.describe('empty detail panes say what the place is for', () => {
  for (const [path, title, action, target] of [
    ['/agents', "Pick an agent to see what it's doing", 'New agent', /\/agents\/new/],
    ['/channels', 'Connections are where people reach your agents', 'Add a connection', /\/channels\/add/],
    ['/deploy', 'Run an agent in the cloud', 'New cloud agent', /\/deploy\/new/],
  ] as const)
    test(path, async ({ page }, info) => {
      test.skip(info.project.name !== 'desktop', 'split view only');
      await open(page, path);
      await expect(page.getByText(title)).toBeVisible();
      await page.locator('#bh-main-content').getByRole('link', { name: action, exact: true }).last().click();
      await expect(page).toHaveURL(target);
    });

  test('/settings', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'split view only');
    await open(page, '/settings');
    await expect(page.getByText('Pick a setting on the left')).toBeVisible();
  });
});

test('approvals carry one plain sentence under the exact request', async ({ page }) => {
  await open(page, '/inbox');
  await expect(page.getByText('registry.npmjs.org').first()).toBeVisible();
  await expect(
    page.getByText("Wants to reach a website it hasn't been allowed to use yet.").first(),
  ).toBeVisible();
  await open(page, '/inbox/apr_a41f'); // reviewer: git push origin beamhop/842
  await expect(page.getByText('Wants to upload code changes to a shared repository.').first()).toBeVisible();
});

test.describe('agent page', () => {
  test('four parts, each with its pieces', async ({ page }) => {
    await open(page, '/agents/reviewer');
    const nav = page.getByRole('navigation', { name: 'reviewer sections' });
    await expect(nav.getByRole('link')).toHaveText([
      'Overview',
      'Who can reach it',
      'What it can do',
      'Advanced',
    ]);
    await nav.getByRole('link', { name: 'Who can reach it' }).click();
    await expect(page).toHaveURL(/\/agents\/reviewer\/reach/);
    await nav.getByRole('link', { name: 'What it can do' }).click();
    for (const h of ['Folders', 'Internet and safety', 'Spending'])
      await expect(page.getByRole('heading', { name: h, exact: true })).toBeVisible();
    await nav.getByRole('link', { name: 'Advanced' }).click();
    for (const h of ['AI program and model', 'Schedules', 'Identity'])
      await expect(page.getByRole('heading', { name: h, exact: true })).toBeVisible();
    await expectAccessible(page);
  });

  for (const [old, part, heading] of [
    ['setup', 'Advanced', 'AI program and model'],
    ['sandbox', 'What it can do', 'Internet and safety'],
    ['channels', 'Who can reach it', undefined],
    ['schedules', 'Advanced', 'Schedules'],
    ['identity', 'Advanced', 'Identity'],
  ] as const)
    test(`old …/${old} link opens ${part}`, async ({ page }) => {
      await open(page, `/agents/reviewer/${old}`);
      await expect(
        page.getByRole('navigation', { name: 'reviewer sections' }).getByRole('link', { name: part }),
      ).toHaveAttribute('aria-current', 'page');
      if (heading) await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    });

  test('Chat in the header starts a conversation with this agent', async ({ page }) => {
    await open(page, '/agents/reviewer');
    await page
      .getByRole('button', { name: /^(Chat|Chat with reviewer)$/ })
      .first()
      .click();
    const sheet = page.getByRole('dialog', { name: 'New session' });
    await expect(sheet).toBeVisible();
    await sheet.getByRole('textbox', { name: /What should reviewer do/ }).fill('summarize open PRs');
    await sheet.getByRole('button', { name: 'Start session with reviewer' }).click();
    await expect(page).toHaveURL(/\/sessions\/ses_/);
    await expect(page.getByText('summarize open PRs').first()).toBeVisible();
  });

  test('an agent that listens somewhere has no app-only callout', async ({ page }) => {
    await open(page, '/agents/reviewer');
    await expect(page.locator('[data-reach="app-only"]')).toHaveCount(0);
  });
});

test.describe('create agent form', () => {
  test('AI accounts in plain words; program and model under Advanced', async ({ page }) => {
    await open(page, '/agents/new');
    await expect(page.getByRole('radio', { name: /Claude.*Ready · your Anthropic account/ })).toBeEnabled();
    await expect(
      page.getByRole('radio', { name: /ChatGPT.*Sign in with your OpenAI account/ }),
    ).toBeDisabled();
    await expect(page.getByText('Needs an update before it can run')).toBeVisible();
    await page.getByText('Advanced: model and program').click();
    await expect(page.getByText(/Runs on Claude Code/)).toBeVisible();
    await expectAccessible(page);
  });

  test('broken connections are not offered as places to listen', async ({ page }) => {
    await open(page, '/agents/new');
    await expect(page.getByRole('checkbox', { name: /Direct messages on Telegram/ })).toBeAttached();
    await expect(page.getByRole('checkbox', { name: /Discord/ })).toHaveCount(0);
  });

  test('finishing the primed channel setup returns to the agent', async ({ page }) => {
    await open(page, '/agents/new');
    await page.getByRole('radio', { name: 'Telegram' }).click();
    await page.getByRole('button', { name: /and connect Telegram/ }).click();
    await expect(page).toHaveURL(/\/channels\/add\/telegram\/1/);
    // The bot is named after the new agent.
    await expect(page.getByText('assistant (beamhop)').first()).toBeVisible();
  });
});

test('a cold start shows the loading screen, never a blank window', async ({ page }) => {
  await page.route('**/src/main.tsx*', async (r) => {
    await new Promise((ok) => setTimeout(ok, 800));
    await r.continue();
  });
  await page.route('**/assets/index-*.js', async (r) => {
    await new Promise((ok) => setTimeout(ok, 800));
    await r.continue();
  });
  await page.goto('/?mock=1&still=1', { waitUntil: 'commit' });
  await expect(page.getByRole('status', { name: 'Loading beamhop' })).toBeVisible();
  await expect(page.locator('#bh-main-content').first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('status', { name: 'Loading beamhop' })).toHaveCount(0);
});
