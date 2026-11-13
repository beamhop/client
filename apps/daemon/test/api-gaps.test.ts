// API gaps reported by the PWA screen builders: approval quorum/votes/scope/rules/reasons, policy
// suggestion values, channel pairings/chats, connect/disconnect, whoami, alerts, updates, quorum,
// custom roles, owners/people, instruction file writes, deploy params, worktree merge and PR push.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RpcError } from '@beamhop/client';
import type { Deployer, DeploySpec, HarnessEvent } from '@beamhop/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  body,
  defaultScript,
  FakeHarnessPlugin,
  makeEnv,
  ownerAlice,
  type Script,
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

const code = (e: unknown) => (e as RpcError).beamhopCode ?? (e as { code?: string }).code;
const group = { kind: 'group' as const, id: 'g1', title: 'app-dev' };
const bob = { principal: 'fake:bob', displayName: 'Bob' };
const lastText = (e: TestEnv, conv: string) => e.conn().textsTo(conv).at(-1) ?? '';
const auditOf = (e: TestEnv, type: string) => e.d.store.audit.query({ type });

/** `TOOL {"tool":"WebFetch","input":{...}}` asks for that tool; otherwise the default script. */
const toolScript: Script = async function* (s, prompt) {
  const text = body(prompt);
  const m = /TOOL (\{.*\})/.exec(text);
  if (!m) {
    yield* defaultScript()(s, prompt);
    return;
  }
  const req = JSON.parse(m[1]!) as { tool: string; input: unknown };
  const id = `p${s.prompts.length}`;
  yield { type: 'permission_request', id, tool: req.tool, input: req.input, title: req.tool } as HarnessEvent;
  const d = await s.waitPermission(id);
  yield { type: 'text', delta: d.allow ? 'tool allowed' : `tool refused: ${d.reason}` };
  yield { type: 'done', stopReason: 'end_turn' };
};

const ask = (e: TestEnv, thread: string, tool: string, input: unknown) =>
  e.conn().inject({
    conversation: group,
    threadId: thread,
    from: bob,
    text: `@beambot TOOL ${JSON.stringify({ tool, input })}`,
    mentionsAgent: true,
  });

const pendingFor = async (e: TestEnv, n = 1) => {
  await until(() => e.d.store.approvals.list().length === n, 3000, 'approval');
  return e.d.store.approvals.list().at(-1)!;
};

