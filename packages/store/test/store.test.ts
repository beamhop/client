import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  ApprovalView,
  AuditEvent,
  DeviceView,
  PolicySuggestion,
  SessionEventView,
  SessionView,
  UsageRow,
} from '@beamhop/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DataCipher,
  Db,
  encodeDataKey,
  generateDataKey,
  hashPairingCode,
  MIGRATIONS,
  meshThreadKey,
  migrate,
  openStore,
  parseDataKey,
  type Store,
} from '../src/index.ts';

let dir: string;
let t: number;
const now = () => new Date(t);
const key = generateDataKey();
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'beamhop-store-'));
  t = Date.parse('2026-11-13T10:00:00Z');
  store = openStore({ key, home: dir, now });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const newSession = (over: Record<string, unknown> = {}) =>
  store.sessions.create({
    agent: 'reviewer',
    channel: 'tg',
    conversationId: 'c1',
    threadId: 't1',
    title: 'Fix bug',
    ...over,
  });

describe('crypto', () => {
  it('round-trips and binds ciphertext to its scope', () => {
    const c = new DataCipher(key);
    const e = c.encrypt('a.b', 'héllo 🌍');
    expect(e.startsWith('e1:')).toBe(true);
    expect(c.decrypt('a.b', e)).toBe('héllo 🌍');
    expect(() => c.decrypt('a.c', e)).toThrow(/cannot decrypt/);
    expect(c.encrypt('a.b', 'x')).not.toBe(c.encrypt('a.b', 'x'));
  });
  it('rejects wrong keys, tampering and bad input', () => {
    const c = new DataCipher(key);
    const e = c.encrypt('s', 'secret');
    expect(() => new DataCipher(generateDataKey()).decrypt('s', e)).toThrow(/wrong data key/);
    const raw = Buffer.from(e.slice(3), 'base64');
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 1;
    expect(() => c.decrypt('s', `e1:${raw.toString('base64')}`)).toThrow();
    expect(() => c.decrypt('s', 'plain')).toThrow(/unencrypted/);
    expect(() => c.decrypt('s', 'e1:AAAA')).toThrow(/corrupt/);
    expect(() => new DataCipher(Buffer.alloc(16))).toThrow(/32 bytes/);
  });
  it('parses keys from base64 and hex', () => {
    expect(parseDataKey(encodeDataKey(key)).equals(key)).toBe(true);
    expect(parseDataKey(key.toString('hex')).equals(key)).toBe(true);
    expect(() => parseDataKey('abcd')).toThrow();
  });
});

describe('migrations', () => {
  it('apply once and record versions', () => {
    const db = new Db(':memory:');
    expect(migrate(db)).toEqual(MIGRATIONS.map((m) => m.version));
    expect(migrate(db)).toEqual([]);
    db.close();
    expect(store.schemaVersion).toBe(MIGRATIONS.at(-1)!.version);
  });
  it('apply new migrations incrementally', () => {
    const db = new Db(':memory:');
    migrate(db);
    expect(
      migrate(db, [...MIGRATIONS, { version: 99, name: 'x', sql: 'CREATE TABLE extra (a TEXT)' }]),
    ).toEqual([99]);
    db.close();
  });
  it('roll back a failing migration', () => {
    const db = new Db(':memory:');
    expect(() => migrate(db, [{ version: 1, name: 'bad', sql: 'CREATE TABLE a (x); NOT SQL' }])).toThrow();
    expect(db.get('SELECT COUNT(*) AS n FROM schema_migrations')).toEqual({ n: 0 });
    db.close();
  });
  it('refuse a database newer than the code', () => {
    const db = new Db(':memory:');
    migrate(db, [{ version: 500, name: 'future', sql: 'SELECT 1' }]);
    expect(() => migrate(db)).toThrow(/newer/);
    db.close();
  });
  it('nested transactions roll back to the savepoint', () => {
    const db = new Db(':memory:');
    db.exec('CREATE TABLE x (v INTEGER)');
    db.tx(() => {
      db.run('INSERT INTO x VALUES (1)');
      expect(() =>
        db.tx(() => {
          db.run('INSERT INTO x VALUES (2)');
          throw new Error('boom');
        }),
      ).toThrow('boom');
    });
    expect(db.all('SELECT v FROM x')).toEqual([{ v: 1 }]);
    db.close();
  });
});

