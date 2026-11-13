/**
 * Review wave B integration: the daemon wires every authz/channel fix (people-aware quorum, button
 * authorization, store dedupe, bot names, confined outbound files, per-person budgets, known Nostr
 * agents, SSRF-safe downloads, broker-backed fetchAttachment).
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MemorySecretStore } from '@beamhop/broker';
import { generateAgentKey } from '@beamhop/channel-nostr';
import { silentLogger } from '@beamhop/core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { MeshProvider } from '../src/mesh.ts';
import { loadBuiltinPlugins, PluginRegistry } from '../src/registry.ts';
import { meshListIncludes } from '../src/router.ts';
import { personBudgetKey } from '../src/util.ts';
import { body, makeEnv, ownerAlice, setupBot, sleep, type TestEnv, tmpHome, until } from './helpers.ts';

let env: TestEnv | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

const group = { kind: 'group' as const, id: 'g1' };
const bob = { principal: 'fake:bob', displayName: 'Bob' };
const lastText = (e: TestEnv, conv: string) => e.conn().textsTo(conv).at(-1) ?? '';
const audits = (e: TestEnv) => e.d.store.audit.query({ limit: 1000 });
const auditTypes = (e: TestEnv) => audits(e).map((a) => a.type);

/** Bob (group default role `user`) asks for the shell; returns the pending approval. */
const pendingShell = async (e: TestEnv) => {
  e.conn().inject({ conversation: group, from: bob, text: '@beambot RUN_SHELL', mentionsAgent: true });
  await until(() => e.d.store.approvals.list().length === 1, 3000, 'approval');
  return e.d.store.approvals.list()[0]!;
};

describe('approvals: one vote per person across linked principals (AUTHZ-2)', () => {
  it('a second linked account cannot complete a quorum of 2', async () => {
    env = await makeEnv({ approvalUndoMs: 10 });
    const conn = await setupBot(env);
    for (const p of ['fake:alice', 'fake:alice2', 'fake:dave'])
      await env.client.call('owner.add', { principal: p });
    env.d.updateGlobal((c) => ({
      ...c,
      approvals: { ...c.approvals, quorum: 2 },
      people: { ...c.people, alice: ['fake:alice', 'fake:alice2'] },
    }));
    const a = await pendingShell(env);
    conn.inject({ text: `/approve ${a.id}` });
    await until(() => env!.d.store.approvals.get(a.id)!.votes.length === 1, 3000, 'first vote');
    conn.press({ buttonId: `approve:${a.id}`, principal: 'fake:alice2', conversationId: 'alice2' });
    await until(() => lastText(env!, 'alice2').includes('already voted'), 3000, 'already voted');
    expect(env.d.store.approvals.get(a.id)!.status).toBe('pending');
    conn.press({ buttonId: `approve:${a.id}`, principal: 'fake:dave', conversationId: 'dave' });
    await until(() => lastText(env!, 'g1').includes('shell allowed'), 3000, 'allowed');
    expect(env.d.store.approvals.get(a.id)!.status).toBe('approved');
  });
});

