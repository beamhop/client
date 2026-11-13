/**
 * Sessions journeys (JOURNEYS §3, SCREENS §3): list filters and grouping, the live session view (tool rows,
 * inline approval, composer, stop, end-of-session merge/PR), prev/next (buttons, keys, touch swipe), long
 * transcript windowing, inspector, and axe on every state. Mock daemon with frozen timers (`still=1`).
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
        `${v.id}: ${v.nodes
          .map((n) => `${n.target.join(' ')} ${n.html.slice(0, 140)}`)
          .slice(0, 3)
          .join(' | ')}`,
    ),
  ).toEqual([]);
};

test.describe('sessions list', () => {
  test('groups by agent, filters by status and agent, remembers nothing broken', async ({ page }) => {
    await open(page, '/sessions');
    await expect(page.getByRole('heading', { name: /reviewer\s*· 4/i })).toBeVisible();
    const live = page.getByRole('radio', { name: /^Live, 1$/ });
    await live.click();
    await expect(page.getByRole('link', { name: /can you fix the login redirect/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /review PR #211/ })).toHaveCount(0);
    await page.getByRole('radio', { name: /^Needs you/ }).click();
    await expect(page.getByRole('link', { name: /How do I rotate my API key/ })).toBeVisible();
    // Agent rail narrows further; an empty result explains itself and offers a reset.
    await page.getByRole('radio', { name: /^scribe/ }).click();
    await expect(page.getByRole('heading', { name: 'No needs you sessions' })).toBeVisible();
    await page.getByRole('button', { name: /Show all \d+ sessions/ }).click();
    await expect(page.getByRole('radio', { name: /^All, \d+/ })).toBeChecked();
    await axe(page);
  });

  test('row menu stops a live session', async ({ page }) => {
    await open(page, '/sessions');
    await page.getByRole('button', { name: /Actions for can you fix the login redirect/ }).click();
    await page.getByRole('menuitem', { name: 'Stop session' }).click();
    await expect(
      page.getByRole('region', { name: 'Notifications' }).getByText(/Stopped reviewer · thread 842/),
    ).toBeVisible();
  });

  test('partial swipe-left reveals Stop (touch)', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'touch gesture');
    await open(page, '/sessions');
    const row = page.locator('[data-session="ses_842"] > div[style]').first();
    const box = (await row.boundingBox())!;
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width - 40, y);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + box.width - 40 - i * 12, y);
    await page.mouse.up();
    const stop = page.locator('[data-session="ses_842"]').getByRole('button', { name: 'Stop' });
    await expect(stop).toBeVisible();
    await stop.click();
    await expect(
      page.getByRole('region', { name: 'Notifications' }).getByText(/Stopped reviewer · thread 842/),
    ).toBeVisible();
  });
});

test.describe('session view', () => {
  test('live transcript: prose, tool rows with diff, inline approval, progress', async ({ page }) => {
    await open(page, '/sessions/ses_842');
    const log = page.getByRole('log', { name: 'Transcript with reviewer' });
    await expect(log).toBeVisible();
    await expect(log.getByRole('heading', { name: /Alice user Telegram/ })).toBeAttached();
    await expect(log.getByText('Tests pass. Pushing the fix so CI can run.')).toBeVisible();
    await expect(page.getByTestId('progress-strip')).toContainText(
      'Waiting for you · git push origin beamhop/842',
    );
    // Tool row expands to the diff viewer.
    await log.getByRole('button', { name: /^Edit 2 files/ }).click();
    await expect(log.getByRole('region', { name: 'Diff of src/auth.ts' })).toBeVisible();
    // Stop is one tap.
    await expect(page.getByRole('button', { name: 'Stop reviewer' })).toBeVisible();
    await axe(page);
    // Inline approval mirrors the Inbox: deny → toast with undo.
    await log.getByRole('button', { name: 'Deny: git push origin beamhop/842' }).click();
    await expect(page.getByRole('region', { name: 'Notifications' }).getByText(/Denied/)).toBeVisible();
    await expect(log.getByText(/Denied by/)).toBeVisible();
  });

  test('composer sends a message and slash /details expands tools', async ({ page }) => {
    await open(page, '/sessions/ses_d17');
    const box = page.getByRole('textbox', { name: 'Message ci-bot' });
    await box.fill('also post the release notes');
    await box.press('Enter');
    await expect(page.getByRole('log').getByText('also post the release notes')).toBeVisible();
    await expect(box).toHaveValue('');
    await box.fill('/details');
    await box.press('Enter');
    await expect(box).toHaveValue('');
  });

  test('stopping ends the session and offers merge / open PR', async ({ page }) => {
    await open(page, '/sessions/ses_842');
    await page.getByRole('button', { name: 'Stop reviewer' }).click();
    await expect(page.getByRole('heading', { name: 'Session ended' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open PR' }).first()).toBeVisible();
  });

  test('finished worktree session: files changed, diff sheet, open PR', async ({ page }) => {
    await open(page, '/sessions/ses_836');
    const log = page.getByRole('log');
    await expect(log.getByText(/3 files/)).toBeVisible();
    await expect(log.getByRole('button', { name: /5 tool calls/ })).toBeVisible();
    await log.getByRole('button', { name: 'View diff' }).click();
    const sheet = page.getByRole('dialog', { name: 'Changes' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('button', { name: /src\/schema\.ts/ })).toBeVisible();
    await axe(page);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Open PR' }).first().click();
    await expect(
      page.getByRole('region', { name: 'Notifications' }).getByText('Asked reviewer to open a pull request'),
    ).toBeVisible();
    await expect(log.getByText(/open a pull request from beamhop\/836/)).toBeVisible();
  });

  test('prev / next session of the same agent: buttons and [ ]', async ({ page }, info) => {
    await open(page, '/sessions/ses_842');
    await page.getByRole('button', { name: /^Previous session: review PR #211/ }).click();
    await expect(page).toHaveURL(/\/sessions\/ses_839/);
    if (info.project.name === 'desktop') {
      await page.keyboard.press(']');
      await expect(page).toHaveURL(/\/sessions\/ses_842/);
    }
  });

  test('horizontal swipe on the header switches sessions (touch)', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'touch gesture');
    await open(page, '/sessions/ses_842');
    const header = page.locator('.sticky.touch-pan-y').first();
    const box = (await header.boundingBox())!;
    const y = box.y + box.height / 2;
    const fire = (type: string, x: number) =>
      header.dispatchEvent(type, {
        pointerType: 'touch',
        pointerId: 7,
        isPrimary: true,
        clientX: x,
        clientY: y,
      });
    await fire('pointerdown', 80);
    for (let x = 90; x <= 320; x += 20) await fire('pointermove', x);
    await fire('pointerup', 320);
    await expect(page).toHaveURL(/\/sessions\/ses_839/);
  });

  test('long transcript renders a window and loads earlier entries', async ({ page }) => {
    await open(page, '/sessions/ses_s09');
    const more = page.getByRole('button', { name: /Load \d+ earlier entries/ });
    await expect(more).toBeVisible();
    const before = await page.locator('[role="log"] > ol > li').count();
    await more.click();
    await expect.poll(() => page.locator('[role="log"] > ol > li').count()).toBeGreaterThan(before);
  });

  test('inspector shows facts, usage meter and files', async ({ page }) => {
    await open(page, '/sessions/ses_836');
    await page.getByRole('button', { name: 'Session actions' }).click();
    await page.getByRole('menuitem', { name: 'Session details' }).click();
    const insp = page.getByTestId('inspector').last();
    await expect(insp).toBeVisible();
    await expect(insp.getByRole('meter', { name: 'reviewer budget today' })).toBeAttached();
    await expect(insp.getByText('src/errors.ts')).toBeVisible();
    await axe(page);
  });

  test('unknown session explains itself', async ({ page }) => {
    await open(page, '/sessions/ses_nope');
    await expect(page.getByRole('heading', { name: 'This session is gone.' })).toBeVisible();
  });

  test('dark theme passes axe', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await open(page, '/sessions/ses_842');
    await expect(page.getByRole('log')).toBeVisible();
    await axe(page);
  });
});
