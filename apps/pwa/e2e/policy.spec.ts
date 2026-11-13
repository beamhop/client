/**
 * Policy journeys (JOURNEYS §5): read reach at a glance, widen deliberately with a reviewed diff,
 * switch profiles with consequences first, triage learning-mode suggestions, fix a finding, roles table.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

const open = async (page: Page, path: string) => {
  const sep = path.includes('?') ? '&' : '?';
  await page.goto(`${path}${sep}mock=1&still=1`);
  await expect(page.locator('#bh-main-content').first()).toBeVisible();
};

const axe = async (page: Page) => {
  const r = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    bad.map(
      (v) =>
        `${v.id}: ${v.nodes
          .map((n) => `${n.target.join(' ')} ${n.html.slice(0, 160)}`)
          .slice(0, 3)
          .join(' | ')}`,
    ),
  ).toEqual([]);
};

const main = (page: Page) => page.locator('#bh-main-content').last();

test('reach answers "can it read ~/.ssh?" and "which hosts?" at a glance', async ({ page }) => {
  await open(page, '/policy/reviewer');
  const reach = main(page).locator('dl').first();
  await expect(reach.getByRole('list', { name: 'Always blocked' })).toContainText('~/.ssh');
  await expect(reach.getByRole('list', { name: 'Hosts reviewer can reach' })).toContainText(
    'api.anthropic.com',
  );
  await expect(reach).toContainText('6 hosts');
  await expect(reach).toContainText('ANTHROPIC_API_KEY');
  await axe(page);
});

test('widening needs a review: URL → host, plain-language diff, "Widen access"', async ({ page }) => {
  await open(page, '/policy/reviewer');
  const input = page.getByRole('textbox', { name: 'Add host' });
  await input.fill('169.254.169.254');
  await input.press('Enter');
  await expect(page.getByText(/cloud metadata address/)).toBeVisible();
  await input.fill('https://pypi.org/simple/requests');
  await input.press('Enter');
  await expect(page.getByText('Added pypi.org (from https://pypi.org/simple/requests)')).toBeVisible();
  await expect(page.getByText('1 change')).toBeVisible();
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: "Review reviewer's sandbox" });
  await expect(sheet.getByText('reviewer will also be able to reach pypi.org.')).toBeVisible();
  await sheet.getByRole('tab', { name: 'YAML' }).click();
  await expect(sheet.getByRole('region', { name: /Diff of/ })).toContainText('pypi.org');
  await axe(page);
  await sheet.getByRole('button', { name: 'Widen access' }).click();
  await expect(page.getByRole('region', { name: 'Notifications' }).getByText(/Widened/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review', exact: true })).toHaveCount(0);
  await expect(main(page).locator('dl').first()).toContainText('7 hosts');
});

test('profile switch shows consequences before anything changes; tightening is "Save"', async ({ page }) => {
  await open(page, '/policy/reviewer');
  await page.getByRole('radio', { name: /strict/ }).click({ force: true });
  const sheet = page.getByRole('dialog', { name: 'Switch reviewer to strict?' });
  await expect(sheet.getByText(/~\/code\/app becomes read-only/)).toBeVisible();
  await expect(sheet.getByText('reviewer will no longer reach github.com.')).toBeVisible();
  await sheet.getByRole('button', { name: 'Use strict' }).click();
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  const review = page.getByRole('dialog', { name: "Review reviewer's sandbox" });
  await expect(review.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  await review.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Notifications' }).getByText(/Saved/)).toBeVisible();
});

test('discard restores the saved rules', async ({ page }) => {
  await open(page, '/policy/reviewer');
  await page.getByRole('button', { name: 'Remove github.com' }).click();
  await expect(page.getByText('1 change')).toBeVisible();
  await page.getByRole('button', { name: 'Discard' }).click();
  await expect(page.getByRole('button', { name: 'Remove github.com' })).toBeVisible();
});

test('a finding fix is staged as a change', async ({ page }) => {
  await open(page, '/policy/reviewer');
  await page.getByRole('button', { name: 'Keep only objects.githubusercontent.com' }).click();
  await expect(page.getByText('No findings.')).toBeVisible();
  await expect(page.getByText('1 change')).toBeVisible();
});

test('learning mode: triage suggestions with buttons, locked paths never allowable', async ({ page }) => {
  await open(page, '/policy/helpdesk');
  const list = page.getByRole('list', { name: 'Blocked requests to review' });
  await expect(list.getByRole('group')).toHaveCount(3);
  await list.getByRole('button', { name: 'Allow: pypi.org' }).click();
  await expect(page.getByText(/pypi\.org\s*will be allowed/)).toBeVisible();
  // Scope choice for a subdomain: wildcard only by explicit choice.
  await list.getByRole('radio', { name: '*.npmjs.org' }).click();
  await expect(list.getByText(/Every subdomain of npmjs.org/)).toBeVisible();
  await list.getByRole('button', { name: 'Keep blocked: registry.npmjs.org' }).click();
  await expect(page.getByText(/registry\.npmjs\.org\s*stays blocked/)).toBeVisible();
  await axe(page);
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  const review = page.getByRole('dialog', { name: "Review helpdesk's sandbox" });
  await expect(review.getByText('helpdesk will also be able to reach pypi.org.')).toBeVisible();
  await review.getByRole('button', { name: 'Widen access' }).click();
  await expect(page.getByRole('region', { name: 'Notifications' }).getByText(/Widened/)).toBeVisible();
  await expect(page.getByRole('list', { name: 'Blocked requests to review' }).getByRole('group')).toHaveCount(
    1,
  );
});

test('Allow… from Audit pre-fills the rule; nothing changes until saved', async ({ page }) => {
  await open(page, '/policy/helpdesk?allowHost=files.pythonhosted.org');
  await expect(
    page.getByText('Added files.pythonhosted.org from Audit. Review and save to allow it.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove files.pythonhosted.org' })).toBeVisible();
  await expect(page.getByText('1 change')).toBeVisible();
});

test('roles: what each role can do', async ({ page }, info) => {
  await open(page, '/policy/roles');
  if (info.project.name === 'desktop') {
    const table = page.getByRole('table', { name: 'What each role can do' });
    await expect(table.getByRole('rowheader', { name: 'Run shell commands' })).toBeVisible();
    await expect(table.getByRole('columnheader', { name: 'viewer' })).toBeVisible();
  } else {
    await page.getByRole('button', { name: /^viewer/ }).click();
    await expect(page.getByRole('button', { name: /^viewer/ })).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('dt:visible', { hasText: 'Run shell commands' })).toHaveCount(1);
  }
  await axe(page);
});

test('profiles: list → explainer page', async ({ page }) => {
  await open(page, '/policy');
  await page.getByRole('link', { name: /^strict Read-only/ }).click();
  await expect(page).toHaveURL(/\/policy\/strict/);
  await expect(page.getByText('Every folder is read-only. The agent can look, never change.')).toBeVisible();
  await axe(page);
});

test('error state with retry when the policy cannot load', async ({ page }) => {
  await open(page, '/policy/reviewer?mockFail=policy.get');
  await expect(page.getByRole('alert').getByText("Couldn't load reviewer's sandbox")).toBeVisible();
});
