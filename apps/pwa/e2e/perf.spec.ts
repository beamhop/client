/**
 * Lighthouse-style load checks on the production build: Largest Contentful Paint and Cumulative
 * Layout Shift on Home and Inbox, with the CPU slowed 4× (mid-range phone) on the mobile project.
 * Budgets: LCP < 2.5 s ("good"), CLS < 0.1 ("good"). Prints the numbers for the record.
 */
import { expect, test } from '@playwright/test';

const measure = () =>
  new Promise<{ lcp: number; cls: number }>((resolve) => {
    let lcp = 0;
    let cls = 0;
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) lcp = Math.max(lcp, e.startTime);
    }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((l) => {
      for (const e of l.getEntries() as Array<PerformanceEntry & { value: number; hadRecentInput: boolean }>)
        if (!e.hadRecentInput) cls += e.value;
    }).observe({ type: 'layout-shift', buffered: true });
    // Let the demo data land and fonts swap in before reading.
    setTimeout(() => resolve({ lcp, cls }), 2500);
  });

for (const path of ['/', '/inbox', '/sessions/ses_842']) {
  test(`load budget ${path}`, async ({ page, browserName }, info) => {
    test.skip(browserName !== 'chromium', 'CDP throttling');
    if (info.project.name === 'mobile') {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    }
    await page.goto(`${path}?mock=1&still=1`);
    await expect(page.locator('#bh-main-content').first()).toBeVisible();
    const { lcp, cls } = await page.evaluate(measure);
    console.log(`[perf] ${info.project.name} ${path}: LCP ${Math.round(lcp)} ms · CLS ${cls.toFixed(3)}`);
    expect(lcp).toBeLessThan(2500);
    expect(cls).toBeLessThan(0.1);
  });
}
