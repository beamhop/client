import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type ScryptOptions,
  scrypt as scryptCb,
} from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { BeamhopError, beamhopHome, type Logger, type SecretStore, silentLogger } from '@beamhop/core';

const scrypt = (pw: string, salt: Buffer, keylen: number, opts: ScryptOptions) =>
  new Promise<Buffer>((res, rej) => scryptCb(pw, salt, keylen, opts, (e, k) => (e ? rej(e) : res(k))));

type Entry = { value: string; updatedAt: string };

const validName = (name: string) => {
  if (!/^[A-Za-z0-9_.:@/-]{1,200}$/.test(name)) {
    throw new BeamhopError('invalid_input', `Invalid secret name: ${JSON.stringify(name)}`);
  }
};

// ───────────────────────────── memory ─────────────────────────────

export class MemorySecretStore implements SecretStore {
  readonly backend = 'memory' as const;
  private readonly map = new Map<string, Entry>();
  constructor(initial: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(initial))
      this.map.set(k, { value: v, updatedAt: new Date().toISOString() });
  }
  async get(name: string) {
    return this.map.get(name)?.value;
  }
  async set(name: string, value: string) {
    validName(name);
    this.map.set(name, { value, updatedAt: new Date().toISOString() });
  }
  async delete(name: string) {
    this.map.delete(name);
  }
  async list() {
    return [...this.map.entries()].map(([name, e]) => ({ name, updatedAt: e.updatedAt })).sort(byName);
  }
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

// ───────────────────────────── encrypted file ─────────────────────────────

interface VaultFile {
  v: 1;
  kdf: 'scrypt';
  N: number;
  r: number;
  p: number;
  salt: string;
  iv: string;
  tag: string;
  ct: string;
}

export interface FileSecretStoreOptions {
  path?: string;
  passphrase: string;
  /** scrypt cost (default 2^15). Lower only in tests. */
  scryptN?: number;
}

export const defaultVaultPath = (): string => join(beamhopHome(), 'vault.enc.json');

/**
 * AES-256-GCM encrypted JSON vault with a scrypt-derived key (headless Linux, §8).
 * Writes are atomic (tmp + rename) and mode 0600. A fresh salt + IV is used on every write.
 */
export class FileSecretStore implements SecretStore {
  readonly backend = 'file' as const;
  readonly path: string;
  private readonly passphrase: string;
  private readonly N: number;
  private cache?: Map<string, Entry>;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: FileSecretStoreOptions) {
    if (!opts.passphrase) throw new BeamhopError('invalid_input', 'Vault passphrase must not be empty');
    this.path = opts.path ?? defaultVaultPath();
    this.passphrase = opts.passphrase;
    this.N = opts.scryptN ?? 2 ** 15;
  }

  private params(N: number) {
    return { N, r: 8, p: 1, maxmem: 256 * N * 8 + 1024 * 1024 };
  }

  private async load(): Promise<Map<string, Entry>> {
    if (this.cache) return this.cache;
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        this.cache = new Map();
        return this.cache;
      }
      throw e;
    }
    let file: VaultFile;
    try {
      file = JSON.parse(raw) as VaultFile;
    } catch {
      throw new BeamhopError('internal', `Vault file ${this.path} is corrupt`);
    }
    if (file.v !== 1 || file.kdf !== 'scrypt') throw new BeamhopError('internal', 'Unsupported vault format');
    const key = await scrypt(this.passphrase, Buffer.from(file.salt, 'base64'), 32, {
      ...this.params(file.N),
      r: file.r,
      p: file.p,
    });
    let plain: string;
    try {
      const d = createDecipheriv('aes-256-gcm', key, Buffer.from(file.iv, 'base64'));
      d.setAAD(Buffer.from('beamhop-vault-v1'));
      d.setAuthTag(Buffer.from(file.tag, 'base64'));
      plain = Buffer.concat([d.update(Buffer.from(file.ct, 'base64')), d.final()]).toString('utf8');
    } catch {
      throw new BeamhopError('unauthorized', 'Wrong vault passphrase (or the vault was tampered with)');
    }
    const data = JSON.parse(plain) as { secrets: Record<string, Entry> };
    this.cache = new Map(Object.entries(data.secrets));
    return this.cache;
  }

  private async persist(map: Map<string, Entry>) {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = await scrypt(this.passphrase, salt, 32, this.params(this.N));
    const c = createCipheriv('aes-256-gcm', key, iv);
    c.setAAD(Buffer.from('beamhop-vault-v1'));
    const ct = Buffer.concat([
      c.update(JSON.stringify({ secrets: Object.fromEntries(map) }), 'utf8'),
      c.final(),
    ]);
    const file: VaultFile = {
      v: 1,
      kdf: 'scrypt',
      N: this.N,
      r: 8,
      p: 1,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: c.getAuthTag().toString('base64'),
      ct: ct.toString('base64'),
    };
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify(file), { mode: 0o600 });
    await rename(tmp, this.path);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  /** Decrypt now (validates the passphrase). */
  async unlock(): Promise<void> {
    await this.serial(() => this.load());
  }

  get(name: string) {
    return this.serial(async () => (await this.load()).get(name)?.value);
  }
  set(name: string, value: string) {
    validName(name);
    return this.serial(async () => {
      const map = new Map(await this.load());
      map.set(name, { value, updatedAt: new Date().toISOString() });
      await this.persist(map);
      this.cache = map;
    });
  }
  delete(name: string) {
    return this.serial(async () => {
      const map = new Map(await this.load());
      if (!map.delete(name)) return;
      await this.persist(map);
      this.cache = map;
    });
  }
  list() {
    return this.serial(async () =>
      [...(await this.load()).entries()].map(([name, e]) => ({ name, updatedAt: e.updatedAt })).sort(byName),
    );
  }
}

