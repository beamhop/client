/**
 * Coverage for Inbox and Conversations features the journey specs (inbox.spec.ts, sessions.spec.ts) don't
 * reach: burst banner, filter chips, recently decided, detail links, gone requests, expired ghosts, access
 * "Ignore", learning "Keep blocked", reason sheet free text / skip, stack paging, batch select / allow, K / A
 * keys, error states, "Add rule & allow", the offline queue flush; session actions menu, steer, slash
 * commands, message actions, jump pill, inspector copy, PR link, list empty / error / Today, placeholder and
 * row menu. Mock daemon with frozen timers (`still=1`); state is poked through `__beamhop.mock` for setup only.
 */
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { open, rpc } from './helpers.ts';

type Approval = { id: string; status: string; agent: string; tool: string; sessionId: string };
type Agent = { config: { name: string }; status: string };
type Session = { id: string; status: string };

const toasts = (page: Page) => page.getByRole('region', { name: 'Notifications' });

/** Run `fn` against the in-page mock daemon, then refetch every query so the UI reflects it. */
const mock = async (page: Page, fn: string) => {
  await page.evaluate(async (src) => {
    const w = window as unknown as {
      __beamhop: {
        mock: { daemon: unknown };
        runtime: { queryClient: { invalidateQueries: () => Promise<void> } };
      };
    };
    const d = w.__beamhop.mock.daemon;
    new Function('d', src)(d);
    await w.__beamhop.runtime.queryClient.invalidateQueries();
  }, fn);
};

const approval = async (page: Page, id: string) =>
  (await rpc<{ approvals: Approval[] }>(page, 'approval.list', { status: 'all' })).approvals.find(
    (a) => a.id === id,
  );

const agentStatus = async (page: Page, name: string) =>
  (await rpc<{ agents: Agent[] }>(page, 'agent.list')).agents.find((a) => a.config.name === name)?.status;

const sessionStatus = async (page: Page, id: string) =>
  (await rpc<{ sessions: Session[] }>(page, 'session.list')).sessions.find((s) => s.id === id)?.status;

const grantClipboard = (context: BrowserContext) =>
  context.grantPermissions(['clipboard-read', 'clipboard-write']);
const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());

/** Focus the page body so single-letter shortcuts reach the window listener. */
const focusBody = (page: Page) => page.locator('body').click({ position: { x: 5, y: 400 } });

// ═══════════════════════════ Inbox ═══════════════════════════