describe('approvals: quorum, votes, scope, rules, reasons', () => {
  it('views carry quorum and votes; N-of-M keeps the request pending', async () => {
    env = await makeEnv({ harness: new FakeHarnessPlugin(toolScript) });
    await setupBot(env);
    await ownerAlice(env);
    await env.client.call('owner.add', { principal: 'fake:carol' });
    await env.client.call('principal.link', { person: 'carol', principal: 'fake:carol' });
    await env.client.call('approval.quorumSet', { quorum: 2 });
    expect(await env.client.call('approval.quorumGet')).toEqual({ quorum: 2, approvers: 3 });
    ask(env, 't1', 'bash', { command: 'ls' });
    const a = await pendingFor(env);
    const [view] = (await env.client.call('approval.list')).approvals;
    expect(view!.quorum).toEqual({ needed: 2, pool: 3 });
    expect(view!.votes).toBeUndefined();
    const after = await env.client.call('approval.decide', { id: a.id, allow: true });
    expect(after.status).toBe('pending');
    expect(after.votes).toEqual([{ by: 'local:owner', allow: true, at: expect.any(String) }]);
    // A linked voter is shown by person.
    await env.d.approvals.decide(a.id, 'fake:carol', true, {});
    const done = (await env.client.call('approval.list', { status: 'all' })).approvals[0]!;
    expect(done.status).toBe('approved');
    expect(done.votes!.map((v) => v.by)).toEqual(['local:owner', 'carol']);
    expect(env.events.some((e) => e.type === 'approval.updated' && e.approval.votes?.length === 1)).toBe(
      true,
    );
  });

  it('deny reason is stored, audited and passed to the agent', async () => {
    env = await makeEnv({ harness: new FakeHarnessPlugin(toolScript) });
    await setupBot(env);
    ask(env, 't1', 'bash', { command: 'rm -rf build' });
    const a = await pendingFor(env);
    await env.client.call('approval.decide', {
      id: a.id,
      allow: false,
      reason: 'use make clean\u0007 instead',
    });
    await until(() => lastText(env!, 'g1').includes('tool refused'), 3000);
    expect(lastText(env, 'g1')).toContain('denied by local:owner: use make clean  instead');
    expect(env.d.approvals.reasonOf(a.id)).toBe('use make clean  instead');
    const vote = auditOf(env, 'approval.vote')[0]!;
    expect(vote.data.reason).toBe('use make clean  instead');
    expect(vote.summary).toContain('use make clean');
  });

  it('session scope allows the tool for the rest of that session only', async () => {
    env = await makeEnv({ harness: new FakeHarnessPlugin(toolScript) });
    await setupBot(env);
    ask(env, 't1', 'bash', { command: 'ls' });
    const a = await pendingFor(env);
    await env.client.call('approval.decide', { id: a.id, allow: true, session: true });
    await until(() => lastText(env!, 'g1').includes('tool allowed'), 3000);
    ask(env, 't1', 'bash', { command: 'pwd' });
    await until(
      () =>
        env!
          .conn()
          .textsTo('g1')
          .filter((t) => t === 'tool allowed').length === 2,
      3000,
    );
    expect(env.d.store.approvals.list({ status: 'all' })).toHaveLength(1);
    expect(env.d.agent('bot').approvalRules).toEqual([]);
    ask(env, 't2', 'bash', { command: 'pwd' });
    await pendingFor(env, 1);
    expect(env.d.store.approvals.list({ status: 'all' })).toHaveLength(2);
  });

  it('always + rule persists a validated rule; matching requests skip the approval', async () => {
    env = await makeEnv({ harness: new FakeHarnessPlugin(toolScript) });
    await setupBot(env);
    ask(env, 't1', 'WebFetch', { url: 'https://registry.npmjs.org/react' });
    const a = await pendingFor(env);
    // Invalid rules are refused and leave the approval pending.
    for (const rule of ['*.org', 'evil.com', 'bash:ls', '~/.ssh/'])
      await expect(
        env.client.call('approval.decide', { id: a.id, allow: true, always: true, rule }),
      ).rejects.toSatisfy((e) => code(e) === 'invalid_input');
    await expect(
      env.client.call('approval.decide', { id: a.id, allow: true, rule: '*.npmjs.org' }),
    ).rejects.toSatisfy((e) => code(e) === 'invalid_input');
    expect(env.d.store.approvals.get(a.id)!.status).toBe('pending');
    await env.client.call('approval.decide', { id: a.id, allow: true, always: true, rule: '*.npmjs.org' });
    await until(() => lastText(env!, 'g1').includes('tool allowed'), 3000);
    await until(() => env!.d.agent('bot').approvalRules.length === 1, 3000, 'rule');
    const bot = env.d.agent('bot');
    expect(bot.approvalRules[0]).toMatchObject({
      kind: 'host',
      value: '*.npmjs.org',
      tool: 'WebFetch',
      role: 'user',
    });
    expect(bot.sandbox.policy?.net.allow).toContain('*.npmjs.org');
    expect(auditOf(env, 'approval.rule')).toHaveLength(1);
    // Another session, another npm host: allowed by the rule; other hosts still ask.
    ask(env, 't2', 'WebFetch', { url: 'https://cdn.npmjs.org/x' });
    await until(
      () =>
        env!
          .conn()
          .textsTo('g1')
          .filter((t) => t === 'tool allowed').length === 2,
      3000,
    );
    expect(env.d.store.approvals.list({ status: 'all' })).toHaveLength(1);
    ask(env, 't3', 'WebFetch', { url: 'https://pypi.org/x' });
    await pendingFor(env, 1);
  });

  it('always without a rule allows exactly that command (legacy CLI --always)', async () => {
    env = await makeEnv({ harness: new FakeHarnessPlugin(toolScript) });
    await setupBot(env);
    ask(env, 't1', 'bash', { command: 'npm test' });
    const a = await pendingFor(env);
    await env.client.call('approval.decide', { id: a.id, allow: true, always: true });
    await until(() => env!.d.agent('bot').approvalRules.length === 1, 3000, 'rule');
    expect(env.d.agent('bot').approvalRules[0]).toMatchObject({
      kind: 'command',
      value: 'npm test',
      exact: true,
    });
    ask(env, 't2', 'bash', { command: 'npm test' });
    await until(
      () =>
        env!
          .conn()
          .textsTo('g1')
          .filter((t) => t === 'tool allowed').length === 2,
      3000,
    );
    ask(env, 't3', 'bash', { command: 'npm test; curl x' });
    await pendingFor(env, 1);
  });

  it('undo drops the pending rule', async () => {
    env = await makeEnv({ harness: new FakeHarnessPlugin(toolScript), approvalUndoMs: 300 });
    await setupBot(env);
    ask(env, 't1', 'bash', { command: 'git status' });
    const a = await pendingFor(env);
    await env.client.call('approval.decide', {
      id: a.id,
      allow: true,
      always: true,
      rule: 'bash:git status',
    });
    await env.client.call('approval.undo', { id: a.id });
    await env.client.call('approval.decide', { id: a.id, allow: true });
    await until(() => lastText(env!, 'g1').includes('tool allowed'), 3000);
    expect(env.d.agent('bot').approvalRules).toEqual([]);
  });
});

