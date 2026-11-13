/**
 * Coverage for the agent page and Create agent that the journey specs leave out: header lifecycle
 * (start/stop, stop hard, move to cloud), the unsaved-changes guard and the review's YAML patch, the reach
 * part (memberships, mesh), what it can do (folders menu, network, learning, blocked hosts, spending,
 * export), advanced (model, login, limits, schedules of every kind, identity), list empty/error states and
 * the create form's deep link, error states, model, folder mode and the primed Telegram setup.
 * Every test asserts what the daemon (mock) ends up holding, not just what the screen shows.
 */
import type { AgentView } from '@beamhop/core';
import { expect, type Page, test } from '@playwright/test';
import { open, rpc, settle } from './helpers.ts';

type Policy = {
  profile: string;
  effective: { learning: boolean; net: { mode: string; allow: string[] } };
  userAllow?: string[];
};
type Schedule = { id: string; kind: string; spec: string; paused: boolean; agent: string };

const agentGet = (page: Page, name: string) => rpc<AgentView>(page, 'agent.get', { name });
const policyGet = (page: Page, name: string) => rpc<Policy>(page, 'policy.get', { name });
const schedules = (page: Page, agent: string) =>
  rpc<{ schedules: Schedule[] }>(page, 'schedule.list', { agent }).then((r) => r.schedules);
const toasts = (page: Page) => page.getByRole('region', { name: 'Notifications' });

/** Review & save the one dirty part of the page; returns once the daemon answered. */
const reviewAndSave = async (page: Page, name: string) => {
  await page.getByRole('button', { name: 'Review & save' }).click();
  const sheet = page.getByRole('dialog', { name: `Save changes to ${name}?` });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: /^(Save|Widen access)$/ }).click();
  await expect(
    toasts(page)
      .getByText(new RegExp(`Saved ${name}`))
      .first(),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review & save' })).toHaveCount(0);
};

/** Pick an option in a Select (popover on desktop, bottom sheet on phones). */
const pick = async (
  page: Page,
  trigger: RegExp,
  option: RegExp,
  scope: Page | ReturnType<Page['locator']> = page,
) => {
  await scope.getByRole('button', { name: trigger }).click();
  await page.getByRole('option', { name: option }).click();
};

/** Flip a switch the way a person does: on its (visible) label, once it can be used. */
const flip = async (sw: ReturnType<Page['locator']>) => {
  await expect(sw).toBeEnabled();
  await sw.locator('xpath=ancestor::label[1]').click();
};

const fillNumber = async (page: Page, label: string, value: string) => {
  const box = page.getByRole('textbox', { name: label, exact: true });
  await box.fill(value);
  await box.press('Tab');
};

// ─────────── Header lifecycle ───────────