test.describe('inbox coverage', () => {
  test('burst banner: "Stop {agent}" stops the agent', async ({ page }) => {
    await open(page, '/inbox');
    // ci-bot has 4 pending in the seed; 17 more makes 21 (> 20) → burst.
    await mock(
      page,
      `const base = d.state.approvals.get('apr_b72c');
       for (let i = 0; i < 17; i++)
         d.putApproval({ ...base, id: 'apr_burst' + i, input: { host: 'h' + i + '.example.com' },
           expiresAt: new Date(Date.now() + (20 + i) * 60000).toISOString() }, true);`,
    );
    await expect(page.getByText(/ci-bot sent 21 requests/)).toBeVisible();
    await page.getByRole('button', { name: 'Stop ci-bot' }).click();
    await expect.poll(() => agentStatus(page, 'ci-bot')).toBe('stopped');
  });

  test('"Filter approvals" chips narrow the triage list', async ({ page }, info) => {
    await open(page, '/inbox');
    const chips = page.getByRole('radiogroup', { name: 'Filter approvals' });
    await expect(chips.getByRole('radio', { name: /^All/ })).toBeChecked();
    await chips.getByRole('radio', { name: /^High risk/ }).click();
    await expect(chips.getByRole('radio', { name: /^High risk/ })).toBeChecked();
    if (info.project.name === 'desktop') {
      await expect(
        page.getByRole('link', { name: /reviewer\s*·?\s*git push origin beamhop\/842/ }),
      ).toBeVisible();
      await expect(page.getByRole('link', { name: /helpdesk/ })).toHaveCount(0);
    } else {
      await expect(page.getByText('1 of 2')).toBeVisible();
    }
    await chips.getByRole('radio', { name: /^helpdesk/ }).click();
    if (info.project.name === 'desktop') {
      await expect(page.getByRole('link', { name: /reviewer\s*·?\s*git push/ })).toHaveCount(0);
      await expect(page.getByRole('link', { name: /helpdesk/ }).first()).toBeVisible();
    } else {
      await expect(page.getByRole('group', { name: /helpdesk/ }).first()).toBeVisible();
      await expect(page.getByText('1 of 2')).toBeVisible();
    }
  });

  test('"Decided recently (24 h)" expands and its rows open the decided request', async ({ page }) => {
    await open(page, '/inbox');
    const toggle = page.getByRole('button', { name: /Decided recently \(24 h\) · 4/ });
    await toggle.scrollIntoViewIfNeeded();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const recent = page.getByRole('region', { name: /Decided recently/ });
    await expect(recent.getByRole('link')).toHaveCount(4);
    await expect(recent.getByText('fetch status.acme.dev')).toBeVisible();
    await recent.getByRole('link', { name: /git push origin beamhop\/839/ }).click();
    await expect(page).toHaveURL(/\/inbox\/apr_9f20/);
    await expect(page.getByText(/^Allowed by .+ · /).first()).toBeVisible();
  });

  test('detail: "Open session" goes to the conversation', async ({ page }) => {
    await open(page, '/inbox/apr_a41f');
    await page.getByRole('link', { name: 'Open session' }).click();
    await expect(page).toHaveURL(/\/sessions\/ses_842/);
  });

  test('detail: "Edit policy" goes to Policy', async ({ page }) => {
    await open(page, '/inbox/apr_a41f');
    await page.getByRole('link', { name: 'Edit policy' }).click();
    await expect(page).toHaveURL(/\/policy/);
  });

  test('missing request explains itself and links back to the Inbox', async ({ page }) => {
    await open(page, '/inbox/apr_nope');
    await expect(page.getByRole('heading', { name: 'This request is gone.' })).toBeVisible();
    // The header back button has the same name; the empty state's action is the last one.
    await page.getByRole('link', { name: 'Back to Inbox' }).last().click();
    await expect(page).not.toHaveURL(/apr_nope/);
    await expect(page).toHaveURL(/\/inbox/);
  });

  test('"Just changed" ghost after an auto-deny, then Dismiss', async ({ page }) => {
    await open(page, '/inbox');
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: /pending/i })
        .first(),
    ).toContainText('05');
    await page.evaluate(() => {
      const d = (
        window as unknown as {
          __beamhop: {
            mock: {
              daemon: {
                state: { approvals: Map<string, Record<string, unknown>> };
                putApproval: (a: unknown) => void;
              };
            };
          };
        }
      ).__beamhop.mock.daemon;
      const a = d.state.approvals.get('apr_c09e')!;
      d.putApproval({ ...a, status: 'expired', decidedAt: new Date().toISOString() });
    });
    const ghosts = page.getByRole('list', { name: 'Just changed' });
    await expect(ghosts.getByText(/Auto-denied at .* — the agent was told\./)).toBeVisible();
    await expect(ghosts.getByText('~/docs/public/faq/api-keys.md')).toBeVisible();
    await ghosts.getByRole('button', { name: 'Dismiss' }).click();
    await expect(ghosts).toHaveCount(0);
  });

  test('access request: Ignore denies it', async ({ page }) => {
    await open(page, '/inbox/apr_d3e1');
    await page.getByRole('button', { name: /^Ignore: helpdesk/ }).click();
    await expect(toasts(page).getByText(/Denied/)).toBeVisible();
    await expect.poll(async () => (await approval(page, 'apr_d3e1'))?.status).toBe('denied');
  });

  test('learning card: "Keep blocked" applies after the undo window', async ({ page }) => {
    await open(page, '/inbox');
    const card = page.getByRole('group', { name: /Suggestion: helpdesk tried to reach pypi\.org/ });
    await card.scrollIntoViewIfNeeded();
    await card.getByRole('button', { name: 'Keep blocked: pypi.org' }).click();
    await expect(toasts(page).getByText(/Kept blocked · pypi\.org/)).toBeVisible();
    await expect(
      page.getByRole('group', { name: /Suggestion: helpdesk tried to reach pypi\.org/ }),
    ).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (await rpc<{ suggestions: Array<{ id: string }> }>(page, 'policy.suggestions')).suggestions.map(
            (s) => s.id,
          ),
        { timeout: 10_000 },
      )
      .not.toContain('sug_pypi');
  });

  test('deny reason sheet: "Or write your own" → "Send reason"', async ({ page }) => {
    await open(page, '/inbox/apr_a41f');
    await page.getByRole('button', { name: /^Deny: reviewer/ }).click();
    await toasts(page).getByRole('button', { name: 'Add reason' }).click();
    const sheet = page.getByRole('dialog', { name: 'Tell the agent why' });
    const send = sheet.getByRole('button', { name: 'Send reason' });
    await expect(send).toBeDisabled();
    await sheet.getByRole('textbox', { name: 'Or write your own' }).fill('push from CI instead');
    await send.click();
    await expect(sheet).toBeHidden();
    await expect(toasts(page).getByText(/Denied with reason/)).toBeVisible();
    // The reason reaches the daemon (audit line after the commit window).
    await expect
      .poll(
        async () =>
          (await rpc<{ events: Array<{ summary: string }> }>(page, 'audit.query', { limit: 20 })).events.some(
            (e) => e.summary.includes('push from CI instead'),
          ),
        { timeout: 10_000 },
      )
      .toBe(true);
  });

  test('deny reason sheet: Skip closes it and keeps the plain deny', async ({ page }) => {
    await open(page, '/inbox/apr_a41f');
    await page.getByRole('button', { name: /^Deny: reviewer/ }).click();
    await toasts(page).getByRole('button', { name: 'Add reason' }).click();
    const sheet = page.getByRole('dialog', { name: 'Tell the agent why' });
    await sheet.getByRole('button', { name: 'Skip' }).click();
    await expect(sheet).toBeHidden();
    await expect(toasts(page).getByText(/Denied with reason/)).toHaveCount(0);
    expect((await approval(page, 'apr_a41f'))?.status).toBe('denied');
  });

  test('stack paging: Next / Previous request (mobile)', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'stack is compact-only');
    await open(page, '/inbox');
    await expect(page.getByText('1 of 5')).toBeVisible();
    const prev = page.getByRole('button', { name: /^Previous request/ });
    const next = page.getByRole('button', { name: /^Next request/ });
    await expect(prev).toBeDisabled();
    await next.click();
    await expect(page.getByText('2 of 5')).toBeVisible();
    await expect(
      page.getByRole('group', { name: /^Approval from reviewer: Run a shell command/ }),
    ).toBeVisible();
    await prev.click();
    await expect(page.getByText('1 of 5')).toBeVisible();
    await expect(page.getByRole('group', { name: /^Approval from ci-bot/ })).toBeVisible();
  });

  test('batch: Select all, Clear (desktop)', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'batch actions are desktop-only');
    await open(page, '/inbox');
    await page.getByRole('button', { name: 'Select all' }).click();
    await expect(page.getByText('5 selected')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Select none' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Allow 5 once' })).toBeDisabled();
    await expect(page.getByText(/batch allow is off/)).toBeVisible();
    await page.getByRole('button', { name: 'Clear' }).click();
    await expect(page.getByText(/selected$/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Select all' })).toBeVisible();
  });

  test('batch: "Allow 1 once" on a low-risk request (desktop)', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'batch actions are desktop-only');
    await open(page, '/inbox');
    await page.getByRole('checkbox', { name: /Select helpdesk, ~\/docs/ }).check({ force: true });
    await expect(page.getByText('1 selected')).toBeVisible();
    const allow = page.getByRole('button', { name: 'Allow 1 once' });
    await expect(allow).toBeEnabled();
    await allow.click();
    await expect(toasts(page).getByText(/Allowed once/)).toBeVisible();
    await expect.poll(async () => (await approval(page, 'apr_c09e'))?.status).toBe('approved');
  });

  test('keys: K moves back, A allows a low-risk request (desktop)', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'hardware keyboard');
    await open(page, '/inbox');
    await expect(page).toHaveURL(/apr_b72c/);
    await focusBody(page);
    await page.keyboard.press('j');
    await expect(page).toHaveURL(/apr_a41f/);
    await page.keyboard.press('k');
    await expect(page).toHaveURL(/apr_b72c/);
    await page.keyboard.press('j');
    await page.keyboard.press('j');
    await expect(page).toHaveURL(/apr_c09e/);
    await focusBody(page);
    await page.keyboard.press('a');
    await expect(toasts(page).getByText(/Allowed once/)).toBeVisible();
    await expect.poll(async () => (await approval(page, 'apr_c09e'))?.status).toBe('approved');
  });

  test('error state when approvals fail to load', async ({ page }) => {
    await open(page, '/inbox?mockFail=approval.list');
    await expect(page.getByText("Couldn't load approvals.").first()).toBeVisible();
  });

  test('"Add rule & allow" adds the rule and allows', async ({ page }) => {
    await open(page, '/inbox/apr_a41f');
    await page.getByRole('button', { name: /^Allow… \(choose scope\): reviewer/ }).click();
    const sheet = page.getByRole('dialog', { name: 'Allow git push?' });
    await sheet.getByText(/Always allow for user on reviewer/).click();
    await sheet.getByRole('button', { name: 'Add rule & allow' }).click();
    await expect(sheet).toBeHidden();
    await expect(toasts(page).getByText(/Rule added & allowed/)).toBeVisible();
    await expect.poll(async () => (await approval(page, 'apr_a41f'))?.status).toBe('approved');
    await expect
      .poll(
        async () =>
          (await rpc<{ events: Array<{ summary: string }> }>(page, 'audit.query', { limit: 20 })).events.some(
            (e) => /always allowed/.test(e.summary),
          ),
        { timeout: 10_000 },
      )
      .toBe(true);
  });

  test('offline queue: a queued decision is sent when back online', async ({ page, context }) => {
    await open(page, '/inbox');
    await expect(
      page.getByRole('button', { name: /^Deny: ci-bot, registry\.npmjs\.org/ }).first(),
    ).toBeVisible();
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await expect(page.getByText(/^Offline\. Decisions you make now are queued/)).toBeVisible();
    await page
      .getByRole('button', { name: /^Deny: ci-bot, registry\.npmjs\.org/ })
      .first()
      .click();
    await expect(toasts(page).getByText(/queued, sends when online/)).toBeVisible();
    await expect(page.getByRole('region', { name: /^Queued/ })).toBeVisible();
    expect((await approval(page, 'apr_b72c'))?.status).toBe('pending');
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(toasts(page).getByText('Sent 1 queued decision.')).toBeVisible();
    await expect.poll(async () => (await approval(page, 'apr_b72c'))?.status).toBe('denied');
    await expect(page.getByRole('region', { name: /^Queued/ })).toHaveCount(0);
  });
});