describe('policy suggestions with a value', () => {
  it('accepts a widened domain; refuses broader or denied values', async () => {
    env = await makeEnv();
    await setupBot(env);
    const s = env.d.store.policySuggestions.record('bot', 'net.allow', 'registry.npmjs.org');
    await expect(
      env.client.call('policy.applySuggestion', { id: s.id, accept: true, value: '*.org' }),
    ).rejects.toSatisfy((e) => code(e) === 'invalid_input');
    await expect(
      env.client.call('policy.applySuggestion', { id: s.id, accept: false, value: '*.npmjs.org' }),
    ).rejects.toSatisfy((e) => code(e) === 'invalid_input');
    await env.client.call('policy.applySuggestion', { id: s.id, accept: true, value: '*.npmjs.org' });
    expect(env.d.agent('bot').sandbox.policy?.net.allow).toEqual(['*.npmjs.org']);
    expect(auditOf(env, 'policy.suggestion')[0]!.data).toMatchObject({
      value: '*.npmjs.org',
      suggested: 'registry.npmjs.org',
    });
    const f = env.d.store.policySuggestions.record('bot', 'fs.read', '~/.aws/credentials');
    await expect(env.client.call('policy.applySuggestion', { id: f.id, accept: true })).rejects.toSatisfy(
      (e) => code(e) === 'invalid_input',
    );
    expect(env.d.agent('bot').sandbox.policy?.fs.read ?? []).toEqual([]);
  });
});

