import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { DatabaseSync as DatabaseSyncT, SQLInputValue } from 'node:sqlite';
import { BeamhopError } from '@beamhop/core';
import { MIGRATIONS, type Migration } from './migrations.ts';

export type Row = Record<string, unknown>;
export type Param = SQLInputValue | undefined | boolean;

const require = createRequire(import.meta.url);

const loadSqlite = (): typeof import('node:sqlite') => {
  try {
    return require('node:sqlite') as typeof import('node:sqlite');
  } catch (err) {
    throw new BeamhopError(
      'unavailable',
      `node:sqlite is not available in Node ${process.version}; beamhop needs Node >= 22.5`,
      { cause: String(err) },
    );
  }
};

const toParam = (p: Param): SQLInputValue => {
  if (p === undefined) return null;
  if (typeof p === 'boolean') return p ? 1 : 0;
  return p;
};

/** Thin synchronous wrapper over node:sqlite with nested transactions (savepoints). */
export class Db {
  readonly raw: DatabaseSyncT;
  private depth = 0;
  private closed = false;

  constructor(path: string) {
    const { DatabaseSync } = loadSqlite();
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
      const fresh = !existsSync(path);
      this.raw = new DatabaseSync(path);
      if (fresh && process.platform !== 'win32') {
        try {
          chmodSync(path, 0o600);
        } catch {
          // best effort
        }
      }
    } else {
      this.raw = new DatabaseSync(':memory:');
    }
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    if (path !== ':memory:') this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA synchronous = NORMAL');
  }

  run(sql: string, ...params: Param[]): { changes: number } {
    const r = this.raw.prepare(sql).run(...params.map(toParam));
    return { changes: Number(r.changes) };
  }

  get<T = Row>(sql: string, ...params: Param[]): T | undefined {
    return this.raw.prepare(sql).get(...params.map(toParam)) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: Param[]): T[] {
    return this.raw.prepare(sql).all(...params.map(toParam)) as T[];
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  tx<T>(fn: () => T): T {
    const sp = `sp${this.depth}`;
    this.raw.exec(this.depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    this.depth++;
    try {
      const out = fn();
      this.depth--;
      this.raw.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
      return out;
    } catch (err) {
      this.depth--;
      this.raw.exec(this.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw err;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.raw.close();
  }
}

/** Apply pending migrations in order; returns the versions applied. */
export const migrate = (db: Db, migrations: Migration[] = MIGRATIONS, now = () => new Date()): number[] => {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const done = new Set(
    db.all<{ version: number }>('SELECT version FROM schema_migrations').map((r) => r.version),
  );
  const latest = Math.max(0, ...done);
  const known = Math.max(0, ...migrations.map((m) => m.version));
  if (latest > known)
    throw new BeamhopError(
      'conflict',
      `database schema v${latest} is newer than this beamhop (v${known}); upgrade beamhop`,
    );
  const applied: number[] = [];
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (done.has(m.version)) continue;
    db.tx(() => {
      db.exec(m.sql);
      db.run(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
        m.version,
        m.name,
        now().toISOString(),
      );
    });
    applied.push(m.version);
  }
  return applied;
};

export const schemaVersion = (db: Db): number =>
  db.get<{ v: number | null }>('SELECT MAX(version) AS v FROM schema_migrations')?.v ?? 0;
