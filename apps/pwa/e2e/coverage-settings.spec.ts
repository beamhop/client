/**
 * Coverage for journeys the other specs leave out: the per-agent sandbox editor's sections (folders,
 * block list, private network, environment, keys, limits, people, learning cards, save conflicts, stopping
 * running sessions), role reset, the policy list's empty/error states; Activity filters, paging errors,
 * security actions, usage controls and export; Settings appearance, identity, owners, retention,
 * notifications, about, stop history, updates and unknown sections; setup's identity, hello, harnesses,
 * doctor and agent pages.
 *
 * Mock state is changed through `window.__beamhop` (the demo daemon) and then reached with client-side
 * navigation: a reload re-seeds the demo daemon.
 */
import { expect, type Page, test } from '@playwright/test';
import { expectAccessible, open, rpc } from './helpers.ts';

declare global {
  interface Window {
    // biome-ignore lint/suspicious/noExplicitAny: test handle into the in-browser demo daemon
    __beamhop: any;
    __bhCalls?: Array<{ method: string; params: unknown }>;
  }
}

const main = (page: Page) => page.locator('#bh-main-content').last();
const toast = (page: Page, text: string | RegExp) =>
  page.getByRole('region', { name: 'Notifications' }).getByText(text);

/** Client-side navigation: keeps the demo daemon's state (a reload re-seeds it). */
const go = async (page: Page, path: string) => {
  await page.evaluate((p) => window.__beamhop.router.history.push(p), path);
  const pathname = path.split('?')[0]!;
  await page.waitForURL((u) => u.pathname === pathname);
};

/** Mark cached reads stale, as a push from another device would. */
const invalidate = (page: Page, ...methods: string[]) =>
  page.evaluate(async (ms) => {
    const qc = window.__beamhop.runtime.queryClient;
    await Promise.all(ms.map((m) => qc.invalidateQueries({ queryKey: ['bh', m] })));
  }, methods);

/** Record every call that reaches the demo daemon. */
const spy = (page: Page) =>
  page.evaluate(() => {
    if (window.__bhCalls) return;
    const calls: Array<{ method: string; params: unknown }> = [];
    window.__bhCalls = calls;
    const d = window.__beamhop.mock.daemon;
    const orig = d.handle.bind(d);
    d.handle = (m: string, p: unknown) => {
      calls.push({ method: m, params: p });
      return orig(m, p);
    };
  });
const callsTo = (page: Page, method: string) =>
  page.evaluate((m) => (window.__bhCalls ?? []).filter((c) => c.method === m).map((c) => c.params), method);