// ───────────────────────────── OS keychain ─────────────────────────────

interface KeyringEntry {
  getPassword(): string | null;
  setPassword(p: string): void;
  deletePassword(): boolean;
}
type KeyringModule = { Entry: new (service: string, user: string) => KeyringEntry };

const INDEX_KEY = '__beamhop_index__';

/**
 * OS keychain via @napi-rs/keyring (macOS Keychain, Windows Credential Manager, libsecret).
 * The keyring has no portable "list", so names + timestamps are kept in an index entry.
 */
export class KeychainSecretStore implements SecretStore {
  readonly backend = 'keychain' as const;
  private constructor(
    private readonly mod: KeyringModule,
    readonly service: string,
  ) {}

  static async load(service = 'beamhop'): Promise<KeychainSecretStore> {
    const mod = (await import('@napi-rs/keyring')) as unknown as KeyringModule;
    return new KeychainSecretStore(mod, service);
  }

  /** Returns a store only when the keychain backend actually works (round-trip probe). */
  static async tryCreate(service = 'beamhop'): Promise<KeychainSecretStore | undefined> {
    try {
      const store = await KeychainSecretStore.load(service);
      const probe = new store.mod.Entry(service, `__probe__${randomBytes(4).toString('hex')}`);
      probe.setPassword('ok');
      const ok = probe.getPassword() === 'ok';
      probe.deletePassword();
      return ok ? store : undefined;
    } catch {
      return undefined;
    }
  }

  private entry(name: string) {
    return new this.mod.Entry(this.service, name);
  }
  private readIndex(): Record<string, string> {
    try {
      const raw = this.entry(INDEX_KEY).getPassword();
      return raw ? (JSON.parse(raw) as Record<string, string>) : {};
    } catch {
      return {};
    }
  }
  private writeIndex(idx: Record<string, string>) {
    this.entry(INDEX_KEY).setPassword(JSON.stringify(idx));
  }

  async get(name: string) {
    if (name === INDEX_KEY) return undefined;
    try {
      return this.entry(name).getPassword() ?? undefined;
    } catch {
      return undefined;
    }
  }
  async set(name: string, value: string) {
    validName(name);
    if (name === INDEX_KEY) throw new BeamhopError('invalid_input', 'Reserved secret name');
    this.entry(name).setPassword(value);
    const idx = this.readIndex();
    idx[name] = new Date().toISOString();
    this.writeIndex(idx);
  }
  async delete(name: string) {
    try {
      this.entry(name).deletePassword();
    } catch {
      /* not present */
    }
    const idx = this.readIndex();
    if (name in idx) {
      delete idx[name];
      this.writeIndex(idx);
    }
  }
  async list() {
    return Object.entries(this.readIndex())
      .map(([name, updatedAt]) => ({ name, updatedAt }))
      .sort(byName);
  }
}

// ───────────────────────────── factory ─────────────────────────────

export interface CreateSecretStoreOptions {
  log?: Logger;
  /** Default: BEAMHOP_VAULT_PASSPHRASE. */
  passphrase?: string;
  vaultPath?: string;
  service?: string;
  /** Skip the keychain (e.g. headless servers). Default: BEAMHOP_NO_KEYCHAIN=1. */
  noKeychain?: boolean;
}

/** Keychain when usable, else encrypted file (passphrase from env), else memory with a warning. */
export const createSecretStore = async (opts: CreateSecretStoreOptions = {}): Promise<SecretStore> => {
  const log = opts.log ?? silentLogger;
  if (!(opts.noKeychain ?? process.env.BEAMHOP_NO_KEYCHAIN === '1')) {
    const kc = await KeychainSecretStore.tryCreate(opts.service);
    if (kc) return kc;
  }
  const passphrase = opts.passphrase ?? process.env.BEAMHOP_VAULT_PASSPHRASE;
  if (passphrase) {
    const store = new FileSecretStore({ passphrase, ...(opts.vaultPath ? { path: opts.vaultPath } : {}) });
    await store.unlock();
    return store;
  }
  log.warn(
    'No OS keychain and no BEAMHOP_VAULT_PASSPHRASE: secrets are kept in memory only and lost on restart.',
  );
  return new MemorySecretStore();
};