test.describe('header lifecycle', () => {
  test('start a stopped agent, then stop it again', async ({ page }, info) => {
    const desktop = info.project.name === 'desktop';
    await open(page, '/agents/scribe');
    await page.getByRole('button', { name: desktop ? 'Start' : 'Start scribe', exact: true }).click();
    await expect(toasts(page).getByText('scribe started')).toBeVisible();
    await expect.poll(async () => (await agentGet(page, 'scribe')).status).toBe('idle');
    await page.getByRole('button', { name: desktop ? 'Stop' : 'Stop scribe', exact: true }).click();
    await expect(toasts(page).getByText('scribe stopped', { exact: true })).toBeVisible();
    await expect.poll(async () => (await agentGet(page, 'scribe')).status).toBe('stopped');
  });

  test('overflow: stop hard ends idle sessions too', async ({ page }) => {
    await open(page, '/agents/reviewer');
    await page.getByRole('button', { name: 'More actions for reviewer' }).click();
    await page.getByRole('menuitem', { name: 'Stop hard (end idle sessions too)' }).click();
    await expect(toasts(page).getByText('reviewer stopped hard · sessions ended')).toBeVisible();
    await expect.poll(async () => (await agentGet(page, 'reviewer')).status).toBe('stopped');
    const { sessions } = await rpc<{ sessions: { status: string }[] }>(page, 'session.list', {
      agent: 'reviewer',
    });
    expect(sessions.filter((s) => ['running', 'queued', 'idle'].includes(s.status))).toEqual([]);
    // Stop hard is only offered while it runs.
    await page.getByRole('button', { name: 'More actions for reviewer' }).click();
    await expect(page.getByRole('menuitem', { name: 'Clone…' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /Stop hard/ })).toHaveCount(0);
  });

  test('overflow: move to cloud opens the deploy form for this agent', async ({ page }) => {
    await open(page, '/agents/reviewer');
    await page.getByRole('button', { name: 'More actions for reviewer' }).click();
    await page.getByRole('menuitem', { name: 'Move to cloud…' }).click();
    await expect(page).toHaveURL(/\/deploy\/new\?(.*&)?agent=reviewer/);
  });

  test('a cloud agent is not offered "Move to cloud"', async ({ page }) => {
    await open(page, '/agents/ci-bot');
    await page.getByRole('button', { name: 'More actions for ci-bot' }).click();
    await expect(page.getByRole('menuitem', { name: 'Clone…' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Move to cloud…' })).toHaveCount(0);
  });
});

// ─────────── Editing: leave guard and review ───────────

test.describe('editing', () => {
  test('leaving with a draft asks first: keep editing, then discard', async ({ page }) => {
    await open(page, '/agents/reviewer/advanced');
    const field = page.getByRole('textbox', { name: 'Display name' });
    await field.fill('Rev the reviewer');
    await expect(page.getByText('1 change')).toBeVisible();
    const nav = page.getByRole('navigation', { name: 'reviewer sections' });
    await nav.getByRole('link', { name: 'Overview' }).click();
    const ask = page.getByRole('alertdialog', { name: 'Discard changes?' });
    await expect(ask).toBeVisible();
    await expect(ask).toContainText('1 unsaved change to reviewer is lost if you leave now.');
    await ask.getByRole('button', { name: 'Keep editing' }).click();
    await expect(ask).toBeHidden();
    await expect(page).toHaveURL(/\/agents\/reviewer\/advanced/);
    await expect(field).toHaveValue('Rev the reviewer');

    await nav.getByRole('link', { name: 'Overview' }).click();
    await page
      .getByRole('alertdialog', { name: 'Discard changes?' })
      .getByRole('button', { name: 'Discard' })
      .click();
    await expect(page).toHaveURL(/\/agents\/reviewer\/overview/);
    expect((await agentGet(page, 'reviewer')).config.displayName).toBe('reviewer');
    // Nothing is held back any more: the next navigation goes straight through.
    await nav.getByRole('link', { name: 'Advanced' }).click();
    await expect(page).toHaveURL(/\/agents\/reviewer\/advanced/);
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Display name' })).toHaveValue('reviewer');
  });

  test('the review shows the YAML patch that will be written', async ({ page }) => {
    await open(page, '/agents/reviewer/abilities');
    await fillNumber(page, 'Messages per minute', '12');
    await page.getByRole('button', { name: 'Review & save' }).click();
    const sheet = page.getByRole('dialog', { name: 'Save changes to reviewer?' });
    await expect(sheet.getByText('~/.beamhop/agents/reviewer.yaml')).toBeVisible();
    const yaml = sheet.getByRole('region', { name: 'YAML patch' });
    await expect(yaml).toContainText('budgets:');
    await expect(yaml).toContainText(/messagesPerMinute: 12/);
    await sheet.getByRole('button', { name: 'Keep editing' }).click();
    await expect(sheet).toBeHidden();
    await expect(page.getByText('1 change')).toBeVisible();
  });
});

// ─────────── Who can reach it ───────────

test.describe('reach', () => {
  test('join a channel: add a membership and save it', async ({ page }) => {
    await open(page, '/agents/reviewer/reach');
    await page.getByRole('button', { name: 'Join a channel' }).click();
    const sheet = page.getByRole('dialog', { name: 'Join a channel' });
    await expect(sheet).toBeVisible();
    await pick(page, /Channel$/, /^acme · Slack/, sheet);
    await expect(sheet.getByText('acme:dm')).toBeVisible();
    await sheet.getByRole('button', { name: 'Add membership' }).click();
    await expect(sheet).toBeHidden();
    // Slack targets read as slack:… in the list.
    await expect(page.getByRole('button', { name: 'Leave slack:dm' })).toBeVisible();
    await reviewAndSave(page, 'reviewer');
    const cfg = (await agentGet(page, 'reviewer')).config;
    expect(cfg.memberships.map((m) => m.target)).toContain('acme:dm');
    expect(cfg.memberships.find((m) => m.target === 'acme:dm')).toMatchObject({
      defaultRole: 'viewer',
      triggers: ['dm'],
    });
  });

  test('join: an existing membership cannot be added twice', async ({ page }) => {
    await open(page, '/agents/reviewer/reach');
    await page.getByRole('button', { name: 'Join a channel' }).click();
    const sheet = page.getByRole('dialog', { name: 'Join a channel' });
    await pick(page, /Channel$/, /^nostr · Nostr/, sheet);
    await expect(sheet.getByText('Already a member of nostr:dm.')).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Add membership' })).toBeDisabled();
  });

  test('leave a membership and save', async ({ page }) => {
    await open(page, '/agents/reviewer/reach');
    const before = (await agentGet(page, 'reviewer')).config.memberships.map((m) => m.target);
    expect(before).toContain('tg:group/-100123');
    await page
      .getByRole('button', { name: /^Leave / })
      .first()
      .click();
    await expect(page.getByText('1 change')).toBeVisible();
    await reviewAndSave(page, 'reviewer');
    const after = (await agentGet(page, 'reviewer')).config.memberships.map((m) => m.target);
    expect(after).toEqual(['nostr:dm']);
  });

  test('mesh: trust a peer, block a peer, raise the hop limit', async ({ page }) => {
    await open(page, '/agents/reviewer/reach');
    const hopsBefore = (await agentGet(page, 'reviewer')).config.mesh.maxHops;
    await page.getByRole('textbox', { name: 'Trust peer' }).fill('telegram:4242');
    await page.getByRole('button', { name: 'Trust peer' }).click();
    await page.getByRole('textbox', { name: 'Block peer' }).fill('nostr:spammer');
    await page.getByRole('textbox', { name: 'Block peer' }).press('Enter');
    await expect(page.getByText('telegram:4242')).toBeVisible();
    await expect(page.getByText('nostr:spammer')).toBeVisible();
    // A bad peer is refused with a reason.
    await page.getByRole('textbox', { name: 'Trust peer' }).fill('not a peer');
    await page.getByRole('button', { name: 'Trust peer' }).click();
    await expect(page.getByText('Use an npub or provider:id.')).toBeVisible();
    await page.getByRole('textbox', { name: 'Trust peer' }).fill('');
    await page.getByRole('button', { name: 'Increase Hop limit' }).click();
    await reviewAndSave(page, 'reviewer');
    const mesh = (await agentGet(page, 'reviewer')).config.mesh;
    expect(mesh.allow).toContain('telegram:4242');
    expect(mesh.block).toContain('nostr:spammer');
    expect(mesh.maxHops).toBe(hopsBefore + 1);
  });
});

// ─────────── What it can do ───────────

test.describe('abilities: internet and safety', () => {
  test('reach summary: "+N more" shows every host, "Show less" folds them again', async ({ page }) => {
    await open(page, '/agents/reviewer/abilities');
    const reach = page.getByRole('definition').filter({ hasText: 'api.anthropic.com' }).first();
    const dl = page.locator('dl[aria-label="What reviewer can reach"]');
    await expect(reach).toBeVisible();
    await expect(dl.getByText('objects.githubusercontent.com')).toHaveCount(0);
    await dl.getByRole('button', { name: '+2 more' }).click();
    await expect(dl.getByText('nodejs.org')).toBeVisible();
    await expect(dl.getByText('objects.githubusercontent.com')).toBeVisible();
    await dl.getByRole('button', { name: 'Show less' }).first().click();
    await expect(dl.getByText('objects.githubusercontent.com')).toHaveCount(0);
    await expect(dl.getByRole('button', { name: '+2 more' })).toBeVisible();
  });

  test('allow all network asks first, then saves the mode', async ({ page }) => {
    await open(page, '/agents/reviewer/abilities');
    const sw = page.getByRole('switch', { name: 'Allow all network' });
    await expect(sw).not.toBeChecked();
    await flip(sw);
    const dlg = page.getByRole('alertdialog', { name: 'Allow all network for reviewer?' });
    await expect(dlg).toContainText('reviewer can then send data to any site.');
    await dlg.getByRole('button', { name: 'Allow all' }).click();
    await expect(dlg).toBeHidden();
    await expect(page.getByText(/reviewer can reach any host\./)).toBeVisible();
    await expect(sw).toBeChecked();
    await expect.poll(async () => (await policyGet(page, 'reviewer')).effective.net.mode).toBe('all');
    expect((await agentGet(page, 'reviewer')).config.sandbox.policy?.net?.mode).toBe('all');
  });

  test('allow all network: cancelling the confirm changes nothing', async ({ page }) => {
    await open(page, '/agents/reviewer/abilities');
    await flip(page.getByRole('switch', { name: 'Allow all network' }));
    const dlg = page.getByRole('alertdialog', { name: 'Allow all network for reviewer?' });
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    await expect(dlg).toBeHidden();
    await expect(page.getByRole('switch', { name: 'Allow all network' })).not.toBeChecked();
    expect((await policyGet(page, 'reviewer')).effective.net.mode).toBe('restricted');
  });

  test('learning mode asks first, then is on', async ({ page }) => {
    await open(page, '/agents/reviewer/abilities');
    await flip(page.getByRole('switch', { name: 'Allow and log new hosts' }));
    const dlg = page.getByRole('alertdialog', { name: 'Turn on learning mode for reviewer?' });
    await expect(dlg).toContainText('locked paths like ~/.ssh stay blocked');
    await dlg.getByRole('button', { name: 'Turn on learning mode' }).click();
    await expect(toasts(page).getByText('Learning mode on for reviewer')).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Allow and log new hosts' })).toBeChecked();
    await expect.poll(async () => (await policyGet(page, 'reviewer')).effective.learning).toBe(true);
  });

  test('add a host to the allowlist, then remove it', async ({ page }) => {
    await open(page, '/agents/reviewer/abilities');
    const box = page.getByRole('textbox', { name: 'Add host' });
    await box.fill('not a host');
    await page.getByRole('button', { name: 'Add host' }).click();
    await expect(page.getByText('Enter a host name, like example.com or *.example.com.')).toBeVisible();
    await box.fill('Example.org');
    await page.getByRole('button', { name: 'Add host' }).click();
    await expect(page.getByRole('button', { name: 'Remove example.org' })).toBeVisible();
    await expect.poll(async () => (await policyGet(page, 'reviewer')).userAllow).toEqual(['example.org']);
    expect((await policyGet(page, 'reviewer')).effective.net.allow).toContain('example.org');
    await page.getByRole('button', { name: 'Remove example.org' }).click();
    await expect(page.getByText('No extra hosts.')).toBeVisible();
    await expect.poll(async () => (await policyGet(page, 'reviewer')).userAllow).toEqual([]);
  });

  test('blocked hosts: allow one, reject the other', async ({ page }) => {
    await open(page, '/agents/helpdesk/abilities');
    const blocked = page.locator('section[aria-labelledby="sb-blocked"]');
    const row = (host: string) => blocked.getByRole('listitem').filter({ hasText: host });
    await row('pypi.org').getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(row('pypi.org')).toHaveCount(0);
    await row('registry.npmjs.org').getByRole('button', { name: 'Reject' }).click();
    await expect(blocked.getByText('Nothing blocked.')).toBeVisible();
    const pol = await policyGet(page, 'helpdesk');
    expect(pol.effective.net.allow).toContain('pypi.org');
    expect(pol.effective.net.allow).not.toContain('registry.npmjs.org');
    const { suggestions } = await rpc<{ suggestions: { kind: string }[] }>(page, 'policy.suggestions', {
      name: 'helpdesk',
    });
    expect(suggestions.filter((s) => s.kind === 'net.allow')).toEqual([]);
  });

  test('test connections answers even when there is nothing to check', async ({ page }) => {
    await open(page, '/agents/reviewer/abilities');
    await page.getByRole('button', { name: 'Test connections' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'No hosts to check.' })).toBeVisible();
  });

  test('"Open Policy editor" opens the agent\'s profile', async ({ page }) => {
    await open(page, '/agents/reviewer/abilities');
    await page.getByRole('link', { name: /Open Policy editor/ }).click();
    await expect(page).toHaveURL(/\/policy\/workspace/);
  });
});

test.describe('abilities: spending', () => {
  test('daily budget and messages per minute are saved', async ({ page }) => {
    await open(page, '/agents/reviewer/abilities');
    await fillNumber(page, 'Daily budget', '7');
    await fillNumber(page, 'Messages per minute', '12');
    await expect(page.getByText('2 changes')).toBeVisible();
    await reviewAndSave(page, 'reviewer');
    const b = (await agentGet(page, 'reviewer')).config.budgets;
    expect(b.dailyUsd).toBe(7);
    expect(b.messagesPerMinute).toBe(12);
    // The header readout follows the new budget.
    await expect(page.getByRole('meter', { name: 'reviewer budget today' }).first()).toHaveAttribute(
      'aria-valuemax',
      '7',
    );
  });

  test("export the agent's data", async ({ page }) => {
    await open(page, '/agents/reviewer/abilities');
    await page.getByRole('button', { name: "Export reviewer's data" }).click();
    await expect(
      toasts(page).getByText(/^Exported to ~\/\.beamhop\/exports\/beamhop-\d{4}-\d{2}-\d{2}\.tar\.gz$/),
    ).toBeVisible();
  });
});

test.describe('abilities: folders', () => {
  test('move a folder up, then back down', async ({ page }) => {
    await open(page, '/agents/reviewer/abilities');
    await page.getByRole('button', { name: 'Options for ~/notes' }).click();
    await expect(page.getByRole('menuitem', { name: 'Move down' })).toBeDisabled();
    await page.getByRole('menuitem', { name: 'Move up' }).click();
    await reviewAndSave(page, 'reviewer');
    expect((await agentGet(page, 'reviewer')).config.mounts.map((m) => m.path)).toEqual([
      '~/notes',
      '~/code/app',
    ]);
    await page.getByRole('button', { name: 'Options for ~/notes' }).click();
    await page.getByRole('menuitem', { name: 'Move down' }).click();
    await reviewAndSave(page, 'reviewer');
    expect((await agentGet(page, 'reviewer')).config.mounts.map((m) => m.path)).toEqual([
      '~/code/app',
      '~/notes',
    ]);
  });

  test('remove a folder', async ({ page }) => {
    await open(page, '/agents/reviewer/abilities');
    await page.getByRole('button', { name: 'Options for ~/notes' }).click();
    await page.getByRole('menuitem', { name: 'Remove folder' }).click();
    await expect(page.getByRole('button', { name: 'Options for ~/notes' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Review & save' }).click();
    await expect(
      page
        .getByRole('dialog', { name: 'Save changes to reviewer?' })
        .getByText('reviewer will no longer see ~/notes.'),
    ).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(
      toasts(page)
        .getByText(/Saved reviewer/)
        .first(),
    ).toBeVisible();
    expect((await agentGet(page, 'reviewer')).config.mounts.map((m) => m.path)).toEqual(['~/code/app']);
  });

  test('parallel writes without a lock, then require the write lock again', async ({ page }) => {
    await open(page, '/agents/scribe/abilities');
    await page.getByRole('button', { name: 'Options for ~/notes' }).click();
    await page.getByRole('menuitem', { name: 'Allow parallel writes (no lock)' }).click();
    await expect(page.getByText('Parallel writes allowed without a lock.', { exact: false })).toBeVisible();
    await reviewAndSave(page, 'scribe');
    expect((await agentGet(page, 'scribe')).config.mounts[0]).toMatchObject({
      path: '~/notes',
      parallelUnsafe: true,
    });
    await page.getByRole('button', { name: 'Options for ~/notes' }).click();
    await page.getByRole('menuitem', { name: 'Require a write lock' }).click();
    await expect(page.getByText(/parallel sessions wait for a write lock/)).toBeVisible();
    await reviewAndSave(page, 'scribe');
    expect((await agentGet(page, 'scribe')).config.mounts[0]).toMatchObject({
      path: '~/notes',
      parallelUnsafe: false,
    });
  });
});

// ─────────── Advanced ───────────

test.describe('advanced: program and model', () => {
  test('model: a listed model, the harness default, and a typed model id are saved', async ({ page }) => {
    await open(page, '/agents/reviewer/advanced');
    const program = page.locator('#agent-program');
    await pick(page, /Model$/, /^Sonnet/, program);
    await reviewAndSave(page, 'reviewer');
    expect((await agentGet(page, 'reviewer')).config.model).toBe('sonnet');

    await pick(page, /Model$/, /^Harness default/, program);
    await reviewAndSave(page, 'reviewer');
    expect((await agentGet(page, 'reviewer')).config.model).toBe('default');

    await pick(page, /Model$/, /^Other model/, program);
    await program.getByRole('textbox', { name: 'Model id' }).fill('claude-next-preview');
    await reviewAndSave(page, 'reviewer');
    expect((await agentGet(page, 'reviewer')).config.model).toBe('claude-next-preview');
  });

  test('subscription login is a widening change, saved after review', async ({ page }) => {
    await open(page, '/agents/reviewer/advanced');
    await page.getByText('Subscription login', { exact: true }).click();
    await expect(page.getByRole('radio', { name: /Subscription login/ })).toBeChecked();
    await expect(page.getByText('Widens access')).toBeVisible();
    await reviewAndSave(page, 'reviewer');
    expect((await agentGet(page, 'reviewer')).config.harnessAuth).toBe('subscription');
  });

  test('copy the login command of a harness that needs a login', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await open(page, '/agents/ci-bot/advanced');
    await expect(page.getByText('codex login', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Copy login command' }).click();
    await expect(page.locator('#agent-program').getByRole('button', { name: 'Copied' })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('codex login');
  });

  test('auto-deny approvals after is saved', async ({ page }) => {
    await open(page, '/agents/reviewer/advanced');
    await fillNumber(page, 'Auto-deny approvals after', '30');
    await reviewAndSave(page, 'reviewer');
    expect((await agentGet(page, 'reviewer')).config.approvalTimeoutMinutes).toBe(30);
  });
});

test.describe('advanced: schedules', () => {
  test('run now starts a run', async ({ page }) => {
    await open(page, '/agents/reviewer/advanced');
    await page.getByRole('button', { name: 'Run now' }).click();
    await expect(toasts(page).getByText('Started a run')).toBeVisible();
    const { events } = await rpc<{ events: { type: string }[] }>(page, 'audit.query', {
      agent: 'reviewer',
      limit: 50,
    });
    expect(events.map((e) => e.type)).toContain('schedule.run');
  });

  test('pause and resume with the Active switch', async ({ page }) => {
    await open(page, '/agents/reviewer/advanced');
    const sw = page.locator('#agent-schedules').getByRole('switch', { name: 'Active' });
    await expect(sw).toBeChecked();
    await flip(sw);
    await expect(sw).not.toBeChecked();
    await expect(page.locator('#agent-schedules').getByText('paused', { exact: true })).toBeVisible();
    await expect.poll(async () => (await schedules(page, 'reviewer'))[0]?.paused).toBe(true);
    await flip(sw);
    await expect(sw).toBeChecked();
    await expect.poll(async () => (await schedules(page, 'reviewer'))[0]?.paused).toBe(false);
  });

  test('remove a cron schedule (with undo offered)', async ({ page }) => {
    await open(page, '/agents/reviewer/advanced');
    await page.getByRole('button', { name: 'Remove schedule 0 9 * * 1-5' }).click();
    await expect(toasts(page).getByText('Schedule removed')).toBeVisible();
    await expect(toasts(page).getByRole('button', { name: 'Undo' })).toBeVisible();
    await expect(page.getByText('No schedules.')).toBeVisible();
    expect(await schedules(page, 'reviewer')).toEqual([]);
  });

  test('removing a webhook asks first, because its secret cannot come back', async ({ page }) => {
    await open(page, '/agents/ci-bot/advanced');
    await page.getByRole('button', { name: 'Remove schedule /hooks/ci-nightly' }).click();
    const dlg = page.getByRole('alertdialog', { name: 'Remove this webhook?' });
    await expect(dlg).toContainText('Calls to /hooks/ci-nightly will fail.');
    await dlg.getByRole('button', { name: 'Remove webhook' }).click();
    await expect(toasts(page).getByText('Schedule removed')).toBeVisible();
    expect(await schedules(page, 'ci-bot')).toEqual([]);
  });

  test('a file-change schedule', async ({ page }) => {
    await open(page, '/agents/reviewer/advanced');
    await page.getByRole('button', { name: 'Add schedule' }).first().click();
    const sheet = page.getByRole('dialog', { name: 'New schedule for reviewer' });
    await sheet.getByRole('radio', { name: 'File change' }).click();
    const glob = sheet.getByRole('textbox', { name: 'File pattern' });
    await expect(glob).toHaveValue('~/code/app/**/*.md');
    await glob.fill('~/notes/**/*.md');
    await sheet.getByRole('textbox', { name: 'What should it do?' }).fill('Summarise changed notes.');
    await sheet.getByRole('button', { name: 'Add schedule' }).click();
    await expect(sheet).toBeHidden();
    await expect(toasts(page).getByText('Schedule added')).toBeVisible();
    await expect(page.getByText('Runs when a matching file changes inside a mounted folder.')).toBeVisible();
    const added = (await schedules(page, 'reviewer')).find((s) => s.kind === 'file-change');
    expect(added).toMatchObject({ spec: '~/notes/**/*.md', agent: 'reviewer' });
  });

  test('a Nostr event schedule', async ({ page }) => {
    await open(page, '/agents/reviewer/advanced');
    await page.getByRole('button', { name: 'Add schedule' }).first().click();
    const sheet = page.getByRole('dialog', { name: 'New schedule for reviewer' });
    await sheet.getByRole('radio', { name: 'Nostr event' }).click();
    const filter = sheet.getByRole('textbox', { name: 'Nostr filter' });
    await expect(filter).toHaveValue('{"kinds":[1],"#t":["deploy"]}');
    await filter.fill('{"kinds":[1],"#t":["release"]}');
    await sheet.getByRole('textbox', { name: 'What should it do?' }).fill('Announce the release.');
    await sheet.getByRole('button', { name: 'Add schedule' }).click();
    await expect(sheet).toBeHidden();
    await expect(toasts(page).getByText('Schedule added')).toBeVisible();
    const added = (await schedules(page, 'reviewer')).find((s) => s.kind === 'nostr-event');
    expect(added).toMatchObject({ spec: '{"kinds":[1],"#t":["release"]}' });
  });
});

test.describe('advanced: identity', () => {
  test('display name and about are saved', async ({ page }) => {
    await open(page, '/agents/reviewer/advanced');
    await page.getByRole('textbox', { name: 'Display name' }).fill('Rev');
    await page.getByRole('textbox', { name: 'About' }).fill('Reviews pull requests for acme/app.');
    // The preview follows the draft.
    await expect(page.locator('#agent-identity').getByText('Rev', { exact: true })).toBeVisible();
    await expect(page.getByText('2 changes')).toBeVisible();
    await reviewAndSave(page, 'reviewer');
    const cfg = (await agentGet(page, 'reviewer')).config;
    expect(cfg.displayName).toBe('Rev');
    expect(cfg.description).toBe('Reviews pull requests for acme/app.');
  });

  test('copy npub', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await open(page, '/agents/reviewer/advanced');
    const identity = page.locator('#agent-identity');
    await identity.getByRole('button', { name: 'Copy npub' }).click();
    await expect(identity.getByRole('button', { name: 'Copied' })).toBeVisible();
    const npub = (await agentGet(page, 'reviewer')).config.identity.npub;
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(npub);
  });
});

// ─────────── Agents list states ───────────

test.describe('agents list states', () => {
  test('no agents yet', async ({ page }) => {
    await open(page, '/agents');
    await expect(page.getByRole('list', { name: 'Agents' }).getByText('reviewer').first()).toBeVisible();
    const { agents } = await rpc<{ agents: AgentView[] }>(page, 'agent.list');
    for (const a of agents) await rpc(page, 'agent.delete', { name: a.config.name });
    // The daemon sends no event for a delete made elsewhere: refetch like a focus/reconnect would.
    await page.evaluate(() =>
      (
        window as unknown as {
          __beamhop: { runtime: { queryClient: { invalidateQueries: () => Promise<void> } } };
        }
      ).__beamhop.runtime.queryClient.invalidateQueries(),
    );
    await expect(page.getByText('No agents yet.')).toBeVisible();
    await expect(page.getByText(/An agent is a harness like Claude Code, in a sandbox/)).toBeVisible();
    await expect(page.getByRole('list', { name: 'Agents' })).toHaveCount(0);
  });

  test("couldn't load your agents", async ({ page }) => {
    await open(page, '/agents?mockFail=agent.list');
    await expect(page.getByText("Couldn't load your agents.")).toBeVisible();
    await expect(page.getByRole('button', { name: /Try again|Retry/ }).first()).toBeVisible();
  });
});

// ─────────── Create agent ───────────

test.describe('create agent', () => {
  test('a ?preset= deep link preselects that preset', async ({ page }) => {
    await open(page, '/agents/new?preset=team-dev-bot');
    await expect(page.getByRole('radio', { name: /^Team dev bot/ })).toBeChecked({ timeout: 3000 });
    await expect(page.getByRole('textbox', { name: 'Name' })).toHaveValue('devbot', { timeout: 3000 });
  });

  test('a failed create says so and stays on the form', async ({ page }) => {
    await open(page, '/agents/new?mockFail=agent.create');
    await expect(page.getByRole('textbox', { name: 'Name' })).toHaveValue('assistant');
    await page.getByRole('button', { name: 'Create assistant', exact: true }).click();
    await expect(page.getByText("Couldn't create assistant.")).toBeVisible();
    await expect(page).toHaveURL(/\/agents\/new/);
    const { agents } = await rpc<{ agents: AgentView[] }>(page, 'agent.list');
    expect(agents.map((a) => a.config.name)).not.toContain('assistant');
  });

  test("presets that can't load show an error with retry", async ({ page }) => {
    await open(page, '/agents/new?mockFail=agent.presets');
    await expect(page.getByText("Couldn't load presets or harnesses.")).toBeVisible();
    await expect(page.getByRole('button', { name: /Create/ })).toHaveCount(0);
  });

  test('a model picked under Advanced ends up in the created agent', async ({ page }) => {
    await open(page, '/agents/new');
    await page.getByText('Advanced: model and program').click();
    await expect(page.getByText(/Runs on Claude Code/)).toBeVisible();
    await pick(page, /Model$/, /^Opus/);
    await page.getByRole('button', { name: 'Create assistant', exact: true }).click();
    await expect(page).toHaveURL(/\/agents\/assistant/);
    const cfg = (await agentGet(page, 'assistant')).config;
    expect(cfg.harness).toBe('claude');
    expect(cfg.model).toBe('opus');
  });

  test('a folder switched to read-write is created read-write', async ({ page }) => {
    await open(page, '/agents/new');
    await expect(page.getByRole('radio', { name: /^Personal assistant/ })).toBeChecked();
    await page.getByRole('button', { name: 'Add folder' }).click();
    await page.getByRole('combobox', { name: 'Folder' }).fill('~/notes');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Add folder' }).click();
    await expect(page.getByRole('button', { name: 'Options for ~/notes' })).toBeVisible();
    await page
      .getByRole('radiogroup', { name: 'Access to ~/notes' })
      .getByRole('radio', { name: 'Read-write' })
      .click();
    await page.getByRole('button', { name: 'Create assistant', exact: true }).click();
    await expect(page).toHaveURL(/\/agents\/assistant/);
    const mounts = (await agentGet(page, 'assistant')).config.mounts;
    expect(mounts).toEqual([expect.objectContaining({ path: '~/notes', mode: 'rw' })]);
  });

  test('create and connect Telegram: the setup ends on the agent, which now listens there', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await open(page, '/agents/new');
    await page.getByRole('radio', { name: 'Telegram' }).click();
    await page.getByRole('button', { name: 'Create assistant and connect Telegram' }).click();
    await expect(page).toHaveURL(/\/channels\/add\/telegram\/1/);
    await expect(page.getByRole('button', { name: 'Continue · Credentials' })).toBeVisible();
    expect((await agentGet(page, 'assistant')).config.name).toBe('assistant');

    await page.getByRole('button', { name: 'Continue · Credentials' }).click();
    await page.getByLabel('Bot token', { exact: true }).fill(`${'7'.repeat(9)}:${'Ab3_'.repeat(9)}`);
    await expect(page.getByText('format ✓ · Looks like a bot token')).toBeVisible();
    const connect = page.getByRole('button', { name: /^Connect @/ });
    await expect(connect).toBeEnabled();
    await connect.click();

    await expect(page).toHaveURL(/\/channels\/add\/telegram\/5/, { timeout: 5000 });
    await expect(page.getByText('Paired with @alice').first()).toBeVisible({ timeout: 8000 });
    await page.getByRole('button', { name: 'This is me · Join' }).click();

    await expect(page).toHaveURL(/\/channels\/add\/telegram\/6/);
    await expect(page.getByRole('heading', { name: 'Choose who answers here' })).toBeVisible();
    await settle(page);
    await expect(page.getByRole('checkbox', { name: /^assistant/ })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: /^reviewer/ })).not.toBeChecked();
    await page.getByRole('button', { name: 'Finish · Add Telegram' }).click();

    await expect(page).toHaveURL(/\/agents\/assistant(\/|\?|$)/);
    const { channels } = await rpc<{ channels: { config: { name: string; provider: string } }[] }>(
      page,
      'channel.list',
    );
    const added = channels.find((c) => c.config.provider === 'telegram' && c.config.name !== 'tg');
    expect(added, 'the new Telegram channel').toBeTruthy();
    const targets = (await agentGet(page, 'assistant')).config.memberships.map((m) => m.target);
    expect(targets).toContain(`${added!.config.name}:dm`);
  });
});