describe('data key check', () => {
  it('reopens with the right key and refuses a different one', () => {
    store.close();
    const again = openStore({ key, home: dir, now });
    again.close();
    expect(() => openStore({ key: generateDataKey(), home: dir, now })).toThrow(/does not match/);
    store = openStore({ key, home: dir, now });
  });
  it('creates the db file with 0600 on posix', () => {
    if (process.platform === 'win32') return;
    expect(statSync(join(dir, 'beamhop.db')).mode & 0o777).toBe(0o600);
  });
});

describe('sessions', () => {
  it('create/get/list/update return SessionView', () => {
    const s = newSession({ principal: 'telegram:1', harness: 'claude' });
    expect(SessionView.parse(s)).toBeTruthy();
    expect(s).toMatchObject({
      title: 'Fix bug',
      status: 'running',
      usage: { inputTokens: 0, outputTokens: 0, usd: 0 },
    });
    t += 1000;
    const u = store.sessions.update(s.id, {
      status: 'idle',
      worktree: { path: '/w', branch: 'beamhop/t1' },
      title: 'New',
    });
    expect(u).toMatchObject({ status: 'idle', title: 'New', worktree: { path: '/w', branch: 'beamhop/t1' } });
    expect(u.lastActivityAt).toBe(new Date(t).toISOString());
    expect(store.sessions.update(s.id, { worktree: null }).worktree).toBeUndefined();
    expect(store.sessions.list({ agent: 'reviewer' })).toHaveLength(1);
    expect(store.sessions.list({ agent: 'other' })).toHaveLength(0);
    expect(store.sessions.list({ status: ['ended'] })).toHaveLength(0);
    expect(() => store.sessions.update('nope', { status: 'ended' })).toThrow(/not found/);
    expect(() => store.sessions.require('nope')).toThrow(/not found/);
  });
  it('finds active and latest sessions per thread', () => {
    const s = newSession();
    expect(store.sessions.findActive('reviewer', 'tg', 'c1', 't1')?.id).toBe(s.id);
    store.sessions.update(s.id, { status: 'ended' });
    expect(store.sessions.get(s.id)?.endedAt).toBeDefined();
    expect(store.sessions.findActive('reviewer', 'tg', 'c1', 't1')).toBeUndefined();
    expect(store.sessions.findLatest('reviewer', 'tg', 'c1', 't1')?.id).toBe(s.id);
    newSession({ threadId: 't2', status: 'queued' });
    expect(store.sessions.countActive('reviewer')).toBe(1);
  });
  it('encrypts title, resume token and accumulates usage', () => {
    const s = newSession({ title: 'TOP-SECRET-TITLE' });
    store.sessions.update(s.id, { resume: 'resume-token-123' });
    expect(store.sessions.resumeToken(s.id)).toBe('resume-token-123');
    store.sessions.update(s.id, { resume: null });
    expect(store.sessions.resumeToken(s.id)).toBeUndefined();
    store.sessions.addUsage(s.id, { inputTokens: 10, outputTokens: 5, usd: 0.01 });
    store.sessions.addUsage(s.id, { inputTokens: 1, outputTokens: -5, usd: 0.02 });
    expect(store.sessions.get(s.id)!.usage).toEqual({ inputTokens: 11, outputTokens: 5, usd: 0.03 });
    const raw = new DatabaseSync(join(dir, 'beamhop.db'));
    const row = raw.prepare('SELECT title_enc FROM sessions').get() as { title_enc: string };
    expect(row.title_enc).not.toContain('TOP-SECRET');
    raw.close();
  });
  it('ends idle sessions', () => {
    const s = newSession({ status: 'idle' });
    t += 3_600_000;
    newSession({ threadId: 'fresh', status: 'idle' });
    expect(store.sessions.endIdle('reviewer', new Date(t - 60_000).toISOString())).toEqual([s.id]);
    expect(store.sessions.get(s.id)!.status).toBe('ended');
  });
  it('deletes sessions with their events', () => {
    const s = newSession();
    store.sessions.appendEvent(s.id, { kind: 'user', text: 'hi' });
    expect(store.sessions.delete(s.id)).toBe(true);
    expect(store.sessions.events(s.id)).toEqual([]);
    expect(store.sessions.delete(s.id)).toBe(false);
  });
});

