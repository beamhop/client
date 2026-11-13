import { HarnessJobStep, type HarnessView } from '@beamhop/core';
import { describe, expect, it } from 'vitest';
import { harnessAction, jobProgress, jobStepLabel } from './jobs.ts';

const h = (p: Partial<HarnessView>): HarnessView =>
  ({ id: 'x', displayName: 'X', command: 'x', status: 'ready', protocol: 'acp', ...p }) as HarnessView;

describe('harness jobs', () => {
  it('labels every step in plain words', () => {
    expect(jobStepLabel('resolving')).toBe('Getting ready…');
    expect(jobStepLabel('downloading')).toBe('Downloading…');
    expect(jobStepLabel('verifying')).toBe('Verifying…');
    expect(jobStepLabel('installing')).toBe('Installing…');
    expect(jobStepLabel('checking')).toBe('Checking…');
    expect(jobStepLabel('waiting-browser')).toBe('Continue in your browser');
    expect(jobStepLabel('done')).toBe('Ready');
    for (const s of HarnessJobStep.options) {
      expect(jobStepLabel(s)).toBeTruthy();
      expect(jobStepLabel(s)).not.toMatch(/beamhop |npm |brew /);
      expect(jobProgress(s)).toBeGreaterThanOrEqual(0);
    }
  });

  it('picks the row action', () => {
    const plan = { method: 'npm' as const, label: 'npm', command: ['npm', 'i'], alternatives: [] };
    expect(harnessAction(h({ status: 'not-installed', installPlan: plan }))).toBe('install');
    expect(
      harnessAction(h({ status: 'not-installed', installPlan: { ...plan, method: 'none', command: [] } })),
    ).toBe('manual');
    expect(harnessAction(h({ status: 'not-installed' }))).toBe('manual');
    expect(harnessAction(h({ status: 'unsupported-version' }))).toBe('update');
    expect(harnessAction(h({ status: 'ready' }), { updateAvailable: true })).toBe('update');
    expect(harnessAction(h({ status: 'ready' }))).toBeUndefined();
    expect(harnessAction(h({ status: 'needs-login', loginFlow: { kind: 'browser' } }))).toBe('login');
    expect(
      harnessAction(h({ status: 'needs-login', loginFlow: { kind: 'browser' } }), { managedLogin: true }),
    ).toBeUndefined();
    expect(harnessAction(h({ status: 'needs-login' }))).toBeUndefined();
  });
});
