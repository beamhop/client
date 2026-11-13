import type { DeploymentView } from '@beamhop/core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { deployLamp, groupPlan, monthToDate, phaseState, planCounts, planTone } from './model.ts';
import { PlanDiff } from './PlanDiff.tsx';

const dep = (over: Partial<DeploymentView> = {}): DeploymentView => ({
  id: 'dep_x',
  provider: 'hetzner',
  agent: 'reviewer',
  status: 'running',
  createdAt: new Date(2026, 10, 1).toISOString(),
  monthlyCostUsd: 30,
  ...over,
});

describe('plan vocabulary', () => {
  it('maps ops to + ~ → - tones', () => {
    expect(planTone('create')).toBe('add');
    expect(planTone('install')).toBe('add');
    expect(planTone('move')).toBe('change');
    expect(planTone('keep')).toBe('change');
    expect(planTone('clone')).toBe('move');
    expect(planTone('stop')).toBe('remove');
    expect(planTone('destroy')).toBe('remove');
    expect(planTone('frobnicate')).toBe('warn');
  });

  it('groups in a stable order and counts', () => {
    const actions = [
      { op: 'stop', resource: 'local agent', detail: 'reviewer' },
      { op: 'create', resource: 'server', detail: 'cx22' },
      { op: 'move', resource: 'identity', detail: '→ vault' },
      { op: 'create', resource: 'firewall', detail: 'outbound only' },
    ];
    expect(groupPlan(actions).map((g) => [g.tone, g.rows.map((r) => r.resource)])).toEqual([
      ['add', ['server', 'firewall']],
      ['change', ['identity']],
      ['remove', ['local agent']],
    ]);
    expect(planCounts(actions)).toMatchObject({ add: 2, change: 1, remove: 1, move: 0 });
  });

  it('renders symbol AND word for every row, expandable', async () => {
    render(
      <PlanDiff
        actions={[
          { op: 'create', resource: 'server', detail: 'hetzner cx22 · fsn1' },
          { op: 'stop', resource: 'local agent', detail: 'reviewer' },
        ]}
      />,
    );
    expect(screen.getByText('1 to create · 1 to remove')).toBeInTheDocument();
    const row = screen.getByRole('button', { name: /create server/ });
    expect(row).toHaveAttribute('aria-expanded', 'false');
    expect(row.textContent).toContain('+');
    await userEvent.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: /stop local agent/ }).textContent).toContain('-');
  });
});

describe('deployment state', () => {
  it('lamps', () => {
    expect(deployLamp(dep())).toBe('ready');
    expect(deployLamp(dep({ status: 'provisioning' }))).toBe('live');
    expect(deployLamp(dep({ status: 'error' }))).toBe('error');
    expect(deployLamp(dep({ status: 'destroyed' }))).toBe('stopped');
  });

  it('month to date is prorated from the later of creation and the 1st', () => {
    const now = new Date(2026, 10, 16).getTime(); // 15 days into a 30-day November
    expect(monthToDate(dep(), now)).toBeCloseTo(15, 5);
    expect(monthToDate(dep({ createdAt: new Date(2026, 9, 1).toISOString() }), now)).toBeCloseTo(15, 5);
    expect(monthToDate(dep({ status: 'destroyed' }), now)).toBe(0);
    expect(monthToDate(dep({ monthlyCostUsd: undefined }), now)).toBe(0);
  });

  it('phases advance with elapsed time while provisioning', () => {
    const created = Date.now();
    const d = dep({ status: 'provisioning', createdAt: new Date(created).toISOString() });
    const early = phaseState(d, created + 100);
    expect(early[0]?.state).toBe('live');
    expect(early.slice(1).every((p) => p.state === 'todo')).toBe(true);
    const mid = phaseState(d, created + 4000);
    expect(mid.filter((p) => p.state === 'done').length).toBe(3);
    expect(phaseState(dep(), created).every((p) => p.state === 'done')).toBe(true);
    expect(phaseState(dep({ status: 'error' }), created).map((p) => p.state)).toContain('error');
  });
});
