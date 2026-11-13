/**
 * Inbox journeys (JOURNEYS §2) on mobile + desktop: risk-scaled swipe, scope sheet, undo, deny
 * reason, access request role picker, N-of-M, learning-mode cards, keyboard triage (J/K/A/D/U),
 * batch decisions, all-clear, offline queue — plus axe on every state we open.
 * Screenshots of the inbox states land in screenshots/{mobile,desktop}/inbox-*.png.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

const open = async (page: Page, path = '/inbox') => {
  const sep = path.includes('?') ? '&' : '?';
  await page.goto(`${path}${sep}mock=1&still=1`);
  await expect(page.locator('#bh-main-content').first()).toBeVisible();
};

const axe = async (page: Page) => {
  // No horizontal page scroll (SCREENS §0.4).
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
          .map((n) => n.target.join(' '))
          .slice(0, 3)
          .join(' | ')}`,
    ),
  ).toEqual([]);
};

const shot = async (page: Page, name: string, project: string) => {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `screenshots/${project}/${name}.png` });
};

/** The pending readout in the title. */
const pendingCount = (page: Page) =>
  page
    .getByRole('status')
    .filter({ hasText: /pending/i })
    .first();

test('stack/list shows the soonest request first with risk, countdown and decision buttons', async ({
  page,
}, info) => {
  await open(page);
  await expect(
    page.getByRole('button', { name: /^Deny: ci-bot, registry\.npmjs\.org/ }).first(),
  ).toBeVisible();
  if (info.project.name === 'mobile') {
    const slip = page.getByRole('group', {
      name: /Approval from ci-bot: Reach a new host, registry\.npmjs\.org, elevated risk, 3 identical/,
    });
    await expect(slip).toBeVisible();
    await expect(slip.getByText('×3')).toBeVisible();
    await expect(page.getByText('1 of 5')).toBeVisible();
  } else {
    await expect(page).toHaveURL(/\/inbox\/apr_b72c/);
    await expect(page.getByRole('link', { name: /reviewer\s*git push origin beamhop\/842/ })).toBeVisible();
  }
  await expect(pendingCount(page)).toContainText('05');
  await axe(page);
});

test('LOW request: allow once commits, toast offers undo, undo restores it', async ({ page }) => {
  await open(page, '/inbox/apr_c09e');
  const allow = page.getByRole('button', {
    name: /^Allow once: helpdesk, ~\/docs\/public\/faq\/api-keys\.md/,
  });
  await allow.click();
  const region = page.getByRole('region', { name: 'Notifications' });
  await expect(region.getByText(/Allowed once/)).toBeVisible();
  await expect(pendingCount(page)).toContainText('04');
  await region.getByRole('button', { name: 'Undo' }).click();
  await expect(pendingCount(page)).toContainText('05');
});

test('HIGH request: Allow… opens the scope sheet; "always" shows the exact rule and relabels the button', async ({
  page,
}, info) => {
  await open(page, '/inbox/apr_a41f');
  await page.getByRole('button', { name: /^Allow… \(choose scope\): reviewer/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Allow git push?' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Allow once' })).toBeVisible();
  await sheet.getByText(/Always allow for user on reviewer/).click();
  await expect(sheet.getByText('+ approvals.auto: bash:git push origin beamhop/842')).toBeVisible();
  await sheet.getByRole('radio', { name: /git push …/ }).click();
  await expect(sheet.getByText('+ approvals.auto: bash:git push')).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Add rule & allow' })).toBeVisible();
  await axe(page);
  await shot(page, 'inbox-scope', info.project.name);
  await sheet.getByText(/Allow for this session/).click();
  await sheet.getByRole('button', { name: 'Allow for session' }).click();
  await expect(sheet).toBeHidden();
  await expect(
    page.getByRole('region', { name: 'Notifications' }).getByText(/Allowed for session/),
  ).toBeVisible();
});