describe('channels: pairings, chats, connect/disconnect', () => {
  it('records owner pairings and known chats in settings and broadcasts them', async () => {
    env = await makeEnv();
    const conn = await setupBot(env);
    const { code: pc } = await env.client.call('channel.pair', { name: 'fk' });
    conn.inject({
      conversation: { kind: 'dm', id: 'dave' },
      from: { principal: 'fake:dave', displayName: 'Dave' },
      text: `/pair ${pc}`,
    });
    await until(() => env!.d.global().owners.includes('fake:dave'), 3000, 'paired');
    await until(() => Array.isArray(env!.d.config.channels.get('fk')!.settings.pairings), 3000, 'pairings');
    const p = (env.d.config.channels.get('fk')!.settings.pairings as Array<Record<string, unknown>>)[0]!;
    expect(p).toMatchObject({ principal: 'fake:dave', displayName: 'Dave', role: 'owner' });
    expect(typeof p.pairedAt).toBe('string');
    const ev = env.events.filter((e) => e.type === 'channel.updated').at(-1);
    expect(ev?.type === 'channel.updated' && ev.channel.config.settings.pairings).toBeTruthy();

    conn.inject({ conversation: group, from: bob, text: 'hello all' });
    await until(
      () => ((env!.d.config.channels.get('fk')!.settings.chats as unknown[]) ?? []).length === 1,
      3000,
    );
    expect(env.d.config.channels.get('fk')!.settings.chats).toEqual([
      { target: 'group/g1', title: 'app-dev' },
    ]);
    const writes = env.events.filter((e) => e.type === 'channel.updated').length;
    conn.inject({ conversation: group, from: bob, text: 'again' });
    await until(() => env!.d.router.history('fk', 'g1').length === 2, 3000, 'second message handled');
    expect(env.events.filter((e) => e.type === 'channel.updated').length).toBe(writes);
    conn.kick('g1');
    await until(
      () => ((env!.d.config.channels.get('fk')!.settings.chats as unknown[]) ?? []).length === 0,
      3000,
    );
    // Removing the owner drops their pairing.
    await env.client.call('owner.add', { principal: 'fake:zed' });
    await env.client.call('owner.remove', { principal: 'fake:dave' });
    expect(env.d.config.channels.get('fk')!.settings.pairings).toEqual([]);
  });

  it('disconnect keeps the channel off (across restarts) until connect', async () => {
    const home = tmpHome();
    env = await makeEnv({ home });
    await setupBot(env);
    const v = await env.client.call('channel.disconnect', { name: 'fk' });
    expect(v.status).toBe('disabled');
    expect(env.channel.conns.get('fk')!.closed).toBe(true);
    expect(env.d.config.channels.get('fk')!.enabled).toBe(false);
    await env.d.stop();
    env.channel.conns.clear();
    env = await makeEnv({ home, channel: env.channel });
    expect(env.channel.conns.has('fk')).toBe(false);
    const c = await env.client.call('channel.connect', { name: 'fk' });
    expect(c.status).toBe('connected');
    expect(env.channel.conns.get('fk')!.closed).toBe(false);
    await expect(env.client.call('channel.connect', { name: 'nope' })).rejects.toSatisfy(
      (e) => code(e) === 'not_found',
    );
  });
});

