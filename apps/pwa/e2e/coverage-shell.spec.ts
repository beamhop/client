/**
 * Coverage for the shell, Home, panic, pairing push and More: keyboard chords and hotkeys, the sidebar's
 * own controls, palette actions, the connection sheet (demo and local daemon), route errors, the needs-you
 * panel when empty, Home's card actions / error / first-run states, and the panic review page.
 */
import { expect, type Page, test } from '@playwright/test';
import { expectAccessible, open, rpc } from './helpers.ts';

type Approval = { id: string; status: string; agent: string; expiresAt: string };
type Agent = { config: { name: string }; status: string };

const desktopOnly = (name: string, why = 'desktop chrome / hardware keyboard') =>
  test.skip(name !== 'desktop', why);

const pending = async (page: Page) =>
  (await rpc<{ approvals: Approval[] }>(page, 'approval.list', { status: 'pending' })).approvals.filter(
    (a) => a.status === 'pending',
  );

const decideAll = async (page: Page, ids?: string[]) => {
  for (const a of await pending(page))
    if (!ids || ids.includes(a.id)) await rpc(page, 'approval.decide', { id: a.id, allow: false });
};

const agentStatus = async (page: Page, name: string) =>
  (await rpc<{ agents: Agent[] }>(page, 'agent.list')).agents.find((a) => a.config.name === name)?.status;

const panicked = async (page: Page) => (await rpc<{ panic?: boolean }>(page, 'system.status')).panic ?? false;

/** In-app navigation: the demo daemon lives in the page, so a reload would reset it. */
const navigate = (page: Page, to: string) =>
  page.evaluate(
    (path) =>
      (
        window as unknown as { __beamhop: { router: { navigate: (o: { to: string }) => Promise<void> } } }
      ).__beamhop.router.navigate({ to: path }),
    to,
  );

const palette = (page: Page) => page.getByRole('dialog', { name: 'Command palette' });
const toasts = (page: Page) => page.getByRole('region', { name: 'Notifications' });

const openPalette = async (page: Page) => {
  await page.keyboard.press('Control+k');
  await expect(palette(page)).toBeVisible();
  await expect(palette(page).getByRole('searchbox')).toBeFocused();
};

// ─────────── Shell: hotkeys and chords ───────────

