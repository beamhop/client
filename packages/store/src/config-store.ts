import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  type FSWatcher,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  watch,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  AgentConfig,
  BeamhopConfig,
  BeamhopError,
  beamhopHome,
  ChannelConfig,
  type Logger,
  paths,
  ScheduleConfig,
  Slug,
  silentLogger,
} from '@beamhop/core';
import { parse, stringify } from 'yaml';
import type { z } from 'zod';

// ───────────────────────────── atomic file IO ─────────────────────────────

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Write via temp file + fsync + rename, so readers never see a half-written file. */
export const writeFileAtomic = (file: string, content: string, mode = 0o644): void => {
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  const fd = openSync(tmp, 'w', mode);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
};

// ───────────────────────────── hand-edit friendliness ─────────────────────────────

/** Keys whose children are user data (principals, provider settings), never renamed. */
const OPAQUE_KEYS = new Set(['grants', 'people', 'settings']);

const camel = (k: string): string => k.replace(/[_-]([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** Accept snake_case / kebab-case keys from hand-written YAML (as in PLAN.md examples). */
export const camelizeKeys = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(camelizeKeys);
  if (!v || typeof v !== 'object') return v;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const ck = camel(k);
    out[ck] = OPAQUE_KEYS.has(ck) ? val : camelizeKeys(val);
  }
  return out;
};

/** Shorthands from PLAN.md §6A.1: `sandbox: workspace`, membership `channel`/`trigger`, `identity.nostr`. */
const normalizeAgent = (raw: unknown): unknown => {
  const a = camelizeKeys(raw) as Record<string, unknown>;
  if (!a || typeof a !== 'object') return a;
  if (typeof a.sandbox === 'string') a.sandbox = { profile: a.sandbox };
  if (Array.isArray(a.memberships))
    a.memberships = a.memberships.map((m) => {
      if (!m || typeof m !== 'object') return m;
      const mm = { ...(m as Record<string, unknown>) };
      if (mm.target === undefined && typeof mm.channel === 'string') mm.target = mm.channel;
      delete mm.channel;
      if (mm.triggers === undefined && mm.trigger !== undefined)
        mm.triggers = Array.isArray(mm.trigger) ? mm.trigger : [mm.trigger];
      delete mm.trigger;
      return mm;
    });
  const id = a.identity as Record<string, unknown> | undefined;
  if (id && typeof id === 'object' && typeof id.nostr === 'string' && id.nostrKeyRef === undefined) {
    id.nostrKeyRef = id.nostr;
    delete id.nostr;
  }
  return a;
};

const formatIssues = (err: z.ZodError): string =>
  err.issues.map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`).join('; ');

// ───────────────────────────── collections ─────────────────────────────

const SCHEDULE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

interface CollectionSpec<T> {
  kind: ConfigKind;
  dir: string;
  schema: z.ZodType<T>;
  keyOf: (v: T) => string;
  validKey: (k: string) => boolean;
  normalize?: (raw: unknown) => unknown;
}

export interface ConfigFileError {
  file: string;
  message: string;
}

/** One directory of `<key>.yaml` files validated by a zod schema. */
export class YamlCollection<T> {
  constructor(
    private readonly spec: CollectionSpec<T>,
    private readonly onWrite: (file: string, content: string | null) => void,
  ) {}

  get dir(): string {
    return this.spec.dir;
  }

  private checkKey(key: string): void {
    if (!this.spec.validKey(key))
      throw new BeamhopError('invalid_input', `invalid ${this.spec.kind} name "${key}"`);
  }

  pathFor(key: string): string {
    this.checkKey(key);
    return join(this.spec.dir, `${key}.yaml`);
  }

  private existingPath(key: string): string | undefined {
    this.checkKey(key);
    for (const ext of ['.yaml', '.yml']) {
      const p = join(this.spec.dir, key + ext);
      if (existsSync(p)) return p;
    }
    return undefined;
  }

  /** Parse and validate YAML text; throws BeamhopError('invalid_input') naming the file. */
  parseText(text: string, file: string): T {
    let raw: unknown;
    try {
      raw = parse(text) ?? {};
    } catch (err) {
      throw new BeamhopError('invalid_input', `${file}: invalid YAML: ${(err as Error).message}`);
    }
    const res = this.spec.schema.safeParse(
      this.spec.normalize ? this.spec.normalize(raw) : camelizeKeys(raw),
    );
    if (!res.success)
      throw new BeamhopError('invalid_input', `${file}: ${formatIssues(res.error)}`, {
        issues: res.error.issues,
      });
    return res.data;
  }

  /** Validate an input object without saving. */
  validate(input: unknown): T {
    const res = this.spec.schema.safeParse(this.spec.normalize ? this.spec.normalize(input) : input);
    if (!res.success)
      throw new BeamhopError('invalid_input', `invalid ${this.spec.kind}: ${formatIssues(res.error)}`, {
        issues: res.error.issues,
      });
    return res.data;
  }

  get(key: string): T | undefined {
    const file = this.existingPath(key);
    if (!file) return undefined;
    const value = this.parseText(readFileSync(file, 'utf8'), file);
    if (this.spec.keyOf(value) !== key)
      throw new BeamhopError(
        'invalid_input',
        `${file}: name "${this.spec.keyOf(value)}" does not match file name`,
      );
    return value;
  }

  require(key: string): T {
    const v = this.get(key);
    if (!v) throw new BeamhopError('not_found', `${this.spec.kind} "${key}" not found`);
    return v;
  }

  has(key: string): boolean {
    return this.existingPath(key) !== undefined;
  }

  /** All valid entries plus a list of files that failed to parse. */
  listWithErrors(): { items: T[]; errors: ConfigFileError[] } {
    if (!existsSync(this.spec.dir)) return { items: [], errors: [] };
    const items: T[] = [];
    const errors: ConfigFileError[] = [];
    const seen = new Set<string>();
    for (const f of readdirSync(this.spec.dir).sort()) {
      const m = /^(.+)\.ya?ml$/.exec(f);
      if (!m || f.startsWith('.') || f.includes('.tmp-')) continue;
      const key = m[1]!;
      if (seen.has(key)) continue;
      seen.add(key);
      const file = join(this.spec.dir, f);
      try {
        if (!this.spec.validKey(key)) throw new BeamhopError('invalid_input', `${file}: invalid file name`);
        const v = this.get(key);
        if (v) items.push(v);
      } catch (err) {
        errors.push({ file, message: (err as Error).message });
      }
    }
    return { items, errors };
  }

  list(): T[] {
    return this.listWithErrors().items;
  }

  /** Validate and write atomically. Returns the parsed (defaults-filled) value. */
  save(input: unknown): T {
    const value = this.validate(input);
    const key = this.spec.keyOf(value);
    const file = this.pathFor(key);
    mkdirSync(this.spec.dir, { recursive: true });
    const content = stringify(value, { lineWidth: 0 });
    this.onWrite(file, content);
    writeFileAtomic(file, content);
    const yml = join(this.spec.dir, `${key}.yml`);
    if (existsSync(yml)) rmSync(yml, { force: true });
    return value;
  }

  /** Load, apply `fn`, validate, save. */
  update(key: string, fn: (current: T) => unknown): T {
    const next = this.validate(fn(this.require(key)));
    if (this.spec.keyOf(next) !== key)
      throw new BeamhopError('invalid_input', `cannot rename ${this.spec.kind} via update`);
    return this.save(next);
  }

  delete(key: string): boolean {
    let removed = false;
    for (const ext of ['.yaml', '.yml']) {
      const p = join(this.spec.dir, key + ext);
      this.checkKey(key);
      if (existsSync(p)) {
        this.onWrite(p, null);
        rmSync(p, { force: true });
        removed = true;
      }
    }
    return removed;
  }
}

// ───────────────────────────── ConfigStore ─────────────────────────────

export type ConfigKind = 'config' | 'agent' | 'channel' | 'schedule';

export interface ConfigChange {
  kind: ConfigKind;
  /** Entry key (agent/channel name, schedule id); undefined for the global config or an unknown file. */
  name?: string;
  type: 'changed' | 'deleted';
  file: string;
}

export interface ConfigStoreOptions {
  home?: string;
  logger?: Logger;
}

/**
 * YAML configuration on disk (§6A.1): `config.yaml`, `agents/<name>.yaml`, `channels/<name>.yaml`,
 * `schedules/<id>.yaml`. The PWA, the CLI and hand edits all go through the same files.
 */
export class ConfigStore {
  readonly home: string;
  readonly agents: YamlCollection<AgentConfig>;
  readonly channels: YamlCollection<ChannelConfig>;
  readonly schedules: YamlCollection<ScheduleConfig>;
  readonly configFile: string;
  private readonly log: Logger;
  /** Hashes of what we last wrote per file, to suppress watch echoes of our own writes. */
  private readonly written = new Map<string, string | null>();

  constructor(opts: ConfigStoreOptions = {}) {
    this.home = opts.home ?? beamhopHome();
    this.log = opts.logger ?? silentLogger;
    const p = paths(this.home);
    this.configFile = p.config;
    const onWrite = (file: string, content: string | null) =>
      this.written.set(file, content === null ? null : sha(content));
    const isSlug = (k: string) => Slug.safeParse(k).success;
    this.agents = new YamlCollection<AgentConfig>(
      {
        kind: 'agent',
        dir: p.agents,
        schema: AgentConfig,
        keyOf: (a) => a.name,
        validKey: isSlug,
        normalize: normalizeAgent,
      },
      onWrite,
    );
    this.channels = new YamlCollection<ChannelConfig>(
      { kind: 'channel', dir: p.channels, schema: ChannelConfig, keyOf: (c) => c.name, validKey: isSlug },
      onWrite,
    );
    this.schedules = new YamlCollection<ScheduleConfig>(
      {
        kind: 'schedule',
        dir: join(this.home, 'schedules'),
        schema: ScheduleConfig,
        keyOf: (s) => s.id,
        validKey: (k) => SCHEDULE_ID.test(k),
      },
      onWrite,
    );
  }

  /** Global config; missing file → defaults. */
  loadGlobal(): BeamhopConfig {
    if (!existsSync(this.configFile)) return BeamhopConfig.parse({});
    const text = readFileSync(this.configFile, 'utf8');
    let raw: unknown;
    try {
      raw = parse(text) ?? {};
    } catch (err) {
      throw new BeamhopError('invalid_input', `${this.configFile}: invalid YAML: ${(err as Error).message}`);
    }
    const res = BeamhopConfig.safeParse(camelizeKeys(raw));
    if (!res.success)
      throw new BeamhopError('invalid_input', `${this.configFile}: ${formatIssues(res.error)}`, {
        issues: res.error.issues,
      });
    return res.data;
  }

  saveGlobal(input: unknown): BeamhopConfig {
    const res = BeamhopConfig.safeParse(input);
    if (!res.success) throw new BeamhopError('invalid_input', `invalid config: ${formatIssues(res.error)}`);
    mkdirSync(this.home, { recursive: true });
    const content = stringify(res.data, { lineWidth: 0 });
    this.written.set(this.configFile, sha(content));
    writeFileAtomic(this.configFile, content, 0o600);
    return res.data;
  }

  updateGlobal(fn: (c: BeamhopConfig) => unknown): BeamhopConfig {
    return this.saveGlobal(fn(this.loadGlobal()));
  }

  /** Create the directory layout. */
  ensureDirs(): void {
    for (const d of [this.home, this.agents.dir, this.channels.dir, this.schedules.dir])
      mkdirSync(d, { recursive: true });
  }

  /**
   * Watch config files (fs.watch, debounced per file). Our own writes are not reported back.
   * Returns a function that stops watching.
   */
  watch(listener: (change: ConfigChange) => void, opts: { debounceMs?: number } = {}): () => void {
    const debounceMs = opts.debounceMs ?? 100;
    this.ensureDirs();
    const timers = new Map<string, NodeJS.Timeout>();
    const watchers: FSWatcher[] = [];
    let closed = false;

    const fire = (kind: ConfigKind, file: string, name: string | undefined) => {
      if (closed) return;
      if (kind !== 'config' && name === undefined) {
        // Platform gave no file name: tell the listener to rescan this collection.
        listener({ kind, type: 'changed', file });
        return;
      }
      const exists = existsSync(file);
      let hash: string | null = null;
      if (exists) {
        try {
          hash = sha(readFileSync(file, 'utf8'));
        } catch {
          return;
        }
      }
      if (this.written.has(file) && this.written.get(file) === hash) return;
      this.written.delete(file);
      const change: ConfigChange = { kind, type: exists ? 'changed' : 'deleted', file };
      if (name !== undefined) change.name = name;
      try {
        listener(change);
      } catch (err) {
        this.log.error('config watch listener failed', { error: String(err) });
      }
    };

    const schedule = (kind: ConfigKind, file: string, name: string | undefined) => {
      const prev = timers.get(file);
      if (prev) clearTimeout(prev);
      timers.set(
        file,
        setTimeout(() => {
          timers.delete(file);
          fire(kind, file, name);
        }, debounceMs),
      );
    };

    const watchDir = (dir: string, onName: (filename: string | null) => void) => {
      try {
        const w = watch(dir, { persistent: false }, (_event, filename) =>
          onName(filename ? String(filename) : null),
        );
        w.on('error', (err) => this.log.warn('config watcher error', { dir, error: String(err) }));
        watchers.push(w);
      } catch (err) {
        this.log.warn('cannot watch config dir', { dir, error: String(err) });
      }
    };

    watchDir(this.home, (f) => {
      if (f === 'config.yaml') schedule('config', this.configFile, undefined);
    });
    for (const [kind, dir] of [
      ['agent', this.agents.dir],
      ['channel', this.channels.dir],
      ['schedule', this.schedules.dir],
    ] as const) {
      watchDir(dir, (f) => {
        if (f === null) {
          schedule(kind, dir, undefined);
          return;
        }
        const m = /^(.+)\.ya?ml$/.exec(f);
        if (!m || f.startsWith('.') || f.includes('.tmp-')) return;
        schedule(kind, join(dir, f), m[1]);
      });
    }

    return () => {
      closed = true;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      for (const w of watchers) w.close();
    };
  }
}
