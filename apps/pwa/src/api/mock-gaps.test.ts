// The mock daemon's new methods behave like beamhopd (apps/daemon/test/api-gaps.test.ts).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockTransport } from './mock/index.ts';

const mk = () => createMockTransport({ live: false, latency: [0, 0] });

describe('mock daemon: API gaps (parity with beamhopd)', () => {
  afterEach(() => vi.useRealTimers());

  it('always + rule is validated like the daemon and persisted after the undo window', async () => {
    vi.useFakeTimers();
    const t = mk();
    for (const rule of ['*.org', 'evil.com', 'bash:ls', '~/.ssh/'])
      await expect(
        t.request('approval.decide', { id: 'apr_b72c', allow: true, always: true, rule }),
      ).rejects.toMatchObject({ code: -32602 });
    await expect(
      t.request('approval.decide', { id: 'apr_b72c', allow: true, rule: '*.npmjs.org' }),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(
      t.request('approval.decide', { id: 'apr_a41f', allow: true, always: true, rule: 'bash:sudo' }),
    ).rejects.toMatchObject({ code: -32602 });
    await t.request('approval.decide', { id: 'apr_b72c', allow: true, always: true, rule: '*.npmjs.org' });
    vi.advanceTimersByTime(5100);
    const a = (await t.request('agent.get', { name: 'ci-bot' })) as { config: { approvalRules: unknown[] } };
    expect(a.config.approvalRules).toEqual([
      expect.objectContaining({ kind: 'host', value: '*.npmjs.org', tool: 'Fetch', role: 'user' }),
    ]);
    t.close?.();
  });

  it('policy.applySuggestion honours a validated value', async () => {
    const t = mk();
    await expect(
      t.request('policy.applySuggestion', { id: 'sug_pypi', accept: true, value: '*.org' }),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(
      t.request('policy.applySuggestion', { id: 'sug_pypi', accept: false, value: '*.pypi.org' }),
    ).rejects.toMatchObject({ code: -32602 });
    await t.request('policy.applySuggestion', { id: 'sug_pypi', accept: true, value: '*.pypi.org' });
    const pol = (await t.request('policy.get', { name: 'helpdesk' })) as {
      effective: { net: { allow: string[] } };
    };
    expect(pol.effective.net.allow).toContain('*.pypi.org');
  });

  it('openPr holds the push behind an approval; merge works on worktree sessions', async () => {
    vi.useFakeTimers();
    const t = mk();
    const pr = (await t.request('session.openPr', { id: 'ses_836' })) as {
      compareUrl: string;
      approval: { id: string; tool: string; status: string };
    };
    expect(pr.compareUrl).toContain('/compare/main...beamhop%2F836');
    expect(pr.approval).toMatchObject({ tool: 'git.push', status: 'pending' });
    await expect(
      t.request('approval.decide', { id: pr.approval.id, allow: true, session: true }),
    ).rejects.toMatchObject({ code: -32602 });
    await t.request('approval.decide', { id: pr.approval.id, allow: true });
    vi.advanceTimersByTime(5100);
    const ev = (await t.request('session.events', { id: 'ses_836' })) as { events: Array<{ text?: string }> };
    expect(ev.events.at(-1)?.text).toContain('Open a pull request');
    expect(await t.request('session.merge', { id: 'ses_836' })).toMatchObject({
      base: 'main',
      branch: 'beamhop/836',
    });
    await expect(t.request('session.merge', { id: 'ses_836', base: '--x' })).rejects.toMatchObject({
      code: -32602,
    });
    t.close?.();
  });

  it('whoami, fs.list, alerts, roles, quorum, owners, instruction files', async () => {
    const t = mk();
    expect(await t.request('system.whoami', {})).toEqual({
      principal: 'local:owner',
      role: 'owner',
      via: 'local',
      person: 'alice',
    });
    const fs = (await t.request('fs.list', { path: '~/Library' })) as {
      entries: Array<{ name: string }>;
      parent: string;
    };
    expect(fs.entries.map((e) => e.name)).toEqual(['Fonts']);
    expect(fs.parent).toBe('~');
    const code = (await t.request('fs.list', { path: '~/code' })) as {
      entries: Array<{ name: string; git: boolean }>;
    };
    expect(code.entries.find((e) => e.name === 'app')?.git).toBe(true);
    await expect(t.request('fs.list', { path: '~/.ssh' })).rejects.toMatchObject({ code: -32003 });
    await expect(t.request('fs.list', { path: '/etc' })).rejects.toMatchObject({ code: -32003 });

    expect(await t.request('alerts.get', {})).toMatchObject({
      budgetWarn: 80,
      spikeEvents: 5,
      nostrDm: true,
    });
    await expect(t.request('alerts.set', { budgetWarn: 150 })).rejects.toMatchObject({ code: -32602 });
    expect(await t.request('alerts.set', { budgetWarn: 70 })).toMatchObject({ budgetWarn: 70 });

    await expect(
      t.request('role.define', { role: { name: 'owner', canApprove: false } }),
    ).rejects.toMatchObject({ code: -32003 });
    await expect(t.request('role.delete', { name: 'viewer' })).rejects.toMatchObject({ code: -32602 });
    const def = (await t.request('role.define', { role: { name: 'user', dlp: 'block' } })) as {
      canPrompt: boolean;
      dlp: string;
    };
    expect(def).toMatchObject({ canPrompt: true, dlp: 'block' });
    expect(await t.request('approval.quorumGet', {})).toMatchObject({ quorum: 1 });
    expect(await t.request('owner.list', {})).toMatchObject({
      owners: [expect.objectContaining({ person: 'alice', linked: ['local:owner', 'telegram:5551'] })],
    });
    expect(await t.request('updates.set', { catalogAuto: false })).toEqual({
      catalogAuto: false,
      appPrompt: true,
    });

    await expect(
      t.request('agent.instructionsWrite', { name: 'reviewer', path: '~/notes/CLAUDE.md', content: 'x' }),
    ).rejects.toMatchObject({ code: -32003 });
    await expect(
      t.request('agent.instructionsWrite', {
        name: 'reviewer',
        path: '~/code/app/package.json',
        content: 'x',
      }),
    ).rejects.toMatchObject({ code: -32003 });
    await t.request('agent.instructionsWrite', {
      name: 'reviewer',
      path: '~/code/app/CLAUDE.md',
      content: '# edited',
    });
    const ins = (await t.request('agent.instructions', { name: 'reviewer' })) as {
      files: Array<{ path: string; content: string }>;
    };
    expect(ins.files.find((f) => f.path === '~/code/app/CLAUDE.md')?.content).toBe('# edited');
    t.close?.();
  });

  it('channel.disconnect / connect', async () => {
    vi.useFakeTimers();
    const t = mk();
    expect(await t.request('channel.disconnect', { name: 'tg' })).toMatchObject({ status: 'disabled' });
    expect(await t.request('channel.connect', { name: 'tg' })).toMatchObject({ status: 'connecting' });
    vi.advanceTimersByTime(1000);
    const { channels } = (await t.request('channel.list', {})) as {
      channels: Array<{ config: { name: string; enabled: boolean }; status: string }>;
    };
    expect(channels.find((c) => c.config.name === 'tg')).toMatchObject({
      status: 'connected',
      config: { enabled: true },
    });
    t.close?.();
  });
});

describe('mock daemon: desktop without a terminal', () => {
  afterEach(() => vi.useRealTimers());

  it('installs a harness through a job, with steps and output lines', async () => {
    vi.useFakeTimers();
    const t = mk();
    const job = (await t.request('harness.install', { id: 'copilot' })) as { id: string; step: string };
    expect(job.step).toBe('resolving');
    await expect(t.request('harness.install', { id: 'copilot' })).rejects.toMatchObject({ code: -32009 });
    vi.advanceTimersByTime(900);
    const mid = (await t.request('harness.job.get', { jobId: job.id })) as {
      job: { step: string };
      lines: string[];
      next: number;
    };
    expect(['verifying', 'installing']).toContain(mid.job.step);
    expect(mid.lines.length).toBe(mid.next);
    vi.advanceTimersByTime(2000);
    const end = (await t.request('harness.job.get', { jobId: job.id, since: mid.next })) as {
      job: { step: string };
    };
    expect(end.job.step).toBe('done');
    const { harnesses } = (await t.request('harness.list', {})) as {
      harnesses: Array<{ id: string; status: string }>;
    };
    expect(harnesses.find((h) => h.id === 'copilot')?.status).not.toBe('not-installed');
    t.close?.();
  });

  it('cancels a job; login exposes url and code; doctorFix flips the check', async () => {
    vi.useFakeTimers();
    const t = mk();
    const up = (await t.request('harness.update', { id: 'pi' })) as { id: string };
    expect(await t.request('harness.job.cancel', { jobId: up.id })).toMatchObject({ step: 'cancelled' });
    const login = (await t.request('harness.loginFlow', { id: 'cursor' })) as { id: string };
    vi.advanceTimersByTime(400);
    expect(await t.request('harness.job.get', { jobId: login.id })).toMatchObject({
      job: { step: 'waiting-browser', url: expect.stringContaining('https://'), code: expect.any(String) },
    });
    const { jobs } = (await t.request('harness.job.list', {})) as { jobs: unknown[] };
    expect(jobs).toHaveLength(2);
    expect(await t.request('harness.updates', {})).toMatchObject({
      updates: expect.arrayContaining([expect.objectContaining({ id: 'pi', required: true })]),
    });
    vi.useRealTimers();
    await expect(
      t.request('system.doctorFix', { id: 'linux.apparmor.bwrap', elevate: 'none' }),
    ).rejects.toMatchObject({ code: -32003 });
    const r = (await t.request('system.doctorFix', { id: 'linux.apparmor.bwrap' })) as {
      checks: Array<{ id: string; status: string }>;
    };
    expect(r.checks.find((c) => c.id === 'userns')?.status).toBe('ok');
    t.close?.();
  });
});