describe('whoami, owners, people, updates, alerts, roles', () => {
  it('whoami for local, a paired device, an owner npub and a stranger', async () => {
    env = await makeEnv();
    expect(await env.client.call('system.whoami')).toEqual({
      principal: 'local:owner',
      role: 'owner',
      via: 'local',
    });
    const call = async (caller: string, method: string, params: unknown = {}) =>
      env!.d.dispatch({ jsonrpc: '2.0', id: 1, method, params }, { caller, transport: 'nostr' });
    const stranger = await call('nostr:npub1stranger', 'system.whoami');
    expect('result' in stranger && stranger.result).toMatchObject({ role: 'viewer', via: 'nostr' });
    const fs = await call('nostr:npub1stranger', 'fs.list');
    expect('error' in fs && (fs.error.data as { code: string }).code).toBe('forbidden');
    await env.client.call('owner.add', { principal: 'nostr:npub1owner' });
    const owner = await call('nostr:npub1owner', 'system.whoami');
    expect('result' in owner && owner.result).toMatchObject({ role: 'owner', principal: 'nostr:npub1owner' });
    env.d.store.devices.add({
      id: 'dev1',
      name: 'Pixel',
      pubkey: 'npub1device',
      pairedAt: new Date().toISOString(),
      pushEnabled: false,
    } as never);
    const dev = await call('nostr:npub1device', 'system.whoami');
    expect('result' in dev && dev.result).toMatchObject({
      principal: 'local:owner',
      role: 'owner',
      via: 'device',
      device: { id: 'dev1', name: 'Pixel' },
    });
  });

  it('owner.list, principal.list / unlink, updates.get / set', async () => {
    env = await makeEnv();
    await env.client.call('owner.add', { principal: 'fake:alice' });
    await env.client.call('principal.link', { person: 'alice', principal: 'fake:alice' });
    await env.client.call('principal.link', { person: 'alice', principal: 'nostr:npub1alice' });
    expect(await env.client.call('owner.list')).toEqual({
      owners: [{ principal: 'fake:alice', person: 'alice', linked: ['nostr:npub1alice'] }],
    });
    await env.client.call('principal.unlink', { person: 'alice', principal: 'nostr:npub1alice' });
    expect((await env.client.call('principal.list')).people).toEqual({ alice: ['fake:alice'] });
    await env.client.call('principal.unlink', { person: 'alice', principal: 'fake:alice' });
    expect((await env.client.call('principal.list')).people).toEqual({});
    await expect(
      env.client.call('principal.unlink', { person: 'alice', principal: 'fake:alice' }),
    ).rejects.toSatisfy((e) => code(e) === 'not_found');
    expect(await env.client.call('updates.get')).toEqual({ catalogAuto: true, appPrompt: true });
    expect(await env.client.call('updates.set', { appPrompt: false })).toEqual({
      catalogAuto: true,
      appPrompt: false,
    });
    expect(env.d.global().updates.appPrompt).toBe(false);
  });

  it('alerts.get / set persist thresholds that drive spikes, budgets and push', async () => {
    env = await makeEnv();
    const r = await env.client.call('alerts.get');
    expect(r).toMatchObject({ budgetWarn: 80, budgetAlert: 100, spikeEvents: 5, crash: true, push: true });
    await expect(env.client.call('alerts.set', { budgetWarn: 120 })).rejects.toSatisfy(
      (e) => code(e) === 'invalid_input',
    );
    await expect(env.client.call('alerts.set', { quietStart: '25:00' })).rejects.toThrow();
    const next = await env.client.call('alerts.set', { spikeEvents: 2, budgetWarn: 50, quietHours: true });
    expect(next).toMatchObject({ spikeEvents: 2, budgetWarn: 50, quietHours: true, budgetAlert: 100 });
    expect(env.d.global().alerts).toEqual({ spikeEvents: 2, budgetWarn: 50, quietHours: true });
    // Two security events now make a spike.
    env.d.audit({ type: 'x', severity: 'security', summary: 'a', actor: 't' });
    env.d.audit({ type: 'x', severity: 'security', summary: 'b', actor: 't' });
    expect(auditOf(env, 'security.spike')).toHaveLength(1);
    // Budget warning at 50%: $2.5 of $5.
    const conn = await setupBot(env, { budgets: { dailyUsd: 5 } });
    env.harness.script = async function* () {
      yield { type: 'usage', inputTokens: 10, outputTokens: 10, costUsd: 2.6 };
      yield { type: 'text', delta: 'spent' };
      yield { type: 'done', stopReason: 'end_turn' };
    };
    await ownerAlice(env);
    conn.inject({ text: 'go' });
    await until(() => auditOf(env!, 'budget.alert').length === 1, 3000, 'budget alert');
    expect(auditOf(env, 'budget.alert')[0]!.data.threshold).toBe(0.5);
  });

  it('role.define / role.delete keep built-in invariants', async () => {
    env = await makeEnv();
    const def = await env.client.call('role.define', {
      role: {
        name: 'reviewer',
        description: 'reads and comments',
        canPrompt: true,
        tools: { allow: ['Read'] },
      },
    });
    expect(def).toMatchObject({
      name: 'reviewer',
      canPrompt: true,
      canApprove: false,
      tools: { allow: ['Read'] },
    });
    // New custom roles start from the viewer base (shell/write denied).
    expect(def.tools.deny).toContain('bash*');
    // Overriding a built-in keeps the fields not given.
    const before = (await env.client.call('role.list')).roles.find((r) => r.name === 'user')!;
    const user = await env.client.call('role.define', { role: { name: 'user', dlp: 'block' } });
    expect(user).toMatchObject({ ...before, dlp: 'block' });
    for (const name of ['owner', 'agent'])
      await expect(env.client.call('role.define', { role: { name, canApprove: false } })).rejects.toSatisfy(
        (e) => code(e) === 'forbidden',
      );
    await expect(env.client.call('role.define', { role: { name: 'Bad Name' } })).rejects.toSatisfy(
      (e) => code(e) === 'invalid_input',
    );
    await expect(env.client.call('role.define', { role: { name: 'x', canPrompt: 'yes' } })).rejects.toSatisfy(
      (e) => code(e) === 'invalid_input',
    );
    await expect(env.client.call('role.define', { role: { name: 'x', bogus: 1 } })).rejects.toSatisfy(
      (e) => code(e) === 'invalid_input',
    );
    await env.client.call('role.grant', { principal: 'fake:bob', role: 'reviewer' });
    await expect(env.client.call('role.delete', { name: 'reviewer' })).rejects.toSatisfy(
      (e) => code(e) === 'conflict',
    );
    await env.client.call('role.revoke', { principal: 'fake:bob' });
    await env.client.call('role.delete', { name: 'reviewer' });
    await env.client.call('role.delete', { name: 'user' });
    expect((await env.client.call('role.list')).roles.find((r) => r.name === 'user')).toEqual(before);
    await expect(env.client.call('role.delete', { name: 'viewer' })).rejects.toSatisfy(
      (e) => code(e) === 'invalid_input',
    );
    await expect(env.client.call('role.delete', { name: 'owner' })).rejects.toSatisfy(
      (e) => code(e) === 'forbidden',
    );
  });
});

