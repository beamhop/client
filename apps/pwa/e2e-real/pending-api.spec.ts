/**
 * Journeys that need API methods another builder is adding to `@beamhop/core` + beamhopd
 * (session.merge / session.openPr, fs.list, alerts.*, role.define, system.whoami, approval
 * quorum/votes). They were `fixme` while those methods were missing on the daemon; the methods have
 * since landed on main (merged here) but these journeys are not written against them yet. Each
 * note says what the test must check.
 */
import { test } from './fixtures.ts';

test.fixme('finished worktree session: Merge / Open PR call session.merge / session.openPr', async () => {
  // Needs session.merge + session.openPr. Run a session with a worktree mount, stop it, press
  // "Open PR" and "Merge" on /sessions/<id>; expect the daemon to report the PR / merge and the
  // transcript to show it (the mock currently fakes this with session.send).
});

test.fixme('New Agent → Folders → Browse lists real directories (fs.list)', async () => {
  // Needs fs.list. In /agents/new step Folders, open Browse, pick a temp directory created by the
  // test, create the agent, expect agents/<name>.yaml to mount it read-only.
});

test.fixme('Audit → Alert rules are stored on the daemon (alerts.*)', async () => {
  // Needs alerts.list / alerts.set. Open Audit → Security → Alert rules, change a threshold, reload,
  // expect the rule from the daemon (today the sheet keeps rules client-side).
});

test.fixme('Policy → Roles: define a custom role (role.define)', async () => {
  // Needs role.define. Create a role from /policy/roles, expect role.list to contain it and the
  // Join step's role picker to offer it.
});

test.fixme('Settings → About shows who the daemon thinks you are (system.whoami)', async () => {
  // Needs system.whoami. Expect the local owner principal and the connection kind (local WebSocket).
});

test.fixme('N-of-M approval: quorum and votes from the daemon (approval quorum/votes)', async () => {
  // Needs ApprovalView.quorum/votes from beamhopd (config approvals.quorum: 2, two owners). Approve
  // from the PWA → "Waiting on others" with 1 of 2; a second owner's /approve on the fake channel
  // completes it and the harness receives the decision.
});
