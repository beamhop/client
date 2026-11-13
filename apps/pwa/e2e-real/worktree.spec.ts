/**
 * A finished session on a git worktree, against the real daemon and real git: the agent (`bot`,
 * rw mount `~/code/app`, seeded by the control API) writes a file in its worktree; the owner merges
 * the branch from the session's end card (`session.merge` → a merge commit on `main` in the repo)
 * and opens a PR (`session.openPr` → a `git.push` approval in the Inbox → approved → the branch
 * lands in the bare `origin`).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { axe, expect, test } from './fixtures.ts';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();

interface Session {
  id: string;
  status: string;
  worktree?: { path: string; branch: string };
}

test('finished worktree session: Merge commits on main, Open PR pushes after an Inbox approval', async ({
  page,
  bh,
}) => {
  const g = await bh.seedGit();
  const mainBefore = git(g.repo, 'rev-parse', 'main');
  await bh.inject({ text: 'WRITE feature.txt from the agent' });
  await expect.poll(async () => (await bh.sentTo('alice')).join('\n')).toContain('wrote feature.txt');
  const { sessions } = await bh.rpc<{ sessions: Session[] }>('session.list');
  const s = sessions[0]!;
  expect(s.worktree?.branch).toMatch(/^beamhop\//);
  const branch = s.worktree!.branch;
  // The agent wrote into its own worktree, not into the repository the owner has checked out.
  expect(readFileSync(join(s.worktree!.path, 'feature.txt'), 'utf8')).toBe('from the agent\n');
  expect(existsSync(join(g.repo, 'feature.txt'))).toBe(false);
  await bh.rpc('session.stop', { id: s.id });

  await bh.open(page, `/sessions/${s.id}`);
  const end = page.getByRole('region', { name: 'Session ended' });
  await expect(end.getByText(`The work is on branch ${branch}`)).toBeVisible();
  await axe(page);

  // ── Merge ──
  await end.getByRole('button', { name: 'Merge branch' }).click();
  const confirm = page.getByRole('alertdialog', { name: `Merge ${branch}?` });
  await expect(confirm).toBeVisible();
  await axe(page);
  await confirm.getByRole('button', { name: 'Merge branch' }).click();
  await expect(end.getByRole('status').filter({ hasText: `Merged ${branch} into main` })).toBeVisible();
  // On disk: a merge commit on main whose second parent is the session branch, with the agent's file.
  const subject = git(g.repo, 'log', '-1', '--format=%s', 'main');
  expect(subject).toBe(`Merge ${branch} (beamhop session ${s.id})`);
  const parents = git(g.repo, 'log', '-1', '--format=%P', 'main').split(' ');
  expect(parents).toEqual([mainBefore, git(g.repo, 'rev-parse', `refs/heads/${branch}`)]);
  expect(readFileSync(join(g.repo, 'feature.txt'), 'utf8')).toBe('from the agent\n');
  expect(git(g.repo, 'status', '--porcelain')).toBe('');
  // The transcript shows it (a system event from the daemon, live).
  await expect(
    page.getByRole('log', { name: 'Transcript with bot' }).getByText(`Merged ${branch} into main`),
  ).toBeVisible();

  // ── Open PR: nothing is pushed until an owner approves ──
  await end.getByRole('button', { name: 'Open PR' }).click();
  await expect(end.getByText(`Pushing ${branch} is waiting for approval.`)).toBeVisible();
  const pending = await bh.rpc<{ approvals: { id: string; tool: string; sessionId: string }[] }>(
    'approval.list',
  );
  expect(pending.approvals).toEqual([expect.objectContaining({ tool: 'git.push', sessionId: s.id })]);
  expect(() => git(g.remote, 'rev-parse', '--verify', `refs/heads/${branch}`)).toThrow();
  await axe(page);

  await end.getByRole('link', { name: 'Review in Inbox' }).click();
  await expect(page).toHaveURL(new RegExp(`/inbox/${pending.approvals[0]!.id}`));
  await bh.open(page, '/inbox');
  await expect(page.getByText(`git push origin ${branch}`).first()).toBeVisible();
  await page
    .getByRole('button', { name: /^Allow… \(choose scope\): bot/ })
    .first()
    .click();
  const sheet = page.getByRole('dialog', { name: /Allow/ });
  await expect(sheet.getByText('Allow once').first()).toBeVisible();
  await axe(page);
  await sheet.getByRole('button', { name: 'Allow once' }).click();
  await expect(page.getByRole('region', { name: 'Notifications' }).getByText(/Allowed once/)).toBeVisible();

  // After the undo window the daemon pushes: the bare remote has the branch at the worktree's head.
  await expect
    .poll(
      () => {
        try {
          return git(g.remote, 'rev-parse', '--verify', `refs/heads/${branch}`);
        } catch {
          return '';
        }
      },
      { timeout: 15_000 },
    )
    .toBe(git(g.repo, 'rev-parse', `refs/heads/${branch}`));
  expect(git(g.remote, 'show', `${branch}:feature.txt`)).toBe('from the agent');
  const { events } = await bh.rpc<{ events: { type: string }[] }>('audit.query', { limit: 50 });
  expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['session.merged', 'session.pushed']));

  await bh.open(page, `/sessions/${s.id}`);
  await expect(
    page.getByRole('region', { name: 'Session ended' }).getByText(`Pushed ${branch}.`),
  ).toBeVisible();
  await expect(
    page.getByRole('log', { name: 'Transcript with bot' }).getByText(`Pushed ${branch} to origin.`),
  ).toBeVisible();
  await axe(page);
});