// ═══════════════════════════ Conversations ═══════════════════════════

const sessionMenu = async (page: Page, item: string | RegExp) => {
  await page.getByRole('button', { name: 'Session actions' }).click();
  await page.getByRole('menuitem', { name: item }).click();
};

test.describe('session view coverage', () => {
  test('Session actions → "Copy session link"', async ({ page, context }) => {
    await grantClipboard(context);
    await open(page, '/sessions/ses_842');
    await sessionMenu(page, 'Copy session link');
    await expect(toasts(page).getByText('Session link copied')).toBeVisible();
    expect(await clipboard(page)).toBe(`${new URL(page.url()).origin}/sessions/ses_842`);
  });

  test('Session actions → "Export transcript (JSONL)" downloads the events', async ({ page }) => {
    await open(page, '/sessions/ses_842');
    await expect(page.getByRole('log')).toBeVisible();
    const download = page.waitForEvent('download');
    await sessionMenu(page, 'Export transcript (JSONL)');
    const d = await download;
    expect(d.suggestedFilename()).toBe('ses_842.jsonl');
    const path = await d.path();
    const { readFileSync } = await import('node:fs');
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    const first = JSON.parse(lines[0]!) as { seq: number; kind: string };
    expect(first.seq).toBe(1);
    expect(first.kind).toBe('user');
    expect(lines.length).toBeGreaterThan(5);
  });

  test('Session actions → expand / collapse all tool calls', async ({ page }) => {
    await open(page, '/sessions/ses_842');
    const tool = page.getByRole('log').getByRole('button', { name: /^Edit 2 files/ });
    await expect(tool).toHaveAttribute('aria-expanded', 'false');
    await sessionMenu(page, 'Expand all tool calls');
    await expect(tool).toHaveAttribute('aria-expanded', 'true');
    await sessionMenu(page, 'Collapse all tool calls');
    await expect(tool).toHaveAttribute('aria-expanded', 'false');
  });

  test('Session actions → "New session" starts one with the agent', async ({ page }) => {
    await open(page, '/sessions/ses_842');
    await sessionMenu(page, 'New session');
    const sheet = page.getByRole('dialog', { name: 'New session' });
    await expect(sheet).toBeVisible();
    await sheet.getByRole('textbox', { name: 'What should reviewer do?' }).fill('add a CHANGELOG entry');
    await sheet.getByRole('button', { name: 'Start session with reviewer' }).click();
    await expect(page).not.toHaveURL(/ses_842/);
    await expect(page).toHaveURL(/\/sessions\/ses_/);
    await expect(page.getByRole('log').getByText('add a CHANGELOG entry')).toBeVisible();
  });

  test('Session actions → "Stop {agent} hard…" confirms and stops the agent', async ({ page }) => {
    await open(page, '/sessions/ses_842');
    await sessionMenu(page, 'Stop reviewer hard…');
    const dialog = page.getByRole('alertdialog', { name: 'Stop reviewer hard?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Stop reviewer' }).click();
    await expect(dialog).toBeHidden();
    await expect(toasts(page).getByText('reviewer stopped')).toBeVisible();
    await expect.poll(() => agentStatus(page, 'reviewer')).toBe('stopped');
    expect(await sessionStatus(page, 'ses_842')).toBe('ended');
  });

  test('steer while working sends the message as the next turn', async ({ page }) => {
    await open(page, '/sessions/ses_842');
    const box = page.getByRole('textbox', { name: 'Steer reviewer' });
    await box.fill('also add a test for //evil.com');
    await expect(page.getByText("Steer · queued as reviewer's next turn")).toBeVisible();
    await page.getByRole('button', { name: 'Send steer message' }).click();
    await expect(page.getByRole('log').getByText('also add a test for //evil.com')).toBeVisible();
    await expect(box).toHaveValue('');
    await expect
      .poll(async () => {
        const { events } = await rpc<{ events: Array<{ kind: string; text?: string }> }>(
          page,
          'session.events',
          {
            id: 'ses_842',
            afterSeq: 0,
          },
        );
        return events.some((e) => e.kind === 'user' && e.text === 'also add a test for //evil.com');
      })
      .toBe(true);
  });

  test('composer "Stop {agent}" stops the live session', async ({ page }) => {
    await open(page, '/sessions/ses_842');
    const composerStop = page.getByRole('button', { name: 'Stop reviewer' });
    await expect(composerStop).toHaveCount(1);
    await composerStop.click();
    await expect(toasts(page).getByText('Stopped reviewer · thread 842')).toBeVisible();
    await expect.poll(() => sessionStatus(page, 'ses_842')).toBe('ended');
    await expect(page.getByRole('textbox', { name: 'Message reviewer' })).toBeVisible();
    await expect(composerStop).toHaveCount(0);
  });

  test('slash /stop stops the session', async ({ page }) => {
    await open(page, '/sessions/ses_842');
    const box = page.getByRole('textbox', { name: 'Steer reviewer' });
    await box.fill('/stop');
    await expect(page.getByRole('group', { name: 'Slash commands' })).toContainText('Stop this session');
    await box.press('Enter');
    await expect(toasts(page).getByText('Stopped reviewer · thread 842')).toBeVisible();
    await expect.poll(() => sessionStatus(page, 'ses_842')).toBe('ended');
  });

  test('slash /new opens the new-session sheet', async ({ page }) => {
    await open(page, '/sessions/ses_d17');
    const box = page.getByRole('textbox', { name: 'Message ci-bot' });
    await box.fill('/new');
    await box.press('Enter');
    await expect(page.getByRole('dialog', { name: 'New session' })).toBeVisible();
    await expect(box).toHaveValue('');
  });

  test('slash /usage opens the session details', async ({ page }) => {
    await open(page, '/sessions/ses_d17');
    const box = page.getByRole('textbox', { name: 'Message ci-bot' });
    await box.fill('/usage');
    await box.press('Enter');
    const insp = page.getByTestId('inspector').last();
    await expect(insp).toBeVisible();
    await expect(insp.getByRole('meter', { name: 'ci-bot budget today' })).toBeAttached();
  });

  test('slash /status shows a status toast', async ({ page }) => {
    await open(page, '/sessions/ses_d17');
    const box = page.getByRole('textbox', { name: 'Message ci-bot' });
    await box.fill('/status');
    await box.press('Enter');
    await expect(toasts(page).getByText(/^ci-bot · idle · \$0\.22 · /)).toBeVisible();
    await expect(box).toHaveValue('');
  });

  test('message actions: Copy text and Quote in composer', async ({ page, context }) => {
    await grantClipboard(context);
    await open(page, '/sessions/ses_d17');
    const log = page.getByRole('log');
    await log.getByRole('button', { name: 'Message actions for Bob' }).click();
    await page.getByRole('menuitem', { name: 'Copy text' }).click();
    expect(await clipboard(page)).toBe('@ci-bot deploy staging after #211 merges');
    await log.getByRole('button', { name: 'Message actions for ci-bot' }).first().click();
    await page.getByRole('menuitem', { name: 'Quote in composer' }).click();
    const box = page.getByRole('textbox', { name: 'Message ci-bot' });
    await expect(box).toHaveValue(/^> Watching #211\. I'll deploy staging when it merges/);
    await expect(box).toBeFocused();
  });

  test('jump pill: "Latest" after scrolling up, "1 new" when something arrives', async ({ page }) => {
    await open(page, '/sessions/ses_s09');
    const log = page.getByRole('log');
    await expect(log).toBeVisible();
    await page.waitForTimeout(300); // initial scroll-to-bottom runs on the next frame
    // Read upwards in a few steps (the pane scroller on desktop, the window on mobile).
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => {
        const sc = document.querySelector('[role="log"]')?.closest('[data-scroll-root]');
        if (sc) sc.scrollBy(0, -600);
        else window.scrollBy(0, -600);
      });
      await page.waitForTimeout(50);
    }
    const latest = page.getByRole('button', { name: 'Latest' });
    await expect(latest).toBeVisible();
    await page.evaluate(() => {
      const d = (
        window as unknown as {
          __beamhop: { mock: { daemon: { pushEvent: (id: string, e: unknown) => void } } };
        }
      ).__beamhop.mock.daemon;
      d.pushEvent('ses_s09', { kind: 'assistant', text: 'One more thing: the todo list is saved.' });
    });
    const fresh = page.getByRole('button', { name: '1 new' });
    await expect(fresh).toBeVisible();
    await fresh.click();
    await expect(fresh).toBeHidden();
    await expect(log.getByText('One more thing: the todo list is saved.')).toBeInViewport();
  });

  test('inspector: "Copy worktree path"', async ({ page, context }) => {
    await grantClipboard(context);
    await open(page, '/sessions/ses_836');
    await sessionMenu(page, 'Session details');
    const insp = page.getByTestId('inspector').last();
    await insp.getByRole('button', { name: 'Copy worktree path' }).click();
    await expect(insp.getByRole('button', { name: 'Copied' })).toBeVisible();
    expect(await clipboard(page)).toBe('~/.beamhop/worktrees/app/beamhop-836');
  });

  test('worktree: after the push is allowed, "Open the pull request" links to the compare URL', async ({
    page,
  }) => {
    await open(page, '/sessions/ses_836');
    await page.getByRole('button', { name: 'Open PR' }).first().click();
    await expect(page.getByText('Pushing beamhop/836 is waiting for approval.').first()).toBeVisible();
    const list = await rpc<{ approvals: Approval[] }>(page, 'approval.list', { status: 'pending' });
    const push = list.approvals.find((a) => a.tool === 'git.push' && a.sessionId === 'ses_836')!;
    await rpc(page, 'approval.decide', { id: push.id, allow: true });
    await expect(page.getByText(/Pushed beamhop\/836\./).first()).toBeVisible();
    const link = page.getByRole('link', { name: 'Open the pull request' }).first();
    await expect(link).toHaveAttribute(
      'href',
      'https://github.com/acme/app/compare/main...beamhop%2F836?expand=1',
    );
  });

  test('"Couldn\'t load this session." when the session list fails', async ({ page }) => {
    await open(page, '/sessions/ses_842?mockFail=session.list');
    await expect(page.getByText("Couldn't load this session.").first()).toBeVisible();
  });

  test('"Couldn\'t load the transcript." when events fail', async ({ page }) => {
    await open(page, '/sessions/ses_842?mockFail=session.events');
    await expect(page.getByText("Couldn't load the transcript.").first()).toBeVisible();
  });
});

