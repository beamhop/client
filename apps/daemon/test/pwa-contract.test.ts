/**
 * Regressions for mismatches found by running the PWA against a real daemon (apps/pwa/e2e-real):
 * what the PWA relies on that the daemon did not do. Plus the test daemon used by that suite.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  FakeHarnessPlugin,
  makeEnv,
  ownerAlice,
  type Script,
  setupBot,
  sleep,
  type TestEnv,
  until,
} from './helpers.ts';
import { startTestDaemon, type TestDaemon } from './test-daemon.ts';

let env: TestEnv | undefined;
let td: TestDaemon | undefined;
afterEach(async () => {
  await env?.close();
  await td?.stop();
  env = undefined;
  td = undefined;
});

const streaming: Script = async function* () {
  yield { type: 'text', delta: 'chunk-1 ' };
  await sleep(60);
  yield { type: 'text', delta: 'chunk-2 ' };
  await sleep(160);
  yield { type: 'text', delta: 'chunk-3' };
  yield { type: 'tool_call', id: 't1', name: 'read', input: { path: 'a' } };
  yield { type: 'tool_result', id: 't1', ok: true, output: 'x' };
  yield { type: 'text', delta: 'after the tool' };
  yield { type: 'done', stopReason: 'end_turn' };
};

const shell: Script = async function* (s) {
  yield { type: 'permission_request', id: 'p1', tool: 'bash', input: { command: 'git push' }, title: 'push' };
  const d = await s.waitPermission('p1');
  yield { type: 'text', delta: d.allow ? 'allowed' : `refused: ${d.reason}` };
  yield { type: 'done', stopReason: 'end_turn' };
};

const approvalEnv = async (opts: { undoMs?: number } = {}) => {
  env = await makeEnv({ harness: new FakeHarnessPlugin(shell), approvalUndoMs: opts.undoMs ?? 30 });
  const conn = await setupBot(env);
  await ownerAlice(env);
  conn.inject({ text: 'go' });
  await until(() => env!.d.store.approvals.list().length === 1, 3000, 'approval');
  return { conn, id: env.d.store.approvals.list()[0]!.id };
};

describe('PWA ↔ daemon contract', () => {
  it('streams assistant text into the transcript: one event per segment, same seq while it grows', async () => {
    env = await makeEnv({ harness: new FakeHarnessPlugin(streaming) });
    const conn = await setupBot(env);
    await ownerAlice(env);
    conn.inject({ text: 'go' });
    await until(() => conn.textsTo('alice').some((t) => t.includes('after the tool')), 5000, 'reply');
    const [session] = env.d.store.sessions.list({ agent: 'bot' });
    const events = env.d.store.sessions.events(session!.id);
    const assistant = events.filter((e) => e.kind === 'assistant');
    expect(assistant.map((e) => e.text)).toEqual(['chunk-1 chunk-2 chunk-3', 'after the tool']);
    // Text before the tool call is ordered before it.
    const kinds = events.map((e) => e.kind);
    expect(kinds.indexOf('assistant')).toBeLessThan(kinds.indexOf('tool_call'));
    expect(kinds.lastIndexOf('assistant')).toBeGreaterThan(kinds.indexOf('tool_result'));
    // Pushed: the first segment's seq was sent more than once, with growing text.
    const pushes = env.events.flatMap((e) =>
      e.type === 'session.event' && e.event.seq === assistant[0]!.seq ? [e.event.text ?? ''] : [],
    );
    expect(pushes[0]).toBe('chunk-1 ');
    expect(pushes.at(-1)).toBe('chunk-1 chunk-2 chunk-3');
    expect(pushes.length).toBeGreaterThan(1);
  });

  it('approval.decide passes a deny reason to the agent', async () => {
    const { conn, id } = await approvalEnv();
    await env!.client.call('approval.decide', { id, allow: false, reason: 'Use a read-only approach' });
    await until(() => conn.textsTo('alice').some((t) => t.includes('refused:')), 3000, 'refusal');
    expect(env!.harness.latest().decisions.get('p1')).toEqual({
      allow: false,
      reason: 'denied by local:owner: Use a read-only approach',
    });
    const vote = env!.d.store.audit.query({ limit: 50 }).find((e) => e.type === 'approval.vote');
    expect(vote?.data).toMatchObject({ reason: 'Use a read-only approach' });
  });

  it('undo then re-deny with a reason (the PWA "Add reason" flow) uses the new reason', async () => {
    const { id } = await approvalEnv({ undoMs: 300 });
    await env!.client.call('approval.decide', { id, allow: false });
    await env!.client.call('approval.undo', { id });
    await env!.client.call('approval.decide', { id, allow: false, reason: 'not now' });
    await until(() => env!.harness.latest().decisions.has('p1'), 3000, 'decision');
    expect(env!.harness.latest().decisions.get('p1')?.reason).toBe('denied by local:owner: not now');
  });

  it('approval.decide with session: true allows the tool for the rest of the session', async () => {
    const { conn, id } = await approvalEnv();
    await env!.client.call('approval.decide', { id, allow: true, session: true });
    await until(() => conn.textsTo('alice').includes('allowed'), 3000, 'allowed');
    expect(env!.harness.latest().decisions.get('p1')).toEqual({ allow: true, always: true });
    conn.inject({ text: 'again' });
    await until(() => conn.textsTo('alice').filter((t) => t === 'allowed').length === 2, 3000, 'second');
    expect(env!.d.store.approvals.list({ status: 'all' })).toHaveLength(1);
  });

  it('an undone "allow for session" does not stick', async () => {
    const { id } = await approvalEnv({ undoMs: 300 });
    await env!.client.call('approval.decide', { id, allow: true, session: true });
    await env!.client.call('approval.undo', { id });
    await env!.client.call('approval.decide', { id, allow: true });
    await until(() => env!.harness.latest().decisions.has('p1'), 3000, 'decision');
    expect(env!.harness.latest().decisions.get('p1')).toEqual({ allow: true });
  });

  it('holds decisions for the PWA’s 5 s undo window by default (JOURNEYS §2.6)', async () => {
    env = await makeEnv({ approvalUndoMs: undefined });
    expect(env.d.approvals.undoMs).toBe(5000);
  });

  it('/approve accepts the id without the apr_ prefix (as the PWA shows it)', async () => {
    const { conn, id } = await approvalEnv();
    expect(id.startsWith('apr_')).toBe(true);
    conn.inject({ text: `/approve ${id.slice(4)}` });
    await until(() => conn.textsTo('alice').includes('allowed'), 3000, 'allowed');
    expect(env!.d.store.approvals.get(id)?.status).toBe('approved');
  });

  it('/pair records the pairing on the channel and pushes channel.updated', async () => {
    env = await makeEnv();
    const conn = await setupBot(env);
    const { code } = await env.client.call('channel.pair', { name: 'fk' });
    const before = env.events.length;
    conn.inject({
      text: `/pair ${code}`,
      from: { principal: 'fake:carol', displayName: 'Carol' },
      conversation: { kind: 'dm', id: 'carol' },
    });
    await until(() => conn.textsTo('carol').some((t) => t.includes('Paired')), 3000, 'paired');
    const cfg = env.d.config.channels.require('fk');
    expect(cfg.settings.pairings).toEqual([
      expect.objectContaining({ principal: 'fake:carol', displayName: 'Carol', role: 'owner' }),
    ]);
    const pushed = env.events
      .slice(before)
      .find((e) => e.type === 'channel.updated' && Array.isArray(e.channel.config.settings.pairings));
    expect(pushed).toBeTruthy();
    expect(env.d.global().owners).toContain('fake:carol');
  });

  it('secret.set on a channel secret tracks the ref and reconnects the channel with it', async () => {
    env = await makeEnv();
    await setupBot(env);
    const first = env.conn();
    await env.client.call('secret.set', { name: 'channel.fk.token', value: 'good' });
    await until(() => env!.channel.conns.get('fk') !== first, 3000, 'reconnect');
    expect(first.closed).toBe(true);
    expect(env.channel.lastCtx?.secrets).toEqual({ token: 'good' });
    await env.client.call('secret.set', { name: 'channel.fk.extra', value: 'v' });
    expect(env.d.config.channels.require('fk').secretRefs).toEqual(['channel.fk.token', 'channel.fk.extra']);
    // Unrelated names do not touch channels.
    await env.client.call('secret.set', { name: 'OPENAI_API_KEY', value: 'x' });
    await env.client.call('secret.set', { name: 'channel.nope.token', value: 'x' });
    expect(env.d.config.channels.list().map((c) => c.name)).toEqual(['fk']);
  });
});

describe('test daemon (apps/pwa/e2e-real)', () => {
  it('serves the API with a seeded fake channel, agent and owner, and drives a scripted turn', async () => {
    td = await startTestDaemon({ tickMs: 0 });
    expect(td.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(td.token.length).toBeGreaterThanOrEqual(32);
    const r = await fetch(`${td.url}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${td.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'agent.list' }),
    });
    const { result } = (await r.json()) as { result: { agents: { config: { name: string } }[] } };
    expect(result.agents.map((a) => a.config.name)).toEqual(['bot']);
    td.inject({ text: 'STREAM 2' });
    await until(
      () => td!.snapshot().sent.fk?.some((s) => s.text.includes('chunk-2')) ?? false,
      3000,
      'stream',
    );
    td.inject({ text: 'ASK git push origin main' });
    await until(() => td!.d.store.approvals.list().length === 1, 3000, 'approval');
    expect(td.snapshot().harness[0]?.prompts).toEqual(['STREAM 2', 'ASK git push origin main']);
    await td.advance(61_000);
    await until(() => td!.snapshot().harness[0]?.decisions.p2 !== undefined, 3000, 'expired');
    expect(td.snapshot().harness[0]?.decisions).toEqual({
      p2: { allow: false, reason: 'denied: timed out' },
    });
    expect(td.d.store.usage.totals({ agent: 'bot' }).usd).toBeCloseTo(0.04, 5);
  });

  it('reports sandbox violations from live session sandboxes', async () => {
    td = await startTestDaemon({ tickMs: 0 });
    expect(td.violate({ kind: 'net.allow', value: 'pypi.org' })).toBe(0);
    td.inject({ text: 'hi' });
    await until(() => td!.snapshot().sent.fk?.some((s) => s.text === 'reply: hi') ?? false, 3000, 'reply');
    expect(td.violate({ kind: 'net.allow', value: 'pypi.org' })).toBe(1);
    const ev = td.d.store.audit.query({ limit: 50 }).find((e) => e.type === 'sandbox.violation');
    expect(ev?.data).toMatchObject({ kind: 'net.allow', value: 'pypi.org' });
  });
});