/** Pick an option in a (React Aria) Select: popover on desktop, bottom sheet on compact. */
const pick = async (page: Page, scope: ReturnType<Page['locator']> | Page, label: string, option: string) => {
  await scope.getByRole('button', { name: new RegExp(`${label}$`) }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
};

type Policy = {
  fs: { read: string[]; write: string[]; deny: string[] };
  net: { allow: string[]; denyPrivateIps: boolean };
  env: { passthrough: string[] };
  proc: { maxSessionMinutes: number };
  secrets: Array<{ name: string; host: string }>;
  learning: boolean;
};
const savedPolicy = async (page: Page, name: string) =>
  (await rpc<{ config: { sandbox: { profile: string; policy?: Policy } } }>(page, 'agent.get', { name }))
    .config.sandbox;

/** Two more learning-mode requests for helpdesk: a locked credential path and a project .env file. */
const addSuggestions = async (page: Page) => {
  await page.evaluate(() => {
    const st = window.__beamhop.mock.daemon.state;
    const at = new Date().toISOString();
    st.suggestions.push(
      {
        id: 'sug_ssh',
        agent: 'helpdesk',
        kind: 'fs.read',
        value: '~/.ssh/id_ed25519',
        count: 2,
        lastSeenAt: at,
      },
      {
        id: 'sug_env',
        agent: 'helpdesk',
        kind: 'fs.read',
        value: '~/code/app/.env',
        count: 4,
        lastSeenAt: at,
      },
    );
  });
  await invalidate(page, 'policy.suggestions');
};

const review = async (page: Page, agent: string) => {
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  return page.getByRole('dialog', { name: `Review ${agent}'s sandbox` });
};
const confirmReview = async (page: Page, sheet: ReturnType<Page['locator']>, agent: string) => {
  await sheet.getByRole('button', { name: /^(Save|Widen access)$/ }).click();
  await expect(toast(page, new RegExp(`^(Saved|Widened) · ${agent}'s sandbox`))).toBeVisible();
  await expect(sheet).toBeHidden();
};

// ─────────────────────────── Sandboxes & roles ───────────────────────────
test.describe('policy editor', () => {
  test('folders: add a read & write folder, switch a mode, remove one; the config gets all three', async ({
    page,
  }) => {
    await open(page, '/policy/reviewer');
    const files = page.getByRole('region', { name: 'Folders', exact: true });
    const input = files.getByRole('combobox', { name: 'Add a folder' });
    await input.fill('code/docs');
    await input.press('Tab');
    await files.getByRole('button', { name: 'Add folder' }).click();
    await expect(files.getByRole('alert')).toHaveText('Use a full path, like ~/code/app.');

    await input.fill('~/code/docs');
    await input.press('Tab');
    await files
      .getByRole('radiogroup', { name: 'Access for the new folder' })
      .getByRole('radio', { name: 'Read & write' })
      .click();
    await files.getByRole('button', { name: 'Add folder' }).click();
    await expect(files.getByRole('button', { name: 'Remove ~/code/docs' })).toBeVisible();
    await expect(
      files
        .getByRole('radiogroup', { name: 'Access to ~/code/docs' })
        .getByRole('radio', { name: 'Read & write' }),
    ).toBeChecked();

    await files
      .getByRole('radiogroup', { name: 'Access to ~/notes' })
      .getByRole('radio', { name: 'Read & write' })
      .click();
    await files.getByRole('button', { name: 'Remove ~/code/app' }).click();
    await expect(files.getByRole('button', { name: 'Remove ~/code/app' })).toHaveCount(0);
    await expect(page.getByText('3 changes')).toBeVisible();

    const sheet = await review(page, 'reviewer');
    await expect(
      sheet.getByText('reviewer will be able to read and change files in ~/code/docs.'),
    ).toBeVisible();
    await expect(sheet.getByText('reviewer will be able to change files in ~/notes.')).toBeVisible();
    await expect(sheet.getByText('reviewer will no longer see ~/code/app.')).toBeVisible();
    await confirmReview(page, sheet, 'reviewer');

    const { policy } = await savedPolicy(page, 'reviewer');
    expect(policy?.fs.write).toEqual(expect.arrayContaining(['~/code/docs', '~/notes']));
    expect(policy?.fs.read).not.toContain('~/code/app');
    expect(policy?.fs.write).not.toContain('~/code/app');
  });

  test('block a path, turn off the private-network block, add a variable, change the limit', async ({
    page,
  }) => {
    await open(page, '/policy/reviewer');
    const never = page.getByRole('region', { name: 'Never readable' });
    const block = never.getByRole('textbox', { name: 'Block a path' });
    await block.fill('code/app/.env');
    await block.press('Enter');
    await expect(never.getByText('Use a full path, like ~/code/app/.env.')).toBeVisible();
    await block.fill('~/code/app/.env');
    await block.press('Enter');
    await expect(never.getByText('~/code/app/.env', { exact: true })).toBeVisible();

    const net = page.getByRole('region', { name: 'Network', exact: true });
    const priv = net.getByRole('switch', { name: /^Block private network/ });
    await expect(priv).toBeChecked();
    await priv.click({ force: true });
    await expect(priv).not.toBeChecked();
    await expect(net.getByText(/can reach machines on your private network/)).toBeVisible();

    const env = page.getByRole('region', { name: 'Environment', exact: true });
    const variable = env.getByRole('textbox', { name: 'Add variable' });
    await variable.fill('GITHUB_TOKEN');
    await variable.press('Enter');
    await expect(env.getByText(/GITHUB_TOKEN looks like a secret/)).toBeVisible();
    await variable.fill('NODE_ENV');
    await variable.press('Enter');
    await expect(env.getByText('NODE_ENV', { exact: true })).toBeVisible();

    const limits = page.getByRole('region', { name: 'Limits', exact: true });
    const minutes = limits.getByRole('textbox', { name: 'Stop a session after' });
    await minutes.fill('90');
    await minutes.press('Tab');

    const sheet = await review(page, 'reviewer');
    await expect(sheet.getByText('~/code/app/.env will always be blocked.')).toBeVisible();
    await expect(sheet.getByText('reviewer will be able to reach your private network.')).toBeVisible();
    await expect(sheet.getByText('reviewer will see the environment variable NODE_ENV.')).toBeVisible();
    await expect(sheet.getByText(/^Sessions stop after 90 min \(was 60\)\.$/)).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Widen access' })).toBeVisible();
    await confirmReview(page, sheet, 'reviewer');

    const { policy } = await savedPolicy(page, 'reviewer');
    expect(policy?.fs.deny).toContain('~/code/app/.env');
    expect(policy?.net.denyPrivateIps).toBe(false);
    expect(policy?.env.passthrough).toContain('NODE_ENV');
    expect(policy?.proc.maxSessionMinutes).toBe(90);
  });

  test('keys: bind a key to one host through the broker', async ({ page }) => {
    await open(page, '/policy/reviewer');
    const keys = page.getByRole('region', { name: 'Keys (secret broker)' });
    await keys.getByRole('button', { name: 'Bind a key' }).click();
    const bind = keys.getByRole('button', { name: 'Bind', exact: true });
    await expect(bind).toBeDisabled();
    await pick(page, keys, 'Key', 'OPENAI_API_KEY');
    await pick(page, keys, 'Only for host', 'github.com');
    await bind.click();
    await expect(keys.getByRole('button', { name: 'Remove OPENAI_API_KEY' })).toBeVisible();
    await expect(keys.getByText(/→ github\.com · Authorization Bearer/)).toBeVisible();

    const sheet = await review(page, 'reviewer');
    await expect(
      sheet.getByText('The broker will add OPENAI_API_KEY to requests to github.com.'),
    ).toBeVisible();
    await confirmReview(page, sheet, 'reviewer');
    const pol = await rpc<{ effective: Policy }>(page, 'policy.get', { name: 'reviewer' });
    expect(pol.effective.secrets).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'OPENAI_API_KEY', host: 'github.com' })]),
    );
  });

  test('who can command it: channel members and grants with their roles', async ({ page }) => {
    await open(page, '/policy/reviewer');
    const people = page.getByRole('region', { name: 'Who can command it' });
    const tg = people.getByRole('listitem').filter({ hasText: 'everyone in tg:group/-100123' });
    await expect(tg).toContainText('user');
    await expect(people.getByRole('listitem').filter({ hasText: 'everyone in nostr:dm' })).toContainText(
      'viewer',
    );
    await expect(people.getByRole('listitem').filter({ hasText: 'telegram:5551' })).toContainText('user');
    await expect(people.getByRole('listitem').filter({ hasText: /admin$/ })).toHaveCount(1);
    await people.getByRole('link', { name: 'What each role can do' }).click();
    await expect(page).toHaveURL(/\/policy\/roles/);
  });

  test('learning mode: turning it on is a reviewed widening and is saved', async ({ page }) => {
    await open(page, '/policy/reviewer');
    const learning = page.getByRole('region', { name: 'Learning mode' });
    const sw = learning.getByRole('switch', { name: /^Learning mode/ });
    await expect(sw).not.toBeChecked();
    await sw.click({ force: true });
    await expect(sw).toBeChecked();
    await expect(learning.getByText('Nothing logged yet.')).toBeVisible();
    const sheet = await review(page, 'reviewer');
    await expect(sheet.getByText(/^Learning mode: requests outside the rules are let through/)).toBeVisible();
    await confirmReview(page, sheet, 'reviewer');
    const pol = await rpc<{ effective: Policy }>(page, 'policy.get', { name: 'reviewer' });
    expect(pol.effective.learning).toBe(true);
  });

  test('learning cards: broker a credential, allow a read; both apply on save', async ({ page }) => {
    await open(page, '/policy/helpdesk');
    await addSuggestions(page);
    const list = page.getByRole('list', { name: 'Logged requests to review' });
    await expect(list.getByRole('group')).toHaveCount(5);

    const locked = list.getByRole('listitem').filter({ hasText: '~/.ssh/id_ed25519' });
    await expect(locked.getByText('Blocked by design')).toBeVisible();
    await expect(locked.getByText("This path is always blocked. It can't be allowed.")).toBeVisible();
    await expect(locked.getByRole('button', { name: /^Allow/ })).toHaveCount(0);

    const cred = list.getByRole('listitem').filter({ hasText: '~/code/app/.env' });
    await expect(cred.getByText('Credential file')).toBeVisible();
    await cred.getByRole('button', { name: 'Use broker instead' }).click();
    await expect(
      page.getByText(/~\/code\/app\/\.env\s*stays blocked · add a broker key instead/),
    ).toBeVisible();

    await list.getByRole('button', { name: 'Allow read: ~/.cache/pip' }).click();
    await expect(page.getByText(/~\/\.cache\/pip\s*will be allowed/)).toBeVisible();
    await expect(
      page
        .getByRole('region', { name: 'Folders', exact: true })
        .getByRole('button', { name: 'Remove ~/.cache/pip' }),
    ).toBeVisible();
    await expect(list.getByRole('group')).toHaveCount(3);

    const sheet = await review(page, 'helpdesk');
    await expect(sheet.getByText('helpdesk will be able to read ~/.cache/pip.')).toBeVisible();
    await expect(
      sheet.getByText('~/code/app/.env stays blocked; provide it through the key broker instead.'),
    ).toBeVisible();
    await confirmReview(page, sheet, 'helpdesk');
    const left = await rpc<{ suggestions: Array<{ id: string }> }>(page, 'policy.suggestions', {
      name: 'helpdesk',
    });
    expect(left.suggestions.map((s) => s.id).sort()).toEqual(['sug_npm', 'sug_pypi', 'sug_ssh']);
  });

  test('learning cards: "Dismiss" on a locked path takes it off the list', async ({ page }) => {
    await open(page, '/policy/helpdesk');
    await addSuggestions(page);
    const list = page.getByRole('list', { name: 'Logged requests to review' });
    await list
      .getByRole('listitem')
      .filter({ hasText: '~/.ssh/id_ed25519' })
      .getByRole('button', { name: 'Dismiss' })
      .click();
    await expect(page.getByText(/~\/\.ssh\/id_ed25519\s*stays blocked$/)).toBeVisible({ timeout: 4000 });
    await expect(list.getByRole('group')).toHaveCount(4);
    const sheet = await review(page, 'helpdesk');
    await expect(
      sheet.getByText('~/.ssh/id_ed25519 stays blocked (dismissed from learning mode).'),
    ).toBeVisible();
    await confirmReview(page, sheet, 'helpdesk');
    const left = await rpc<{ suggestions: Array<{ id: string }> }>(page, 'policy.suggestions', {
      name: 'helpdesk',
    });
    expect(left.suggestions.map((s) => s.id)).not.toContain('sug_ssh');
  });

  test('save conflict: "Keep mine" keeps the draft over a change made elsewhere', async ({ page }) => {
    await open(page, '/policy/reviewer');
    await page.getByRole('button', { name: 'Remove github.com' }).click();
    await expect(page.getByText('1 change')).toBeVisible();
    await rpc(page, 'policy.set', { name: 'reviewer', profile: 'strict' });
    await invalidate(page, 'policy.get');
    const banner = page.getByText(/^reviewer's sandbox was changed elsewhere at .*\. Your edits are kept\.$/);
    await expect(banner).toBeVisible();
    await page.getByRole('button', { name: 'Keep mine' }).click();
    await expect(banner).toBeHidden();
    await expect(page.getByRole('button', { name: 'Remove github.com' })).toHaveCount(0);
    // Saving now writes the draft over theirs.
    const sheet = await review(page, 'reviewer');
    await confirmReview(page, sheet, 'reviewer');
    const { policy } = await savedPolicy(page, 'reviewer');
    expect(policy?.net.allow).not.toContain('github.com');
  });

  test('save conflict: "Use theirs" drops the draft for the saved rules', async ({ page }) => {
    await open(page, '/policy/reviewer');
    await page.getByRole('button', { name: 'Remove github.com' }).click();
    await rpc(page, 'policy.set', { name: 'reviewer', profile: 'strict' });
    await invalidate(page, 'policy.get');
    await page.getByRole('button', { name: 'Use theirs' }).click();
    await expect(page.getByText(/changed elsewhere/)).toBeHidden();
    await expect(page.getByRole('button', { name: 'Remove github.com' })).toBeVisible();
    await expect(page.getByRole('radio', { name: /^strict/ })).toBeChecked();
    await expect(page.getByRole('button', { name: 'Review', exact: true })).toHaveCount(0);
  });

  test('review: "Stop them now" ends the running sessions on save', async ({ page }) => {
    await open(page, '/policy/reviewer');
    await page.getByRole('button', { name: 'Remove github.com' }).click();
    const sheet = await review(page, 'reviewer');
    await expect(sheet.getByText('1 running session keeps the old rules:')).toBeVisible();
    const stop = sheet.getByRole('checkbox', {
      name: 'Stop them now so the next message starts with the new rules',
    });
    await sheet.getByText('Stop them now so the next message starts with the new rules').click();
    await expect(stop).toBeChecked();
    await confirmReview(page, sheet, 'reviewer');
    const { sessions } = await rpc<{ sessions: Array<{ id: string; status: string }> }>(
      page,
      'session.list',
      {
        agent: 'reviewer',
      },
    );
    expect(sessions.find((s) => s.id === 'ses_842')?.status).toBe('ended');
    expect(sessions.filter((s) => s.status === 'running')).toEqual([]);
  });
});

