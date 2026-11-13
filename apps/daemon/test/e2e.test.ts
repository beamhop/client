import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  body,
  type FakeHarnessSession,
  FakeHarnessPlugin,
  makeEnv,
  ownerAlice,
  setupBot,
  type TestEnv,
  tmpHome,
  until,
} from './helpers.ts';

let env: TestEnv | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

const group = { kind: 'group' as const, id: 'g1' };
const lastText = (env: TestEnv, conv: string) => env.conn().textsTo(conv).at(-1) ?? '';
const auditTypes = (env: TestEnv) => env.d.store.audit.query({ limit: 1000 }).map((e) => e.type);

describe('core loop', () => {
  it('owner DM gets a live-edited reply; transcript + events recorded', async () => {
    env = await makeEnv();
    const conn = await setupBot(env);
    await ownerAlice(env);
    conn.inject({ text: 'hello there' });
    await until(() => lastText(env!, 'alice').includes('reply: hello there'), 5000, 'reply');
    const sent = conn.sent.find((s) => s.text.includes('reply: hello there'))!;
    expect(sent.msg.threadId).toBe('alice');
    // preamble went to the harness, marked untrusted
    const prompt = env.harness.latest().prompts[0]!;
    expect(prompt).toContain('[beamhop] channel=fk:dm/alice');
    expect(prompt).toContain('role=owner');
    expect(prompt).toContain('untrusted');
    const [session] = env.d.store.sessions.list({ agent: 'bot' });
    await until(() => env!.d.store.sessions.events(session!.id).some((e) => e.kind === 'assistant'));
    const kinds = env.d.store.sessions.events(session!.id).map((e) => e.kind);
    expect(kinds).toContain('user');
    expect(kinds).toContain('assistant');
    expect(env.events.some((e) => e.type === 'session.event')).toBe(true);
    // resume token stored
    await until(() => env!.d.store.sessions.resumeToken(session!.id) !== undefined);
    // tool calls are hidden: no message mentions the harness internals
    expect(conn.sent.every((s) => !s.text.includes('tool_call'))).toBe(true);
  });

  it('non-edit channels get typing + final message', async () => {
    env = await makeEnv();
    env.channel.caps = { edit: false, buttons: false, typing: true, files: false, threads: false };
    const conn = await setupBot(env);
    await ownerAlice(env);
    conn.inject({ text: 'plain' });
    await until(() => lastText(env!, 'alice').includes('reply: plain'));
    expect(conn.typings.length).toBeGreaterThan(0);
    expect(conn.sent.every((s) => s.edits.length === 0)).toBe(true);
  });

  it('dedupes repeated message ids', async () => {
    env = await makeEnv();
    const conn = await setupBot(env);
    await ownerAlice(env);
    conn.inject({ id: 'same', text: 'one' });
    conn.inject({ id: 'same', text: 'one' });
    await until(() => lastText(env!, 'alice').includes('reply: one'));
    await new Promise((r) => setTimeout(r, 100));
    expect(env.harness.sessions.flatMap((s) => s.prompts)).toHaveLength(1);
  });

  it('group: ignored without mention, replies on mention', async () => {
    env = await makeEnv();
    const conn = await setupBot(env);
    conn.inject({ conversation: group, from: { principal: 'fake:bob', displayName: 'Bob' }, text: 'just chatting' });
    await new Promise((r) => setTimeout(r, 100));
    expect(env.harness.sessions).toHaveLength(0);
    conn.inject({ conversation: group, from: { principal: 'fake:bob', displayName: 'Bob' }, text: '@beambot summarize', mentionsAgent: true });
    await until(() => lastText(env!, 'g1').includes('reply: @beambot summarize'));
    expect(env.harness.latest().prompts[0]).toContain('role=user');
  });

  it('unknown DM sender is ignored, audited, and gets one access request; approving grants a role', async () => {
    env = await makeEnv();
    const conn = await setupBot(env);
    await ownerAlice(env);
    conn.inject({ text: 'hi, I am the owner' }); // records alice's DM for notifications
    await until(() => lastText(env!, 'alice').includes('reply:'));
    conn.inject({ conversation: { kind: 'dm', id: 'eve' }, from: { principal: 'fake:eve', displayName: 'Eve' }, text: 'let me in' });
    conn.inject({ conversation: { kind: 'dm', id: 'eve' }, from: { principal: 'fake:eve', displayName: 'Eve' }, text: 'please' });
    await until(() => env!.d.store.approvals.list().length === 1);
    expect(conn.textsTo('eve')).toHaveLength(0);
    const [req] = env.d.store.approvals.list();
    expect(req!.kind).toBe('access-request');
    expect(auditTypes(env)).toContain('sender.unknown');
    expect(lastText(env, 'alice')).toContain('Access request');
    await env.client.call('approval.decide', { id: req!.id, allow: true, grantRole: 'user' });
    await until(() => env!.d.agent('bot').grants['fake:eve'] === 'user', 3000, 'grant');
    conn.inject({ conversation: { kind: 'dm', id: 'eve' }, from: { principal: 'fake:eve', displayName: 'Eve' }, text: 'thanks' });
    await until(() => lastText(env!, 'eve').includes('reply: thanks'));
  });

  it('public agent answers strangers as viewer', async () => {
    env = await makeEnv();
    const conn = await setupBot(env, { public: true });
    conn.inject({ conversation: { kind: 'dm', id: 'eve' }, from: { principal: 'fake:eve' }, text: 'question' });
    await until(() => lastText(env!, 'eve').includes('reply: question'));
    expect(env.harness.latest().prompts[0]).toContain('role=viewer');
    expect(env.harness.latest().spec.permissionMode).toBe('read-only');
  });
});

