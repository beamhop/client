import { createHash } from 'node:crypto';
import {
  type ApprovalView,
  type AuditEvent,
  BeamhopError,
  type DeploymentView,
  type DeviceView,
  type KV,
  newId,
  type PolicySuggestion,
  type UsageRow,
} from '@beamhop/core';
import type { DataCipher } from './crypto.ts';
import type { Db, Row } from './db.ts';

type Now = () => Date;

const utcDay = (d: Date): string => d.toISOString().slice(0, 10);
const json = (v: unknown): string => JSON.stringify(v ?? {});

// ───────────────────────────── Approvals ─────────────────────────────

export interface ApprovalVote {
  by: string;
  allow: boolean;
  at: string;
}

/** ApprovalView plus vote history (compatible with @beamhop/authz ApprovalState). */
export type StoredApproval = ApprovalView & { votes: ApprovalVote[] };
export type ApprovalInput = Omit<ApprovalView, 'kind'> & {
  kind?: ApprovalView['kind'];
  votes?: ApprovalVote[];
};

export class ApprovalRepo {
  constructor(
    private readonly db: Db,
    private readonly cipher: DataCipher,
  ) {}

  private toState(r: Row): StoredApproval {
    const a: StoredApproval = {
      id: r.id as string,
      agent: r.agent as string,
      sessionId: r.session_id as string,
      requestedBy: JSON.parse(r.requested_by as string),
      tool: r.tool as string,
      title: this.cipher.decrypt('approvals.title', r.title_enc as string),
      input: this.cipher.decryptJson('approvals.input', r.input_enc),
      risk: r.risk as ApprovalView['risk'],
      createdAt: r.created_at as string,
      expiresAt: r.expires_at as string,
      status: r.status as ApprovalView['status'],
      kind: r.kind as ApprovalView['kind'],
      votes: JSON.parse((r.votes as string) || '[]'),
    };
    if (r.decided_by) a.decidedBy = r.decided_by as string;
    if (r.decided_at) a.decidedAt = r.decided_at as string;
    return a;
  }

  /** Insert or replace an approval (state transitions are computed by @beamhop/authz ApprovalPolicy). */
  put(a: ApprovalInput): StoredApproval {
    this.db.run(
      `INSERT INTO approvals (id, agent, session_id, requested_by, tool, title_enc, input_enc, risk, created_at,
         expires_at, status, decided_by, decided_at, kind, votes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, decided_by = excluded.decided_by,
         decided_at = excluded.decided_at, votes = excluded.votes, expires_at = excluded.expires_at`,
      a.id,
      a.agent,
      a.sessionId,
      JSON.stringify(a.requestedBy),
      a.tool,
      this.cipher.encrypt('approvals.title', a.title),
      this.cipher.encryptJson('approvals.input', a.input ?? null),
      a.risk,
      a.createdAt,
      a.expiresAt,
      a.status,
      a.decidedBy ?? null,
      a.decidedAt ?? null,
      a.kind ?? 'tool',
      JSON.stringify(a.votes ?? []),
    );
    return this.get(a.id)!;
  }

  get(id: string): StoredApproval | undefined {
    const r = this.db.get('SELECT * FROM approvals WHERE id = ?', id);
    return r ? this.toState(r) : undefined;
  }

  list(
    filter: { status?: 'pending' | 'all'; agent?: string; sessionId?: string; limit?: number } = {},
  ): ApprovalView[] {
    return this.listStates(filter).map(({ votes: _v, ...view }) => view);
  }

  listStates(
    filter: { status?: 'pending' | 'all'; agent?: string; sessionId?: string; limit?: number } = {},
  ): StoredApproval[] {
    const where: string[] = [];
    const params: string[] = [];
    if ((filter.status ?? 'pending') === 'pending') where.push(`status = 'pending'`);
    if (filter.agent) {
      where.push('agent = ?');
      params.push(filter.agent);
    }
    if (filter.sessionId) {
      where.push('session_id = ?');
      params.push(filter.sessionId);
    }
    return this.db
      .all(
        `SELECT * FROM approvals ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY created_at DESC, id DESC LIMIT ?`,
        ...params,
        filter.limit ?? 500,
      )
      .map((r) => this.toState(r));
  }

