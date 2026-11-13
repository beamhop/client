/**
 * Agents journeys (SCREENS §4, JOURNEYS §1.05/§5): list → detail sections → edit with review & save,
 * schedules (cron preview, webhook secret shown once), memberships/people, lifecycle (stop, clone, delete),
 * and the preset-first New agent flow. Runs on mobile + desktop, with axe on every section and step.
 * Screenshots (light + dark) for review land in screenshots/{project}/agents-*.png.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

const open = async (page: Page, path: string) => {
  const sep = path.includes('?') ? '&' : '?';
  await page.goto(`${path}${sep}mock=1&still=1`);
  await expect(page.locator('#bh-main-content').first()).toBeVisible();
};

const axe = async (page: Page) => {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'horizontal page overflow (px)').toBeLessThanOrEqual(0);
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    bad.map(
      (v) =>
        `${v.id}: ${v.help} → ${v.nodes
          .map((n) => `${n.target.join(' ')} ${n.html.slice(0, 160)}`)
          .slice(0, 3)
          .join(' | ')}`,
    ),
  ).toEqual([]);
};

const sectionNav = (page: Page) => page.getByRole('navigation', { name: 'reviewer sections' });

test('list: agents sorted live first, open detail', async ({ page }) => {
  await open(page, '/agents');
  const list = page.getByRole('list', { name: 'Agents' });
  await expect(list.getByText('reviewer').first()).toBeVisible();
  await expect(list.getByText('scribe').first()).toBeVisible();
  await list
    .getByRole('link', { name: /reviewer/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/agents\/reviewer/);
  await expect(page.getByRole('meter', { name: 'reviewer budget today' })).toBeVisible();
  await expect(page.getByText('$1.80', { exact: true })).toBeVisible();
});

test('stop from the list card is one tap (mobile)', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'cards with Stop are the compact layout');
  await open(page, '/agents');
  await page.getByRole('button', { name: 'Stop reviewer' }).click();
  await expect(
    page.getByRole('region', { name: 'Notifications' }).getByText('reviewer stopped'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start reviewer' })).toBeVisible();
});

test('old section links land in the part that holds them now', async ({ page }) => {
  await open(page, '/agents/reviewer/budgets');
  await expect(sectionNav(page).getByRole('link', { name: 'What it can do' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByRole('heading', { name: 'Spending', exact: true })).toBeVisible();
});

test('sections are routes; overview opens an instruction file', async ({ page }) => {
  await open(page, '/agents/reviewer');
  await expect(sectionNav(page).getByRole('link', { name: 'Overview' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await page.getByRole('button', { name: /CLAUDE\.md/ }).click();
  const sheet = page.getByRole('dialog', { name: '~/code/app/CLAUDE.md' });
  await expect(sheet.getByText('Never push to main')).toBeVisible();
  await page.keyboard.press('Escape');
  await sectionNav(page).getByRole('link', { name: 'Advanced' }).click();
  await expect(page).toHaveURL(/\/agents\/reviewer\/advanced/);
  await expect(page.getByRole('heading', { name: 'Schedules', exact: true })).toBeVisible();
  await expect(page.getByText('Every weekday at 09:00 Berlin time')).toBeVisible();
});

test('instruction file in a read-write mount: edit, preview the diff, write', async ({ page }) => {
  await open(page, '/agents/reviewer');
  await page.getByRole('button', { name: /CLAUDE\.md/ }).click();
  const sheet = page.getByRole('dialog', { name: '~/code/app/CLAUDE.md' });
  await expect(sheet.getByText(/In a read-write mount \(~\/code\/app\)/)).toBeVisible();
  await sheet.getByRole('button', { name: 'Edit' }).click();
  const box = sheet.getByRole('textbox', { name: 'Contents of ~/code/app/CLAUDE.md' });
  await box.press('End');
  await box.fill(`${await box.inputValue()}- Ask before touching CI.\n`);
  await sheet.getByRole('button', { name: 'Preview changes' }).click();
  await expect(sheet.getByRole('button', { name: /^~\/code\/app\/CLAUDE\.md \+1 −0/ })).toBeVisible();
  await expect(sheet.getByText('- Ask before touching CI.')).toBeVisible();
  await axe(page);
  await sheet.getByRole('button', { name: 'Write file' }).click();
  await expect(
    page.getByRole('region', { name: 'Notifications' }).getByText('Saved · ~/code/app/CLAUDE.md'),
  ).toBeVisible();
  await expect(sheet.getByText('- Ask before touching CI.')).toBeVisible();
});

test('instruction file: a change made meanwhile stops the write', async ({ page }) => {
  await open(page, '/agents/reviewer');
  await page.getByRole('button', { name: /CLAUDE\.md/ }).click();
  const sheet = page.getByRole('dialog', { name: '~/code/app/CLAUDE.md' });
  await sheet.getByRole('button', { name: 'Edit' }).click();
  const box = sheet.getByRole('textbox', { name: /Contents of/ });
  await box.fill('# mine\n');
  // Someone else writes the file before we save.
  await page.evaluate(() =>
    (
      window as unknown as {
        __beamhop: { runtime: { client: { call: (m: string, p: unknown) => Promise<unknown> } } };
      }
    ).__beamhop.runtime.client.call('agent.instructionsWrite', {
      name: 'reviewer',
      path: '~/code/app/CLAUDE.md',
      content: '# theirs\n',
    }),
  );
  await sheet.getByRole('button', { name: 'Preview changes' }).click();
  await sheet.getByRole('button', { name: 'Write file' }).click();
  await expect(sheet.getByRole('alert')).toContainText('changed since you started editing');
  await sheet.getByRole('button', { name: 'Start over from the new version' }).click();
  await expect(sheet.getByRole('textbox', { name: /Contents of/ })).toHaveValue('# theirs\n');
});

test('instruction file in a read-only mount cannot be edited', async ({ page }) => {
  await open(page, '/agents/ci-bot');
  await page.getByRole('button', { name: /CLAUDE\.md/ }).click();
  const sheet = page.getByRole('dialog', { name: '~/code/app/CLAUDE.md' });
  await expect(sheet.getByText(/mounted read-only/)).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Edit' })).toHaveCount(0);
});

test('setup: making a folder read-write is a widening change, reviewed before save', async ({ page }) => {
  await open(page, '/agents/reviewer/abilities');
  await page.getByRole('radio', { name: 'Read-write' }).nth(1).click(); // ~/notes RO → RW
  await expect(page.getByText('1 change')).toBeVisible();
  await expect(page.getByText('Widens access')).toBeVisible();
  await page.getByRole('button', { name: 'Review & save' }).click();
  const sheet = page.getByRole('dialog', { name: 'Save changes to reviewer?' });
  await expect(sheet.getByText('reviewer will be able to write ~/notes.')).toBeVisible();
  await expect(sheet.getByText('mode: rw').first()).toBeVisible();
  await sheet.getByRole('button', { name: 'Widen access' }).click();
  await expect(page.getByRole('region', { name: 'Notifications' }).getByText(/Saved reviewer/)).toBeVisible();
  await expect(page.getByText('1 change')).toHaveCount(0);
});

test('setup: discard reverts the draft', async ({ page }) => {
  await open(page, '/agents/reviewer/setup');
  await page.getByRole('button', { name: 'Increase Parallel sessions' }).click();
  await expect(page.getByText('1 change')).toBeVisible();
  await page.getByRole('button', { name: 'Discard' }).click();
  await expect(page.getByText('1 change')).toHaveCount(0);
});

test('channels: grant a person a role and lower a default role', async ({ page }) => {
  await open(page, '/agents/reviewer/channels');
  await page.getByRole('textbox', { name: 'Person' }).fill('telegram:777');
  await page.getByRole('button', { name: 'Grant', exact: true }).click();
  await expect(page.getByText('telegram:777', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Review & save' }).click();
  const sheet = page.getByRole('dialog', { name: 'Save changes to reviewer?' });
  await expect(sheet.getByText('telegram:777 gets the user role on reviewer.')).toBeVisible();
  await sheet.getByRole('button', { name: 'Widen access' }).click();
  await expect(page.getByRole('region', { name: 'Notifications' }).getByText(/Saved reviewer/)).toBeVisible();
});

test('schedules: cron preview, then a webhook whose secret is shown once', async ({ page }) => {
  await open(page, '/agents/reviewer/schedules');
  await page.getByRole('button', { name: 'Add schedule' }).first().click();
  const sheet = page.getByRole('dialog', { name: 'New schedule for reviewer' });
  await sheet.getByRole('textbox', { name: 'Time zone' }).fill('Europe/Berlin');
  await sheet.getByRole('button', { name: 'Every hour' }).click();
  await expect(sheet.getByText('Every hour, on the hour')).toBeVisible();
  await expect(sheet.getByRole('list', { name: 'Next runs' }).getByRole('listitem')).toHaveCount(3);
  await sheet.getByRole('textbox', { name: 'Cron expression' }).fill('0 25 * * *');
  await expect(sheet.getByText('The hour must be 0–23.')).toBeVisible();

  await sheet.getByRole('radio', { name: 'Webhook' }).click();
  await sheet.getByRole('textbox', { name: 'What should it do?' }).fill('Explain the failing CI run.');
  await sheet.getByRole('button', { name: 'Create webhook' }).click();
  const secret = page.getByRole('dialog', { name: 'Save the signing secret' });
  await expect(
    secret.getByText('This is the only time beamhop shows this secret.', { exact: false }),
  ).toBeVisible();
  await expect(secret.getByText(/127\.0\.0\.1:7878\/hooks\/reviewer-2/)).toBeVisible();
  await secret.getByRole('button', { name: "I've saved it" }).click();
  await expect(secret).toBeHidden();
  await expect(page.getByText('/hooks/reviewer-2')).toBeVisible();
});

test('lifecycle: clone then delete the clone', async ({ page }) => {
  await open(page, '/agents/scribe');
  await page.getByRole('button', { name: 'More actions for scribe' }).click();
  await page.getByRole('menuitem', { name: 'Clone…' }).click();
  const sheet = page.getByRole('dialog', { name: 'Clone scribe' });
  await expect(sheet.getByRole('textbox', { name: 'Name of the copy' })).toHaveValue('scribe-copy');
  await sheet.getByRole('button', { name: 'Clone as scribe-copy' }).click();
  await expect(page).toHaveURL(/\/agents\/scribe-copy/);
  await page.getByRole('button', { name: 'More actions for scribe-copy' }).click();
  await page.getByRole('menuitem', { name: 'Delete…' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Delete scribe-copy?' });
  await expect(confirm.getByText(/Transcripts are kept until retention ends \(30 days\)/)).toBeVisible();
  await confirm.getByRole('button', { name: 'Delete scribe-copy' }).click();
  await expect(page).toHaveURL(/\/agents(\?.*)?$/);
});

test('unknown agent shows a calm not-found state', async ({ page }) => {
  await open(page, '/agents/ghost');
  await expect(page.getByRole('heading', { name: 'No agent named ghost.' })).toBeVisible();
});

test('new agent: one page — purpose, name, AI account, folders, where it listens', async ({ page }) => {
  await open(page, '/agents/new');
  await page.getByText('Public Q&A bot', { exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Name' })).toHaveValue('qa');
  await expect(page.getByRole('radio', { name: /ChatGPT/ })).toBeDisabled();
  await page.getByText('Gemini', { exact: true }).click();
  await page.getByRole('button', { name: 'Add folder' }).click();
  await page.getByRole('combobox', { name: 'Folder' }).fill('~/.ssh');
  await page.getByRole('button', { name: 'Add folder' }).click();
  await expect(page.getByText('~/.ssh is always blocked. No agent can mount it.')).toBeVisible();
  await page.getByRole('combobox', { name: 'Folder' }).fill('~/docs/public');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Add folder' }).click();
  await expect(page.getByText('Read-only (preset).')).toBeVisible();
  await page.getByText('Direct messages on Telegram', { exact: true }).click();
  await expect(page.getByRole('checkbox', { name: /Direct messages on Telegram/ })).toBeChecked();
  await expect(page.getByText('Direct messages on Telegram').nth(1)).toBeAttached();
  await page.getByRole('button', { name: 'Create qa', exact: true }).click();
  await expect(page).toHaveURL(/\/agents\/qa/);
  await expect(page.getByRole('region', { name: 'Notifications' }).getByText(/Created qa/)).toBeVisible();
  // It listens on Telegram, so it is not "app only".
  await expect(page.locator('[data-reach="app-only"]')).toHaveCount(0);
});

test('new agent: connecting a new place opens its setup, primed to join this agent', async ({ page }) => {
  await open(page, '/agents/new');
  await page.getByText('Code reviewer', { exact: true }).click();
  await page.getByRole('radio', { name: 'Slack' }).click();
  await page.getByRole('button', { name: 'Create reviewer-2 and connect Slack' }).click();
  await expect(page).toHaveURL(/\/channels\/add\/slack\/1/);
  const draft = await page.evaluate(() => localStorage.getItem('bh.channelDraft.slack'));
  expect(JSON.parse(draft ?? '{}').values).toMatchObject({ agents: ['reviewer-2'], forAgent: 'reviewer-2' });
});

test('new agent: from scratch is app only until it gets a channel', async ({ page }) => {
  await open(page, '/agents/new');
  await page.getByText('Start from scratch', { exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Name' })).toHaveValue('agent');
  await page.getByRole('radio', { name: 'Strict', exact: true }).click();
  await expect(page.getByText(/Read-only folders and a locked-down sandbox/)).toBeVisible();
  await page.getByText('Gemini', { exact: true }).click();
  await page.getByRole('button', { name: 'Create agent', exact: true }).click();
  await expect(page).toHaveURL(/\/agents\/agent/);
  await expect(
    page.getByRole('heading', { name: 'Only you can reach agent, here in the app.' }),
  ).toBeVisible();
  await page.locator('[data-reach="app-only"]').getByRole('button', { name: 'Chat' }).click();
  await expect(page.getByRole('dialog', { name: 'New session' })).toBeVisible();
});

test('new agent: a taken name is caught with a suggestion', async ({ page }) => {
  await open(page, '/agents/new');
  await page.getByRole('textbox', { name: 'Name' }).fill('reviewer');
  await page.getByRole('button', { name: 'Create reviewer', exact: true }).click();
  await expect(page.getByText('reviewer already exists. Try reviewer-2.').first()).toBeVisible();
  await expect(page).toHaveURL(/\/agents\/new/);
});

for (const path of [
  '/agents',
  '/agents/reviewer',
  '/agents/reviewer/reach',
  '/agents/reviewer/abilities',
  '/agents/reviewer/advanced',
  '/agents/new',
]) {
  test(`a11y ${path}`, async ({ page }) => {
    await open(page, path);
    await page.waitForTimeout(300);
    await axe(page);
  });
}

test('a11y new-agent with a folder sheet open', async ({ page }) => {
  await open(page, '/agents/new');
  await page.getByRole('button', { name: 'Add folder' }).click();
  await axe(page);
});

// ─────────── Screenshots for review (light + dark) ───────────
const SHOTS: Array<[string, string]> = [
  ['/agents', 'agents'],
  ['/agents/reviewer', 'agents_reviewer'],
  ['/agents/reviewer/reach', 'agents_reviewer_reach'],
  ['/agents/reviewer/abilities', 'agents_reviewer_abilities'],
  ['/agents/reviewer/advanced', 'agents_reviewer_advanced'],
  ['/agents/new', 'agents_new'],
];

test.describe('screenshots', () => {
  test.skip(!process.env.BH_SHOTS, 'set BH_SHOTS=1 to refresh screenshots');
  for (const scheme of ['light', 'dark'] as const) {
    test(`agents screens ${scheme}`, async ({ page }, info) => {
      test.setTimeout(120_000);
      await page.emulateMedia({ colorScheme: scheme });
      const suffix = scheme === 'dark' ? '-dark' : '';
      for (const [path, name] of SHOTS) {
        await open(page, path);
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(500);
        await page.screenshot({ path: `screenshots/${info.project.name}/${name}${suffix}.png` });
        if (process.env.BH_SHOTS === 'full')
          await page.screenshot({
            path: `screenshots/${info.project.name}/${name}${suffix}-full.png`,
            fullPage: true,
          });
      }
      // New-agent steps + an edit in progress + the webhook secret
      await open(page, '/agents/new');
      await page.getByRole('button', { name: 'Continue · Harness' }).click();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `screenshots/${info.project.name}/agents_new_harness${suffix}.png` });
      await page.getByRole('button', { name: 'Continue · Folders' }).click();
      await page.getByRole('button', { name: /Skip · Review/ }).click();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `screenshots/${info.project.name}/agents_new_review${suffix}.png` });
      await open(page, '/agents/reviewer/abilities');
      await page.getByRole('radio', { name: 'Read-write' }).nth(1).click();
      await page.getByRole('button', { name: 'Review & save' }).click();
      await page.waitForTimeout(500);
      await page.screenshot({
        path: `screenshots/${info.project.name}/agents_reviewer_setup_review${suffix}.png`,
      });
    });
  }
});