describe('tools & approvals', () => {
  const bobDm = { kind: 'dm' as const, id: 'bob' };
  const bob = { principal: 'fake:bob', displayName: 'Bob' };

  it('viewer is denied the shell tool outright', async () => {
    env = await makeEnv();
    const conn = await setupBot(env);
    await env.client.call('role.grant', { principal: 'fake:bob', role: 'viewer', agent: 'bot' });
    conn.inject({ conversation: bobDm, from: bob, text: 'RUN_SHELL' });
    await until(() => lastText(env!, 'bob').includes('shell refused'));
    expect(lastText(env, 'bob')).toMatch(/denied/);
    expect(env.d.store.approvals.list()).toHaveLength(0);
    expect(auditTypes(env)).toContain('tool.denied');
  });

  const approvalSetup = async () => {
    env = await makeEnv();
    const conn = await setupBot(env);
    await ownerAlice(env);
    conn.inject({ text: 'hi' });
    await until(() => lastText(env!, 'alice').includes('reply: hi'));
    conn.inject({ conversation: group, from: bob, text: '@beambot RUN_SHELL', mentionsAgent: true });
    await until(() => env!.d.store.approvals.list().length === 1, 3000, 'approval');
    return { conn, approval: env.d.store.approvals.list()[0]! };
  };

  it('user shell needs approval: card with buttons to the owner, approve via button', async () => {
    const { conn, approval } = await approvalSetup();
    expect(approval.risk).toBe('high');
    expect(approval.requestedBy.role).toBe('user');
    const card = conn.sent.find((s) => s.text.includes('Approval needed'))!;
    expect(card.msg.conversation.id).toBe('alice');
    expect(card.msg.buttons?.map((b) => b.id)).toContain(`approve:${approval.id}`);
    expect(env!.events.some((e) => e.type === 'approval.created')).toBe(true);
    conn.press({ buttonId: `approve:${approval.id}`, principal: 'fake:alice', conversationId: 'alice' });
    await until(() => lastText(env!, 'g1').includes('shell allowed'), 3000, 'allowed');
    expect(env!.d.store.approvals.get(approval.id)!.status).toBe('approved');
    expect(auditTypes(env!)).toContain('approval.vote');
  });

  it('non-approvers cannot approve', async () => {
    const { conn, approval } = await approvalSetup();
    conn.press({ buttonId: `approve:${approval.id}`, principal: 'fake:bob', conversationId: 'g1' });
    await until(() => auditTypes(env!).includes('approval.unauthorized'));
    expect(env!.d.store.approvals.get(approval.id)!.status).toBe('pending');
  });

  it('deny via /deny command', async () => {
    const { conn, approval } = await approvalSetup();
    conn.inject({ text: `/deny ${approval.id}` });
    await until(() => lastText(env!, 'g1').includes('shell refused'), 3000);
    expect(lastText(env!, 'g1')).toContain('denied by');
  });

  it('timeout denies with "denied: timed out"', async () => {
    const { approval } = await approvalSetup();
    env!.clock.t += 16 * 60_000;
    await env!.d.tick();
    await until(() => lastText(env!, 'g1').includes('shell refused'));
    expect(lastText(env!, 'g1')).toContain('denied: timed out');
    expect(env!.d.store.approvals.get(approval.id)!.status).toBe('expired');
  });

  it('undo within the window reopens the approval; nothing reaches the harness', async () => {
    env = await makeEnv({ approvalUndoMs: 400 });
    const conn = await setupBot(env);
    await ownerAlice(env);
    conn.inject({ conversation: group, from: bob, text: '@beambot RUN_SHELL', mentionsAgent: true });
    await until(() => env!.d.store.approvals.list().length === 1);
    const id = env.d.store.approvals.list()[0]!.id;
    await env.client.call('approval.decide', { id, allow: true });
    const undone = await env.client.call('approval.undo', { id });
    expect(undone.status).toBe('pending');
    await new Promise((r) => setTimeout(r, 500));
    expect(env.harness.latest().decisions.size).toBe(0);
    await env.client.call('approval.decide', { id, allow: false });
    await until(() => lastText(env!, 'g1').includes('shell refused'), 3000);
  });

  it('owner "always" approval auto-allows the same tool for the rest of the session', async () => {
    const { approval } = await approvalSetup();
    await env!.client.call('approval.decide', { id: approval.id, allow: true, always: true });
    await until(() => lastText(env!, 'g1').includes('shell allowed'));
    const conn = env!.conn();
    conn.inject({ conversation: group, from: bob, text: '@beambot RUN_SHELL again', mentionsAgent: true });
    await until(() => conn.textsTo('g1').filter((t) => t.includes('shell allowed')).length === 2, 3000);
    expect(env!.d.store.approvals.list({ status: 'all' })).toHaveLength(1);
  });
});

