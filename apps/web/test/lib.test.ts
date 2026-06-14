import { describe, test, expect } from 'bun:test';
import { normalizeRelayUrl } from '../src/lib/session.js';
import { auditToCsv, type AuditEntry } from '../src/lib/audit.js';
import { formatCount, initials, truncateMiddle, hashString, timeAgo } from '../src/lib/ui.js';

describe('normalizeRelayUrl', () => {
  test('adds wss:// when scheme missing', () => {
    expect(normalizeRelayUrl('relay.example.com')).toBe('wss://relay.example.com');
  });
  test('preserves ws:// and wss://', () => {
    expect(normalizeRelayUrl('ws://localhost:7777')).toBe('ws://localhost:7777');
    expect(normalizeRelayUrl('wss://relay.damus.io')).toBe('wss://relay.damus.io');
  });
  test('strips trailing slash', () => {
    expect(normalizeRelayUrl('wss://relay.example.com/')).toBe('wss://relay.example.com');
  });
  test('rejects non-ws schemes and empties', () => {
    expect(normalizeRelayUrl('http://example.com')).toBeNull();
    expect(normalizeRelayUrl('')).toBeNull();
    expect(normalizeRelayUrl('   ')).toBeNull();
  });
  test('rejects garbage and bare words', () => {
    expect(normalizeRelayUrl('not a url')).toBeNull();
    expect(normalizeRelayUrl('relay')).toBeNull();
  });
  test('allows localhost with port', () => {
    expect(normalizeRelayUrl('ws://localhost:7777')).toBe('ws://localhost:7777');
  });
});

describe('auditToCsv', () => {
  test('serializes entries with a header and escapes quotes', () => {
    const entries: AuditEntry[] = [
      { id: '1', type: 'key', event: 'Accessed "key"', detail: 'x', at: 0 },
    ];
    const csv = auditToCsv(entries);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('timestamp,type,event,detail');
    expect(lines[1]).toContain('"Accessed ""key"""');
  });
});

describe('ui helpers', () => {
  test('formatCount compacts thousands', () => {
    expect(formatCount(5)).toBe('5');
    expect(formatCount(1200)).toBe('1.2k');
    expect(formatCount(15000)).toBe('15k');
  });
  test('initials takes up to two letters', () => {
    expect(initials('Maya Okonkwo')).toBe('MO');
    expect(initials('cher')).toBe('C');
  });
  test('truncateMiddle keeps head and tail', () => {
    const v = 'npub1abcdefghijklmnopqrstuvwxyz0123456789';
    expect(truncateMiddle(v, 8, 4)).toBe('npub1abc…6789');
    expect(truncateMiddle('short', 8, 4)).toBe('short');
  });
  test('hashString is deterministic', () => {
    expect(hashString('abc')).toBe(hashString('abc'));
  });
  test('timeAgo returns now for fresh timestamps', () => {
    expect(timeAgo(Math.floor(Date.now() / 1000))).toBe('now');
  });
});