describe('agent.instructionsWrite', () => {
  it('writes harness instruction files in rw mounts only, refusing links and other files', async () => {
    env = await makeEnv();
    const rw = join(tmpHome(), 'rw');
    const ro = join(tmpHome(), 'ro');
    mkdirSync(rw, { recursive: true });
    mkdirSync(ro, { recursive: true });
    await env.client.call('agent.create', {
      config: {
        name: 'a',
        harness: 'fake',
        mounts: [
          { path: rw, mode: 'rw' },
          { path: ro, mode: 'ro' },
        ],
      },
    });
    const r = await env.client.call('agent.instructionsWrite', {
      name: 'a',
      path: join(rw, 'CLAUDE.md'),
      content: '# hi\n',
    });
    expect(r).toEqual({ path: join(rw, 'CLAUDE.md'), harness: 'claude', bytes: 5 });
    expect(readFileSync(join(rw, 'CLAUDE.md'), 'utf8')).toBe('# hi\n');
    // Relative to the first rw mount; nested dir created.
    await env.client.call('agent.instructionsWrite', { name: 'a', path: '.claude/CLAUDE.md', content: 'x' });
    expect(readFileSync(join(rw, '.claude', 'CLAUDE.md'), 'utf8')).toBe('x');
    const files = (await env.client.call('agent.instructions', { name: 'a' })).files.map((f) => f.path);
    expect(files).toEqual(expect.arrayContaining([join(rw, 'CLAUDE.md'), join(rw, '.claude', 'CLAUDE.md')]));
    const refuse = async (path: string, want: string) =>
      expect(
        env!.client.call('agent.instructionsWrite', { name: 'a', path, content: 'x' }),
      ).rejects.toSatisfy((e) => code(e) === want);
    await refuse(join(ro, 'CLAUDE.md'), 'forbidden');
    await refuse(join(rw, 'package.json'), 'forbidden');
    await refuse(join(rw, 'sub', 'CLAUDE.md'), 'forbidden');
    await refuse(join(rw, '..', 'CLAUDE.md'), 'forbidden');
    await refuse('/etc/CLAUDE.md', 'forbidden');
    if (process.platform !== 'win32') {
      const outside = join(tmpHome(), 'outside');
      mkdirSync(outside);
      writeFileSync(join(outside, 'AGENTS.md'), 'secret');
      symlinkSync(join(outside, 'AGENTS.md'), join(rw, 'AGENTS.md'));
      await refuse(join(rw, 'AGENTS.md'), 'sandbox_violation');
      expect(readFileSync(join(outside, 'AGENTS.md'), 'utf8')).toBe('secret');
      symlinkSync(outside, join(rw, '.pi'));
      await refuse(join(rw, '.pi', 'SYSTEM.md'), 'sandbox_violation');
      expect(existsSync(join(outside, 'SYSTEM.md'))).toBe(false);
    }
    expect(auditOf(env, 'agent.instructions')).toHaveLength(2);
  });
});