describe('commands', () => {
  it('/pair links the sender as owner; bad codes are audited', async () => {
    env = await makeEnv();
    const conn = await setupBot(env);
    const { code } = await env.client.call('channel.pair', { name: 'fk' });
    const bob = { principal: 'fake:bob', displayName: 'Bob' };
    conn.inject({ conversation: { kind: 'dm', id: 'bob' }, from: bob, text: '/pair ZZZZZZ' });
    await until(() => auditTypes(env!).includes('pairing.failed'));
    conn.inject({ conversation: { kind: 'dm', id: 'bob' }, from: bob, text: `/pair ${code}` });
    await until(() => env!.d.global().owners.includes('fake:bob'));
    expect(env.d.global().people.owner).toContain('fake:bob');
    expect(lastText(env, 'bob')).toContain('Paired');
    expect(auditTypes(env)).toContain('pairing.success');
    // code is single-use
    conn.inject({ conversation: { kind: 'dm', id: 'eve' }, from: { principal: 'fake:eve' }, text: `/pair ${code}` });
    await until(() => auditTypes(env!).filter((t) => t === 'pairing.failed').length === 2);
    expect(env.d.global().owners).not.toContain('fake:eve');
    // owner can now talk
    conn.inject({ conversation: { kind: 'dm', id: 'bob' }, from: bob, text: 'hi owner' });
    await until(() => lastText(env!, 'bob').includes('reply: hi owner'));
  });

  it('/status, /usage, /help, /details, /stop, /new, /resume, /model, /mode, /harness', async () => {
    env = await makeEnv();
    const conn = await setupBot(env);
    await ownerAlice(env);
    const say = async (text: string, expectText: string | RegExp) => {
      const before = conn.textsTo('alice').length;
      conn.inject({ text });
      await until(() => conn.textsTo('alice').slice(before).some((t) => (typeof expectText === 'string' ? t.includes(expectText) : expectText.test(t))), 3000, text);
    };
    await say('/help', '/approve');
    await say('/status', 'No active session');
    await say('SLOW job', 'thinking hard');
    const first = env.harness.latest();
    await say('/status', 'running');
    await say('/stop', 'Stopped');
    expect(first.cancelled).toBeGreaterThan(0);
    await say('/details', 'No tool calls');
    await say('/usage', 'Today:');
    await say('/model gpt-x', 'Model set to `gpt-x`');
    await say('/mode plan', 'Mode set to plan');
    await say('/harness nope', 'not installed');
    await say('/new', 'new session');
    expect(first.closed).toBe(true);
    await say('/resume', 'Resumed session');
    await say('again', 'reply: again');
    // resumed session restarts the harness with the stored resume token
    expect(env.harness.latest().spec.resume).toBeUndefined();
  });

  it('viewer cannot reconfigure', async () => {
    env = await makeEnv();
    const conn = await setupBot(env);
    await env.client.call('role.grant', { principal: 'fake:bob', role: 'viewer', agent: 'bot' });
    conn.inject({ conversation: { kind: 'dm', id: 'bob' }, from: { principal: 'fake:bob' }, text: '/mode auto' });
    await until(() => lastText(env!, 'bob').includes('⛔'));
  });
});