describe('button presses are authorized exactly like commands (R-B2)', () => {
  it('a mesh-blocked admin cannot approve by button or by /approve', async () => {
    env = await makeEnv();
    const conn = await setupBot(env, { mesh: { block: ['fake:mallory'] } });
    await ownerAlice(env);
    await env.client.call('role.grant', { principal: 'fake:mallory', role: 'admin' });
    const a = await pendingShell(env);
    conn.press({ buttonId: `approve:${a.id}`, principal: 'fake:mallory', conversationId: 'mallory' });
    await until(() => auditTypes(env!).includes('approval.unauthorized'), 3000, 'unauthorized');
    conn.inject({
      conversation: { kind: 'dm', id: 'mallory' },
      from: { principal: 'fake:mallory' },
      text: `/approve ${a.id}`,
    });
    await until(() => auditTypes(env!).filter((t) => t === 'approval.unauthorized').length === 2, 3000);
    expect(env.d.store.approvals.get(a.id)!.status).toBe('pending');
    expect(env.d.store.approvals.get(a.id)!.votes).toHaveLength(0);
  });

  it('a grant whose role lacks canApprove gets nothing; an admin grant may approve', async () => {
    env = await makeEnv();
    const conn = await setupBot(env);
    await ownerAlice(env);
    await env.client.call('role.grant', { principal: 'fake:carol', role: 'user', agent: 'bot' });
    await env.client.call('role.grant', { principal: 'fake:erin', role: 'admin', agent: 'bot' });
    const a = await pendingShell(env);
    conn.press({ buttonId: `deny:${a.id}`, principal: 'fake:carol', conversationId: 'carol' });
    await until(() => auditTypes(env!).includes('approval.unauthorized'), 3000);
    expect(env.d.store.approvals.get(a.id)!.status).toBe('pending');
    conn.press({ buttonId: `approve:${a.id}`, principal: 'fake:erin', conversationId: 'erin' });
    await until(() => lastText(env!, 'g1').includes('shell allowed'), 3000, 'allowed');
  });

  it('forged button data is parsed strictly and never reaches a decision', async () => {
    env = await makeEnv();
    const conn = await setupBot(env);
    await ownerAlice(env);
    const a = await pendingShell(env);
    for (const buttonId of [
      `approve:${a.id}:extra`,
      `approve:${a.id}\n`,
      `APPROVE:${a.id}`,
      `grant:${a.id}`,
      'approve:',
      `approve:${'x'.repeat(500)}`,
      'approve:../../etc',
    ])
      conn.press({ buttonId, principal: 'fake:alice', conversationId: 'alice' });
    conn.press({ buttonId: 'deny:apr_doesnotexist', principal: 'fake:alice', conversationId: 'alice' });
    await until(() => lastText(env!, 'alice').includes('not found'), 3000);
    expect(env.d.store.approvals.get(a.id)!.status).toBe('pending');
    expect(env.d.store.approvals.get(a.id)!.votes).toHaveLength(0);
  });

  it('"details" with another session id shows nothing to a non-approver', async () => {
    env = await makeEnv();
    const conn = await setupBot(env);
    await ownerAlice(env);
    conn.inject({ text: 'hello' });
    await until(() => lastText(env!, 'alice').includes('reply: hello'));
    const sid = env.d.store.sessions.list({ agent: 'bot' })[0]!.id;
    const before = conn.sent.length;
    conn.press({ buttonId: `details:${sid}`, principal: 'fake:bob', conversationId: 'g1' });
    await sleep(100);
    expect(conn.sent.length).toBe(before);
    conn.press({ buttonId: `details:${sid}`, principal: 'fake:alice', conversationId: 'alice' });
    await until(() => conn.sent.length > before, 3000, 'details for owner');
  });
});

describe('inbound guards', () => {
  it('store dedupe drops a replayed message id, also across a restart (NOS-1)', async () => {
    const home = tmpHome();
    env = await makeEnv({ home });
    const conn = await setupBot(env);
    await ownerAlice(env);
    conn.inject({ id: 'evt-1', text: 'first' });
    await until(() => lastText(env!, 'alice').includes('reply: first'));
    conn.inject({ id: 'evt-1', text: 'first' });
    await sleep(150);
    expect(env.harness.sessions.flatMap((s) => s.prompts)).toHaveLength(1);
    await env.close();
    env = await makeEnv({ home });
    await until(() => env!.channel.conns.has('fk'), 2000);
    env.conn().inject({ id: 'evt-1', text: 'first' });
    env.conn().inject({ id: 'evt-2', text: 'second' });
    await until(() => lastText(env!, 'alice').includes('reply: second'), 5000);
    // The replayed history may mention "first"; the message itself must not be prompted again.
    expect(env.harness.sessions.flatMap((s) => s.prompts).some((p) => body(p).includes('first'))).toBe(false);
  });

  it('/approve@otherbot is ignored; /approve@<our handle> works (isAddressedTo)', async () => {
    env = await makeEnv();
    const conn = await setupBot(env);
    await ownerAlice(env);
    const a = await pendingShell(env);
    conn.inject({ conversation: group, text: `/approve@otherbot ${a.id}`, mentionsAgent: false });
    await sleep(100);
    expect(env.d.store.approvals.get(a.id)!.votes).toHaveLength(0);
    conn.inject({ conversation: group, text: `/approve@BeamBot ${a.id}` });
    await until(() => conn.textsTo('g1').some((t) => t.includes('Approved')), 3000);
  });
});

