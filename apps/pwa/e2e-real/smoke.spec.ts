/**
 * Every screen against real daemon data: loads without errors (no page errors, no failed RPCs logged,
 * no error state), axe has no serious/critical findings and nothing scrolls sideways.
 * The daemon is seeded and has one finished session, so detail routes have something to show.
 */
import { axe, expect, test, watchErrors } from './fixtures.ts';

const ROUTES = [
  '/',
  '/inbox',
  '/sessions',
  '/sessions/:session',
  '/agents',
  '/agents/bot',
  '/agents/bot/setup',
  '/agents/bot/sandbox',
  '/agents/bot/channels',
  '/agents/bot/schedules',
  '/agents/bot/budgets',
  '/agents/bot/identity',
  '/agents/new',
  '/channels',
  '/channels/fk',
  '/channels/add',
  '/harnesses',
  '/policy',
  '/policy/workspace',
  '/policy/bot',
  '/policy/roles',
  '/deploy',
  '/audit',
  '/audit?tab=security',
  '/audit?tab=log',
  '/settings',
  '/settings/appearance',
  '/settings/devices',
  '/setup/doctor',
  '/panic',
  '/more',
];

/** Console noise that is not an app failure (Playwright blocks service workers in this suite). */
const IGNORED = [/Service Worker registration blocked/, /service worker registration failed/];

for (const route of ROUTES) {
  test(`real data: ${route}`, async ({ page, bh }) => {
    await bh.inject({ text: 'hello' });
    await expect.poll(async () => (await bh.sentTo('alice')).join('\n')).toContain('reply: hello');
    const { sessions } = await bh.rpc<{ sessions: { id: string }[] }>('session.list');
    const path = route.replace(':session', sessions[0]!.id);
    const errors = watchErrors(page);
    await bh.open(page, path);
    await page.waitForTimeout(800);
    await expect(page.getByRole('heading', { name: /didn't load|couldn't load|not found/i })).toHaveCount(0);
    await axe(page);
    expect(errors.filter((e) => !IGNORED.some((r) => r.test(e)))).toEqual([]);
  });
}