test('roles: a changed built-in role can be reset to its default', async ({ page }, info) => {
  await open(page, '/policy/roles');
  await rpc(page, 'role.define', { role: { name: 'user', canApprove: true } });
  await invalidate(page, 'role.list');
  if (info.project.name !== 'desktop') await page.getByRole('button', { name: /^user/ }).click();
  await page.getByRole('button', { name: 'Edit user' }).click();
  const sheet = page.getByRole('dialog', { name: 'Edit user' });
  await expect(
    sheet.getByText('A built-in role with your changes. Reset puts back the default.'),
  ).toBeVisible();
  await sheet.getByRole('button', { name: 'Reset to default' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Reset user to the default?' });
  await expect(confirm.getByText(/Your changes to this role are dropped/)).toBeVisible();
  await confirm.getByRole('button', { name: 'Reset to default' }).click();
  await expect(toast(page, 'Reset · user')).toBeVisible();
  const { roles } = await rpc<{ roles: Array<{ name: string; canApprove: boolean }> }>(page, 'role.list');
  expect(roles.find((r) => r.name === 'user')?.canApprove).toBe(false);
});

test('policy list: no agents → empty state with a way to create one', async ({ page }) => {
  await open(page, '/policy');
  for (const name of ['reviewer', 'ci-bot', 'helpdesk', 'scribe']) await rpc(page, 'agent.delete', { name });
  await invalidate(page, 'agent.list');
  await expect(page.getByText('No agents yet.')).toBeVisible();
  await expect(page.getByText(/Each agent gets its own sandbox/)).toBeVisible();
  await page.getByRole('link', { name: 'New agent' }).click();
  await expect(page).toHaveURL(/\/agents\/new/);
});

test('policy list: error state when agents cannot load', async ({ page }) => {
  await open(page, '/policy?mockFail=agent.list');
  await expect(page.getByRole('alert').getByText("Couldn't load agents")).toBeVisible();
});

// ─────────────────────────── Activity ───────────────────────────
test.describe('activity', () => {
  test('log filters: severity, agent, time and event type narrow the list', async ({ page }, info) => {
    await open(page, '/audit?tab=log');
    await expect(page.getByText(/^50 events · 50 loaded$/)).toBeVisible();
    const compact = info.project.name !== 'desktop';
    let scope: Page | ReturnType<Page['locator']> = main(page);
    if (compact) {
      await page.getByRole('button', { name: 'Filters', exact: true }).click();
      scope = page.getByRole('dialog', { name: 'Filters' });
    }
    await pick(page, scope, 'Severity', 'high');
    await pick(page, scope, 'Agent', 'helpdesk');
    await pick(page, scope, 'Time', 'last 24 h');
    await pick(page, scope, 'Event type', 'sandbox.blocked_host');
    if (compact) {
      await (scope as ReturnType<Page['locator']>)
        .getByRole('button', { name: /^Show \d+ events?$/ })
        .click();
      await expect(page.getByRole('button', { name: 'Filters, 4 active' })).toBeVisible();
    }
    await expect(page.getByText(/^1 event · \d+ loaded$/)).toBeVisible();
    await expect(
      main(page).getByRole('button', { name: /helpdesk reached pypi\.org outside its policy/ }),
    ).toBeVisible();
    await expect(main(page).getByRole('button', { name: /reviewer was blocked/ })).toHaveCount(0);
  });

  test('log: older events that fail to load offer a retry that works', async ({ page }) => {
    await open(page, '/audit?tab=log');
    await expect(page.getByText(/^50 events · 50 loaded$/)).toBeVisible();
    await page.evaluate(() => {
      const w = window as unknown as { __failOlder: boolean; __olderTries: number };
      const d = window.__beamhop.mock.daemon;
      const orig = d.handle.bind(d);
      w.__failOlder = true;
      w.__olderTries = 0;
      d.handle = (m: string, p: { before?: string }) => {
        if (m === 'audit.query' && p?.before) {
          w.__olderTries++;
          if (w.__failOlder) return Promise.reject(new Error('relay dropped the page'));
        }
        return orig(m, p);
      };
    });
    const tries = () => page.evaluate(() => (window as unknown as { __olderTries: number }).__olderTries);
    const retry = page.getByRole('button', { name: "Couldn't load older events. Retry" });
    await page.getByRole('button', { name: 'Load older events' }).scrollIntoViewIfNeeded();
    await expect(retry).toBeVisible();
    // A failed page waits for the person: no automatic retries.
    const failed = await tries();
    await page.waitForTimeout(1000);
    expect(await tries()).toBe(failed);
    await expect(page.getByText(/^50 events · 50 loaded$/)).toBeVisible();
    await page.evaluate(() => {
      (window as unknown as { __failOlder: boolean }).__failOlder = false;
    });
    await retry.click({ timeout: 3000 });
    await expect(page.getByText(/· (5[1-9]|[6-9]\d|\d{3,}) loaded$/)).toBeVisible();
    await expect(retry).toHaveCount(0);
  });

  test('security: ignoring an unknown sender hides it until they ask again', async ({ page }) => {
    await open(page, '/audit?tab=security');
    await page.getByRole('button', { name: /^Unknown senders/ }).click();
    const events = page.getByRole('list', { name: 'Events' });
    await expect(events.getByText('npub1qz…8k4 asked to talk to helpdesk')).toBeVisible();
    await events.getByRole('button', { name: 'Ignore' }).click();
    await expect(toast(page, 'Ignored. They can ask again.')).toBeVisible();
    await expect(page.getByText('npub1qz…8k4 asked to talk to helpdesk')).toHaveCount(0);
    await expect(page.getByText('Nothing in Unknown senders for this range.')).toBeVisible();
  });

  test('security: Open session and Open channel go to the right place', async ({ page }) => {
    await open(page, '/audit?tab=security');
    const events = page.getByRole('list', { name: 'Events' });
    await events
      .getByRole('listitem')
      .filter({ hasText: 'reviewer was blocked from 169.254.169.254 (cloud metadata)' })
      .getByRole('button', { name: 'Open session' })
      .click();
    await expect(page).toHaveURL(/\/sessions\/ses_842/);
    await open(page, '/audit?tab=security');
    await page
      .getByRole('list', { name: 'Events' })
      .getByRole('listitem')
      .filter({ hasText: 'Failed pairing on tg' })
      .getByRole('button', { name: 'Open channel' })
      .click();
    await expect(page).toHaveURL(/\/channels\/tg/);
  });

  test('security: a blocked ordinary path offers "Review sandbox"', async ({ page }) => {
    await open(page, '/audit?tab=log');
    await page.evaluate(() => {
      window.__beamhop.mock.daemon.state.audit.unshift({
        id: 'aud_e2e_path',
        at: new Date().toISOString(),
        agent: 'helpdesk',
        actor: 'srt',
        type: 'sandbox.blocked_path',
        severity: 'security',
        summary: 'helpdesk tried to read ~/projects/site',
        data: { path: '~/projects/site' },
      });
    });
    await go(page, '/audit?tab=security');
    await invalidate(page, 'audit.query');
    const row = page
      .getByRole('list', { name: 'Events' })
      .getByRole('listitem')
      .filter({ hasText: 'helpdesk tried to read ~/projects/site' });
    await expect(row.getByText('Blocked by design')).toHaveCount(0);
    await row.getByRole('button', { name: 'Review sandbox' }).click();
    await expect(page).toHaveURL(/\/policy\/helpdesk/);
  });

  test('security: "High only" and the time range narrow the events', async ({ page }) => {
    await open(page, '/audit?tab=security');
    const events = page.getByRole('list', { name: 'Events' });
    await expect(events.getByText('npub1qz…8k4 asked to talk to helpdesk')).toBeVisible();
    await page
      .getByRole('radiogroup', { name: 'Severity' })
      .getByRole('radio', { name: 'High only' })
      .click();
    await expect(events.getByText('npub1qz…8k4 asked to talk to helpdesk')).toHaveCount(0);
    await expect(events.getByText(/Failed pairing on tg/)).toBeVisible();

    const all = page.getByRole('list', { name: 'Category' }).getByRole('button').first();
    // biome-ignore lint/performance/useDomNodeTextContent: only rendered, visible text counts here
    const count = async () => Number((await all.innerText()).match(/(\d+)\s*$/)?.[1]);
    const range = page.getByRole('radiogroup', { name: 'Time range' });
    await range.getByRole('radio', { name: '24 h' }).click();
    await expect(range.getByRole('radio', { name: '24 h' })).toBeChecked();
    const day = await count();
    await range.getByRole('radio', { name: '14 d' }).click();
    await expect.poll(count).toBeGreaterThan(day);
    expect(day).toBeGreaterThan(0);
  });

  test('usage: range, tokens and a breakdown by peer agent', async ({ page }) => {
    await open(page, '/audit');
    await page.getByRole('radiogroup', { name: 'Range' }).getByRole('radio', { name: '7 d' }).click();
    await expect(page.getByRole('heading', { name: 'Last 7 days · all agents' })).toBeVisible();
    await page.getByRole('radiogroup', { name: 'Measure' }).getByRole('radio', { name: 'Tokens' }).click();
    await expect(page.getByRole('group', { name: 'Tokens per day, last 7 days, by Agent' })).toBeVisible();
    await page
      .getByRole('radiogroup', { name: 'Break down by' })
      .getByRole('radio', { name: 'Peer' })
      .click();
    await expect(page.getByRole('group', { name: 'Tokens per day, last 7 days, by Peer' })).toBeVisible();
    await page.getByRole('button', { name: 'View as table' }).click();
    await expect(page.getByRole('table', { name: /Tokens per day, last 7 days, by Peer/ })).toBeVisible();
  });

  test('export: "These N events" downloads exactly the filtered list', async ({ page }) => {
    await open(page, '/audit?tab=log');
    await page.getByRole('searchbox', { name: 'Search the log' }).fill('pypi.org');
    // biome-ignore lint/performance/useDomNodeTextContent: only rendered, visible text counts here
    const shown = Number((await page.getByText(/^\d+ events? · \d+ loaded$/).innerText()).match(/^\d+/)?.[0]);
    expect(shown).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Export' }).click();
    const sheet = page.getByRole('dialog', { name: 'Export audit log' });
    await expect(sheet.getByText(`These ${shown} event${shown === 1 ? '' : 's'}`)).toBeVisible();
    const dl = page.waitForEvent('download');
    await sheet.getByRole('button', { name: 'CSV' }).click();
    const file = await dl;
    expect(file.suggestedFilename()).toMatch(/^beamhop-audit-.*\.csv$/);
    const text = await (await file.createReadStream()).toArray();
    const lines = Buffer.concat(text as Buffer[])
      .toString('utf8')
      .trim()
      .split('\n');
    expect(lines.length).toBe(shown + 1);
    await expect(toast(page, `Downloaded ${shown} event${shown === 1 ? '' : 's'}`)).toBeVisible();
  });

  test('security and log empty states', async ({ page }) => {
    await open(page, '/settings/about');
    await page.evaluate(() => {
      window.__beamhop.mock.daemon.state.audit = [];
    });
    await invalidate(page, 'audit.query');
    await go(page, '/audit?tab=security');
    await expect(page.getByText('No security events in the last 7 days.')).toBeVisible();
    await page.getByRole('button', { name: 'Show 14 days' }).click();
    await expect(page.getByText('No security events in the last 14 days.')).toBeVisible();
    await go(page, '/audit?tab=log');
    await expect(page.getByText('The log is empty.')).toBeVisible();
    await expect(
      page.getByText(/Every decision, config change, pairing and deploy is recorded here/),
    ).toBeVisible();
  });

  test('security and log error states', async ({ page }) => {
    await open(page, '/audit?tab=security&mockFail=audit.query');
    await expect(page.getByRole('alert').getByText("Couldn't load security events")).toBeVisible();
    await open(page, '/audit?tab=log&mockFail=audit.query');
    await expect(page.getByRole('alert').getByText("Couldn't load the audit log")).toBeVisible();
  });
});

// ─────────────────────────── Settings ───────────────────────────
test.describe('settings', () => {
  test('appearance: theme, contrast, motion and haptics apply at once and survive a reload', async ({
    page,
  }) => {
    await open(page, '/settings/appearance');
    const html = page.locator('html');
    await page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Night shift' }).click();
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await expect(page.getByText(/Night shift/).first()).toBeVisible();
    await page.getByRole('radiogroup', { name: 'Contrast' }).getByRole('radio', { name: 'More' }).click();
    await expect(html).toHaveAttribute('data-contrast', 'more');
    await page.getByRole('radiogroup', { name: 'Motion' }).getByRole('radio', { name: 'Reduced' }).click();
    await expect(html).toHaveAttribute('data-motion', 'reduced');
    const haptics = page.getByRole('switch', { name: /^Haptics/ });
    await expect(haptics).toBeChecked();
    await haptics.click({ force: true });
    await expect(haptics).not.toBeChecked();

    await page.reload();
    await expect(page.locator('#bh-main-content').first()).toBeVisible();
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await expect(html).toHaveAttribute('data-contrast', 'more');
    await expect(html).toHaveAttribute('data-motion', 'reduced');
    await expect(
      page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Night shift' }),
    ).toBeChecked();
    await expect(page.getByRole('switch', { name: /^Haptics/ })).not.toBeChecked();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('bh.appearance') ?? '{}'))).toEqual({
      theme: 'dark',
      contrast: 'more',
      motion: 'reduced',
      haptics: false,
    });
    await expectAccessible(page);

    await page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Paper' }).click();
    await expect(html).toHaveAttribute('data-theme', 'light');
  });

  test('identity: no owner key yet → "Create owner key" → backup export', async ({ page }) => {
    await open(page, '/settings/about');
    await page.evaluate(() => {
      const h = window.__beamhop.mock.daemon.handlers;
      const get = h['identity.get'];
      const create = h['identity.ownerCreate'];
      let created = false;
      h['identity.get'] = (p: unknown) => {
        const r = get(p);
        return created ? r : { ...r, npub: undefined, ownerKeyHeld: false };
      };
      h['identity.ownerCreate'] = (p: unknown) => {
        created = true;
        return create(p);
      };
    });
    await invalidate(page, 'identity.get');
    await go(page, '/settings/identity');
    const owner = page.getByRole('region', { name: 'Owner key' });
    await expect(owner.getByText(/^No owner key yet\./)).toBeVisible();
    await owner.getByRole('button', { name: 'Create owner key' }).click();
    await expect(toast(page, "Owner key created and kept in this computer's keychain.")).toBeVisible();
    await expect(owner.getByText('You', { exact: true })).toBeVisible();

    await owner.getByRole('button', { name: 'Export backup…' }).click();
    const sheet = page.getByRole('dialog', { name: 'Export owner key backup' });
    await expect(sheet.getByText(/Anyone with this key can act as you/)).toBeVisible();
    await sheet.getByRole('button', { name: 'Reveal secret key' }).click();
    await expect(sheet.getByText('nsec1…(mock: never shown in demo)')).toBeVisible();
    await sheet.getByRole('button', { name: "I've stored it safely" }).click();
    await expect(sheet).toBeHidden();
  });

  test('identity: publish an agent profile', async ({ page }) => {
    await open(page, '/settings/identity');
    await spy(page);
    const agents = page.getByRole('region', { name: 'Agents', exact: true });
    await agents
      .getByRole('listitem')
      .filter({ hasText: 'scribe' })
      .getByRole('button', { name: 'Publish' })
      .click();
    await expect(toast(page, 'Published · scribe profile + attestation')).toBeVisible();
    expect(await callsTo(page, 'identity.publish')).toEqual([{ name: 'scribe' }]);
  });

  test('identity: check NIP-05 handles against the domain and download nostr.json', async ({ page }) => {
    await open(page, '/settings/identity');
    await spy(page);
    await page.getByLabel('Domain').fill('example.com');
    await page.getByRole('button', { name: 'Generate nostr.json' }).click();
    await expect(
      page.getByRole('region', { name: 'https://example.com/.well-known/nostr.json' }),
    ).toBeVisible();
    const [gen] = (await callsTo(page, 'identity.nip05')) as Array<{ names: Record<string, string> }>;
    // Only reviewer is uploaded so far.
    await page.route('https://example.com/.well-known/nostr.json**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ names: { reviewer: gen!.names.reviewer } }),
      }),
    );
    await page.getByRole('button', { name: 'Check reviewer@example.com' }).click();
    await expect(page.getByText('reviewer@example.com resolves to this agent.')).toBeVisible();
    await page.getByRole('button', { name: 'Check helpdesk@example.com' }).click();
    await expect(page.getByText('nostr.json has no entry for "helpdesk".')).toBeVisible();

    const dl = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download nostr.json' }).click();
    const file = await dl;
    expect(file.suggestedFilename()).toBe('nostr.json');
    const body = Buffer.concat((await (await file.createReadStream()).toArray()) as Buffer[]).toString(
      'utf8',
    );
    expect(JSON.parse(body).names.reviewer).toBe(gen!.names.reviewer);
  });

  test('owners: add an owner by key, then remove them', async ({ page }) => {
    const hex = '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d';
    await open(page, '/settings/owners');
    const owners = page.getByRole('region', { name: 'Owners', exact: true });
    await expect(owners.getByText("You're the only owner. At least one owner always remains.")).toBeVisible();
    await owners.getByRole('button', { name: 'Add owner' }).click();
    const sheet = page.getByRole('dialog', { name: 'Add an owner' });
    const key = sheet.getByRole('textbox', { name: 'Their Nostr public key' });
    await key.fill('npub1notakey');
    await sheet.getByRole('button', { name: 'Add owner' }).click();
    await expect(sheet.getByText("That isn't an npub or a 64-character hex key.")).toBeVisible();
    await key.fill(hex);
    await sheet.getByRole('button', { name: 'Add owner' }).click();
    await expect(toast(page, /^Added owner · npub1/)).toBeVisible();
    await expect(sheet).toBeHidden();
    const listed = await rpc<{ owners: Array<{ principal: string }> }>(page, 'owner.list');
    expect(listed.owners).toHaveLength(2);
    const added = listed.owners.find((o) => !o.principal.includes('alc3q8'))!.principal;
    expect(added).toMatch(/^nostr:npub1/);

    await owners.getByRole('button', { name: /^Actions for / }).click();
    await page.getByRole('menuitem', { name: 'Remove owner…' }).click();
    const confirm = page.getByRole('alertdialog', { name: /^Remove .* as owner\?$/ });
    await expect(confirm.getByText(/They lose owner rights on every agent right away/)).toBeVisible();
    await confirm.getByRole('button', { name: 'Remove owner' }).click();
    await expect(toast(page, /^Removed owner · /)).toBeVisible();
    const after = await rpc<{ owners: Array<{ principal: string }> }>(page, 'owner.list');
    expect(after.owners.map((o) => o.principal)).not.toContain(added);
    await expect(owners.getByRole('button', { name: /^Actions for / })).toHaveCount(0);
  });

  test('owners: revoke a role from a person', async ({ page }) => {
    await open(page, '/settings/owners');
    const people = page.getByRole('region', { name: 'People with roles' });
    await people.getByRole('button', { name: 'Actions for telegram:5551' }).click();
    await page.getByRole('menuitem', { name: 'Revoke role' }).click();
    await expect(toast(page, 'Revoked · telegram:5551')).toBeVisible();
    await expect(people.getByRole('button', { name: 'Actions for telegram:5551' })).toHaveCount(0);
    const { grants } = await rpc<{ grants: Record<string, string> }>(page, 'role.list');
    expect(grants['telegram:5551']).toBeUndefined();
  });

  test('retention: edit how long one agent keeps transcripts', async ({ page }) => {
    await open(page, '/settings/retention');
    await page.getByRole('button', { name: 'Edit retention for scribe' }).click();
    const sheet = page.getByRole('dialog', { name: 'Retention · scribe' });
    const days = sheet.getByRole('textbox', { name: 'Keep transcripts for' });
    await days.fill('90');
    await days.press('Tab');
    await sheet.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(toast(page, 'Saved · scribe keeps transcripts 90 d')).toBeVisible();
    await expect(sheet).toBeHidden();
    const a = await rpc<{ config: { retention: { transcriptDays: number } } }>(page, 'agent.get', {
      name: 'scribe',
    });
    expect(a.config.retention.transcriptDays).toBe(90);
    await expect(page.getByRole('listitem').filter({ hasText: 'scribe' })).toContainText('transcripts 90 d');
  });

  test('retention: export all data and copy the archive path', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await open(page, '/settings/retention');
    await page.getByRole('button', { name: 'Export all data' }).click();
    const saved = page
      .getByRole('status')
      .filter({ hasText: /^Saved · ~\/\.beamhop\/exports\/beamhop-.*\.tar\.gz/ });
    await expect(saved).toBeVisible();
    // biome-ignore lint/performance/useDomNodeTextContent: only rendered, visible text counts here
    const path = (await saved.innerText()).replace(/^Saved · /, '').trim();
    await saved.getByRole('button', { name: 'Copy path' }).click();
    await expect(saved.getByRole('button', { name: 'Copied' })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(path);
  });

  test('retention: purge one agent needs its name typed, then only its records go', async ({ page }) => {
    await open(page, '/settings/retention');
    await page.getByRole('button', { name: 'Purge…' }).click();
    const sheet = page.getByRole('alertdialog', { name: 'Purge data?' });
    await sheet.getByText('helpdesk', { exact: true }).click();
    await expect(sheet.getByRole('radio', { name: 'helpdesk' })).toBeChecked();
    await sheet
      .getByRole('radiogroup', { name: 'Data older than' })
      .getByRole('radio', { name: 'All' })
      .click();
    const purge = sheet.getByRole('button', { name: 'Purge helpdesk' });
    await expect(purge).toBeDisabled();
    await sheet.getByLabel('Type helpdesk to confirm').fill('everything');
    await expect(purge).toBeDisabled();
    await sheet.getByLabel('Type helpdesk to confirm').fill('helpdesk');
    await purge.click();
    await expect(toast(page, /^Purged · [1-9]\d* records deleted$/)).toBeVisible();
    const mine = await rpc<{ events: unknown[] }>(page, 'audit.query', { agent: 'helpdesk', limit: 1000 });
    expect(mine.events).toHaveLength(0);
    const others = await rpc<{ events: unknown[] }>(page, 'audit.query', { agent: 'reviewer', limit: 1000 });
    expect(others.events.length).toBeGreaterThan(0);
  });

  test('notifications: turn on, send a test, thresholds, security spike and the Nostr DM fallback', async ({
    page,
  }, info) => {
    test.skip(info.project.name !== 'desktop', 'the iPhone profile only gets push in the installed app');
    // Headless Chromium can't show notifications: a stand-in that the user allows and that records each one.
    await page.addInitScript(() => {
      const shown: Array<{ title: string; body?: string }> = [];
      (window as unknown as { __shown: typeof shown }).__shown = shown;
      class FakeNotification {
        static permission = 'default';
        static requestPermission = async () => {
          FakeNotification.permission = 'granted';
          return 'granted';
        };
        constructor(title: string, opts?: { body?: string }) {
          shown.push({ title, body: opts?.body });
        }
      }
      (window as unknown as { Notification: unknown }).Notification = FakeNotification;
    });
    await open(page, '/settings/notifications');
    const device = page.getByRole('region', { name: 'This device' });
    await expect(device.getByText('push off', { exact: true })).toBeVisible();
    await device.getByRole('button', { name: 'Turn on notifications' }).click();
    await expect(toast(page, 'Notifications on for this device')).toBeVisible();
    await expect(device.getByText('push on', { exact: true })).toBeVisible();
    await device.getByRole('button', { name: 'Send a test notification' }).click();
    await expect(device.getByRole('status')).toHaveText('Sent. It should appear in a moment.');
    expect(await page.evaluate(() => (window as unknown as { __shown: unknown[] }).__shown)).toEqual([
      { title: 'beamhop · test', body: 'Notifications work on this device.' },
    ]);

    const spike = page.getByRole('switch', { name: /^Security spike/ });
    await expect(spike).toBeChecked();
    await page.getByText('Security spike', { exact: true }).click();
    await expect(spike).not.toBeChecked();
    await expect
      .poll(() =>
        page.evaluate(() =>
          [...window.__beamhop.mock.daemon.pushPrefs.values()].some(
            (p: { security?: boolean }) => p.security === false,
          ),
        ),
      )
      .toBe(true);

    const dm = page.getByRole('switch', { name: /^Nostr DM fallback/ });
    const before = (await rpc<{ nostrDm: boolean }>(page, 'alerts.get')).nostrDm;
    await expect(dm).toBeChecked({ checked: before });
    await page.getByText('Nostr DM fallback', { exact: true }).click();
    await expect
      .poll(async () => (await rpc<{ nostrDm: boolean }>(page, 'alerts.get')).nostrDm)
      .toBe(!before);
    await expect(dm).toBeChecked({ checked: !before });
  });

  test('notifications: "Budget alert at" saves the percentage typed', async ({ page }) => {
    await open(page, '/settings/notifications');
    const budget = page.getByRole('textbox', { name: 'Budget alert at' });
    await budget.fill('70');
    await budget.press('Tab');
    await expect(budget).toHaveValue(/^70/, { timeout: 3000 });
    await expect
      .poll(async () => (await rpc<{ budgetWarn: number }>(page, 'alerts.get')).budgetWarn, { timeout: 3000 })
      .toBe(70);
  });

  test('notifications: blocked in the browser says how to allow them', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'the iPhone profile shows the install hint instead');
    await page.addInitScript(() => {
      Object.defineProperty(Notification, 'permission', { get: () => 'denied' });
    });
    await open(page, '/settings/notifications');
    const device = page.getByRole('region', { name: 'This device' });
    await expect(device.getByText('blocked', { exact: true })).toBeVisible();
    await expect(
      device.getByText(/Blocked for this site\. Allow notifications in your browser/),
    ).toBeVisible();
    await expect(device.getByRole('button', { name: 'Turn on notifications' })).toHaveCount(0);
  });

  test('notifications: a browser without notifications points to the DM fallback', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'the iPhone profile shows the install hint instead');
    await page.addInitScript(() => {
      delete (window as unknown as { Notification?: unknown }).Notification;
    });
    await open(page, '/settings/notifications');
    const device = page.getByRole('region', { name: 'This device' });
    await expect(device.getByText('unsupported', { exact: true })).toBeVisible();
    await expect(
      device.getByText(/This browser can't show notifications\. Use the Nostr DM fallback below\./),
    ).toBeVisible();
  });

  test('notifications: iPhone outside the installed app is told to add it to the Home Screen', async ({
    page,
  }, info) => {
    test.skip(info.project.name === 'desktop', 'iPhone user agent only');
    await open(page, '/settings/notifications');
    await expect(page.getByText(/iPhone sends alerts only to the installed app/)).toBeVisible();
  });

  test('about: who the daemon thinks you are, how you reach it, its version', async ({ page }) => {
    await open(page, '/settings/about');
    const you = page.getByRole('region', { name: 'You, as the daemon sees you' });
    await expect(you.getByText('alice', { exact: true })).toBeVisible();
    await expect(you.getByText('linked to alice')).toBeVisible();
    await expect(you.getByText('Demo daemon')).toBeVisible();
    await expect(you.getByText('nothing leaves this browser')).toBeVisible();
    const { version } = await rpc<{ version: string }>(page, 'system.status');
    await expect(
      page.getByRole('region', { name: 'Daemon' }).getByText(`beamhopd ${version}`, { exact: true }),
    ).toBeVisible();
    await expectAccessible(page);
    await open(page, '/settings/about?mockFail=system.whoami');
    await expect(page.getByRole('alert').getByText("Couldn't ask the daemon who you are.")).toBeVisible();
  });

  test('stop everything: history lists each stop and resume', async ({ page }) => {
    await open(page, '/settings/stop');
    const history = page.getByRole('region', { name: 'History' });
    await expect(history.getByText('Never used. Good.')).toBeVisible();
    await rpc(page, 'system.panic', { reason: 'e2e drill' });
    await expect(history.getByText('Stopped everything', { exact: true })).toBeVisible();
    await expect(history.getByText('alice stopped everything: e2e drill')).toBeVisible();
    await rpc(page, 'system.resume');
    await expect(history.getByText('Resumed after review', { exact: true })).toBeVisible();
    await expect(history.getByText('Never used. Good.')).toHaveCount(0);
  });

  test('updates: cloud daemons are listed until they are destroyed', async ({ page }) => {
    await open(page, '/settings/updates');
    const cloud = page.getByRole('region', { name: 'Cloud daemons' });
    await expect(cloud.getByText('ci-bot @ fly ams')).toBeVisible();
    await expect(cloud.getByText('reviewer-staging @ hetzner fsn1')).toBeVisible();
    await rpc(page, 'deploy.destroy', { id: 'dep_fly_ams1' });
    await rpc(page, 'deploy.destroy', { id: 'dep_hz_fsn1' });
    await invalidate(page, 'deploy.list');
    await expect(cloud.getByText("No cloud daemons. They follow this computer's version.")).toBeVisible();
  });

  test('an unknown section says so and links back to all settings', async ({ page }) => {
    await open(page, '/settings/nope');
    await expect(page.getByText('There\'s no "nope" section.')).toBeVisible();
    await page.getByRole('link', { name: 'All settings' }).click();
    await expect(page).not.toHaveURL(/\/settings\/nope/);
    await expect(page).toHaveURL(/\/settings/);
    await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible();
  });
});

