import { describe, expect, it } from 'vitest';
import { nextCronTime, parseCron } from '../src/cron.ts';
import { readDeployEnv } from '../src/home.ts';
import { stricterProfile } from '../src/sessions.ts';

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());

describe('cron', () => {
  it('basic fields, steps, lists, ranges, names', () => {
    expect(iso(nextCronTime('*/15 * * * *', at('2026-11-13T10:07:00Z')))).toBe('2026-11-13T10:15:00.000Z');
    expect(iso(nextCronTime('0 9 * * mon-fri', at('2026-11-13T10:00:00Z')))).toBe('2026-11-16T09:00:00.000Z'); // Fri → Mon
    expect(iso(nextCronTime('30 8 1,15 * *', at('2026-11-13T00:00:00Z')))).toBe('2026-11-15T08:30:00.000Z');
    expect(iso(nextCronTime('@yearly', at('2026-11-13T00:00:00Z')))).toBe('2027-01-01T00:00:00.000Z');
    expect(iso(nextCronTime('0 0 * * 7', at('2026-11-13T00:00:00Z')))).toBe('2026-11-15T00:00:00.000Z'); // 7 = Sunday
  });

  it('timezones', () => {
    // 09:00 in Berlin (UTC+1 in November) is 08:00Z
    expect(iso(nextCronTime('0 9 * * *', at('2026-11-13T07:00:00Z'), 'Europe/Berlin'))).toBe(
      '2026-11-13T08:00:00.000Z',
    );
    expect(iso(nextCronTime('0 9 * * *', at('2026-11-13T07:00:00Z'), 'America/New_York'))).toBe(
      '2026-11-13T14:00:00.000Z',
    );
  });

  it('rejects invalid expressions', () => {
    expect(() => parseCron('* * *')).toThrow(/5 fields/);
    expect(() => parseCron('61 * * * *')).toThrow(/range/);
    expect(() => parseCron('*/0 * * * *')).toThrow(/step/);
    expect(() => nextCronTime('* * * * *', 0, 'Nowhere/City')).toThrow(/timezone/);
  });
});

describe('misc', () => {
  it('stricter sandbox profile of agent and role', () => {
    expect(stricterProfile('workspace', 'strict')).toBe('strict');
    expect(stricterProfile('strict', 'workspace')).toBe('strict');
    expect(stricterProfile('custom', 'workspace')).toBe('custom');
    expect(stricterProfile('workspace', 'custom')).toBe('workspace');
  });

  it('reads cloud deploy env', () => {
    const e = readDeployEnv({
      BEAMHOP_AWAIT_PROVISIONING: '1',
      BEAMHOP_SANDBOX_FS: 'container',
      BEAMHOP_HARNESSES: 'claude, codex',
      BEAMHOP_OWNER_NPUB: 'npub1x',
    });
    expect(e).toMatchObject({
      awaitProvisioning: true,
      sandboxFs: 'container',
      harnesses: ['claude', 'codex'],
      ownerNpub: 'npub1x',
    });
    expect(readDeployEnv({}).sandboxFs).toBe('srt');
  });
});