describe('deploy params', () => {
  it('passes mount sync choices and harness auth through; unknown mounts are refused', async () => {
    env = await makeEnv();
    const specs: DeploySpec[] = [];
    const fake: Deployer = {
      id: 'fakecloud',
      displayName: 'Fake Cloud',
      kind: 'vps',
      sizes: async () => [],
      regions: async () => [],
      plan: async (s) => {
        specs.push(s);
        return { provider: s.provider, actions: [], monthlyCostUsd: 4, warnings: [] };
      },
      apply: async (s) => ({
        id: 'd1',
        provider: 'fakecloud',
        agent: s.agent,
        status: 'provisioning',
        createdAt: new Date().toISOString(),
      }),
      status: async (id) => ({
        id,
        provider: 'fakecloud',
        agent: 'a',
        status: 'running',
        createdAt: new Date().toISOString(),
      }),
      logs: async function* () {},
      destroy: async () => {},
    };
    env.d.registry.addDeployer(fake);
    await env.client.call('agent.create', {
      config: { name: 'a', harness: 'fake', mounts: [{ path: '/srv/app' }] },
    });
    await env.client.call('deploy.plan', {
      agent: 'a',
      provider: 'fakecloud',
      mode: 'new',
      mounts: [{ path: '/srv/app', sync: 'git-clone' }],
      harnessAuth: 'subscription',
    });
    expect(specs[0]).toMatchObject({
      mounts: [{ path: '/srv/app', sync: 'git-clone' }],
      harnessAuth: 'subscription',
      harnesses: ['fake'],
    });
    await env.client.call('deploy.plan', { agent: 'a', provider: 'fakecloud', mode: 'new' });
    expect(specs[1]!.harnessAuth).toBe('api-key');
    await expect(
      env.client.call('deploy.plan', {
        agent: 'a',
        provider: 'fakecloud',
        mode: 'new',
        mounts: [{ path: '/etc', sync: 'rsync' }],
      }),
    ).rejects.toSatisfy((e) => code(e) === 'invalid_input');
  });
});