describe('security', () => {
  it('DLP redacts a vault secret in a reply to a non-owner and alerts owners', async () => {
    const secret = `zq${randomBytes(20).toString('hex')}`;
    env = await makeEnv();
    env.harness.script = (await import('./helpers.ts')).defaultScript(secret);
    await env.secrets.set('MY_SERVICE_TOKEN', secret);
    const conn = await setupBot(env);
    await ownerAlice(env);
    conn.inject({ text: 'hi' });
    await until(() => lastText(env!, 'alice').includes('reply: hi'));
    await env.client.call('role.grant', { principal: 'fake:bob', role: 'user', agent: 'bot' });
    conn.inject({ conversation: { kind: 'dm', id: 'bob' }, from: { principal: 'fake:bob' }, text: 'LEAK it' });
    await until(() => lastText(env!, 'bob').includes('done'));
    for (const s of conn.sent.filter((x) => x.msg.conversation.id === 'bob')) {
      expect(s.text).not.toContain(secret);
      for (const e of s.edits) expect(e).not.toContain(secret);
    }
    expect(auditTypes(env)).toContain('dlp.hit');
    await until(() => conn.textsTo('alice').some((t) => t.includes('DLP')));
    // viewer role blocks instead
    await env.client.call('role.grant', { principal: 'fake:carol', role: 'viewer', agent: 'bot' });
    conn.inject({ conversation: { kind: 'dm', id: 'carol' }, from: { principal: 'fake:carol' }, text: 'LEAK it' });
    await until(() => lastText(env!, 'carol').includes('withheld'));
    // owners are only warned
    conn.inject({ text: 'LEAK it' });
    await until(() => conn.textsTo('alice').some((t) => t.includes(secret)));
  });

  it('daily budget: 80%/100% alerts and refusal afterwards', async () => {
    env = await makeEnv();
    const conn = await setupBot(env, { budgets: { dailyUsd: 2 } });
    await ownerAlice(env);
    conn.inject({ text: 'SPEND 1' });
    await until(() => lastText(env!, 'alice').includes('reply: SPEND 1'));
    conn.inject({ text: 'SPEND 2' });
    await until(() => conn.textsTo('alice').some((t) => t.includes('reply: SPEND 2')));
    await until(() => env!.d.store.audit.query({ type: 'budget.alert' }).length === 2);
    conn.inject({ text: 'SPEND 3' });
    await until(() => lastText(env!, 'alice').includes('daily budget'));
    expect(env.d.store.usage.totals({ agent: 'bot' }).usd).toBeCloseTo(3);
    const rows = (await env.client.call('usage.query', {})).rows;
    expect(rows[0]!.usd).toBeCloseTo(3);
  });

  it('rate limit per principal', async () => {
    env = await makeEnv();
    const conn = await setupBot(env, { public: true });
    for (let i = 0; i < 6; i++)
      conn.inject({ conversation: { kind: 'dm', id: 'eve' }, from: { principal: 'fake:eve' }, text: `q${i}` });
    await until(() => conn.textsTo('eve').some((t) => t.includes('rate limit')));
  });

  it('mesh: peer messages carry hops; hop limit drops and requires a human', async () => {
    env = await makeEnv();
    const conn = await setupBot(env);
    const peer = { principal: 'fake:otherbot', displayName: 'Other', isBot: true };
    conn.inject({ conversation: group, from: peer, text: '@beambot hello peer', mentionsAgent: true, hops: 1 });
    await until(() => lastText(env!, 'g1').includes('reply: @beambot hello peer'));
    expect(conn.sent.at(-1)!.msg.hops).toBe(2);
    expect(env.harness.latest().prompts[0]).toContain('role=agent');
    conn.inject({ conversation: group, from: peer, text: '@beambot deeper', mentionsAgent: true, hops: 3 });
    await until(() => auditTypes(env!).includes('mesh.limit'));
    // still blocked until a human speaks
    conn.inject({ conversation: group, from: peer, text: '@beambot retry', mentionsAgent: true, hops: 1 });
    await new Promise((r) => setTimeout(r, 100));
    expect(env.d.store.audit.query({ type: 'mesh.limit' })).toHaveLength(2);
    conn.inject({ conversation: group, from: { principal: 'fake:bob' }, text: '@beambot human here', mentionsAgent: true });
    await until(() => lastText(env!, 'g1').includes('human here'));
    conn.inject({ conversation: group, from: peer, text: '@beambot back again', mentionsAgent: true, hops: 1 });
    await until(() => lastText(env!, 'g1').includes('back again'));
  });

  it('kick-to-revoke: membership revoked, never auto-rejoined, audited', async () => {
    env = await makeEnv();
    const conn = await setupBot(env);
    conn.kick('g1');
    await until(() => !!env!.d.agent('bot').memberships.find((m) => m.target === 'fk:group/g1')?.revokedAt);
    expect(auditTypes(env)).toContain('membership.revoked');
    conn.inject({ conversation: group, from: { principal: 'fake:bob' }, text: '@beambot hi', mentionsAgent: true });
    await new Promise((r) => setTimeout(r, 100));
    expect(env.harness.sessions).toHaveLength(0);
    // explicit re-add clears the revocation
    await env.client.call('membership.join', { agent: 'bot', membership: { target: 'fk:group/g1', defaultRole: 'user' } });
    conn.inject({ conversation: group, from: { principal: 'fake:bob' }, text: '@beambot again', mentionsAgent: true });
    await until(() => lastText(env!, 'g1').includes('again'));
  });

  it('kicked from a wildcard group membership adds an explicit revoked entry', async () => {
    env = await makeEnv();
    const conn = await setupBot(env, {
      memberships: [{ target: 'fk:group', defaultRole: 'user', triggers: ['mention'] }],
    });
    conn.kick('g9');
    await until(() => env!.d.agent('bot').memberships.some((m) => m.target === 'fk:group/g9' && m.revokedAt));
    conn.inject({ conversation: { kind: 'group', id: 'g9' }, from: { principal: 'fake:bob' }, text: '@x', mentionsAgent: true });
    conn.inject({ conversation: { kind: 'group', id: 'g2' }, from: { principal: 'fake:bob' }, text: '@beambot ok', mentionsAgent: true });
    await until(() => lastText(env!, 'g2').includes('ok'));
    expect(conn.textsTo('g9')).toHaveLength(0);
  });

  it('panic kills sessions, disconnects channels, persists across restart; resume is explicit', async () => {
    const home = tmpHome();
    env = await makeEnv({ home });
    const conn = await setupBot(env);
    await ownerAlice(env);
    conn.inject({ text: 'SLOW task' });
    await until(() => env!.harness.sessions.length === 1 && env!.d.sessions.isBusy('bot'));
    const hs: FakeHarnessSession = env.harness.latest();
    await env.client.call('system.panic', { reason: 'test' });
    expect(hs.cancelled).toBeGreaterThan(0);
    expect(hs.closed).toBe(true);
    expect(conn.closed).toBe(true);
    expect(env.d.global().panic.active).toBe(true);
    expect(env.events.some((e) => e.type === 'panic' && e.active)).toBe(true);
    expect((await env.client.call('agent.get', { name: 'bot' })).status).toBe('paused');
    await expect(env.client.call('session.start', { agent: 'bot', text: 'x' })).rejects.toThrow(/panic/);
    await env.d.stop();
    // restart: still in panic, no channel connected
    const channel = env.channel;
    channel.conns.clear();
    const env2 = await makeEnv({ home, channel, harness: new FakeHarnessPlugin() });
    env = env2;
    expect(env2.d.isPanic()).toBe(true);
    expect(channel.conns.size).toBe(0);
    expect((await env2.client.call('system.status')).panic).toBe(true);
    await env2.client.call('system.resume');
    await until(() => channel.conns.has('fk'));
    expect(env2.d.isPanic()).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });
});