  /** Mark pending approvals past their deadline as expired; returns them. */
  expireDue(now: Date): StoredApproval[] {
    return this.db.tx(() => {
      const at = now.toISOString();
      const due = this.db
        .all(`SELECT * FROM approvals WHERE status = 'pending' AND expires_at <= ?`, at)
        .map((r) => this.toState(r));
      this.db.run(
        `UPDATE approvals SET status = 'expired', decided_at = ?, decided_by = 'system:timeout'
         WHERE status = 'pending' AND expires_at <= ?`,
        at,
        at,
      );
      return due.map((a) => ({
        ...a,
        status: 'expired' as const,
        decidedAt: at,
        decidedBy: 'system:timeout',
      }));
    });
  }

  countPending(): number {
    return Number(
      this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'`)?.n ?? 0,
    );
  }
}

// ───────────────────────────── Audit ─────────────────────────────

export type AuditInput = Omit<AuditEvent, 'id' | 'at' | 'data'> & {
  id?: string;
  at?: string;
  data?: Record<string, unknown>;
};

export class AuditRepo {
  constructor(
    private readonly db: Db,
    private readonly now: Now,
  ) {}

  append(e: AuditInput): AuditEvent {
    const ev: AuditEvent = {
      id: e.id ?? newId('aud'),
      at: e.at ?? this.now().toISOString(),
      actor: e.actor,
      type: e.type,
      severity: e.severity,
      summary: e.summary,
      data: e.data ?? {},
    };
    if (e.agent) ev.agent = e.agent;
    this.db.run(
      'INSERT INTO audit (id, at, agent, actor, type, severity, summary, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ev.id,
      ev.at,
      ev.agent ?? null,
      ev.actor,
      ev.type,
      ev.severity,
      ev.summary,
      json(ev.data),
    );
    return ev;
  }

  query(
    q: {
      agent?: string;
      severity?: AuditEvent['severity'];
      type?: string;
      limit?: number;
      before?: string;
      since?: string;
    } = {},
  ): AuditEvent[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    const add = (sql: string, v: string | undefined) => {
      if (v === undefined) return;
      where.push(sql);
      params.push(v);
    };
    add('agent = ?', q.agent);
    add('severity = ?', q.severity);
    add('type = ?', q.type);
    add('at < ?', q.before);
    add('at >= ?', q.since);
    return this.db
      .all(
        `SELECT * FROM audit ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC, id DESC LIMIT ?`,
        ...params,
        Math.min(Math.max(1, q.limit ?? 200), 10_000_000),
      )
      .map((r) => {
        const ev: AuditEvent = {
          id: r.id as string,
          at: r.at as string,
          actor: r.actor as string,
          type: r.type as string,
          severity: r.severity as AuditEvent['severity'],
          summary: r.summary as string,
          data: JSON.parse(r.data as string),
        };
        if (r.agent) ev.agent = r.agent as string;
        return ev;
      });
  }