test.describe('sessions list coverage', () => {
  test('"No sessions yet." when the daemon has none', async ({ page }) => {
    await open(page, '/sessions');
    await expect(page.getByRole('heading', { name: /reviewer\s*· 4/i })).toBeVisible();
    await mock(page, 'd.state.sessions.clear(); d.state.events.clear();');
    await expect(page.getByRole('heading', { name: 'No sessions yet.' })).toBeVisible();
    await page.getByRole('button', { name: 'New session' }).last().click();
    await expect(page.getByRole('dialog', { name: 'New session' })).toBeVisible();
  });

  test('"Couldn\'t load sessions." when the list fails', async ({ page }) => {
    await open(page, '/sessions?mockFail=session.list');
    await expect(page.getByText("Couldn't load sessions.").first()).toBeVisible();
  });

  test('"Today" filter hides older sessions', async ({ page }) => {
    await open(page, '/sessions');
    await page.getByRole('radio', { name: /^Today, \d+$/ }).click();
    await expect(page.getByRole('radio', { name: /^Today, \d+$/ })).toBeChecked();
    const rows = page.getByRole('list', { name: 'Sessions of reviewer' });
    await expect(rows.getByRole('link', { name: /can you fix the login redirect/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /turn my meeting notes into a todo list/ })).toHaveCount(0);
  });

  test('desktop placeholder: "Pick a session" lists what needs attention', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'split view is desktop-only');
    await open(page, '/sessions');
    await expect(page.getByRole('heading', { name: 'Pick a session' })).toBeVisible();
    const attention = page.getByRole('list', { name: 'Live and waiting on you' });
    await attention.getByRole('link', { name: /can you fix the login redirect/ }).click();
    await expect(page).toHaveURL(/\/sessions\/ses_842/);
  });

  test('row menu: "New session with {agent}" preselects the agent', async ({ page }) => {
    await open(page, '/sessions');
    await page.getByRole('button', { name: /Actions for deploy staging after #211 merges/ }).click();
    await page.getByRole('menuitem', { name: 'New session with ci-bot' }).click();
    const sheet = page.getByRole('dialog', { name: 'New session' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Start session with ci-bot' })).toBeVisible();
    await expect(sheet.getByRole('textbox', { name: 'What should ci-bot do?' })).toBeVisible();
  });

  test('row menu: "Copy session link"', async ({ page, context }) => {
    await grantClipboard(context);
    await open(page, '/sessions');
    await page.getByRole('button', { name: /Actions for review PR #211/ }).click();
    await page.getByRole('menuitem', { name: 'Copy session link' }).click();
    await expect.poll(() => clipboard(page)).toBe(`${new URL(page.url()).origin}/sessions/ses_839`);
  });
});
