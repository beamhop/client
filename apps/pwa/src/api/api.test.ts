import { type MethodName, methods, type ServerEvent } from '@beamhop/core';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveConnection } from './connection.ts';
import { applyServerEvent } from './events.ts';
import { apiKey, invalidationsFor } from './keys.ts';
import { createMockTransport } from './mock/index.ts';

const SAMPLE: Partial<Record<MethodName, unknown>> = {
  'device.pairStatus': { pairingId: 'p1' },
  'device.pairConfirm': { pairingId: 'p1', accept: true },
  'identity.ownerImport': { npub: 'npub1x' },
  'identity.attestationTemplate': { name: 'reviewer' },
  'identity.attest': { name: 'reviewer', event: {} },
  'identity.publish': { name: 'reviewer' },
  'onboarding.hello': { agent: 'reviewer' },
  'onboarding.helloStatus': { agent: 'reviewer' },
  'agent.get': { name: 'reviewer' },
  'agent.create': { config: { name: 'tester', harness: 'claude' }, preset: 'code-reviewer' },
  'agent.update': { name: 'reviewer', patch: { description: 'x' } },
  'agent.delete': { name: 'scribe' },
  'agent.start': { name: 'reviewer' },
  'agent.stop': { name: 'ci-bot' },
  'agent.clone': { name: 'reviewer', newName: 'reviewer-2' },
  'agent.instructions': { name: 'reviewer' },
  'harness.add': { id: 'myacp', command: 'my-agent', args: ['--acp'] },
  'channel.validate': { provider: 'slack', values: {}, secrets: { bot: 'placeholder' } },
  'channel.add': { name: 'ops2', provider: 'discord', values: {}, secrets: { token: 'placeholder' } },
  'channel.remove': { name: 'ops' },
  'channel.pair': { name: 'tg' },
  'membership.join': { agent: 'reviewer', membership: { target: 'acme:channel/C0ENG' } },
  'membership.leave': { agent: 'reviewer', target: 'nostr:dm' },
  'session.events': { id: 'ses_842' },
  'session.send': { id: 'ses_842', text: 'hi' },
  'session.start': { agent: 'reviewer', text: 'hello' },
  'session.stop': { id: 'ses_d17' },
  'approval.decide': { id: 'apr_c09e', allow: true },
  'approval.undo': { id: 'apr_c09e' },
  'role.grant': { principal: 'nostr:npub1x', role: 'viewer' },
  'role.revoke': { principal: 'nostr:npub1x' },
  'principal.link': { person: 'alice', principal: 'telegram:1' },
  'owner.add': { principal: 'nostr:npub1bob' },
  'owner.remove': { principal: 'nostr:npub1bob' },
  'policy.get': { name: 'reviewer' },
  'policy.set': { name: 'helpdesk', profile: 'strict' },
  'policy.applySuggestion': { id: 'sug_pypi', accept: true },
  'secret.set': { name: 'X', value: 'v' },
  'secret.setKeySource': { keySource: 'keychain' },
  'harness.login': { id: 'codex', value: 'sk-test' },
  'harness.logout': { id: 'codex' },
  'harness.checkLogin': { id: 'claude' },
  'secret.delete': { name: 'X' },
  'schedule.add': { agent: 'reviewer', kind: 'cron', spec: '0 9 * * *', prompt: 'p', owner: 'nostr:npub1a' },
  'schedule.update': { id: 'sch_standup', patch: { paused: true } },
  'schedule.remove': { id: 'sch_notes' },
  'schedule.run': { id: 'sch_standup' },
  'deploy.options': { provider: 'hetzner' },
  'deploy.plan': { agent: 'reviewer', provider: 'hetzner', mode: 'move' },
  'deploy.apply': { agent: 'reviewer', provider: 'hetzner', mode: 'new' },
  'deploy.destroy': { id: 'dep_hz_fsn1' },
  'device.pairComplete': { code: 'X', pubkey: 'npub1y', name: 'Pixel' },
  'device.remove': { id: 'dev_pixel' },
  'device.pushSubscribe': { id: 'dev_mac', subscription: {} },
  'device.pushPrefs': { id: 'dev_mac' },
  'identity.nip05': { domain: 'example.com' },
  'agent.instructionsWrite': { name: 'reviewer', path: '~/code/app/CLAUDE.md', content: '# hi' },
  'channel.connect': { name: 'tg' },
  'channel.disconnect': { name: 'tg' },
  'session.merge': { id: 'ses_836' },
  'session.openPr': { id: 'ses_836' },
  'approval.quorumSet': { quorum: 2 },
  'role.define': { role: { name: 'reviewer-role', canPrompt: true } },
  'role.delete': { name: 'reviewer-role' },
  'principal.unlink': { person: 'alice', principal: 'telegram:5551' },
  'alerts.set': { spikeEvents: 3 },
  'updates.set': { appPrompt: false },
  'fs.list': { path: '~/code' },
};