describe('worktree merge and PR push', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@x',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@x',
      },
    }).trim();

  const setup = async () => {
    const root = tmpHome();
    const repo = join(root, 'repo');
    const remote = join(root, 'remote.git');
    mkdirSync(repo);
    git(root, 'init', '-q', '--bare', '-b', 'main', remote);
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'README.md'), 'hi\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'init');
    git(repo, 'remote', 'add', 'origin', remote);
    const harness = new FakeHarnessPlugin(async function* (s) {
      writeFileSync(join(s.spec.cwd, 'feature.txt'), 'from the agent\n');
      yield { type: 'text', delta: 'wrote it' };
      yield { type: 'done', stopReason: 'end_turn' };
    });
    env = await makeEnv({ harness });
    await setupBot(env, { mounts: [{ path: repo, mode: 'rw' }] });
    await ownerAlice(env);
    env.conn().inject({ text: 'add a feature' });
    await until(() => lastText(env!, 'alice').includes('wrote it'), 5000, 'reply');
    const [s] = env.d.store.sessions.list();
    await until(() => env!.d.store.sessions.get(s!.id)!.status !== 'running', 3000, 'idle');
    return { repo, remote, session: env.d.store.sessions.get(s!.id)! };
  };

  it('session.merge commits pending work and merges the branch into the checked-out base', async () => {
    const { repo, session } = await setup();
    expect(session.worktree?.branch).toMatch(/^beamhop\//);
    writeFileSync(join(repo, 'README.md'), 'dirty\n');
    await expect(env!.client.call('session.merge', { id: session.id })).rejects.toSatisfy(
      (e) => code(e) === 'conflict',
    );
    git(repo, 'checkout', '--', 'README.md');
    await expect(env!.client.call('session.merge', { id: session.id, base: '--evil' })).rejects.toSatisfy(
      (e) => code(e) === 'invalid_input',
    );
    const r = await env!.client.call('session.merge', { id: session.id });
    expect(r).toMatchObject({ branch: session.worktree!.branch, base: 'main', fastForward: false });
    expect(readFileSync(join(repo, 'feature.txt'), 'utf8')).toBe('from the agent\n');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(r.commit);
    expect(auditOf(env!, 'session.merged')).toHaveLength(1);
    const ev = env!.d.store.sessions.events(session.id);
    expect(ev.some((e) => e.kind === 'system' && e.text?.includes('Merged'))).toBe(true);
  });

  it('session.openPr waits for an approval, then pushes the branch', async () => {
    const { remote, session } = await setup();
    const branch = session.worktree!.branch;
    await expect(env!.client.call('session.openPr', { id: session.id, remote: '-x' })).rejects.toSatisfy(
      (e) => code(e) === 'invalid_input',
    );
    await expect(
      env!.client.call('session.openPr', { id: session.id, remote: 'upstream' }),
    ).rejects.toSatisfy((e) => code(e) === 'not_found');
    const r = await env!.client.call('session.openPr', { id: session.id });
    expect(r).toMatchObject({ branch, base: 'main', remote: 'origin' });
    expect(r.compareUrl).toBeUndefined(); // a file:// remote has no web UI
    expect(r.approval).toMatchObject({ status: 'pending', tool: 'git.push', sessionId: session.id });
    expect(() => git(remote, 'rev-parse', `refs/heads/${branch}`)).toThrow();
    await expect(
      env!.client.call('approval.decide', { id: r.approval.id, allow: true, always: true }),
    ).rejects.toSatisfy((e) => code(e) === 'invalid_input');
    await env!.client.call('approval.decide', { id: r.approval.id, allow: true });
    await until(() => auditOf(env!, 'session.pushed').length === 1, 10_000, 'pushed');
    expect(git(remote, 'rev-parse', `refs/heads/${branch}`)).toMatch(/^[0-9a-f]{40}$/);
    expect(git(remote, 'show', `${branch}:feature.txt`)).toBe('from the agent');
  });

  it('a denied push never runs; sessions without a worktree are refused', async () => {
    const { remote, session } = await setup();
    const r = await env!.client.call('session.openPr', { id: session.id });
    await env!.client.call('approval.decide', { id: r.approval.id, allow: false, reason: 'not yet' });
    await new Promise((res) => setTimeout(res, 200));
    expect(() => git(remote, 'rev-parse', `refs/heads/${session.worktree!.branch}`)).toThrow();
    const plain = await env!.client.call('session.start', { agent: 'bot', text: 'x' }).catch(() => undefined);
    if (plain && !plain.worktree)
      await expect(env!.client.call('session.merge', { id: plain.id })).rejects.toSatisfy(
        (e) => code(e) === 'invalid_input',
      );
  });
});