  /** Count events since a time (for security spike alerts, §9B). */
  count(q: { since: string; severity?: AuditEvent['severity']; agent?: string; type?: string }): number {
    const where = ['at >= ?'];
    const params: string[] = [q.since];
    if (q.severity) {
      where.push('severity = ?');
      params.push(q.severity);
    }
    if (q.agent) {
      where.push('agent = ?');
      params.push(q.agent);
    }
    if (q.type) {
      where.push('type = ?');
      params.push(q.type);
    }
    return Number(
      this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit WHERE ${where.join(' AND ')}`, ...params)
        ?.n ?? 0,
    );
  }
}

// ───────────────────────────── Usage ─────────────────────────────

export interface UsageDelta {
  agent: string;
  channel?: string;
  peer?: string;
  inputTokens?: number;
  outputTokens?: number;
  usd?: number;
  minutes?: number;
  /** Defaults to now. */
  at?: Date | string;
}

export class UsageRepo {
  constructor(
    private readonly db: Db,
    private readonly now: Now,
  ) {}

  /** Add to the daily rollup for (day, agent, channel, peer). */
  add(d: UsageDelta): void {
    const at = d.at === undefined ? this.now() : typeof d.at === 'string' ? new Date(d.at) : d.at;
    if (Number.isNaN(at.getTime())) throw new BeamhopError('invalid_input', 'invalid usage timestamp');
    this.db.run(
      `INSERT INTO usage (day, agent, channel, peer, input_tokens, output_tokens, usd, minutes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(day, agent, channel, peer) DO UPDATE SET
         input_tokens = input_tokens + excluded.input_tokens,
         output_tokens = output_tokens + excluded.output_tokens,
         usd = usd + excluded.usd,
         minutes = minutes + excluded.minutes`,
      utcDay(at),
      d.agent,
      d.channel ?? '',
      d.peer ?? '',
      Math.max(0, Math.round(d.inputTokens ?? 0)),
      Math.max(0, Math.round(d.outputTokens ?? 0)),
      Math.max(0, d.usd ?? 0),
      Math.max(0, d.minutes ?? 0),
    );
  }

  /** Rows for the last `days` days (including today), newest first. */
  query(q: { days?: number; agent?: string } = {}): UsageRow[] {
    const days = Math.max(1, q.days ?? 14);
    const since = utcDay(new Date(this.now().getTime() - (days - 1) * 86_400_000));
    const params: string[] = [since];
    let sql = 'SELECT * FROM usage WHERE day >= ?';
    if (q.agent) {
      sql += ' AND agent = ?';
      params.push(q.agent);
    }
    sql += ' ORDER BY day DESC, agent, channel, peer';
    return this.db.all(sql, ...params).map((r) => {
      const row: UsageRow = {
        day: r.day as string,
        agent: r.agent as string,
        inputTokens: Number(r.input_tokens),
        outputTokens: Number(r.output_tokens),
        usd: Number(r.usd),
        minutes: Number(r.minutes),
      };
      if (r.channel) row.channel = r.channel as string;
      if (r.peer) row.peer = r.peer as string;
      return row;
    });
  }

  /** Totals for one day (default today), optionally narrowed to an agent / channel / peer. */
  totals(q: { agent?: string; channel?: string; peer?: string; day?: string } = {}): {
    tokens: number;
    inputTokens: number;
    outputTokens: number;
    usd: number;
    minutes: number;
  } {
    const where = ['day = ?'];
    const params: string[] = [q.day ?? utcDay(this.now())];
    for (const [col, v] of [
      ['agent', q.agent],
      ['channel', q.channel],
      ['peer', q.peer],
    ] as const) {
      if (v === undefined) continue;
      where.push(`${col} = ?`);
      params.push(v);
    }
    const r = this.db.get<Row>(
      `SELECT COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o, COALESCE(SUM(usd),0) AS u,
         COALESCE(SUM(minutes),0) AS m FROM usage WHERE ${where.join(' AND ')}`,
      ...params,
    )!;
    const i = Number(r.i);
    const o = Number(r.o);
    return { tokens: i + o, inputTokens: i, outputTokens: o, usd: Number(r.u), minutes: Number(r.m) };
  }
}

// ───────────────────────────── Devices ─────────────────────────────

export class DeviceRepo {
  constructor(
    private readonly db: Db,
    private readonly cipher: DataCipher,
    private readonly now: Now,
  ) {}

  private toView(r: Row): DeviceView {
    const d: DeviceView = {
      id: r.id as string,
      name: r.name as string,
      pubkey: r.pubkey as string,
      pairedAt: r.paired_at as string,
      pushEnabled: Boolean(r.push_enabled),
    };
    if (r.last_seen_at) d.lastSeenAt = r.last_seen_at as string;
    return d;
  }

  add(input: { name: string; pubkey: string; id?: string; pairedAt?: string }): DeviceView {
    const id = input.id ?? newId('dev');
    try {
      this.db.run(
        'INSERT INTO devices (id, name, pubkey, paired_at) VALUES (?, ?, ?, ?)',
        id,
        input.name,
        input.pubkey,
        input.pairedAt ?? this.now().toISOString(),
      );
    } catch (err) {
      if (String(err).includes('UNIQUE')) throw new BeamhopError('conflict', 'device already paired');
      throw err;
    }
    return this.get(id)!;
  }

  get(id: string): DeviceView | undefined {
    const r = this.db.get('SELECT * FROM devices WHERE id = ?', id);
    return r ? this.toView(r) : undefined;
  }

  getByPubkey(pubkey: string): DeviceView | undefined {
    const r = this.db.get('SELECT * FROM devices WHERE pubkey = ?', pubkey);
    return r ? this.toView(r) : undefined;
  }

  list(): DeviceView[] {
    return this.db.all('SELECT * FROM devices ORDER BY paired_at, id').map((r) => this.toView(r));
  }

  touch(id: string, at = this.now().toISOString()): void {
    this.db.run('UPDATE devices SET last_seen_at = ? WHERE id = ?', at, id);
  }

  rename(id: string, name: string): void {
    this.db.run('UPDATE devices SET name = ? WHERE id = ?', name, id);
  }

  /** Store a Web Push subscription (encrypted); null disables push. */
  setPush(id: string, subscription: unknown | null): void {
    const r = this.db.run(
      'UPDATE devices SET push_enabled = ?, push_sub_enc = ? WHERE id = ?',
      subscription != null,
      subscription == null ? null : this.cipher.encryptJson('devices.push', subscription),
      id,
    );
    if (r.changes === 0) throw new BeamhopError('not_found', `device ${id} not found`);
  }

  pushSubscription(id: string): unknown | undefined {
    const r = this.db.get<{ push_sub_enc: string | null }>(
      'SELECT push_sub_enc FROM devices WHERE id = ?',
      id,
    );
    return this.cipher.decryptJson('devices.push', r?.push_sub_enc);
  }

  /** The plain "Remove" button for lost phones (§7A). */
  remove(id: string): boolean {
    return this.db.run('DELETE FROM devices WHERE id = ?', id).changes > 0;
  }
}

// ───────────────────────────── KV ─────────────────────────────

export class KvRepo {
  constructor(
    private readonly db: Db,
    private readonly cipher: DataCipher,
    private readonly now: Now,
  ) {}

  get<T = unknown>(ns: string, key: string): T | undefined {
    const r = this.db.get<{ value_enc: string }>(
      'SELECT value_enc FROM kv WHERE ns = ? AND key = ?',
      ns,
      key,
    );
    return r ? this.cipher.decryptJson<T>(`kv.${ns}`, r.value_enc) : undefined;
  }

  set(ns: string, key: string, value: unknown): void {
    if (value === undefined) {
      this.delete(ns, key);
      return;
    }
    this.db.run(
      `INSERT INTO kv (ns, key, value_enc, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(ns, key) DO UPDATE SET value_enc = excluded.value_enc, updated_at = excluded.updated_at`,
      ns,
      key,
      this.cipher.encryptJson(`kv.${ns}`, value),
      this.now().toISOString(),
    );
  }

  delete(ns: string, key: string): void {
    this.db.run('DELETE FROM kv WHERE ns = ? AND key = ?', ns, key);
  }

  keys(ns: string): string[] {
    return this.db.all<{ key: string }>('SELECT key FROM kv WHERE ns = ? ORDER BY key', ns).map((r) => r.key);
  }

  /** A namespaced async KV matching the core `KV` interface (e.g. per-channel state). */
  namespace(ns: string): KV {
    return {
      get: async <T>(key: string) => this.get<T>(ns, key),
      set: async (key, value) => this.set(ns, key, value),
      delete: async (key) => this.delete(ns, key),
    };
  }
}

// ───────────────────────────── Policy suggestions ─────────────────────────────

export type SuggestionStatus = 'open' | 'accepted' | 'rejected';

export class PolicySuggestionRepo {
  constructor(
    private readonly db: Db,
    private readonly now: Now,
  ) {}

  private toView(r: Row): PolicySuggestion {
    return {
      id: r.id as string,
      agent: r.agent as string,
      kind: r.kind as PolicySuggestion['kind'],
      value: r.value as string,
      count: Number(r.count),
      lastSeenAt: r.last_seen_at as string,
    };
  }

  /** Record an srt violation seen in learning mode; repeated values bump the count. */
  record(
    agent: string,
    kind: PolicySuggestion['kind'],
    value: string,
    at = this.now().toISOString(),
  ): PolicySuggestion {
    this.db.run(
      `INSERT INTO policy_suggestions (id, agent, kind, value, count, last_seen_at) VALUES (?, ?, ?, ?, 1, ?)
       ON CONFLICT(agent, kind, value) DO UPDATE SET count = count + 1, last_seen_at = excluded.last_seen_at`,
      newId('pol'),
      agent,
      kind,
      value,
      at,
    );
    return this.toView(
      this.db.get(
        'SELECT * FROM policy_suggestions WHERE agent = ? AND kind = ? AND value = ?',
        agent,
        kind,
        value,
      )!,
    );
  }

  list(filter: { agent?: string; status?: SuggestionStatus } = {}): PolicySuggestion[] {
    const params: string[] = [filter.status ?? 'open'];
    let sql = 'SELECT * FROM policy_suggestions WHERE status = ?';
    if (filter.agent) {
      sql += ' AND agent = ?';
      params.push(filter.agent);
    }
    return this.db.all(`${sql} ORDER BY count DESC, last_seen_at DESC`, ...params).map((r) => this.toView(r));
  }

  get(id: string): PolicySuggestion | undefined {
    const r = this.db.get('SELECT * FROM policy_suggestions WHERE id = ?', id);
    return r ? this.toView(r) : undefined;
  }

  /** Accept or reject; rejected values are not suggested again. */
  resolve(id: string, accept: boolean): PolicySuggestion {
    const r = this.db.run(
      'UPDATE policy_suggestions SET status = ? WHERE id = ?',
      accept ? 'accepted' : 'rejected',
      id,
    );
    if (r.changes === 0) throw new BeamhopError('not_found', `suggestion ${id} not found`);
    return this.get(id)!;
  }
}

// ───────────────────────────── Pairing codes ─────────────────────────────

export interface PairingCodeRecord {
  purpose: string;
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
  data: Record<string, unknown>;
}

export type PairingConsume =
  | { ok: true; record: PairingCodeRecord }
  | { ok: false; reason: 'unknown' | 'expired' | 'used' };

/** Only a SHA-256 of each code is stored; lookups by hash don't leak timing about the code. */
export const hashPairingCode = (code: string): string =>
  createHash('sha256')
    .update(
      code
        .normalize('NFKC')
        .toUpperCase()
        .replace(/[\s_-]+/g, ''),
      'utf8',
    )
    .digest('hex');

export class PairingCodeRepo {
  constructor(
    private readonly db: Db,
    private readonly now: Now,
  ) {}

  put(input: { code: string; purpose: string; expiresAt: string; data?: Record<string, unknown> }): void {
    this.db.run(
      'INSERT OR REPLACE INTO pairing_codes (code_hash, purpose, created_at, expires_at, data) VALUES (?, ?, ?, ?, ?)',
      hashPairingCode(input.code),
      input.purpose,
      this.now().toISOString(),
      input.expiresAt,
      json(input.data),
    );
  }

  /** One-shot: marks the code used on success. Optionally require a purpose. */
  consume(code: string, purpose?: string): PairingConsume {
    return this.db.tx(() => {
      const h = hashPairingCode(code);
      const r = this.db.get('SELECT * FROM pairing_codes WHERE code_hash = ?', h);
      if (!r || (purpose && r.purpose !== purpose)) return { ok: false, reason: 'unknown' };
      if (r.used_at) return { ok: false, reason: 'used' };
      const now = this.now();
      if (now.getTime() >= Date.parse(r.expires_at as string)) return { ok: false, reason: 'expired' };
      this.db.run('UPDATE pairing_codes SET used_at = ? WHERE code_hash = ?', now.toISOString(), h);
      return {
        ok: true,
        record: {
          purpose: r.purpose as string,
          createdAt: r.created_at as string,
          expiresAt: r.expires_at as string,
          usedAt: now.toISOString(),
          data: JSON.parse(r.data as string),
        },
      };
    });
  }

  /** Delete codes that expired or were used before `before`. */
  prune(before: string): number {
    return this.db.run('DELETE FROM pairing_codes WHERE expires_at < ? OR used_at < ?', before, before)
      .changes;
  }
}

// ───────────────────────────── Deployments ─────────────────────────────

export type DeploymentRecord = DeploymentView & { address?: string; data?: Record<string, unknown> };

export class DeploymentRepo {
  constructor(private readonly db: Db) {}

  private toView(r: Row): DeploymentRecord {
    const d: DeploymentRecord = {
      id: r.id as string,
      provider: r.provider as string,
      agent: r.agent as string,
      status: r.status as DeploymentView['status'],
      createdAt: r.created_at as string,
    };
    if (r.region) d.region = r.region as string;
    if (r.size) d.size = r.size as string;
    if (r.monthly_cost_usd != null) d.monthlyCostUsd = Number(r.monthly_cost_usd);
    if (r.address) d.address = r.address as string;
    const data = JSON.parse(r.data as string);
    if (Object.keys(data).length) d.data = data;
    return d;
  }

  upsert(d: DeploymentRecord): DeploymentRecord {
    this.db.run(
      `INSERT INTO deployments (id, provider, agent, status, region, size, created_at, monthly_cost_usd, address, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, region = excluded.region, size = excluded.size,
         monthly_cost_usd = excluded.monthly_cost_usd, address = excluded.address, data = excluded.data`,
      d.id,
      d.provider,
      d.agent,
      d.status,
      d.region,
      d.size,
      d.createdAt,
      d.monthlyCostUsd,
      d.address,
      json(d.data),
    );
    return this.get(d.id)!;
  }

  get(id: string): DeploymentRecord | undefined {
    const r = this.db.get('SELECT * FROM deployments WHERE id = ?', id);
    return r ? this.toView(r) : undefined;
  }

  list(filter: { agent?: string; includeDestroyed?: boolean } = {}): DeploymentRecord[] {
    const where: string[] = [];
    const params: string[] = [];
    if (!filter.includeDestroyed) where.push(`status != 'destroyed'`);
    if (filter.agent) {
      where.push('agent = ?');
      params.push(filter.agent);
    }
    return this.db
      .all(
        `SELECT * FROM deployments ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at`,
        ...params,
      )
      .map((r) => this.toView(r));
  }

  setStatus(id: string, status: DeploymentView['status']): void {
    if (this.db.run('UPDATE deployments SET status = ? WHERE id = ?', status, id).changes === 0)
      throw new BeamhopError('not_found', `deployment ${id} not found`);
  }

  delete(id: string): boolean {
    return this.db.run('DELETE FROM deployments WHERE id = ?', id).changes > 0;
  }
}

// ───────────────────────────── Mesh threads ─────────────────────────────

/** Same shape as @beamhop/authz MeshThreadState. */
export interface MeshThreadRecord {
  turns: number;
  hops: number;
  humanRequired: boolean;
  lastHumanAt?: string;
}

export const meshThreadKey = (
  agent: string,
  channel: string,
  conversationId: string,
  threadId: string,
): string => JSON.stringify([agent, channel, conversationId, threadId]);

export class MeshThreadRepo {
  constructor(
    private readonly db: Db,
    private readonly now: Now,
  ) {}

  get(key: string): MeshThreadRecord {
    const r = this.db.get('SELECT * FROM mesh_threads WHERE key = ?', key);
    if (!r) return { turns: 0, hops: 0, humanRequired: false };
    const out: MeshThreadRecord = {
      turns: Number(r.turns),
      hops: Number(r.hops),
      humanRequired: Boolean(r.human_required),
    };
    if (r.last_human_at) out.lastHumanAt = r.last_human_at as string;
    return out;
  }

  put(key: string, agent: string, s: MeshThreadRecord): void {
    this.db.run(
      `INSERT INTO mesh_threads (key, agent, turns, hops, human_required, last_human_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET turns = excluded.turns, hops = excluded.hops,
         human_required = excluded.human_required, last_human_at = excluded.last_human_at,
         updated_at = excluded.updated_at`,
      key,
      agent,
      s.turns,
      s.hops,
      s.humanRequired,
      s.lastHumanAt,
      this.now().toISOString(),
    );
  }

  /** Read-modify-write atomically. */
  update(key: string, agent: string, fn: (s: MeshThreadRecord) => MeshThreadRecord): MeshThreadRecord {
    return this.db.tx(() => {
      const next = fn(this.get(key));
      this.put(key, agent, next);
      return next;
    });
  }

  reset(key: string): void {
    this.db.run('DELETE FROM mesh_threads WHERE key = ?', key);
  }
}

// ───────────────────────────── Dedupe ─────────────────────────────

export class DedupeRepo {
  constructor(
    private readonly db: Db,
    private readonly now: Now,
  ) {}

  /** Returns true the first time a (channel, message id) is seen, false for duplicates. */
  firstSeen(channel: string, messageId: string): boolean {
    return (
      this.db.run(
        'INSERT OR IGNORE INTO dedupe (channel, message_id, seen_at) VALUES (?, ?, ?)',
        channel,
        messageId,
        this.now().toISOString(),
      ).changes > 0
    );
  }

  has(channel: string, messageId: string): boolean {
    return (
      this.db.get('SELECT 1 AS x FROM dedupe WHERE channel = ? AND message_id = ?', channel, messageId) !==
      undefined
    );
  }

  prune(before: string): number {
    return this.db.run('DELETE FROM dedupe WHERE seen_at < ?', before).changes;
  }
}
