import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  agentKeyError,
  commandExists,
  parseCount,
  parseMinutes,
  parseMount,
  parseMounts,
  parsePort,
  tildify,
  validateHarnessId,
} from '../src/args.ts';

describe('parseMinutes', () => {
  it('honours units, default minutes', () => {
    expect(parseMinutes('15', 'x')).toBe(15);
    expect(parseMinutes('15m', 'x')).toBe(15);
    expect(parseMinutes('2h', 'x')).toBe(120);
    expect(parseMinutes('10h', 'x')).toBe(600);
    expect(parseMinutes('1d', 'x')).toBe(1440);
    expect(parseMinutes('120s', 'x')).toBe(2);
    expect(parseMinutes('1.5h', 'x')).toBe(90);
  });
  it('rejects garbage and fractions of a minute', () => {
    expect(() => parseMinutes('abc', '--heartbeat')).toThrow(/--heartbeat: expected a duration/);
    expect(() => parseMinutes('10x', 'x')).toThrow(/expected a duration/);
    expect(() => parseMinutes('', 'x')).toThrow(/expected a duration/);
    expect(() => parseMinutes('90s', 'x')).toThrow(/whole number of minutes/);
    expect(() => parseMinutes('0m', 'x')).toThrow(/at least 1m/);
  });
});

describe('parseCount / parsePort', () => {
  it('accepts whole numbers only', () => {
    expect(parseCount('5', 'x')).toBe(5);
    expect(() => parseCount('5m', '--spike')).toThrow(/--spike: expected a whole number/);
    expect(() => parseCount('1.5', 'x')).toThrow();
  });
  it('validates ports', () => {
    expect(parsePort('7952')).toBe(7952);
    expect(() => parsePort('abc')).toThrow(/1 to 65535/);
    expect(() => parsePort('70000')).toThrow(/1 to 65535/);
    expect(() => parsePort('0')).toThrow();
  });
});

describe('validateHarnessId', () => {
  it('allows lowercase, digits and dashes, with an optional acp: prefix', () => {
    expect(validateHarnessId('my-agent2')).toBeUndefined();
    expect(validateHarnessId('acp:my-agent')).toBeUndefined();
    expect(validateHarnessId('Bad Id')).toMatch(/invalid harness id "Bad Id"/);
    expect(validateHarnessId('a_b')).toBeDefined();
    expect(validateHarnessId('-x')).toBeDefined();
    expect(validateHarnessId('')).toBeDefined();
  });
});

describe('mounts', () => {
  it('splits the mode suffix and rejects a bad one', () => {
    expect(parseMount('~/code:rw')).toEqual({ path: '~/code', mode: 'rw' });
    expect(parseMount('/data')).toEqual({ path: '/data' });
    expect(() => parseMount('/data:xx')).toThrow(/invalid mount mode "xx".*\/data:ro or \/data:rw/);
    expect(() => parseMount('/data:')).toThrow(/invalid mount mode/);
  });
  it('defaults to ro and rejects the same folder twice', () => {
    expect(parseMounts(['~/a:rw', '/b'])).toEqual([
      { path: '~/a', mode: 'rw' },
      { path: '/b', mode: 'ro' },
    ]);
    expect(() => parseMounts(['/b:rw', '/b:ro'])).toThrow(/mounted twice/);
    expect(() => parseMounts([`${homedir()}/x`, '~/x/'])).toThrow(/mounted twice/);
  });
});

describe('agentKeyError', () => {
  it('accepts known keys, nested ones and free-form record keys', () => {
    for (const k of ['model', 'harness', 'budgets.dailyUsd', 'sandbox.profile', 'grants.telegram:1'])
      expect(agentKeyError(k)).toBeUndefined();
  });
  it('names the valid keys for an unknown one', () => {
    expect(agentKeyError('nosuchkey')).toMatch(/unknown agent setting "nosuchkey". Valid keys: .*model/);
    expect(agentKeyError('budgets.bogus')).toMatch(/Valid keys under budgets: dailyUsd/);
  });
});

describe('commandExists', () => {
  it('finds executables on PATH or by path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bh-cmd-'));
    const exe = join(dir, 'my-agent');
    writeFileSync(exe, '#!/bin/sh\n');
    chmodSync(exe, 0o755);
    expect(commandExists('my-agent', { PATH: dir }, 'darwin')).toBe(true);
    expect(commandExists(exe, {}, 'darwin')).toBe(true);
    expect(commandExists('no-such-binary-beamhop', { PATH: dir }, 'darwin')).toBe(false);
    expect(commandExists(join(dir, 'missing'), {}, 'darwin')).toBe(false);
    expect(commandExists('anything', {}, 'win32')).toBe(true);
  });
});

describe('tildify', () => {
  it('shortens paths under home', () => {
    expect(tildify(join(homedir(), '.beamhop', 'vault.key'))).toBe('~/.beamhop/vault.key');
    expect(tildify('/srv/bh/vault.key')).toBe('/srv/bh/vault.key');
  });
});