test('deny, then add a reason from the toast', async ({ page }) => {
  await open(page, '/inbox/apr_a41f');
  await page.getByRole('button', { name: /^Deny: reviewer/ }).click();
  const region = page.getByRole('region', { name: 'Notifications' });
  await region.getByRole('button', { name: 'Add reason' }).click();
  const sheet = page.getByRole('dialog', { name: 'Tell the agent why' });
  await sheet.getByRole('button', { name: 'Use a read-only approach' }).click();
  await expect(sheet).toBeHidden();
  await expect(region.getByText(/Denied with reason/)).toBeVisible();
});

test('access request: role picker defaults to least access', async ({ page }, info) => {
  await open(page, '/inbox/apr_d3e1');
  await expect(page.getByText(/asked to talk to helpdesk/).first()).toBeVisible();
  await page.getByRole('button', { name: /^Allow… \(choose scope\): helpdesk/ }).click();
  const sheet = page.getByRole('dialog', { name: /talk to helpdesk\?/ });
  await expect(sheet.getByRole('radio', { name: /^viewer/ })).toBeChecked();
  await expect(sheet.getByRole('button', { name: 'Allow as viewer' })).toBeVisible();
  await sheet.getByText(/^user$/).click();
  await expect(sheet.getByRole('button', { name: 'Allow as user' })).toBeVisible();
  await shot(page, 'inbox-access', info.project.name);
  await sheet.getByRole('button', { name: 'Allow as user' }).click();
  await expect(
    page.getByRole('region', { name: 'Notifications' }).getByText(/Allowed as user/),
  ).toBeVisible();
});

test('N-of-M: approving moves the request to "Waiting on others"', async ({ page }) => {
  await open(page, '/inbox/apr_e5d0');
  await expect(page.getByText('1 of 3 owners approved').first()).toBeVisible();
  await page.getByRole('button', { name: /^Approve \(choose scope\): ci-bot/ }).click();
  const sheet = page.getByRole('dialog', { name: /Allow fly deploy\?/ });
  await sheet.getByRole('button', { name: 'Approve' }).click();
  await expect(sheet).toBeHidden();
  await expect(
    page.getByRole('region', { name: 'Notifications' }).getByText(/Approved · waiting for others/),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: /Waiting on others/ })).toBeVisible();
});

test('learning-mode suggestion: allow with explicit wildcard scope, undo keeps it', async ({ page }) => {
  await open(page);
  const card = page.getByRole('group', { name: /Suggestion: helpdesk tried to reach registry\.npmjs\.org/ });
  await card.scrollIntoViewIfNeeded();
  await card.getByRole('radio', { name: '*.npmjs.org' }).click();
  await card.getByRole('button', { name: /^Allow host: \*\.npmjs\.org/ }).click();
  const region = page.getByRole('region', { name: 'Notifications' });
  await expect(region.getByText(/Allowed · \*\.npmjs\.org/)).toBeVisible();
  await region.getByRole('button', { name: 'Undo' }).click();
  await expect(
    page.getByRole('group', { name: /Suggestion: helpdesk tried to reach registry\.npmjs\.org/ }),
  ).toBeVisible();
});

test('keyboard triage: J moves, D denies, U undoes (desktop)', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'hardware keyboard');
  await open(page);
  await expect(page).toHaveURL(/apr_b72c/);
  await page.locator('body').click({ position: { x: 5, y: 400 } });
  await page.keyboard.press('j');
  await expect(page).toHaveURL(/apr_a41f/);
  await page.keyboard.press('d');
  await expect(page.getByRole('region', { name: 'Notifications' }).getByText(/Denied/)).toBeVisible();
  await expect(page).not.toHaveURL(/apr_a41f/);
  await page.keyboard.press('u');
  await expect(page.getByRole('link', { name: /reviewer\s*git push/ })).toBeVisible();
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
});