describe('mock daemon', () => {
  afterEach(() => vi.useRealTimers());

  it('implements every method in the API contract', async () => {
    const t = createMockTransport({ live: false, latency: [0, 0] });
    const order = (Object.keys(methods) as MethodName[]).filter(
      (m) => m !== 'system.panic' && m !== 'system.resume',
    );
    for (const m of [...order, 'system.panic', 'system.resume'] as MethodName[]) {
      await expect(t.request(m, SAMPLE[m] ?? {}), m).resolves.toBeDefined();
    }
    t.close?.();
  });

  it('validates params with the real schemas and reports unknown methods', async () => {
    const t = createMockTransport({ live: false, latency: [0, 0] });
    await expect(t.request('agent.get', {})).rejects.toMatchObject({ code: -32602 });
    await expect(t.request('nope.nope', {})).rejects.toMatchObject({ code: -32601 });
    await expect(t.request('agent.get', { name: 'ghost' })).rejects.toMatchObject({ code: -32004 });
  });

  it('holds decisions in a 5 s undo window, then releases them', async () => {
    vi.useFakeTimers();
    const t = createMockTransport({ live: false, latency: [0, 0] });
    const a = (await t.request('approval.decide', { id: 'apr_a41f', allow: true })) as { status: string };
    expect(a.status).toBe('approved');
    const back = (await t.request('approval.undo', { id: 'apr_a41f' })) as { status: string };
    expect(back.status).toBe('pending');
    await t.request('approval.decide', { id: 'apr_a41f', allow: false });
    vi.advanceTimersByTime(5100);
    await expect(t.request('approval.undo', { id: 'apr_a41f' })).rejects.toMatchObject({ code: -32009 });
    t.close?.();
  });

  it('panic stops everything and resume leaves agents stopped', async () => {
    const t = createMockTransport({ live: false, latency: [0, 0] });
    const events: ServerEvent[] = [];
    t.subscribe?.((e) => events.push(e));
    await t.request('system.panic', {});
    const st = (await t.request('system.status', {})) as { panic: boolean; pendingApprovals: number };
    expect(st).toMatchObject({ panic: true, pendingApprovals: 0 });
    expect(events.some((e) => e.type === 'panic' && e.active)).toBe(true);
    await expect(t.request('agent.start', { name: 'reviewer' })).rejects.toMatchObject({ code: -32009 });
    await t.request('system.resume', {});
    const { agents } = (await t.request('agent.list', {})) as { agents: Array<{ status: string }> };
    expect(agents.every((a) => a.status === 'stopped')).toBe(true);
  });

  it('can simulate failures for error-state work', async () => {
    const t = createMockTransport({ live: false, latency: [0, 0], failMethods: ['channel.list'] });
    await expect(t.request('channel.list', {})).rejects.toMatchObject({ code: -32010 });
  });
});

describe('applyServerEvent', () => {
  it('patches list and detail caches in place', async () => {
    const qc = new QueryClient();
    const t = createMockTransport({ live: false, latency: [0, 0] });
    qc.setQueryData(apiKey('agent.list'), await t.request('agent.list', {}));
    qc.setQueryData(
      apiKey('approval.list', { status: 'pending' }),
      await t.request('approval.list', { status: 'pending' }),
    );
    qc.setQueryData(
      apiKey('session.events', { id: 'ses_842', afterSeq: 0 }),
      await t.request('session.events', { id: 'ses_842' }),
    );
    t.subscribe?.((e) => applyServerEvent(qc, e));

    await t.request('agent.stop', { name: 'reviewer' });
    const list = qc.getQueryData(apiKey('agent.list')) as {
      agents: Array<{ config: { name: string }; status: string }>;
    };
    expect(list.agents.find((a) => a.config.name === 'reviewer')?.status).toBe('stopped');

    await t.request('approval.decide', { id: 'apr_b72c', allow: false });
    const pending = qc.getQueryData(apiKey('approval.list', { status: 'pending' })) as {
      approvals: Array<{ id: string }>;
    };
    expect(pending.approvals.some((a) => a.id === 'apr_b72c')).toBe(false);

    const before = (
      qc.getQueryData(apiKey('session.events', { id: 'ses_842', afterSeq: 0 })) as { events: unknown[] }
    ).events.length;
    t.daemon.pushEvent('ses_842', { kind: 'assistant', text: 'Pus' });
    const seq = t.daemon.nextSeq('ses_842') - 1;
    t.daemon.pushEvent('ses_842', { seq, kind: 'assistant', text: 'Pushed.' });
    const evs = (
      qc.getQueryData(apiKey('session.events', { id: 'ses_842', afterSeq: 0 })) as {
        events: Array<{ text?: string }>;
      }
    ).events;
    expect(evs).toHaveLength(before + 1);
    expect(evs.at(-1)?.text).toBe('Pushed.');
  });
});

describe('connection + keys', () => {
  it('stores #token, strips it from the URL and picks the local daemon', () => {
    localStorage.clear();
    sessionStorage.clear();
    history.replaceState(null, '', '/inbox#token=abc123');
    const c = resolveConnection(window.location);
    expect(c).toMatchObject({ kind: 'local', token: 'abc123', reason: 'token' });
    expect(window.location.hash).toBe('');
    expect(localStorage.getItem('bh.token')).toBe('abc123');
  });

  it('uses the mock with ?mock=1 (sticky) or without a token', () => {
    localStorage.clear();
    sessionStorage.clear();
    history.replaceState(null, '', '/');
    expect(resolveConnection(window.location)).toMatchObject({ kind: 'mock', reason: 'no-token' });
    localStorage.setItem('bh.token', 't');
    history.replaceState(null, '', '/?mock=1&still=1');
    expect(resolveConnection(window.location)).toMatchObject({ kind: 'mock', live: false });
    history.replaceState(null, '', '/');
    expect(resolveConnection(window.location).kind).toBe('mock');
    history.replaceState(null, '', '/?mock=0');
    expect(resolveConnection(window.location).kind).toBe('local');
  });

  it('maps mutations to the reads they invalidate', () => {
    expect(invalidationsFor('agent.stop')).toContain('agent.list');
    expect(invalidationsFor('system.panic')).toBe('all');
    expect(invalidationsFor('approval.decide')).toContain('system.status');
  });
});
