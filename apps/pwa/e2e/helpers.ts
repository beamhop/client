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
/**
 * Wait until nothing is mid-animation: sheets and dialogs fade in, and axe measuring colour contrast on a
 * half-transparent dialog reports failures that no user ever sees.
 */
export const settle = async (page: Page) => {
  await page
    .waitForFunction(
      () => {
        const running = document
          .getAnimations()
          .some((a) => a.playState === 'running' && a.effect?.getComputedTiming().iterations !== Infinity);
        if (running) return false;
        for (const d of document.querySelectorAll('[role="dialog"], [role="alertdialog"]')) {
          for (let el: Element | null = d; el; el = el.parentElement)
            if (Number(getComputedStyle(el).opacity) < 1) return false;
          const t = getComputedStyle(d).transform;
          if (t && t !== 'none' && t !== 'matrix(1, 0, 0, 1, 0, 0)') return false;
        }
        return true;
      },
      null,
      { timeout: 4000, polling: 50 },
    )
    .catch(() => {});
};

export const expectAccessible = async (page: Page) => {
  await settle(page);
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    bad.map(
      (v) =>
        `${v.id}: ${v.nodes
          .map((n) => n.target.join(' '))
          .slice(0, 3)
          .join(' | ')}`,
    ),
  ).toEqual([]);
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