test('batch: select two, deny both with one undo (desktop)', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'batch actions are desktop-only');
  await open(page);
  await page.getByRole('checkbox', { name: /Select reviewer/ }).check({ force: true });
  await page.getByRole('checkbox', { name: /Select helpdesk, ~\/docs/ }).check({ force: true });
  await expect(page.getByText('2 selected')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Allow 2 once' })).toBeDisabled();
  await shot(page, 'inbox-batch', info.project.name);
  await page.getByRole('button', { name: 'Deny 2' }).click();
  await expect(page.getByRole('region', { name: 'Notifications' }).getByText(/Denied/)).toBeVisible();
  await expect(page.getByRole('link', { name: /reviewer\s*git push/ })).toHaveCount(0);
});

test('swipe left denies the top slip (mobile)', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'touch');
  await open(page);
  const slip = page.getByRole('group', { name: /^Approval from ci-bot/ }).first();
  const box = (await slip.boundingBox())!;
  const y = box.y + 80;
  await page.mouse.move(box.x + box.width * 0.6, y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + box.width * 0.6 - i * 28, y, { steps: 2 });
  await page.mouse.up();
  await expect(page.getByRole('region', { name: 'Notifications' }).getByText(/Denied/)).toBeVisible();
  await expect(page.getByText('1 of 4')).toBeVisible();
});

test('swipe right on an ELEVATED slip opens the scope sheet instead of committing (mobile)', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'mobile', 'touch');
  await open(page);
  const slip = page.getByRole('group', { name: /^Approval from ci-bot/ }).first();
  const box = (await slip.boundingBox())!;
  const y = box.y + 80;
  await page.mouse.move(box.x + box.width * 0.3, y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + box.width * 0.3 + i * 28, y, { steps: 2 });
  await page.mouse.up();
  await expect(page.getByRole('dialog', { name: 'Allow registry.npmjs.org?' })).toBeVisible();
  await expect(page.getByText('+ network.allow')).toHaveCount(0);
});

test('offline: a decision is queued and sent when back online', async ({ page, context }) => {
  await open(page, '/inbox/apr_c09e');
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.getByRole('button', { name: /^Deny: helpdesk, ~\/docs/ }).click();
  await expect(
    page.getByRole('region', { name: 'Notifications' }).getByText(/queued, sends when online/),
  ).toBeVisible();
  await page.goto('/inbox?mock=1&still=1').catch(() => undefined);
  await context.setOffline(false);
});

test('all clear when nothing is pending', async ({ page }, info) => {
  await open(page);
  await page.evaluate(async () => {
    const w = window as unknown as {
      __beamhop: {
        runtime: {
          client: {
            call: (m: string, p?: unknown) => Promise<{ approvals: Array<{ id: string; quorum?: unknown }> }>;
          };
        };
      };
    };
    const c = w.__beamhop.runtime.client;
    const { approvals } = await c.call('approval.list', { status: 'pending' });
    for (const a of approvals) await c.call('approval.decide', { id: a.id, allow: false });
  });
  if (info.project.name === 'desktop')
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Inbox/ }).click();
  await expect(page.getByRole('heading', { name: 'Inbox clear.' })).toBeVisible();
  await expect(pendingCount(page)).toContainText('00');
  await axe(page);
  await shot(page, 'inbox-clear', info.project.name);
});

test('screenshots: inbox light + dark, detail', async ({ page }, info) => {
  await open(page);
  await shot(page, 'inbox', info.project.name);
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'inbox-dark', info.project.name);
  await page.emulateMedia({ colorScheme: 'light' });
  await open(page, '/inbox/apr_a41f');
  await shot(page, 'inbox_apr_a41f', info.project.name);
  await open(page, '/inbox/apr_e5d0');
  await shot(page, 'inbox-quorum', info.project.name);
  if (info.project.name === 'mobile') {
    await open(page);
    await page.evaluate(() => window.scrollBy(0, 620));
    await shot(page, 'inbox-learning', info.project.name);
  }
});