describe('session events', () => {
  it('assigns per-session seq numbers and round-trips encrypted fields', () => {
    const a = newSession();
    const b = newSession({ threadId: 't2' });
    const e1 = store.sessions.appendEvent(a.id, {
      kind: 'user',
      from: { principal: 'telegram:1', displayName: 'Alice', role: 'user' },
      text: 'please run SECRET-PROMPT',
    });
    const e2 = store.sessions.appendEvent(a.id, {
      kind: 'tool_call',
      tool: {
        id: 'tc1',
        name: 'Bash',
        input: { command: 'echo TOOL-SECRET' },
        output: 'OUT-SECRET',
        ok: true,
      },
      approvalId: 'apr_1',
    });
    const e3 = store.sessions.appendEvent(b.id, { kind: 'assistant', text: 'x' });
    expect([e1.seq, e2.seq, e3.seq]).toEqual([1, 2, 1]);
    const evs = store.sessions.events(a.id);
    expect(evs.map((e) => SessionEventView.parse(e))).toEqual([e1, e2]);
    expect(evs[1]).toMatchObject({ tool: { input: { command: 'echo TOOL-SECRET' } }, approvalId: 'apr_1' });
    expect(store.sessions.events(a.id, { afterSeq: 1 })).toEqual([e2]);
    expect(store.sessions.events(a.id, { limit: 1 })).toEqual([e1]);
    const raw = readFileSync(join(dir, 'beamhop.db'));
    const wal = (() => {
      try {
        return readFileSync(join(dir, 'beamhop.db-wal'));
      } catch {
        return Buffer.alloc(0);
      }
    })();
    for (const needle of ['SECRET-PROMPT', 'TOOL-SECRET', 'OUT-SECRET'])
      expect(Buffer.concat([raw, wal]).includes(needle)).toBe(false);
  });
  it('rejects events for unknown sessions', () => {
    expect(() => store.sessions.appendEvent('nope', { kind: 'user', text: 'x' })).toThrow(/not found/);
  });
  it('keeps empty strings distinct from missing text', () => {
    const s = newSession();
    store.sessions.appendEvent(s.id, { kind: 'assistant', text: '' });
    store.sessions.appendEvent(s.id, { kind: 'progress' });
    const [a, b] = store.sessions.events(s.id);
    expect(a!.text).toBe('');
    expect(b!.text).toBeUndefined();
  });
});

const approval = (over: Partial<ApprovalView> = {}): ApprovalView => ({
  id: 'apr_1',
  agent: 'reviewer',
  sessionId: 'ses_1',
  requestedBy: { principal: 'telegram:1', role: 'user' },
  tool: 'Bash',
  title: 'Run rm -rf build',
  input: { command: 'rm -rf build' },
  risk: 'high',
  createdAt: new Date(t).toISOString(),
  expiresAt: new Date(t + 900_000).toISOString(),
  status: 'pending',
  kind: 'tool',
  ...over,
});

