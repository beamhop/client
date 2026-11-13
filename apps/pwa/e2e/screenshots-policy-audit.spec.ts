/**
 * Extra review screenshots for Policy and Audit (dark theme, learning triage, review sheet) →
 * apps/pwa/screenshots/{mobile,desktop}/. Same conventions as screenshots.spec.ts.
 */
import { expect, type Page, test } from '@playwright/test';

const shot = async (page: Page, path: string, name: string, act?: (p: Page) => Promise<void>) => {
  const sep = path.includes('?') ? '&' : '?';
  await page.goto(`${path}${sep}mock=1&still=1`);
  await expect(page.locator('#bh-main-content').first()).toBeVisible();
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
  if (act) await act(page);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `screenshots/${test.info().project.name}/${name}.png` });
};

test('screenshot policy + audit extras', async ({ page }) => {
  await shot(page, '/policy/helpdesk', 'policy_helpdesk_learning', async (p) => {
    await p.getByRole('list', { name: 'Logged requests to review' }).scrollIntoViewIfNeeded();
  });
  await shot(page, '/policy/reviewer', 'policy_reviewer_review', async (p) => {
    const input = p.getByRole('textbox', { name: 'Add host' });
    await input.fill('https://pypi.org/simple');
    await input.press('Enter');
    await p.getByRole('button', { name: 'Review', exact: true }).click();
  });
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, '/policy/reviewer', 'policy_reviewer-dark');
  await shot(page, '/audit', 'audit-dark');
  await shot(page, '/audit?tab=security', 'audit_tab_security-dark');
});