test.describe('shell keyboard', () => {
  test('Ctrl+Shift+. opens the stop sheet; Cancel leaves everything running', async ({ page }, info) => {
    desktopOnly(info.project.name);
    await open(page, '/agents');
    await page.locator('body').click({ position: { x: 5, y: 400 } });
    await page.keyboard.press('Control+Shift+.');
    const sheet = page.getByRole('alertdialog', { name: 'Stop everything?' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('list', { name: 'What will stop' })).toBeVisible();
    await sheet.getByRole('button', { name: 'Cancel' }).click();
    await expect(sheet).toBeHidden();
    expect(await panicked(page)).toBe(false);
  });

  for (const [key, from, to] of [
    ['h', '/inbox', /\/(\?.*)?$/],
    ['s', '/', /\/sessions(\?|$)/],
    ['a', '/', /\/agents(\?|$)/],
    ['c', '/', /\/channels(\?|$)/],
    ['p', '/', /\/policy(\?|$)/],
    ['d', '/', /\/deploy(\?|$)/],
    ['u', '/', /\/audit(\?|$)/],
    [',', '/', /\/settings(\?|$)/],
  ] as const)
    test(`g ${key} lands on its screen`, async ({ page }, info) => {
      desktopOnly(info.project.name);
      await open(page, from);
      await page.locator('body').click({ position: { x: 5, y: 400 } });
      await page.keyboard.press('g');
      await page.keyboard.press(key);
      await expect(page).toHaveURL(to);
    });
});

// ─────────── Shell: sidebar ───────────

test.describe('sidebar', () => {
  test('Stop everything stops everything and the button goes away', async ({ page }, info) => {
    desktopOnly(info.project.name);
    await open(page, '/agents');
    const sidebar = page.getByRole('complementary', { name: 'Sidebar' });
    await sidebar.getByRole('button', { name: 'Stop everything' }).click();
    const sheet = page.getByRole('alertdialog', { name: 'Stop everything?' });
    await sheet.getByRole('button', { name: 'Stop everything' }).click();
    await expect(page.getByRole('alertdialog', { name: 'Everything is stopped.' })).toBeVisible();
    await expect.poll(() => panicked(page)).toBe(true);
    await page
      .getByRole('alertdialog', { name: 'Everything is stopped.' })
      .getByRole('button', { name: 'Close' })
      .first()
      .click();
    await expect(sidebar.getByRole('button', { name: 'Stop everything' })).toHaveCount(0);
  });

  test('Collapse / Expand, Ctrl+\\ toggles, and the choice is remembered', async ({ page }, info) => {
    desktopOnly(info.project.name);
    await open(page, '/');
    const sidebar = page.getByRole('complementary', { name: 'Sidebar' });
    await expect(sidebar).toHaveAttribute('data-sidebar', 'full');
    await sidebar.getByRole('button', { name: 'Collapse sidebar' }).click();
    await expect(sidebar).toHaveAttribute('data-sidebar', 'rail');
    // Rail: icons only, but the links keep their names.
    await expect(sidebar.getByRole('link', { name: 'Inbox' })).toBeVisible();
    await page.reload();
    await expect(page.locator('#bh-main-content').first()).toBeVisible();
    await expect(sidebar).toHaveAttribute('data-sidebar', 'rail');
    await sidebar.getByRole('button', { name: 'Expand sidebar' }).click();
    await expect(sidebar).toHaveAttribute('data-sidebar', 'full');
    await page.locator('body').click({ position: { x: 600, y: 400 } });
    await page.keyboard.press('Control+\\');
    await expect(sidebar).toHaveAttribute('data-sidebar', 'rail');
    await page.keyboard.press('Control+\\');
    await expect(sidebar).toHaveAttribute('data-sidebar', 'full');
  });

  test('Search… opens the command palette', async ({ page }, info) => {
    desktopOnly(info.project.name);
    await open(page, '/');
    await page
      .getByRole('complementary', { name: 'Sidebar' })
      .getByRole('button', { name: /^Search…/ })
      .click();
    await expect(palette(page)).toBeVisible();
    await page.keyboard.type('audit');
    await palette(page)
      .getByRole('menuitem', { name: /^Activity/ })
      .click();
    await expect(page).toHaveURL(/\/audit/);
  });
});

// ─────────── Shell: status strip ───────────

test.describe('status strip', () => {
  test('"search" opens the palette, "?" the shortcut sheet', async ({ page }, info) => {
    desktopOnly(info.project.name);
    await open(page, '/');
    const strip = page.getByRole('region', { name: 'Daemon status' });
    await strip.getByRole('button', { name: /search/ }).click();
    await expect(palette(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(palette(page)).toBeHidden();
    await strip.getByRole('button', { name: 'Keyboard shortcuts' }).click();
    const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText('Search and run commands')).toBeVisible();
  });

  test('needs-you panel says the inbox is clear once everything is decided', async ({ page }, info) => {
    desktopOnly(info.project.name);
    await open(page, '/agents');
    const strip = page.getByRole('region', { name: 'Daemon status' });
    await expect(strip.getByRole('button', { name: /need you/ })).toBeVisible();
    await decideAll(page);
    await expect(strip.getByRole('button', { name: /needs? you/ })).toHaveCount(0);
    await page.locator('body').click({ position: { x: 5, y: 400 } });
    await page.keyboard.press('n');
    const panel = page.getByRole('dialog', { name: 'Needs you' });
    await expect(panel).toBeVisible();
    await expect(panel.getByText('Inbox clear. Nothing is waiting on you.')).toBeVisible();
    await expectAccessible(page);
  });
});

// ─────────── Shell: command palette actions ───────────

test.describe('palette actions', () => {
  test('Review next approval opens the request closest to auto-deny', async ({ page }, info) => {
    desktopOnly(info.project.name);
    await open(page, '/');
    const next = [...(await pending(page))].sort((a, b) => a.expiresAt.localeCompare(b.expiresAt))[0]!;
    await openPalette(page);
    await page.keyboard.type('next approval');
    await palette(page)
      .getByRole('menuitem', { name: /^Review next approval · ci-bot: registry\.npmjs\.org/ })
      .click();
    await expect(page).toHaveURL(new RegExp(`/inbox/${next.id}`));
  });

  test('Allow next decides a low-risk request, with undo', async ({ page }, info) => {
    desktopOnly(info.project.name);
    await open(page, '/agents');
    // Clear the higher-risk requests that expire first, so the next one is the low-risk helpdesk read.
    await decideAll(page, ['apr_b72c', 'apr_b72d', 'apr_b72e', 'apr_a41f']);
    await openPalette(page);
    await page.keyboard.type('allow next');
    await palette(page)
      .getByRole('menuitem', { name: /^Allow next · helpdesk:/ })
      .click();
    await expect(toasts(page).getByText(/^Allowed · /)).toBeVisible();
    await expect.poll(async () => (await pending(page)).some((a) => a.id === 'apr_c09e')).toBe(false);
    await toasts(page).getByRole('button', { name: 'Undo' }).click();
    await expect.poll(async () => (await pending(page)).some((a) => a.id === 'apr_c09e')).toBe(true);
  });

  test('Stop {agent} stops that agent', async ({ page }, info) => {
    desktopOnly(info.project.name);
    await open(page, '/agents');
    expect(await agentStatus(page, 'reviewer')).not.toBe('stopped');
    await openPalette(page);
    await page.keyboard.type('agent stop reviewer');
    await palette(page)
      .getByRole('menuitem', { name: /^Stop reviewer/ })
      .click();
    await expect(toasts(page).getByText('Stopped reviewer')).toBeVisible();
    await expect.poll(() => agentStatus(page, 'reviewer')).toBe('stopped');
  });

  test('theme toggle switches to Night shift and back to Paper', async ({ page }, info) => {
    desktopOnly(info.project.name);
    await open(page, '/');
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark');
    await openPalette(page);
    await page.keyboard.type('theme');
    await palette(page)
      .getByRole('menuitem', { name: /Switch to Night shift \(dark\)/ })
      .click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await openPalette(page);
    await page.keyboard.type('theme');
    await palette(page)
      .getByRole('menuitem', { name: /Switch to Paper \(light\)/ })
      .click();
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark');
  });

  test('Stop everything from the palette opens the stop sheet', async ({ page }, info) => {
    desktopOnly(info.project.name);
    await open(page, '/');
    await openPalette(page);
    await page.keyboard.type('panic');
    await palette(page)
      .getByRole('menuitem', { name: /^Stop everything/ })
      .click();
    const sheet = page.getByRole('alertdialog', { name: 'Stop everything?' });
    await expect(sheet).toBeVisible();
    await sheet.getByRole('button', { name: 'Stop everything' }).click();
    await expect(page.getByRole('alertdialog', { name: 'Everything is stopped.' })).toBeVisible();
    await expect.poll(() => panicked(page)).toBe(true);
  });

  test('no match says what to try', async ({ page }, info) => {
    desktopOnly(info.project.name);
    await open(page, '/');
    await openPalette(page);
    await page.keyboard.type('qqzzxxyy');
    await expect(palette(page).getByText(/^Nothing matches\. Try an agent name/)).toBeVisible();
    await expect(palette(page).getByRole('menuitem', { name: /Stop everything|Agents|Home/ })).toHaveCount(0);
  });
});

// ─────────── Shell: connection sheet, route errors, tab bar ───────────

test('connection sheet (demo) explains where the data comes from', async ({ page }) => {
  await open(page, '/agents');
  await page
    .getByRole('button', { name: /^Connection:/ })
    .filter({ visible: true })
    .first()
    .click();
  const sheet = page.getByRole('dialog', { name: 'Connection' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText('Demo daemon in this browser')).toBeVisible();
  await expect(sheet.getByText('connected').first()).toBeVisible();
  // Demo mode has nothing to disconnect from.
  await expect(sheet.getByRole('button', { name: 'Disconnect this browser' })).toHaveCount(0);
  await expectAccessible(page);
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
});

test('local daemon: Disconnect this browser forgets the token and goes back to pairing', async ({
  page,
}, info) => {
  // A local daemon over WebSocket; it answers every call with an error, which is enough for the shell.
  await page.routeWebSocket(/\/ws\?token=/, (ws) => {
    ws.onMessage((m) => {
      const { id } = JSON.parse(String(m)) as { id: number };
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'not in this test' } }));
    });
  });
  await page.goto('/#token=e2e-token');
  await expect(page.locator('#bh-main-content').first()).toBeVisible();
  await expect(page).not.toHaveURL(/token=/);
  expect(await page.evaluate(() => localStorage.getItem('bh.token'))).toBe('e2e-token');

  if (info.project.name === 'mobile') {
    // iPhone browser tab, local daemon, on Home: the install hint, once until dismissed.
    await expect(page.getByText('Install beamhop for notifications.')).toBeVisible();
    await page.getByRole('button', { name: 'Not now' }).click();
    await expect(page.getByText('Install beamhop for notifications.')).toHaveCount(0);
  }

  await page
    .getByRole('button', { name: /^Connection:/ })
    .filter({ visible: true })
    .first()
    .click();
  const sheet = page.getByRole('dialog', { name: 'Connection' });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: 'Disconnect this browser' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Disconnect this browser?' });
  await expect(confirm).toBeVisible();
  await expect(confirm.getByText(/forgets the daemon's access token/)).toBeVisible();
  await confirm.getByRole('button', { name: 'Disconnect this browser' }).click();
  await expect(page.getByRole('heading', { name: 'Connect this browser to your computer' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('bh.token'))).toBeNull();
});

test('a screen whose code fails to load says so', async ({ page }) => {
  await open(page, '/');
  await page.route(/\/assets\/PanicScreen-[^/]+\.js/, (r) => r.abort());
  await navigate(page, '/panic');
  // The router reloads once on a missing chunk; it is still missing, so the error state stays.
  await expect(page.getByRole('heading', { name: "This screen didn't load." })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expectAccessible(page);
});

test('Retry on "This screen didn\'t load." loads the screen once its code is reachable again', async ({
  page,
}) => {
  await open(page, '/');
  let block = true;
  await page.route(/\/assets\/PanicScreen-[^/]+\.js/, (r) => (block ? r.abort() : r.continue()));
  await navigate(page, '/panic');
  await expect(page.getByRole('heading', { name: "This screen didn't load." })).toBeVisible();
  block = false;
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByRole('heading', { name: 'Stop everything', level: 2 })).toBeVisible({
    timeout: 5000,
  });
});

test('tab bar: the Inbox badge counts decisions and follows them', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'tab bar is compact chrome');
  await open(page, '/agents');
  const n = (await pending(page)).length;
  expect(n).toBeGreaterThan(1);
  const inbox = page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Inbox/ });
  // ×3 identical requests are one decision.
  await expect(inbox).toHaveAccessibleName(/^5 decisions waiting, Inbox$/);
  await rpc(page, 'approval.decide', { id: 'apr_a41f', allow: false });
  await expect(inbox).toHaveAccessibleName(/^4 decisions waiting, Inbox$/);
  await decideAll(page);
  await expect(inbox).toHaveAccessibleName(/^Inbox$/);
});