describe('approvals', () => {
  it('put/get/list/update keep votes and decrypt input', () => {
    store.approvals.put(approval());
    expect(store.approvals.countPending()).toBe(1);
    const got = store.approvals.get('apr_1')!;
    expect(got.input).toEqual({ command: 'rm -rf build' });
    expect(got.votes).toEqual([]);
    const listed = store.approvals.list();
    expect(listed.map((a) => ApprovalView.parse(a))).toHaveLength(1);
    expect('votes' in listed[0]!).toBe(false);
    store.approvals.put({
      ...got,
      status: 'approved',
      decidedBy: 'nostr:a',
      decidedAt: new Date(t).toISOString(),
      votes: [{ by: 'nostr:a', allow: true, at: 'x' }],
    });
    expect(store.approvals.get('apr_1')).toMatchObject({
      status: 'approved',
      decidedBy: 'nostr:a',
      votes: [{ by: 'nostr:a' }],
    });
    expect(store.approvals.list()).toEqual([]);
    expect(store.approvals.list({ status: 'all', agent: 'reviewer' })).toHaveLength(1);
    expect(store.approvals.list({ status: 'all', sessionId: 'other' })).toHaveLength(0);
  });
  it('expires due approvals', () => {
    store.approvals.put(approval());
    store.approvals.put(approval({ id: 'apr_2', expiresAt: new Date(t + 10 * 3_600_000).toISOString() }));
    const expired = store.approvals.expireDue(new Date(t + 900_000));
    expect(expired.map((a) => a.id)).toEqual(['apr_1']);
    expect(store.approvals.get('apr_1')!.status).toBe('expired');
    expect(store.approvals.get('apr_2')!.status).toBe('pending');
  });
});

describe('audit', () => {
  it('appends and queries with filters', () => {
    store.audit.append({
      actor: 'system',
      type: 'srt.violation',
      severity: 'security',
      summary: 'blocked host',
      agent: 'a',
      data: { host: 'x' },
    });
    t += 1000;
    store.audit.append({ actor: 'nostr:o', type: 'role.grant', severity: 'info', summary: 'granted' });
    const all = store.audit.query();
    expect(all.map((e) => AuditEvent.parse(e))).toHaveLength(2);
    expect(all[0]!.type).toBe('role.grant');
    expect(store.audit.query({ agent: 'a' })).toHaveLength(1);
    expect(store.audit.query({ severity: 'security' })[0]!.data).toEqual({ host: 'x' });
    expect(store.audit.query({ before: new Date(t).toISOString() })).toHaveLength(1);
    expect(store.audit.query({ limit: 1 })).toHaveLength(1);
    expect(store.audit.count({ since: new Date(t - 5000).toISOString(), severity: 'security' })).toBe(1);
    expect(
      store.audit.count({ since: new Date(t - 5000).toISOString(), agent: 'a', type: 'srt.violation' }),
    ).toBe(1);
  });
});

describe('usage', () => {
  it('rolls up per day/agent/channel/peer and queries a window', () => {
    store.usage.add({ agent: 'a', channel: 'tg', inputTokens: 10, outputTokens: 5, usd: 0.1, minutes: 1 });
    store.usage.add({ agent: 'a', channel: 'tg', inputTokens: 10, outputTokens: 5, usd: 0.1, minutes: 1 });
    store.usage.add({ agent: 'a', peer: 'nostr:p', inputTokens: 1 });
    store.usage.add({ agent: 'b', inputTokens: 1, at: '2026-10-01T00:00:00Z' });
    const rows = store.usage.query({ days: 14 });
    expect(rows.map((r) => UsageRow.parse(r))).toHaveLength(2);
    expect(rows.find((r) => r.channel === 'tg')).toMatchObject({
      inputTokens: 20,
      outputTokens: 10,
      minutes: 2,
    });
    expect(rows.find((r) => r.channel === 'tg')!.usd).toBeCloseTo(0.2);
    expect(rows.find((r) => r.peer)).toMatchObject({ peer: 'nostr:p' });
    expect(rows.find((r) => r.peer)!.channel).toBeUndefined();
    expect(store.usage.query({ days: 60 })).toHaveLength(3);
    expect(store.usage.query({ days: 60, agent: 'b' })).toHaveLength(1);
    expect(store.usage.totals({ agent: 'a' })).toMatchObject({ tokens: 31, inputTokens: 21 });
    expect(store.usage.totals({ agent: 'a', peer: 'nostr:p' }).tokens).toBe(1);
    expect(store.usage.totals({ agent: 'zzz' })).toEqual({
      tokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      usd: 0,
      minutes: 0,
    });
    expect(() => store.usage.add({ agent: 'a', at: 'garbage' })).toThrow(/invalid/);
  });
});

