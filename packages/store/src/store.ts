import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BeamhopError, beamhopHome, type Logger, paths, silentLogger } from '@beamhop/core';
import { DataCipher } from './crypto.ts';
import { Db, migrate, schemaVersion } from './db.ts';
import {
  ApprovalRepo,
  AuditRepo,
  DedupeRepo,
  DeploymentRepo,
  DeviceRepo,
  KvRepo,
  MeshThreadRepo,
  PairingCodeRepo,
  PolicySuggestionRepo,
  UsageRepo,
} from './repos.ts';
import { SessionRepo } from './sessions.ts';

export interface StoreOptions {
  /** 32-byte data key (from the keychain). */
  key: Uint8Array;
  /** beamhop home; defaults to $BEAMHOP_HOME or ~/.beamhop. */
  home?: string;
  /** SQLite file, or ":memory:". Defaults to `paths(home).db`. */
  path?: string;
  /** Where `exportData` writes. Defaults to `<home>/exports`. */
  exportDir?: string;
  logger?: Logger;
  /** Injectable clock for tests. */
  now?: () => Date;
}

export interface RetentionPolicy {
  transcriptDays?: number;
  auditDays?: number;
}

export const DEFAULT_RETENTION = { transcriptDays: 30, auditDays: 365 } as const;
/** How long inbound message ids are remembered for dedupe. */
export const DEDUPE_DAYS = 7;

export interface PurgeResult {
  deleted: number;
  sessions: number;
  events: number;
  approvals: number;
  audit: number;
  meshThreads: number;
}

const DAY_MS = 86_400_000;
const KEYCHECK_NS = '__store';
const KEYCHECK_VALUE = 'beamhop-keycheck-v1';

const toIso = (d: string | Date, what: string): string => {
  const t = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(t.getTime())) throw new BeamhopError('invalid_input', `invalid ${what}: ${String(d)}`);
  return t.toISOString();
};

/**
 * beamhop's SQLite store. Transcript text, tool I/O, approval inputs, resume tokens, push subscriptions and
 * KV values are encrypted at rest with AES-256-GCM under the caller's data key.
 */
export class Store {
  readonly db: Db;
  readonly sessions: SessionRepo;
  readonly approvals: ApprovalRepo;
  readonly audit: AuditRepo;
  readonly usage: UsageRepo;
  readonly devices: DeviceRepo;
  readonly kv: KvRepo;
  readonly policySuggestions: PolicySuggestionRepo;
  readonly pairingCodes: PairingCodeRepo;
  readonly deployments: DeploymentRepo;
  readonly meshThreads: MeshThreadRepo;
  readonly dedupe: DedupeRepo;
  readonly home: string;
  private readonly exportDir: string;
  private readonly now: () => Date;
  private readonly log: Logger;

  constructor(opts: StoreOptions) {
    const cipher = new DataCipher(opts.key);
    this.home = opts.home ?? (opts.path && opts.path !== ':memory:' ? dirname(opts.path) : beamhopHome());
    this.exportDir = opts.exportDir ?? join(this.home, 'exports');
    this.now = opts.now ?? (() => new Date());
    this.log = opts.logger ?? silentLogger;
    this.db = new Db(opts.path ?? paths(this.home).db);
    try {
      const applied = migrate(this.db, undefined, this.now);
      if (applied.length) this.log.info('store migrated', { applied, version: schemaVersion(this.db) });
      this.sessions = new SessionRepo(this.db, cipher, this.now);
      this.approvals = new ApprovalRepo(this.db, cipher);
      this.audit = new AuditRepo(this.db, this.now);
      this.usage = new UsageRepo(this.db, this.now);
      this.devices = new DeviceRepo(this.db, cipher, this.now);
      this.kv = new KvRepo(this.db, cipher, this.now);
      this.policySuggestions = new PolicySuggestionRepo(this.db, this.now);
      this.pairingCodes = new PairingCodeRepo(this.db, this.now);
      this.deployments = new DeploymentRepo(this.db);
      this.meshThreads = new MeshThreadRepo(this.db, this.now);
      this.dedupe = new DedupeRepo(this.db, this.now);
      this.checkKey();
    } catch (err) {
      this.db.close();
      throw err;
    }
  }

  /** Fail fast with a clear error when the data key doesn't match the database. */
  private checkKey(): void {
    let existing: unknown;
    try {
      existing = this.kv.get(KEYCHECK_NS, 'key');
    } catch {
      throw new BeamhopError('unauthorized', 'the data key does not match this database');
    }
    if (existing === undefined) this.kv.set(KEYCHECK_NS, 'key', KEYCHECK_VALUE);
    else if (existing !== KEYCHECK_VALUE)
      throw new BeamhopError('unauthorized', 'the data key does not match this database');
  }

  get schemaVersion(): number {
    return schemaVersion(this.db);
  }