// ─────────── Home ───────────

test.describe('home', () => {
  test('Stop on a live agent card stops it', async ({ page }) => {
    await open(page, '/');
    await page.getByRole('button', { name: 'Stop reviewer' }).click();
    await expect(toasts(page).getByText('Stopped reviewer.')).toBeVisible();
    await expect.poll(() => agentStatus(page, 'reviewer')).toBe('stopped');
    await expect(page.getByRole('button', { name: 'Stop reviewer' })).toHaveCount(0);
  });

  test('error state when the agents fail to load', async ({ page }) => {
    await open(page, '/?mockFail=agent.list');
    await expect(page.getByRole('heading', { name: "Couldn't load your agents." })).toBeVisible();
    await expect(page.getByText(/simulated/).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  });

  test('first run: Refresh shows "Create your first agent." with preset links', async ({ page }) => {
    await open(page, '/');
    for (const a of (await rpc<{ agents: Agent[] }>(page, 'agent.list')).agents)
      await rpc(page, 'agent.delete', { name: a.config.name });
    await page.getByRole('button', { name: 'Refresh' }).filter({ visible: true }).first().click();
    await expect(page.getByRole('heading', { name: 'Create your first agent.' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Code reviewer/ })).toBeVisible();
    await expectAccessible(page);
    await page
      .locator('#bh-main-content')
      .getByRole('link', { name: 'New agent', exact: true })
      .last()
      .click();
    await expect(page).toHaveURL(/\/agents\/new/);
  });

  test('a preset link from the first-run screen preselects that preset', async ({ page }) => {
    await open(page, '/');
    for (const a of (await rpc<{ agents: Agent[] }>(page, 'agent.list')).agents)
      await rpc(page, 'agent.delete', { name: a.config.name });
    await page.getByRole('button', { name: 'Refresh' }).filter({ visible: true }).first().click();
    await page.getByRole('link', { name: /Code reviewer/ }).click();
    await expect(page).toHaveURL(/\/agents\/new\?(.*&)?preset=code-reviewer/);
    await expect(page.getByRole('radio', { name: /^Code reviewer/ })).toBeChecked({ timeout: 3000 });
  });

  test('"+ N more in Inbox" opens the inbox', async ({ page }) => {
    await open(page, '/');
    await page.getByRole('link', { name: /^\+ \d+ more in Inbox$/ }).click();
    // The desktop Inbox may open its first request (/inbox/apr_…) right away.
    await expect(page).toHaveURL(/\/inbox(\/apr_\w+)?(\?|$)/);
  });

  test('requests you already voted on are "waiting on others"; learning suggestions are counted', async ({
    page,
  }) => {
    await open(page, '/');
    await expect(page.getByText(/waiting on others/)).toHaveCount(0);
    // apr_e5d0 needs 3 owners; alice's vote makes it 2 of 3, so it now waits on others.
    await rpc(page, 'approval.decide', { id: 'apr_e5d0', allow: true });
    await expect(page.getByText('1 waiting on others')).toBeVisible();
    const sug = (await rpc<{ suggestions: unknown[] }>(page, 'policy.suggestions')).suggestions.length;
    expect(sug).toBeGreaterThan(0);
    await expect(
      page
        .locator('#bh-main-content')
        .getByText(new RegExp(`^(· )?${sug} learning suggestions?$`))
        .filter({ visible: true }),
    ).toBeVisible();
  });

  for (const [row, url] of [
    [/Catalog · \d+ harnesses/, /\/harnesses/],
    [/Policy: \d+ learning suggestions?/, /\/policy/],
    [/security events? today/, /\/audit\?(.*&)?tab=security/],
  ] as const)
    test(`Signals row ${row.source} opens its screen`, async ({ page }) => {
      await open(page, '/');
      await page.getByRole('link', { name: row }).filter({ visible: true }).first().click();
      await expect(page).toHaveURL(url);
    });
});

// ─────────── Panic ───────────

test.describe('panic page', () => {
  test('/panic when nothing is stopped is the one-press confirm', async ({ page }) => {
    await open(page, '/panic');
    await expect(page.getByRole('heading', { name: 'Stop everything', level: 2 })).toBeVisible();
    await expect(page.getByRole('list', { name: 'What will stop' })).toBeVisible();
    await page.locator('#bh-main-content').getByRole('button', { name: 'Stop everything' }).click();
    await expect.poll(() => panicked(page)).toBe(true);
    // Once stopped, the page turns into the review checklist.
    await expect(page.getByRole('heading', { name: 'Resume after review' }).first()).toBeAttached();
    await expect(page.getByRole('button', { name: 'Resume without agents' })).toBeVisible();
  });

  test('Resume without agents: resumes, nothing comes back', async ({ page }) => {
    await open(page, '/agents');
    await rpc(page, 'system.panic', {});
    await navigate(page, '/panic');
    await page.getByRole('button', { name: 'Resume without agents' }).click();
    await expect(page).toHaveURL(/\/(\?.*)?$/);
    await expect(toasts(page).getByText('Resumed · 0 selected')).toBeVisible();
    expect(await panicked(page)).toBe(false);
    const { agents } = await rpc<{ agents: Agent[] }>(page, 'agent.list');
    expect(agents.every((a) => a.status === 'stopped')).toBe(true);
  });

  test('a selected schedule comes back; the others stay paused', async ({ page }) => {
    await open(page, '/agents');
    const before = await rpc<{ schedules: Array<{ id: string; enabled: boolean; paused?: boolean }> }>(
      page,
      'schedule.list',
    );
    expect(before.schedules.length).toBeGreaterThan(1);
    await rpc(page, 'system.panic', {});
    await navigate(page, '/panic');
    const boxes = page.locator('section[aria-labelledby="resume-schedules"]').getByRole('checkbox');
    await expect(boxes.first()).toBeVisible();
    await expect(boxes.first()).not.toBeChecked();
    await boxes.first().check({ force: true });
    await expect(boxes.first()).toBeChecked();
    await page.getByRole('button', { name: 'Resume 1 selected' }).click();
    await expect(page).toHaveURL(/\/(\?.*)?$/);
    const after = await rpc<{ schedules: Array<{ id: string; paused?: boolean }> }>(page, 'schedule.list');
    expect(after.schedules.filter((s) => !s.paused)).toHaveLength(1);
  });

  test('the note for the audit log is recorded with the resume', async ({ page }) => {
    await open(page, '/agents');
    await rpc(page, 'system.panic', {});
    await navigate(page, '/panic');
    const note = page.getByRole('textbox', { name: 'Note for the audit log' });
    await note.fill('checked the npm token leak, all clear');
    await expect(note).toHaveValue('checked the npm token leak, all clear');
    await page.getByRole('button', { name: 'Resume without agents' }).click();
    await expect(page).toHaveURL(/\/(\?.*)?$/);
    const { events } = await rpc<{ events: Array<{ summary: string; data?: unknown }> }>(
      page,
      'audit.query',
      { limit: 50 },
    );
    expect(events.some((e) => JSON.stringify(e).includes('checked the npm token leak'))).toBe(true);
  });
});

// ─────────── Pair: push ───────────

test('pairing ends with notifications on for the new device', async ({ page }, info) => {
  test.skip(info.project.name === 'mobile', 'iPhone browser tabs cannot get push (covered by pair.spec)');
  await page.addInitScript(() => {
    let permission = 'default';
    const FakeNotification = Object.assign(() => undefined, {
      get permission() {
        return permission;
      },
      requestPermission: async () => {
        permission = 'granted';
        return 'granted';
      },
    });
    Object.defineProperty(window, 'Notification', { value: FakeNotification, configurable: true });
  });
  await open(page, '/pair');
  await page.getByLabel('Pairing code').fill('ambr rly8');
  await page.getByRole('button', { name: 'Continue · Compare words' }).click();
  await page.getByLabel('Device name').fill('Push phone');
  await page.getByRole('button', { name: 'Send pairing request' }).click();
  await page.getByRole('button', { name: 'Confirmed · Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Paired · Push phone' })).toBeVisible();
  await page.getByRole('button', { name: 'Turn on notifications' }).click();
  await expect(page.getByRole('heading', { name: 'Notifications on' })).toBeVisible();
  await expect
    .poll(async () => {
      const { devices } = await rpc<{ devices: Array<{ name: string; pushEnabled: boolean }> }>(
        page,
        'device.list',
      );
      return devices.find((d) => d.name === 'Push phone')?.pushEnabled;
    })
    .toBe(true);
});

// ─────────── More (compact) ───────────

test.describe('more', () => {
  for (const [label, path] of [
    ['Connections', /\/channels(\?|$)/],
    ['AI accounts', /\/harnesses(\?|$)/],
    ['Sandboxes & roles', /\/policy(\?|$)/],
    ['Cloud', /\/deploy(\?|$)/],
    ['Activity', /\/audit(\?|$)/],
    ['Settings', /\/settings(\?|$)/],
  ] as const)
    test(`${label} navigates`, async ({ page }, info) => {
      test.skip(info.project.name !== 'mobile', 'More is the compact menu');
      await open(page, '/more');
      await page
        .locator('#bh-main-content')
        .getByRole('link', { name: new RegExp(`^${label.replace('&', '\\&')}`) })
        .click();
      await expect(page).toHaveURL(path);
    });
});