describe('devices', () => {
  it('add/list/touch/push/remove', () => {
    const d = store.devices.add({ name: 'Phone', pubkey: 'pk1' });
    expect(DeviceView.parse(d)).toMatchObject({ name: 'Phone', pushEnabled: false });
    expect(() => store.devices.add({ name: 'Dup', pubkey: 'pk1' })).toThrow(/already paired/);
    store.devices.touch(d.id);
    expect(store.devices.get(d.id)!.lastSeenAt).toBeDefined();
    store.devices.setPush(d.id, { endpoint: 'https://push/x', keys: { auth: 'a' } });
    expect(store.devices.getByPubkey('pk1')!.pushEnabled).toBe(true);
    expect(store.devices.pushSubscription(d.id)).toEqual({ endpoint: 'https://push/x', keys: { auth: 'a' } });
    store.devices.setPush(d.id, null);
    expect(store.devices.pushSubscription(d.id)).toBeUndefined();
    store.devices.rename(d.id, 'Old phone');
    expect(store.devices.list().map((x) => x.name)).toEqual(['Old phone']);
    expect(() => store.devices.setPush('nope', null)).toThrow(/not found/);
    expect(store.devices.remove(d.id)).toBe(true);
    expect(store.devices.remove(d.id)).toBe(false);
  });
});

describe('kv', () => {
  it('stores encrypted JSON per namespace and implements core KV', async () => {
    store.kv.set('tg', 'offset', 42);
    store.kv.set('tg', 'obj', { a: [1, 2] });
    store.kv.set('other', 'offset', 1);
    expect(store.kv.get('tg', 'offset')).toBe(42);
    expect(store.kv.keys('tg')).toEqual(['obj', 'offset']);
    const kv = store.kv.namespace('tg');
    expect(await kv.get('obj')).toEqual({ a: [1, 2] });
    await kv.set('offset', 43);
    expect(await kv.get('offset')).toBe(43);
    await kv.delete('offset');
    expect(await kv.get('offset')).toBeUndefined();
    store.kv.set('tg', 'obj', undefined);
    expect(store.kv.get('tg', 'obj')).toBeUndefined();
    expect(store.kv.get('other', 'offset')).toBe(1);
  });
});

describe('policy suggestions', () => {
  it('counts repeats, lists open ones, resolves', () => {
    store.policySuggestions.record('a', 'net.allow', 'api.github.com');
    t += 1000;
    const s = store.policySuggestions.record('a', 'net.allow', 'api.github.com');
    store.policySuggestions.record('a', 'fs.read', '/etc/hosts');
    store.policySuggestions.record('b', 'net.allow', 'x.com');
    expect(PolicySuggestion.parse(s)).toMatchObject({ count: 2, lastSeenAt: new Date(t).toISOString() });
    expect(store.policySuggestions.list({ agent: 'a' }).map((x) => x.value)).toEqual([
      'api.github.com',
      '/etc/hosts',
    ]);
    store.policySuggestions.resolve(s.id, false);
    expect(store.policySuggestions.list({ agent: 'a' })).toHaveLength(1);
    expect(store.policySuggestions.list({ agent: 'a', status: 'rejected' })).toHaveLength(1);
    expect(() => store.policySuggestions.resolve('nope', true)).toThrow(/not found/);
  });
});

describe('pairing codes', () => {
  it('stores only hashes and is one-shot', () => {
    store.pairingCodes.put({
      code: 'ABC234',
      purpose: 'device',
      expiresAt: new Date(t + 600_000).toISOString(),
      data: { name: 'Phone' },
    });
    const raw = store.db.all<{ code_hash: string }>('SELECT code_hash FROM pairing_codes');
    expect(raw[0]!.code_hash).toBe(hashPairingCode('ABC234'));
    expect(JSON.stringify(raw)).not.toContain('ABC234');
    expect(store.pairingCodes.consume('abc-234', 'channel')).toEqual({ ok: false, reason: 'unknown' });
    const r = store.pairingCodes.consume('abc-234', 'device');
    expect(r).toMatchObject({ ok: true, record: { purpose: 'device', data: { name: 'Phone' } } });
    expect(store.pairingCodes.consume('ABC234')).toEqual({ ok: false, reason: 'used' });
    expect(store.pairingCodes.consume('ZZZZZZ')).toEqual({ ok: false, reason: 'unknown' });
  });
  it('rejects expired codes and prunes', () => {
    store.pairingCodes.put({
      code: 'XYZ789',
      purpose: 'device',
      expiresAt: new Date(t + 600_000).toISOString(),
    });
    t += 600_000;
    expect(store.pairingCodes.consume('XYZ789')).toEqual({ ok: false, reason: 'expired' });
    expect(store.pairingCodes.prune(new Date(t + 1).toISOString())).toBe(1);
  });
});

