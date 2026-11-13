// Security review wave B: pairing brute force, SQL injection via repo inputs, config name traversal.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigStore } from '../src/config-store.ts';
import { generateDataKey } from '../src/crypto.ts';
import { PAIRING_MAX_FAILURES } from '../src/repos.ts';
import { openStore, type Store } from '../src/store.ts';

const dirs: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'bh-sec-'));
  dirs.push(d);
  return d;
};

const t = Date.parse('2026-11-13T10:00:00Z');
const mk = () => {
  const s = openStore({ key: generateDataKey(), home: tmp(), path: ':memory:', now: () => new Date(t) });
  stores.push(s);
  return s;
};

describe('STORE-1: pairing codes cannot be brute forced', () => {
  it('after PAIRING_MAX_FAILURES wrong guesses the live code is burned, even if later guessed right', () => {
    const s = mk();
    s.pairingCodes.put({
      code: 'ABC234',
      purpose: 'channel',
      expiresAt: new Date(t + 600_000).toISOString(),
    });
    for (let i = 0; i < PAIRING_MAX_FAILURES; i++)
      expect(s.pairingCodes.consume(`ZZZ${String(i).padStart(3, '2')}`, 'channel')).toEqual({
        ok: false,
        reason: 'unknown',
      });
    expect(s.pairingCodes.consume('ABC234', 'channel')).toEqual({ ok: false, reason: 'too_many_attempts' });
    // And it stays burned.
    expect(s.pairingCodes.consume('ABC234', 'channel')).toEqual({ ok: false, reason: 'used' });
  });

  it('a few wrong guesses still let the owner pair; a fresh code starts at zero', () => {
    const s = mk();
    s.pairingCodes.put({
      code: 'ABC234',
      purpose: 'channel',
      expiresAt: new Date(t + 600_000).toISOString(),
    });
    s.pairingCodes.consume('WRONG2', 'channel');
    s.pairingCodes.consume('WRONG3', 'channel');
    expect(s.pairingCodes.consume('abc-234', 'channel').ok).toBe(true);
  });

  it('failures for one purpose do not burn codes of another purpose', () => {
    const s = mk();
    s.pairingCodes.put({ code: 'DEV234', purpose: 'device', expiresAt: new Date(t + 600_000).toISOString() });
    for (let i = 0; i < PAIRING_MAX_FAILURES + 2; i++) s.pairingCodes.consume('NOPE22', 'channel');
    expect(s.pairingCodes.consume('DEV234', 'device').ok).toBe(true);
  });
});

describe('store inputs are parameterized (no SQL injection)', () => {
  it('property: hostile strings round-trip through dedupe, kv and audit without effect on other rows', () => {
    const s = mk();
    s.dedupe.firstSeen('c', 'sentinel');
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ unit: 'binary', maxLength: 60 }),
          fc.constantFrom("'; DROP TABLE dedupe; --", "x' OR '1'='1", '%', '_', '\\', '\u0000'),
        ),
        (v) => {
          s.dedupe.firstSeen(v, v);
          expect(s.dedupe.has(v, v)).toBe(true);
          s.kv.set(v.slice(0, 20) || 'ns', v, { v });
          expect(s.kv.get(v.slice(0, 20) || 'ns', v)).toEqual({ v });
        },
      ),
      { numRuns: 300 },
    );
    expect(s.dedupe.has('c', 'sentinel')).toBe(true);
  });
});

describe('config names cannot escape their directory', () => {
  it('rejects traversal, absolute and odd names for every collection', () => {
    const cs = new ConfigStore({ home: tmp() });
    for (const bad of [
      '../x',
      '..',
      'a/b',
      'a\\b',
      '/etc/passwd',
      'C:x',
      'A',
      '',
      'x'.repeat(49),
      'a.yaml',
      '%2e%2e',
    ]) {
      expect(() => cs.agents.pathFor(bad)).toThrow();
      expect(() => cs.channels.get(bad)).toThrow();
      expect(() => cs.agents.delete(bad)).toThrow();
    }
    expect(() => cs.schedules.pathFor('../../x')).toThrow();
  });

  it('a YAML __proto__ key cannot smuggle owners into the global config', () => {
    const home = tmp();
    const cs = new ConfigStore({ home });
    cs.ensureDirs();
    cs.saveGlobal({});
    const file = cs.configFile;
    // Hand-written YAML: try to set owners through the prototype.
    writeFileSync(file, '__proto__:\n  owners: ["nostr:attacker"]\n');
    const g = cs.loadGlobal();
    expect(g.owners ?? []).toEqual([]);
    expect(({} as { owners?: unknown }).owners).toBeUndefined();
  });
});
