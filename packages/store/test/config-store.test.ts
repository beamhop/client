import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ConfigChange, ConfigStore, camelizeKeys, writeFileAtomic } from '../src/index.ts';

let home: string;
let cs: ConfigStore;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'beamhop-config-'));
  cs = new ConfigStore({ home });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const waitFor = async (pred: () => boolean, ms = 3000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('global config', () => {
  it('defaults when missing, saves with 0600 and reloads', () => {
    expect(cs.loadGlobal().owners).toEqual([]);
    cs.saveGlobal({ owners: ['nostr:npub1x'] });
    expect(cs.loadGlobal().owners).toEqual(['nostr:npub1x']);
    if (process.platform !== 'win32') expect(statSync(cs.configFile).mode & 0o777).toBe(0o600);
    cs.updateGlobal((c) => ({ ...c, approvals: { quorum: 2 } }));
    expect(cs.loadGlobal().approvals.quorum).toBe(2);
  });
  it('accepts snake_case hand edits but keeps grants/people keys verbatim', () => {
    writeFileSync(
      cs.configFile,
      'owners: ["nostr:npub1x"]\npeople:\n  alice_smith: ["telegram:1"]\ngrants:\n  "telegram:2": user\napi:\n  port: 9999\n',
    );
    const c = cs.loadGlobal();
    expect(c.people).toEqual({ alice_smith: ['telegram:1'] });
    expect(c.grants).toEqual({ 'telegram:2': 'user' });
    expect(c.api.port).toBe(9999);
  });
  it('reports invalid YAML and schema errors with the file name', () => {
    writeFileSync(cs.configFile, 'owners: [unclosed');
    expect(() => cs.loadGlobal()).toThrow(/config\.yaml: invalid YAML/);
    writeFileSync(cs.configFile, 'owners: ["no-provider"]');
    expect(() => cs.loadGlobal()).toThrow(/owners\.0/);
    expect(() => cs.saveGlobal({ owners: [1] })).toThrow(/invalid config/);
  });
});

describe('agents collection', () => {
  it('saves, gets, lists, updates and deletes', () => {
    const a = cs.agents.save({ name: 'reviewer', harness: 'claude' });
    expect(a.budgets).toEqual({ dailyUsd: 5 });
    expect(existsSync(join(home, 'agents', 'reviewer.yaml'))).toBe(true);
    expect(cs.agents.get('reviewer')).toEqual(a);
    cs.agents.save({ name: 'coder', harness: 'codex' });
    expect(cs.agents.list().map((x) => x.name)).toEqual(['coder', 'reviewer']);
    const u = cs.agents.update('reviewer', (c) => ({ ...c, model: 'opus' }));
    expect(u.model).toBe('opus');
    expect(() => cs.agents.update('reviewer', (c) => ({ ...c, name: 'renamed' }))).toThrow(/rename/);
    expect(cs.agents.delete('coder')).toBe(true);
    expect(cs.agents.delete('coder')).toBe(false);
    expect(cs.agents.get('coder')).toBeUndefined();
    expect(() => cs.agents.require('coder')).toThrow(/not found/);
    expect(readdirSync(join(home, 'agents')).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });
  it('validates on save', () => {
    expect(() => cs.agents.save({ name: 'Bad Name', harness: 'claude' })).toThrow(/invalid agent/);
    expect(() => cs.agents.save({ name: 'ok' })).toThrow(/harness/);
  });
  it('refuses path traversal and unicode names', () => {
    for (const k of ['../evil', 'a/b', '..', 'ünïcode', 'UPPER', ''])
      expect(() => cs.agents.get(k), k).toThrow(/invalid agent name/);
    expect(() => cs.agents.delete('../config')).toThrow();
  });
  it('reads PLAN.md-style hand-written YAML', () => {
    mkdirSync(join(home, 'agents'), { recursive: true });
    writeFileSync(
      join(home, 'agents', 'reviewer.yml'),
      `# hand edited
name: reviewer
harness: claude
model: default
mounts:
  - { path: ~/code/app, mode: rw }
sandbox: workspace
identity: { nostr: "keychain:reviewer", nip05: reviewer@example.com }
memberships:
  - { channel: "nostr:dm", default_role: viewer }
  - { channel: "telegram:group/-100123", default_role: user, trigger: [mention, reply] }
concurrency: { max_sessions: 3 }
budgets: { daily_usd: 5, per_session_minutes: 30 }
grants:
  "telegram:5551": admin
`,
    );
    const a = cs.agents.get('reviewer')!;
    expect(a.sandbox.profile).toBe('workspace');
    expect(a.identity).toEqual({ nostrKeyRef: 'keychain:reviewer', nip05: 'reviewer@example.com' });
    expect(a.memberships[1]).toEqual({
      target: 'telegram:group/-100123',
      defaultRole: 'user',
      triggers: ['mention', 'reply'],
    });
    expect(a.concurrency.maxSessions).toBe(3);
    expect(a.budgets).toEqual({ dailyUsd: 5, perSessionMinutes: 30 });
    expect(a.grants).toEqual({ 'telegram:5551': 'admin' });
    // saving replaces the .yml with a canonical .yaml
    cs.agents.save(a);
    expect(existsSync(join(home, 'agents', 'reviewer.yml'))).toBe(false);
    expect(cs.agents.get('reviewer')).toEqual(a);
  });
  it('list skips invalid files and reports them', () => {
    cs.agents.save({ name: 'good', harness: 'claude' });
    writeFileSync(join(home, 'agents', 'broken.yaml'), 'name: broken\n');
    writeFileSync(join(home, 'agents', 'mismatch.yaml'), 'name: other\nharness: x\n');
    writeFileSync(join(home, 'agents', 'Bad Name.yaml'), 'name: x\nharness: x\n');
    writeFileSync(join(home, 'agents', 'notes.txt'), 'ignore me');
    const { items, errors } = cs.agents.listWithErrors();
    expect(items.map((i) => i.name)).toEqual(['good']);
    expect(errors.map((e) => e.file.split(/[\\/]/).pop()).sort()).toEqual([
      'Bad Name.yaml',
      'broken.yaml',
      'mismatch.yaml',
    ]);
    expect(errors.find((e) => e.file.endsWith('mismatch.yaml'))!.message).toMatch(/does not match/);
  });
  it('empty files report schema errors, not crashes', () => {
    mkdirSync(join(home, 'agents'), { recursive: true });
    writeFileSync(join(home, 'agents', 'empty.yaml'), '');
    expect(() => cs.agents.get('empty')).toThrow(/name/);
  });
});

describe('channels and schedules', () => {
  it('keep provider settings keys verbatim', () => {
    const c = cs.channels.save({
      name: 'mybot',
      provider: 'telegram',
      settings: { allowed_updates: ['message'], Some_Key: 1 },
      createdAt: '2026-11-13T00:00:00Z',
    });
    expect(cs.channels.get('mybot')!.settings).toEqual({ allowed_updates: ['message'], Some_Key: 1 });
    expect(c.enabled).toBe(true);
  });
  it('schedules use ids as keys', () => {
    cs.schedules.save({
      id: 'sch_1',
      agent: 'a',
      kind: 'cron',
      spec: '0 9 * * *',
      prompt: 'standup',
      owner: 'nostr:x',
    });
    expect(cs.schedules.list()).toHaveLength(1);
    expect(existsSync(join(home, 'schedules', 'sch_1.yaml'))).toBe(true);
    expect(() =>
      cs.schedules.save({ id: '../x', agent: 'a', kind: 'cron', spec: 's', prompt: 'p', owner: 'nostr:x' }),
    ).toThrow(/invalid schedule name/);
  });
});

describe('atomic writes', () => {
  it('replaces files without leaving temp files', () => {
    const f = join(home, 'x.yaml');
    writeFileAtomic(f, 'a: 1\n');
    writeFileAtomic(f, 'a: 2\n');
    expect(readFileSync(f, 'utf8')).toBe('a: 2\n');
    expect(readdirSync(home)).toEqual(['x.yaml']);
  });
  it('camelizeKeys handles arrays and nesting', () => {
    expect(camelizeKeys({ a_b: [{ c_d: 1 }], 'e-f': { g_h: null } })).toEqual({
      aB: [{ cD: 1 }],
      eF: { gH: null },
    });
  });
});

describe('watch', () => {
  it('reports hand edits and deletions, debounced, but not our own writes', async () => {
    cs.ensureDirs();
    const changes: ConfigChange[] = [];
    const stop = cs.watch((c) => changes.push(c), { debounceMs: 30 });
    try {
      cs.agents.save({ name: 'self', harness: 'claude' });
      cs.saveGlobal({ owners: [] });
      await new Promise((r) => setTimeout(r, 200));
      expect(changes).toEqual([]);

      const f = join(home, 'agents', 'hand.yaml');
      writeFileSync(f, 'name: hand\nharness: claude\n');
      writeFileSync(f, 'name: hand\nharness: codex\n');
      await waitFor(() => changes.some((c) => c.name === 'hand'));
      await new Promise((r) => setTimeout(r, 100));
      expect(changes.filter((c) => c.name === 'hand')).toEqual([
        { kind: 'agent', name: 'hand', type: 'changed', file: f },
      ]);

      rmSync(f);
      await waitFor(() => changes.some((c) => c.name === 'hand' && c.type === 'deleted'));

      writeFileSync(cs.configFile, 'owners: ["nostr:npub1z"]\n');
      await waitFor(() => changes.some((c) => c.kind === 'config'));

      writeFileSync(join(home, 'schedules', 's1.yaml'), 'id: s1\n');
      await waitFor(() => changes.some((c) => c.kind === 'schedule' && c.name === 's1'));

      // a PWA edit through the store after a hand edit is not echoed
      const before = changes.length;
      cs.agents.save({ name: 'self', harness: 'codex' });
      await new Promise((r) => setTimeout(r, 200));
      expect(changes.slice(before).filter((c) => c.name === 'self')).toEqual([]);
    } finally {
      stop();
    }
  });
  it('stops reporting after close', async () => {
    const changes: ConfigChange[] = [];
    const stop = cs.watch((c) => changes.push(c), { debounceMs: 10 });
    stop();
    writeFileSync(join(home, 'agents', 'late.yaml'), 'name: late\nharness: x\n');
    await new Promise((r) => setTimeout(r, 100));
    expect(changes).toEqual([]);
  });
});