  /**
   * Delete transcripts (sessions + events), approvals and mesh counters, optionally for one agent and/or
   * only rows older than `before`. Audit entries are kept unless `includeAudit` is set.
   */
  purge(opts: { agent?: string; before?: string | Date; includeAudit?: boolean } = {}): PurgeResult {
    const before = opts.before === undefined ? undefined : toIso(opts.before, 'date');
    return this.db.tx(() => {
      const agentSql = opts.agent === undefined ? '' : ' AND agent = ?';
      const agentP = opts.agent === undefined ? [] : [opts.agent];
      const beforeSql = (col: string) => (before === undefined ? '' : ` AND ${col} < ?`);
      const beforeP = before === undefined ? [] : [before];

      // Events older than `before` inside sessions that are kept, plus all events of deleted sessions (cascade).
      const events =
        before === undefined
          ? 0
          : this.db.run(
              `DELETE FROM session_events WHERE at < ? AND session_id IN (SELECT id FROM sessions WHERE 1=1${agentSql})`,
              before,
              ...agentP,
            ).changes;
      const cascaded = Number(
        this.db.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM session_events WHERE session_id IN
             (SELECT id FROM sessions WHERE 1=1${agentSql}${beforeSql('last_activity_at')})`,
          ...agentP,
          ...beforeP,
        )?.n ?? 0,
      );
      const sessions = this.db.run(
        `DELETE FROM sessions WHERE 1=1${agentSql}${beforeSql('last_activity_at')}`,
        ...agentP,
        ...beforeP,
      ).changes;
      const approvals = this.db.run(
        `DELETE FROM approvals WHERE status != 'pending'${agentSql}${beforeSql('created_at')}`,
        ...agentP,
        ...beforeP,
      ).changes;
      const meshThreads = this.db.run(
        `DELETE FROM mesh_threads WHERE 1=1${agentSql}${beforeSql('updated_at')}`,
        ...agentP,
        ...beforeP,
      ).changes;
      const audit = opts.includeAudit
        ? this.db.run(`DELETE FROM audit WHERE 1=1${agentSql}${beforeSql('at')}`, ...agentP, ...beforeP)
            .changes
        : 0;
      const result = {
        sessions,
        events: events + cascaded,
        approvals,
        audit,
        meshThreads,
        deleted: sessions + events + cascaded + approvals + audit + meshThreads,
      };
      this.log.info('store purged', { agent: opts.agent, before, ...result });
      return result;
    });
  }

  /**
   * Apply retention (§8): transcripts older than each agent's `transcriptDays`, audit older than `auditDays`.
   * Agents not in `policies` (and audit rows without an agent) use the defaults (30 days / 1 year).
   * Also prunes dedupe ids, used/expired pairing codes and stale mesh counters.
   */
  applyRetention(
    now: Date = this.now(),
    policies: Record<string, RetentionPolicy> = {},
  ): { transcripts: number; audit: number; dedupe: number; pairingCodes: number } {
    return this.db.tx(() => {
      const agents = new Set<string>(Object.keys(policies));
      for (const sql of [
        'SELECT DISTINCT agent FROM sessions',
        'SELECT DISTINCT agent FROM approvals',
        'SELECT DISTINCT agent FROM mesh_threads',
        'SELECT DISTINCT agent FROM audit WHERE agent IS NOT NULL',
      ])
        for (const r of this.db.all<{ agent: string }>(sql)) agents.add(r.agent);

      let transcripts = 0;
      let audit = 0;
      for (const agent of agents) {
        const p = { ...DEFAULT_RETENTION, ...stripUndef(policies[agent] ?? {}) };
        const tCut = new Date(now.getTime() - p.transcriptDays * DAY_MS);
        transcripts += this.purge({ agent, before: tCut }).deleted;
        const aCut = new Date(now.getTime() - p.auditDays * DAY_MS).toISOString();
        audit += this.db.run('DELETE FROM audit WHERE agent = ? AND at < ?', agent, aCut).changes;
      }
      const globalCut = new Date(now.getTime() - DEFAULT_RETENTION.auditDays * DAY_MS).toISOString();
      audit += this.db.run('DELETE FROM audit WHERE agent IS NULL AND at < ?', globalCut).changes;
      const dedupe = this.dedupe.prune(new Date(now.getTime() - DEDUPE_DAYS * DAY_MS).toISOString());
      const pairingCodes = this.pairingCodes.prune(new Date(now.getTime() - DAY_MS).toISOString());
      return { transcripts, audit, dedupe, pairingCodes };
    });
  }

  /** Build the export document (decrypted) for one agent or everything. */
  exportJson(agent?: string): Record<string, unknown> {
    const sessions = this.sessions.list({ agent, limit: 1_000_000 }).map((s) => ({
      ...s,
      events: this.sessions.events(s.id),
    }));
    const approvals = this.approvals.listStates({ status: 'all', agent, limit: 1_000_000 });
    const audit = this.audit.query({ agent, limit: 10_000_000 });
    const usage = this.usage.query({ days: 3650, agent });
    const deployments = this.deployments.list({ agent, includeDestroyed: true });
    const doc: Record<string, unknown> = {
      format: 'beamhop-export',
      version: 1,
      exportedAt: this.now().toISOString(),
      schemaVersion: this.schemaVersion,
      agent: agent ?? null,
      sessions,
      approvals,
      audit,
      usage,
      deployments,
      policySuggestions: this.policySuggestions.list({ agent }),
    };
    if (agent === undefined) doc.devices = this.devices.list();
    return doc;
  }

  /** `beamhop data export`: write a JSON file (mode 0600) and return its path. */
  exportData(agent?: string): string {
    mkdirSync(this.exportDir, { recursive: true });
    const stamp = this.now().toISOString().replace(/[:.]/g, '-');
    const label =
      agent === undefined
        ? 'all'
        : agent
            .toLowerCase()
            .replace(/[^a-z0-9-]+/g, '_')
            .slice(0, 48);
    const file = join(this.exportDir, `beamhop-export-${label}-${stamp}.json`);
    writeFileSync(file, `${JSON.stringify(this.exportJson(agent), null, 2)}\n`, { mode: 0o600 });
    this.log.info('store exported', { agent, file });
    return file;
  }

  close(): void {
    this.db.close();
  }
}

const stripUndef = <T extends object>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

export const openStore = (opts: StoreOptions): Store => new Store(opts);