describe('deployments', () => {
  it('upserts, lists, changes status', () => {
    store.deployments.upsert({
      id: 'd1',
      provider: 'hetzner',
      agent: 'a',
      status: 'provisioning',
      createdAt: new Date(t).toISOString(),
      monthlyCostUsd: 4.5,
      region: 'fsn1',
    });
    store.deployments.upsert({
      id: 'd1',
      provider: 'hetzner',
      agent: 'a',
      status: 'running',
      createdAt: 'ignored',
      address: '1.2.3.4',
      data: { serverId: 9 },
    });
    expect(store.deployments.get('d1')).toMatchObject({
      status: 'running',
      address: '1.2.3.4',
      data: { serverId: 9 },
    });
    store.deployments.setStatus('d1', 'destroyed');
    expect(store.deployments.list()).toEqual([]);
    expect(store.deployments.list({ includeDestroyed: true, agent: 'a' })).toHaveLength(1);
    expect(() => store.deployments.setStatus('x', 'running')).toThrow(/not found/);
    expect(store.deployments.delete('d1')).toBe(true);
  });
});

describe('mesh threads and dedupe', () => {
  it('stores mesh counters per thread', () => {
    const k = meshThreadKey('a', 'nostr', 'c', 't');
    expect(store.meshThreads.get(k)).toEqual({ turns: 0, hops: 0, humanRequired: false });
    store.meshThreads.update(k, 'a', (s) => ({ ...s, turns: s.turns + 1, hops: 2 }));
    store.meshThreads.update(k, 'a', (s) => ({
      ...s,
      turns: s.turns + 1,
      humanRequired: true,
      lastHumanAt: 'x',
    }));
    expect(store.meshThreads.get(k)).toEqual({ turns: 2, hops: 2, humanRequired: true, lastHumanAt: 'x' });
    store.meshThreads.reset(k);
    expect(store.meshThreads.get(k).turns).toBe(0);
    expect(meshThreadKey('a:b', 'c', 'd', 'e')).not.toBe(meshThreadKey('a', 'b:c', 'd', 'e'));
  });
  it('dedupes inbound message ids per channel', () => {
    expect(store.dedupe.firstSeen('tg', 'm1')).toBe(true);
    expect(store.dedupe.firstSeen('tg', 'm1')).toBe(false);
    expect(store.dedupe.firstSeen('slack', 'm1')).toBe(true);
    expect(store.dedupe.has('tg', 'm1')).toBe(true);
    expect(store.dedupe.prune(new Date(t + 1).toISOString())).toBe(2);
    expect(store.dedupe.has('tg', 'm1')).toBe(false);
  });
});