describe('parallel sessions', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } });

  it('git rw mounts get a worktree per session; beyond maxSessions messages queue', async () => {
    const repo = join(tmpHome(), 'repo');
    mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'README.md'), 'hi\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'init');
    const plain = join(tmpHome(), 'plain');
    mkdirSync(plain, { recursive: true });
    const release: (() => void)[] = [];
    const harness = new FakeHarnessPlugin(async function* (_s, prompt) {
      yield { type: 'text', delta: `start ${body(prompt)}` };
      await new Promise<void>((r) => release.push(r));
      yield { type: 'done', stopReason: 'end_turn' };
    });
    env = await makeEnv({ harness });
    const conn = await setupBot(env, {
      mounts: [{ path: repo, mode: 'rw' }, { path: plain, mode: 'rw', parallelUnsafe: true }],
      concurrency: { maxSessions: 2 },
    });
    const bob = { principal: 'fake:bob' };
    conn.inject({ conversation: group, threadId: 't-1', from: bob, text: '@beambot one', mentionsAgent: true });
    conn.inject({ conversation: group, threadId: 't-2', from: bob, text: '@beambot two', mentionsAgent: true });
    conn.inject({ conversation: group, threadId: 't-3', from: bob, text: '@beambot three', mentionsAgent: true });
    await until(() => harness.sessions.length === 2, 5000, 'two sessions');
    await until(() => env!.d.store.sessions.list({ status: 'queued' }).length === 1, 3000, 'queued');
    const [a, b] = harness.sessions;
    expect(a!.spec.cwd).not.toBe(b!.spec.cwd);
    expect(a!.spec.cwd.startsWith(join(env.home, 'worktrees'))).toBe(true);
    const branches = git(repo, 'branch', '--list', 'beamhop/*');
    expect(branches).toContain('beamhop/t-1');
    expect(branches).toContain('beamhop/t-2');
    const rec = env.d.store.sessions.list().find((s) => s.threadId === 't-1')!;
    expect(rec.worktree?.branch).toBe('beamhop/t-1');
    // the non-git rw mount is shared (parallelUnsafe)
    expect(a!.spec.mounts.find((m) => m.path === plain)).toBeTruthy();
    release.shift()!();
    await until(() => harness.sessions.length === 3, 5000, 'third starts after a slot frees');
    await until(() => release.length === 2);
    for (const r of release.splice(0)) r();
    await until(() => env!.d.store.sessions.list({ status: 'running' }).length === 0, 3000, 'all done');
  });

  it('non-git rw mounts take a write lock unless parallelUnsafe', async () => {
    const plain = join(tmpHome(), 'plain');
    mkdirSync(plain, { recursive: true });
    const release: (() => void)[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const harness = new FakeHarnessPlugin(async function* () {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise<void>((r) => release.push(r));
      concurrent--;
      yield { type: 'text', delta: 'done' };
      yield { type: 'done', stopReason: 'end_turn' };
    });
    env = await makeEnv({ harness });
    const conn = await setupBot(env, { mounts: [{ path: plain, mode: 'rw' }] });
    conn.inject({ conversation: group, threadId: 'a', from: { principal: 'fake:bob' }, text: '@beambot a', mentionsAgent: true });
    conn.inject({ conversation: group, threadId: 'b', from: { principal: 'fake:bob' }, text: '@beambot b', mentionsAgent: true });
    await until(() => release.length === 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(release.length).toBe(1);
    release.shift()!();
    await until(() => release.length === 1);
    release.shift()!();
    expect(maxConcurrent).toBe(1);
  });
});