// ─────────────────────────── Setup ───────────────────────────
test.describe('setup', () => {
  test('identity: back up the owner key now, or later', async ({ page }) => {
    await open(page, '/setup/identity');
    await expect(page.locator('[data-owner="ready"]')).toBeVisible();
    await page.getByRole('button', { name: 'Later' }).click();
    await expect(page.getByText("OK. Settings → Identity reminds you until it's done.")).toBeVisible();
    await open(page, '/setup/identity');
    await page.getByRole('button', { name: 'Export backup now' }).click();
    await expect(page.getByText('nsec1…(mock: never shown in demo)')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy secret key' })).toBeVisible();
  });

  test('identity: replace the key with a new one', async ({ page }) => {
    await open(page, '/setup/identity');
    await spy(page);
    await page.getByRole('button', { name: 'Use a different key…' }).click();
    await expect(page.getByRole('radio', { name: /Create a new owner key/ })).toBeChecked();
    await page.getByRole('button', { name: 'Create owner key' }).click();
    await expect(page.locator('[data-owner="ready"]')).toBeVisible();
    expect(await callsTo(page, 'identity.ownerCreate')).toEqual([{ replace: true }]);
  });

  test('identity: import a key from a bunker URL', async ({ page }) => {
    const hex = '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d';
    await open(page, '/setup/identity');
    await spy(page);
    await page.getByRole('button', { name: 'Use a different key…' }).click();
    await page.getByRole('radio', { name: /Connect a bunker \(NIP-46\)/ }).click({ force: true });
    const url = page.getByRole('textbox', { name: 'Bunker URL' });
    await expect(page.getByText('Paste it from your signer app.')).toBeVisible();
    await url.fill('bunker://not-a-key');
    await expect(
      page.getByText(/A bunker URL starts with bunker:\/\/ followed by a 64-character key/),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Use this key' })).toBeDisabled();
    await url.fill(`bunker://${hex}?relay=wss://relay.example.com`);
    await page.getByRole('button', { name: 'Use this key' }).click();
    await expect(page.locator('[data-owner="ready"]')).toBeVisible();
    expect(await callsTo(page, 'identity.ownerImport')).toEqual([
      { npub: 'npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6', replace: true },
    ]);
  });

  test('hello: a send failure explains what to check, and setup can finish without it', async ({ page }) => {
    await open(page, '/setup/hello?mockFail=onboarding.hello');
    const alert = page.getByRole('alert').filter({ hasText: "Couldn't send the hello." });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('Check your network, or add a relay in Channels → Nostr.');
    await page.getByRole('button', { name: 'Finish without testing' }).click();
    await expect(page).toHaveURL(/\/setup\/next/);
    await expect(page.getByRole('button', { name: 'Finish Say hello' })).toBeVisible();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('bh.setup') ?? '{}').skipped)).toContain(
      'hello',
    );
  });

  test('hello: no relay reachable says so before waiting', async ({ page }) => {
    await open(page, '/settings/about');
    await page.evaluate(() => {
      const ch = window.__beamhop.mock.daemon.state.channels.get('nostr');
      ch.config.settings.relaysUp = [];
    });
    await invalidate(page, 'channel.list');
    await go(page, '/setup/hello');
    await expect(page.getByText('No relay is reachable.')).toBeVisible();
    await expect(
      page.getByText(/Check your network or add a relay in Channels → Nostr\. The hello waits/),
    ).toBeVisible();
  });

  test('hello: with no agent, it offers to create one or finish setup', async ({ page }) => {
    await open(page, '/settings/about');
    for (const name of ['reviewer', 'ci-bot', 'helpdesk', 'scribe'])
      await rpc(page, 'agent.delete', { name });
    await invalidate(page, 'agent.list');
    await go(page, '/setup/hello');
    await expect(page.getByText("There's no agent to say hello yet.")).toBeVisible();
    await page.getByRole('button', { name: 'Create an agent' }).click();
    await expect(page).toHaveURL(/\/setup\/agent/);
    await expect(page.getByRole('heading', { name: 'Create your first agent' })).toBeVisible();
    await go(page, '/setup/hello');
    await page.getByRole('button', { name: 'Finish setup' }).click();
    await expect(page).toHaveURL(/\/setup\/next/);
  });

  test('hello: after the reply, next steps lead to adding a channel', async ({ page }) => {
    test.setTimeout(45_000);
    await open(page, '/setup/hello');
    await expect(page.getByRole('heading', { name: 'It works.' })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('link', { name: /Add Telegram, Slack or Discord/ }).click();
    await expect(page).toHaveURL(/\/channels\/add/);
  });

  test('harnesses (browser): login and install steps as commands, then Check again picks them up', async ({
    page,
  }) => {
    await open(page, '/settings/about');
    // A harness whose login the app can't drive, and one beamhop can't install by itself.
    await page.evaluate(() => {
      const hs = window.__beamhop.mock.daemon.state.harnesses;
      const cursor = hs.find((h: { id: string }) => h.id === 'cursor');
      delete cursor.loginFlow;
      const copilot = hs.find((h: { id: string }) => h.id === 'copilot');
      copilot.installPlan = {
        method: 'none',
        label: 'none',
        command: [],
        reason: 'No npm on this computer.',
      };
    });
    await invalidate(page, 'harness.scan');
    await go(page, '/setup/harnesses');
    await expect(page.getByText(/^7 found · 3 ready$/)).toBeVisible({ timeout: 5000 });
    const list = page.getByRole('list', { name: 'Harnesses' });
    await expect(list.getByText('cursor-agent login', { exact: true })).toBeVisible();
    await expect(list.getByRole('button', { name: 'Copy Cursor Agent login command' })).toBeVisible();
    await page.evaluate(() => {
      const cursor = window.__beamhop.mock.daemon.state.harnesses.find(
        (h: { id: string }) => h.id === 'cursor',
      );
      cursor.status = 'ready';
    });
    await list.getByRole('button', { name: 'Check again' }).click();
    await expect(page.getByText(/^7 found · 4 ready$/)).toBeVisible({ timeout: 5000 });

    await list.getByRole('button', { name: 'How to install Copilot CLI' }).click();
    const sheet = page.getByRole('dialog', { name: 'Install Copilot CLI' });
    await expect(sheet.getByText('npm i -g @github/copilot', { exact: true })).toBeVisible();
    await expect(sheet.getByText('brew install copilot-cli', { exact: true })).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Copy brew command' })).toBeVisible();
    await page.evaluate(() => {
      for (const h of window.__beamhop.mock.daemon.state.harnesses)
        if (h.id === 'copilot') Object.assign(h, { status: 'ready', version: '1.0.0' });
    });
    await sheet.getByRole('button', { name: 'Check again' }).click();
    await expect(sheet).toBeHidden();
    await expect(page.getByText(/^7 found · 5 ready$/)).toBeVisible({ timeout: 5000 });
  });

  test('doctor: Run again picks up a fix made outside beamhop', async ({ page }) => {
    await open(page, '/setup/doctor');
    await expect(page.getByText(/^5 checks · 4 ok · 1 attention$/)).toBeVisible();
    await page.evaluate(() => {
      const st = window.__beamhop.mock.daemon.state;
      st.doctor = st.doctor.map((c: { id: string; title: string }) =>
        c.id === 'userns' ? { id: c.id, title: c.title, status: 'ok', message: 'allowed for bwrap' } : c,
      );
    });
    await page.getByRole('button', { name: 'Run again' }).click();
    await expect(page.getByText(/^5 checks · 5 ok$/)).toBeVisible();
  });

  test('doctor: a fix that runs but does not help says so', async ({ page }) => {
    await open(page, '/setup/doctor');
    await page.evaluate(() => {
      const d = window.__beamhop.mock.daemon;
      d.handlers['system.doctorFix'] = async () => ({
        checks: d.state.doctor.map((c: { id: string; title: string }) =>
          c.id === 'userns' ? { ...c, status: 'warn', message: undefined } : c,
        ),
        output: '$ sh -c …\nexit 1',
      });
    });
    await page.getByRole('button', { name: 'Fix: user namespaces (AppArmor)' }).click();
    await expect(
      page.getByRole('alert').filter({ hasText: 'The fix ran, but the check still fails.' }),
    ).toBeVisible();
    await expect(page.getByText(/^5 checks · 4 ok · 1 attention$/)).toBeVisible();
  });

  test('agent: with no AI account ready, create explains what to do and creates nothing', async ({
    page,
  }) => {
    await open(page, '/settings/about');
    await page.evaluate(() => {
      for (const h of window.__beamhop.mock.daemon.state.harnesses)
        if (h.status === 'ready') h.status = 'needs-login';
    });
    await invalidate(page, 'harness.list');
    await go(page, '/setup/agent');
    await expect(page.getByRole('heading', { name: 'Create your first agent' })).toBeVisible();
    await expect(page.getByText('Sign in with your', { exact: false }).first()).toBeVisible();
    await page.getByRole('button', { name: /^Create [a-z]/ }).click();
    await expect(
      page.getByRole('alert').filter({ hasText: "Pick an AI account that's ready, or set one up." }),
    ).toBeVisible();
    const { agents } = await rpc<{ agents: unknown[] }>(page, 'agent.list');
    expect(agents).toHaveLength(4);
    await expect(page.locator('[data-agent="created"]')).toHaveCount(0);
  });
});