describe('outbound files only via openConfinedFile copies (MCP-1 / SSRF-1)', () => {
  it('refuses URL attachments, channel file ids and arbitrary host paths', async () => {
    env = await makeEnv();
    const conn = await setupBot(env);
    const ctx = { agent: 'bot', dlp: 'warn' as const, recipient: 'fk:dm/alice' };
    const send = (att: Record<string, unknown>) =>
      env!.d.sendOutbound(
        conn,
        {
          conversation: { kind: 'dm', id: 'alice' },
          markdown: 'file',
          attachments: [{ name: 'x', mime: 'text/plain', ...att }],
        },
        ctx,
      );
    await expect(send({ url: 'http://169.254.169.254/latest/meta-data/' })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(send({ url: 'telegram-file:AgADBAAD' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(send({ localPath: '/etc/passwd' })).rejects.toMatchObject({ code: 'forbidden' });
    expect(conn.sent).toHaveLength(0);
    expect(auditTypes(env).filter((t) => t === 'attachment.refused')).toHaveLength(3);
    // A registered confined copy goes through.
    env.d.confinedOutbound.add('/tmp/confined-copy');
    await send({ localPath: '/tmp/confined-copy' });
    expect(conn.sent).toHaveLength(1);
  });
});

describe('budgets per person (R-B3)', () => {
  it('linked principals share one rate limit and one spend budget', async () => {
    env = await makeEnv();
    const conn = await setupBot(env);
    env.d.updateGlobal((c) => ({
      ...c,
      roles: [...c.roles, { ...env!.d.roleDef('user'), budget: { messagesPerMinute: 2 } }],
      people: { ...c.people, bob: ['fake:bob', 'fake:bob2'] },
    }));
    conn.inject({ conversation: group, from: bob, text: '@beambot one', mentionsAgent: true });
    conn.inject({ conversation: group, from: bob, text: '@beambot SPEND', mentionsAgent: true });
    await until(() => conn.textsTo('g1').filter((t) => t.startsWith('reply:')).length === 2, 5000, 'two');
    // Same person, different account: the per-person bucket is empty.
    conn.inject({
      conversation: group,
      from: { principal: 'fake:bob2', displayName: 'Bob (alt)' },
      text: '@beambot three',
      mentionsAgent: true,
    });
    await until(() => conn.textsTo('g1').some((t) => t.includes('rate limit')), 3000, 'rate limited');
    // An unlinked user still has their own budget.
    conn.inject({
      conversation: group,
      from: { principal: 'fake:zed' },
      text: '@beambot hi',
      mentionsAgent: true,
    });
    await until(() => conn.textsTo('g1').some((t) => t.includes('reply: @beambot hi')), 5000, 'zed');
    const key = personBudgetKey('bot', env.d.global().people, 'fake:bob2')!;
    expect(key).toBe('person:bot:bob');
    await until(() => env!.d.budgets.usage(key).usd >= 1.5, 3000, 'person spend');
  });
});

describe('Nostr peers without a hops tag (R-B1)', () => {
  const key = generateAgentKey();
  const peer = { principal: `nostr:${key.npub}`, displayName: 'Peer' };
  const peerDm = { kind: 'dm' as const, id: key.npub };
  const mesh = (known: Set<string>): MeshProvider => ({
    listAgents: async () => [],
    ask: async () => '',
    postJob: async () => ({ jobId: 'x' }),
    jobResult: async () => ({}),
    isKnownAgent: async (p) => known.has(p),
  });
  const rolePrompt = (e: TestEnv) => e.harness.sessions.flatMap((s) => s.prompts).at(-1) ?? '';

  it('an agent with a capability card / attestation is still role=agent', async () => {
    env = await makeEnv({ mesh: mesh(new Set([peer.principal])) });
    const conn = await setupBot(env);
    conn.inject({ conversation: peerDm, from: peer, text: 'hello from a peer' });
    await until(() => rolePrompt(env!).includes('hello from a peer'), 5000, 'peer prompt');
    expect(rolePrompt(env)).toContain('role=agent');
  });

  it('an unknown key without hops stays an unknown human (no access)', async () => {
    env = await makeEnv({ mesh: mesh(new Set()) });
    const conn = await setupBot(env);
    conn.inject({ conversation: peerDm, from: peer, text: 'hello?' });
    await until(() => auditTypes(env!).includes('sender.unknown'), 3000);
    expect(env.harness.sessions).toHaveLength(0);
  });

  it('a peer seen with a hops tag before stays an agent when it drops the tag', async () => {
    env = await makeEnv({ mesh: mesh(new Set()) });
    const conn = await setupBot(env);
    conn.inject({ conversation: peerDm, from: peer, text: 'with hops', hops: 1 });
    await until(() => rolePrompt(env!).includes('with hops'), 5000);
    conn.inject({ conversation: peerDm, from: peer, text: 'without hops' });
    await until(() => rolePrompt(env!).includes('without hops'), 5000);
    expect(rolePrompt(env)).toContain('role=agent');
  });

  it('mesh.allow peers are treated as peers (membership role, mesh caps apply)', async () => {
    env = await makeEnv({ mesh: mesh(new Set()) });
    const conn = await setupBot(env, { mesh: { allow: [key.npub], maxTurnsPerThread: 1 } });
    conn.inject({ conversation: peerDm, from: peer, text: 'allowed one' });
    await until(() => rolePrompt(env!).includes('allowed one'), 5000);
    expect(rolePrompt(env)).toContain('role=viewer');
    conn.inject({ conversation: peerDm, from: peer, text: 'allowed two' });
    await until(() => auditTypes(env!).includes('mesh.limit'), 3000, 'mesh cap');
  });

  it('meshListIncludes canonicalizes hex, npub and nostr: forms', () => {
    expect(meshListIncludes([key.pubkey], peer.principal)).toBe(true);
    expect(meshListIncludes([`nostr:${key.pubkey}`], peer.principal)).toBe(true);
    expect(meshListIncludes([key.npub], peer.principal)).toBe(true);
    expect(meshListIncludes([key.npub], `telegram:${key.npub}`)).toBe(false);
  });
});

describe('SSRF-safe inbound downloads (Nostr/Discord URLs)', () => {
  let server: Server;
  let port = 0;
  let hits = 0;
  beforeAll(async () => {
    server = createServer((_q, r) => {
      hits++;
      r.end('attachment body');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  });

  const attach = (url: string) => [{ name: 'pic.png', mime: 'image/png', url }];

  it('refuses loopback / metadata URLs and never connects', async () => {
    env = await makeEnv({ fetch: { allowedPorts: [] } });
    const conn = await setupBot(env);
    await ownerAlice(env);
    const before = hits;
    for (const url of [
      `http://127.0.0.1:${port}/a`,
      `http://localhost:${port}/a`,
      'http://169.254.169.254/latest/meta-data/',
    ])
      conn.inject({ text: `file ${url}`, attachments: attach(url) });
    await until(() => conn.textsTo('alice').filter((t) => t.startsWith('reply:')).length === 3, 5000);
    expect(hits).toBe(before);
    const sid = env.d.store.sessions.list({ agent: 'bot' })[0]!.id;
    const errs = env.d.store.sessions.events(sid).filter((e) => e.kind === 'error');
    expect(errs.filter((e) => /fetch refused/.test(e.text ?? '')).length).toBe(3);
  });

  it('downloads public URLs into the inbox through the checked address', async () => {
    env = await makeEnv({
      fetch: {
        allowedPorts: [],
        lookup: async (h) => (h === 'cdn.test' ? [{ address: '127.0.0.1', family: 4 }] : []),
        isBlocked: (a) => a !== '127.0.0.1',
      },
    });
    const conn = await setupBot(env);
    await ownerAlice(env);
    const before = hits;
    conn.inject({ text: 'see file', attachments: attach(`http://cdn.test:${port}/pic.png`) });
    await until(() => lastText(env!, 'alice').includes('reply:'), 5000);
    expect(hits).toBe(before + 1);
    const prompt = env.harness.latest().prompts[0]!;
    expect(prompt).toMatch(/files=\S*inbox\S*pic\.png/);
  });
});

describe('registry wiring', () => {
  it('Slack and Discord get the broker-backed fetchAttachment', async () => {
    const registry = new PluginRegistry();
    const calls: string[] = [];
    await loadBuiltinPlugins({
      registry,
      secrets: new MemorySecretStore(),
      log: silentLogger,
      fetchAttachment: async (u) => {
        calls.push(u);
        return new Response('x');
      },
      provisioning: async () => ({ ownerNpub: '', provisioningPubkey: '', beamhopVersion: '0' }),
    });
    const slack = await import('@beamhop/channel-slack');
    const discord = await import('@beamhop/channel-discord');
    expect(registry.channel('slack')).toBeDefined();
    expect(registry.channel('slack')).not.toBe(slack.slackPlugin);
    expect(registry.channel('discord')).toBeDefined();
    expect(registry.channel('discord')).not.toBe(discord.discordPlugin);
  });
});