describe('retention, purge, export', () => {
  const day = 86_400_000;
  const seed = () => {
    const old = newSession({ agent: 'a', threadId: 'old' });
    store.sessions.appendEvent(old.id, { kind: 'user', text: 'old msg' });
    store.approvals.put(approval({ id: 'apr_old', agent: 'a', status: 'denied' }));
    store.approvals.put(approval({ id: 'apr_pending', agent: 'a' }));
    store.audit.append({ agent: 'a', actor: 'x', type: 't', severity: 'info', summary: 'old audit' });
    store.audit.append({ actor: 'x', type: 't', severity: 'info', summary: 'old global audit' });
    store.meshThreads.put(meshThreadKey('a', 'n', 'c', 't'), 'a', {
      turns: 1,
      hops: 1,
      humanRequired: false,
    });
    store.dedupe.firstSeen('tg', 'old');
    t += 40 * day;
    const fresh = newSession({ agent: 'a', threadId: 'fresh' });
    store.sessions.appendEvent(fresh.id, { kind: 'user', text: 'new msg' });
    const other = newSession({ agent: 'b', threadId: 'b-old' });
    store.sessions.update(other.id, { lastActivityAt: new Date(t - 40 * day).toISOString() });
    return { old, fresh, other };
  };

  it('purge by agent and date', () => {
    const { old, fresh, other } = seed();
    const r = store.purge({ agent: 'a', before: new Date(t - 10 * day) });
    expect(r).toMatchObject({ sessions: 1, events: 1, approvals: 1, audit: 0, meshThreads: 1 });
    expect(r.deleted).toBe(4);
    expect(store.sessions.get(old.id)).toBeUndefined();
    expect(store.sessions.get(fresh.id)).toBeDefined();
    expect(store.sessions.get(other.id)).toBeDefined();
    expect(store.approvals.get('apr_pending')).toBeDefined();
  });
  it('purge everything for an agent, including audit on request', () => {
    seed();
    const r = store.purge({ agent: 'a', includeAudit: true });
    expect(r).toMatchObject({ sessions: 2, events: 2, audit: 1 });
    expect(store.sessions.list({ agent: 'b' })).toHaveLength(1);
    expect(() => store.purge({ before: 'not a date' })).toThrow(/invalid date/);
  });
  it('purge before also trims old events in kept sessions', () => {
    const s = newSession();
    store.sessions.appendEvent(s.id, { kind: 'user', text: 'early' });
    t += 5 * day;
    store.sessions.appendEvent(s.id, { kind: 'user', text: 'late' });
    const r = store.purge({ before: new Date(t - day).toISOString() });
    expect(r).toMatchObject({ sessions: 0, events: 1 });
    expect(store.sessions.events(s.id).map((e) => e.text)).toEqual(['late']);
  });
  it('applyRetention honors per-agent transcriptDays/auditDays and defaults', () => {
    const { old, fresh, other } = seed();
    const r = store.applyRetention(now(), { a: { transcriptDays: 30, auditDays: 20 } });
    expect(store.sessions.get(old.id)).toBeUndefined();
    expect(store.sessions.get(fresh.id)).toBeDefined();
    // agent b uses the 30-day default
    expect(store.sessions.get(other.id)).toBeUndefined();
    // agent a audit (40 days old) is past auditDays=20; the global one is kept for a year
    expect(store.audit.query().map((e) => e.summary)).toEqual(['old global audit']);
    expect(r.audit).toBe(1);
    expect(r.dedupe).toBe(1);
    expect(r.transcripts).toBeGreaterThanOrEqual(4);
  });
  it('applyRetention keeps data when the policy is longer', () => {
    const { old } = seed();
    store.applyRetention(now(), { a: { transcriptDays: 90 } });
    expect(store.sessions.get(old.id)).toBeDefined();
  });
  it('exportData writes decrypted JSON with 0600', () => {
    seed();
    const file = store.exportData('a');
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    expect(doc).toMatchObject({ format: 'beamhop-export', agent: 'a' });
    expect(doc.sessions).toHaveLength(2);
    expect(
      doc.sessions.flatMap((s: { events: { text: string }[] }) => s.events.map((e) => e.text)).sort(),
    ).toEqual(['new msg', 'old msg']);
    expect(doc.approvals).toHaveLength(2);
    expect(doc.devices).toBeUndefined();
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    const all = JSON.parse(readFileSync(store.exportData(), 'utf8'));
    expect(all.sessions).toHaveLength(3);
    expect(all.devices).toEqual([]);
  });
  it('export file names cannot escape the export dir', () => {
    const file = store.exportData('../../etc/passwd');
    expect(file.startsWith(join(dir, 'exports'))).toBe(true);
  });
});

describe('in-memory store', () => {
  it('works with :memory:', () => {
    const m = openStore({ key, path: ':memory:', home: dir });
    m.sessions.create({ agent: 'a', channel: 'c', conversationId: 'x', threadId: 'y' });
    expect(m.sessions.list()).toHaveLength(1);
    m.close();
    m.close();
  });
});
