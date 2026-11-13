import { describe, expect, it } from 'vitest';
import { leavesPage } from './leaveGuard.ts';

describe('leavesPage', () => {
  it('is true for another section, agent or screen', () => {
    expect(leavesPage({ pathname: '/agents/bot/setup' }, { pathname: '/agents/bot/sandbox' })).toBe(true);
    expect(leavesPage({ pathname: '/agents/bot/setup' }, { pathname: '/inbox' })).toBe(true);
  });
  it('is false when only search or hash changes on the same page', () => {
    expect(leavesPage({ pathname: '/agents/bot/setup' }, { pathname: '/agents/bot/setup' })).toBe(false);
  });
});
