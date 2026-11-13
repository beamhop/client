import { DEFAULT_ROLES, type RoleDef } from '@beamhop/core';
import { describe, expect, it } from 'vitest';
import { definePayload, isLockedRole, roleDiff, roleUses } from './roles.ts';

const role = (name: string): RoleDef => structuredClone(DEFAULT_ROLES.find((r) => r.name === name)!);

describe('role editing', () => {
  it('locks only owner and agent', () => {
    expect(isLockedRole('owner')).toBe(true);
    expect(isLockedRole('agent')).toBe(true);
    expect(isLockedRole('admin')).toBe(false);
    expect(isLockedRole('reviewer-guest')).toBe(false);
  });

  it('describes changes in plain language, in table order', () => {
    const before = role('viewer');
    expect(roleDiff(before, before)).toEqual([]);
    const after: RoleDef = {
      ...before,
      canApprove: !before.canApprove,
      permissionMode: 'auto',
      budget: { ...before.budget, dailyUsd: 5 },
      description: `${before.description} (edited)`,
    };
    const d = roleDiff(before, after);
    expect(d[0]).toMatch(/^Tool use: .+ → Acts without asking$/);
    expect(d).toContain(
      `Can approve other people’s requests: ${before.canApprove ? 'yes' : 'no'} → ${before.canApprove ? 'no' : 'yes'}`,
    );
    expect(d).toContain(
      `Daily spend: ${before.budget.dailyUsd === undefined ? 'no limit' : `$${before.budget.dailyUsd}/day`} → $5/day`,
    );
    expect(d.at(-1)).toBe('Description changes');
  });

  it('sends every editable field (and nothing else) to role.define', () => {
    const p = definePayload({ ...role('user'), description: '  padded  ' });
    expect(Object.keys(p).sort()).toEqual(
      [
        'budget',
        'canApprove',
        'canPrompt',
        'canReconfigure',
        'description',
        'dlp',
        'name',
        'permissionMode',
        'sandboxProfile',
      ].sort(),
    );
    expect(p.description).toBe('padded');
  });
});

describe('roleUses (what the daemon checks before role.delete)', () => {
  const agents = [
    {
      config: {
        name: 'bot',
        grants: { 'fake:bob': 'guest' },
        memberships: [
          { target: 'fk:dm', defaultRole: 'viewer' },
          { target: 'fk2:dm', defaultRole: 'guest' },
        ],
      },
    },
    { config: { name: 'plain' } },
  ];

  it('counts global grants, per-agent grants and channel memberships', () => {
    expect(roleUses('guest', { 'fake:carol': 'guest', 'fake:dan': 'user' }, agents)).toEqual([
      'fake:carol',
      'fake:bob on bot',
      'bot on fk2:dm',
    ]);
  });

  it('is empty for an unused role (a membership default counts as use, not only people)', () => {
    expect(roleUses('reviewer', { 'fake:carol': 'guest' }, agents)).toEqual([]);
    expect(roleUses('viewer', {}, agents)).toEqual(['bot on fk:dm']);
  });
});
