/** Shared e2e helpers for the deploy / settings / onboarding / pair specs. */
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

export const open = async (page: Page, path: string) => {
  const [p, hash] = path.split('#');
  const sep = p!.includes('?') ? '&' : '?';
  await page.goto(`${p}${sep}mock=1&still=1${hash ? `#${hash}` : ''}`);
  await expect(page.locator('#bh-main-content').first()).toBeVisible();
};

/** axe (serious/critical) on whatever is on screen now, e.g. with a sheet open. */
export const expectAccessible = async (page: Page) => {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    // react-aria's LiveAnnouncer keeps a transient node whose label may already have unmounted.
    .exclude('div[role="log"][aria-live] > div[role="img"]')
    .analyze();
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([]);
};

/** Call the in-browser mock daemon directly (setup for a test, never the thing under test). */
export const rpc = <T>(page: Page, method: string, params: unknown = {}) =>
  page.evaluate(
    async ([m, p]) => {
      const w = window as unknown as {
        __beamhop: { runtime: { client: { call: (m: string, p?: unknown) => Promise<unknown> } } };
      };
      return w.__beamhop.runtime.client.call(m as string, p);
    },
    [method, params] as const,
  ) as Promise<T>;
