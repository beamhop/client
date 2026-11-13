import { DEFAULT_ROLES, type RoleDef } from '@beamhop/core';
import { describe, expect, it } from 'vitest';
import { definePayload, isLockedRole, roleDiff } from './roles.ts';

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
