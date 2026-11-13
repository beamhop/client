import { AgentConfig } from '@beamhop/core';
import { describe, expect, it } from 'vitest';
import { parseDiff } from '../../ui/CodeBlock.tsx';
import {
  createCli,
  describeChanges,
  describeCron,
  nextRuns,
  parseCron,
  patchOf,
  reachOf,
  suggestName,
  toYaml,
  unifiedDiff,
  validateMountPath,
  validateName,
  validateNip05,
  validatePrincipal,
  validateSpec,
  writableMount,
} from './model.ts';

const base = AgentConfig.parse({
  name: 'reviewer',
  harness: 'claude',
  mounts: [{ path: '~/code/app', mode: 'ro' }],
  memberships: [{ target: 'nostr:dm', defaultRole: 'viewer', triggers: ['dm'] }],
});

describe('cron', () => {
  it('parses fields, names, ranges, steps and aliases', () => {
    const c = parseCron('*/15 9-17 * * mon-fri');
    expect('error' in c).toBe(false);
    if ('error' in c) return;
    expect([...c.minute]).toEqual([0, 15, 30, 45]);
    expect([...c.dow]).toEqual([1, 2, 3, 4, 5]);
    expect('error' in parseCron('@daily')).toBe(false);
  });

  it('explains errors in plain words', () => {
    expect(parseCron('0 9 * *')).toEqual({ error: expect.stringMatching(/5 fields/) });
    expect(parseCron('0 25 * * *')).toEqual({ error: 'The hour must be 0–23.' });
    expect(parseCron('x 1 * * *')).toEqual({ error: expect.stringMatching(/isn't a valid minute/) });
  });

  it('describes common schedules', () => {
    expect(describeCron('0 9 * * 1-5', 'Europe/Berlin')).toBe('Every weekday at 09:00 Berlin time');
    expect(describeCron('30 7 * * *')).toBe('Every day at 07:30 UTC');
    expect(describeCron('0 * * * *')).toBe('Every hour, on the hour');
    expect(describeCron('*/5 * * * *')).toBe('Every 5 minutes');
    expect(describeCron('0 18 * * 5', 'America/New_York')).toBe('Every Friday at 18:00 New York time');
    expect(describeCron('0 8 1 * *')).toBe('On day 1 of every month at 08:00 UTC');
    expect(describeCron('0 9 * * 1,3,5')).toBe('Every Mon, Wed and Fri at 09:00 UTC');
    expect(describeCron('0 9 1-7 * 1')).toBe('Custom schedule');
  });

  it('computes the next runs in the schedule timezone', () => {
    // Thu 13 Nov 2026 10:00 UTC → 11:00 in Berlin (CET, UTC+1)
    const from = Date.UTC(2026, 10, 13, 10, 0);
    const runs = nextRuns('0 9 * * 1-5', 'Europe/Berlin', from, 3);
    expect(runs.map((t) => new Date(t).toISOString())).toEqual([
      '2026-11-16T08:00:00.000Z',
      '2026-11-17T08:00:00.000Z',
      '2026-11-18T08:00:00.000Z',
    ]);
    expect(nextRuns('*/30 * * * *', 'UTC', from, 2).map((t) => new Date(t).toISOString())).toEqual([
      '2026-11-13T10:30:00.000Z',
      '2026-11-13T11:00:00.000Z',
    ]);
    expect(nextRuns('bad', 'UTC', from)).toEqual([]);
    expect(nextRuns('0 9 * * *', 'Not/AZone', from)).toEqual([]);
  });
});

describe('schedule specs', () => {
  const mounts = [{ path: '~/notes', mode: 'rw' as const, parallelUnsafe: false }];
  it('validates per kind', () => {
    expect(validateSpec('webhook', '/hooks/nightly')).toBeUndefined();
    expect(validateSpec('webhook', 'hooks nightly')).toMatch(/path like/);
    expect(validateSpec('file-change', '~/notes/*.md', mounts)).toBeUndefined();
    expect(validateSpec('file-change', '~/code/*.md', mounts)).toMatch(/inside a mounted folder/);
    expect(validateSpec('file-change', '~/x', [])).toMatch(/no folders/);
    expect(validateSpec('nostr-event', '{"kinds":[1]}')).toBeUndefined();
    expect(validateSpec('nostr-event', '[1]')).toMatch(/JSON object/);
    expect(validateSpec('nostr-event', '{kinds')).toMatch(/valid JSON/);
    expect(validateSpec('cron', '')).toBe('Required.');
  });
});

describe('reach', () => {
  it('derives a preview from profile and mounts', () => {
    const r = reachOf({ ...base, mounts: [{ path: '~/code/app', mode: 'rw', parallelUnsafe: false }] });
    expect(r.reads).toEqual(['~/code/app']);
    expect(r.writes).toEqual(['~/code/app']);
    expect(r.talksTo[0]).toBe('api.anthropic.com');
    expect(r.never).toContain('~/.ssh');
  });
  it('strict never writes and only reaches the model API', () => {
    const r = reachOf({
      ...base,
      sandbox: { profile: 'strict' },
      mounts: [{ path: '~/code/app', mode: 'rw', parallelUnsafe: false }],
    });
    expect(r.writes).toEqual([]);
    expect(r.talksTo).toEqual(['api.anthropic.com']);
  });
});

describe('changes', () => {
  it('patches only changed top-level keys', () => {
    const after = { ...base, budgets: { dailyUsd: 9 } };
    expect(patchOf(base, after)).toEqual({ budgets: { dailyUsd: 9 } });
    expect(patchOf(base, base)).toEqual({});
  });

  it('flags widening changes and phrases them plainly', () => {
    const after: AgentConfig = {
      ...base,
      public: true,
      mounts: [{ path: '~/code/app', mode: 'rw', parallelUnsafe: false }],
      grants: { 'telegram:1': 'admin' },
      budgets: { dailyUsd: 2 },
    };
    const c = describeChanges(base, after);
    expect(c).toContainEqual({ text: 'reviewer will be able to write ~/code/app.', widens: true });
    expect(c).toContainEqual({ text: 'Anyone can talk to reviewer as viewer.', widens: true });
    expect(c).toContainEqual({ text: 'telegram:1 gets the admin role on reviewer.', widens: true });
    expect(c).toContainEqual({ text: 'Daily budget: $5.00 → $2.00.', widens: false });
  });

  it('tightening is not widening', () => {
    const after: AgentConfig = { ...base, memberships: [], mounts: [] };
    const c = describeChanges(base, after);
    expect(c.every((x) => !x.widens)).toBe(true);
    expect(c.map((x) => x.text)).toEqual([
      'reviewer will no longer see ~/code/app.',
      'reviewer leaves nostr:dm.',
    ]);
  });

  it('renders a readable YAML patch', () => {
    expect(toYaml({ budgets: { dailyUsd: 9 }, mounts: [{ path: '~/a', mode: 'ro' }], public: true })).toBe(
      'budgets:\n  dailyUsd: 9\nmounts:\n  - path: ~/a\n    mode: ro\npublic: true',
    );
  });
});

describe('validators', () => {
  it('names', () => {
    expect(validateName('reviewer', ['reviewer'])).toBe('reviewer already exists. Try reviewer-2.');
    expect(validateName('Bad Name', [])).toMatch(/lowercase/);
    expect(validateName('ok-1', [])).toBeUndefined();
    expect(suggestName('qa', ['qa', 'qa-2'])).toBe('qa-3');
  });
  it('principals, nip05, mounts', () => {
    expect(validatePrincipal('telegram:5551')).toBeUndefined();
    expect(validatePrincipal('bob')).toMatch(/provider:id/);
    expect(validateNip05('a@b.co')).toBeUndefined();
    expect(validateNip05('nope')).toMatch(/name@domain/);
    expect(validateMountPath('~/.ssh', [])).toMatch(/always blocked/);
    expect(validateMountPath('~', [])).toMatch(/whole home/);
    expect(
      validateMountPath('~/code/app/', [{ path: '~/code/app', mode: 'ro', parallelUnsafe: false }]),
    ).toMatch(/already mounted/);
    expect(validateMountPath('~/code/site', [])).toBeUndefined();
  });
  it('builds the CLI equivalent', () => {
    expect(
      createCli({
        name: 'qa',
        preset: 'public-qa',
        harness: 'gemini',
        mounts: [{ path: '~/docs/public', mode: 'ro', parallelUnsafe: false }],
      }),
    ).toBe('beamhop agent add qa --preset public-qa --harness gemini --mount ~/docs/public:ro');
  });
});

describe('instruction files', () => {
  it('are writable only inside a read-write mount', () => {
    const mounts = [
      { path: '~/code/app', mode: 'rw' as const, parallelUnsafe: false },
      { path: '~/notes', mode: 'ro' as const, parallelUnsafe: false },
    ];
    expect(writableMount(mounts, '~/code/app/CLAUDE.md')?.path).toBe('~/code/app');
    expect(writableMount(mounts, '~/code/app/./sub/../AGENTS.md')?.path).toBe('~/code/app');
    expect(writableMount(mounts, '~/notes/CLAUDE.md')).toBeUndefined();
    expect(writableMount(mounts, '~/code/application/CLAUDE.md')).toBeUndefined();
    expect(writableMount(mounts, '~/code/app/../site/CLAUDE.md')).toBeUndefined();
  });

  it('previews edits as a unified diff the DiffView can read', () => {
    const before = [
      '# app',
      '',
      '- one',
      '- two',
      '- three',
      '- four',
      '- five',
      '- six',
      '- seven',
      '',
    ].join('\n');
    const after = before.replace('- two', '- TWO').replace('- seven', '- seven\n- eight');
    const d = unifiedDiff('CLAUDE.md', before, after);
    expect(d.split('\n').slice(0, 3)).toEqual([
      'diff --git a/CLAUDE.md b/CLAUDE.md',
      '--- a/CLAUDE.md',
      '+++ b/CLAUDE.md',
    ]);
    const [file] = parseDiff(d);
    expect(file).toMatchObject({ path: 'CLAUDE.md', added: 2, removed: 1 });
    expect(file!.lines.filter((l) => l.kind === 'del').map((l) => l.text)).toEqual(['- two']);
    expect(file!.lines.filter((l) => l.kind === 'add').map((l) => l.text)).toEqual(['- TWO', '- eight']);
    expect(unifiedDiff('x', 'same', 'same')).toBe('');
  });

  it('splits far-apart changes into separate hunks with correct line numbers', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    const after = [...lines];
    after[1] = 'changed 2';
    after[27] = 'changed 28';
    const d = unifiedDiff('f', lines.join('\n'), after.join('\n'));
    const hunks = d.split('\n').filter((l) => l.startsWith('@@'));
    expect(hunks).toEqual(['@@ -1,5 +1,5 @@', '@@ -25,6 +25,6 @@']);
  });
});
