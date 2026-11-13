/**
 * beamhop's secret store: ONE encrypted file (`<home>/vault.enc.json`, AES-256-GCM) holds every secret
 * (LLM keys, channel tokens, agent Nostr keys, the database key). Only the key that unlocks it lives
 * elsewhere, and where is the user's choice (`<home>/vault.json` → `keySource`):
 *
 *   file      (default)  `<home>/vault.key`, a random 256-bit key, mode 0600. No prompts, starts unattended.
 *   keychain  (opt-in)   one item in the OS keychain (service "beamhop", account "vault-key:<home>"). macOS asks
 *                        at most once for it, instead of once per secret.
 *   passphrase           BEAMHOP_VAULT_PASSPHRASE (servers / CI), scrypt-derived. Overrides the setting.
 *
 * Switching between `file` and `keychain` moves the key; the vault itself is not re-encrypted.
 * The beamhop home is denied to every sandbox, so agents can read neither the vault nor its key.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type ScryptOptions,
  scrypt as scryptCb,
} from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  BeamhopError,
  beamhopHome,
  type Logger,
  type SecretStore,
  silentLogger,
  type VaultKeySource,
} from '@beamhop/core';

const scrypt = (pw: string, salt: Buffer, keylen: number, opts: ScryptOptions) =>
  new Promise<Buffer>((res, rej) => scryptCb(pw, salt, keylen, opts, (e, k) => (e ? rej(e) : res(k))));

type Entry = { value: string; updatedAt: string };

const validName = (name: string) => {
  if (!/^[A-Za-z0-9_.:@/-]{1,200}$/.test(name)) {
    throw new BeamhopError('invalid_input', `Invalid secret name: ${JSON.stringify(name)}`);
  }
};

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

/** Write a file atomically (tmp + rename) with mode 0600. */
const writeAtomic = async (path: string, data: string) => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, data, { mode: 0o600 });
  await rename(tmp, path);
};

// ───────────────────────────── memory (tests) ─────────────────────────────

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

// ───────────────────────────── encrypted file ─────────────────────────────

type VaultFile =
  | {
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
  | { v: 1; kdf: 'raw'; iv: string; tag: string; ct: string };

const AAD = Buffer.from('beamhop-vault-v1');

export interface FileSecretStoreOptions {
  path?: string;
  /** A random 32-byte key (key file / keychain). */
  key?: Buffer;
  /** Or a passphrase, stretched with scrypt (BEAMHOP_VAULT_PASSPHRASE). */
  passphrase?: string;
  /** Where the key came from, for display. */
  keySource?: VaultKeySource;
  /** scrypt cost (default 2^15). Lower only in tests. */
  scryptN?: number;
}

export const defaultVaultPath = (): string => vaultPaths(beamhopHome()).vault;

/** AES-256-GCM encrypted JSON vault. Atomic writes, mode 0600, fresh IV (and salt) on every write. */
export class FileSecretStore implements SecretStore {
  readonly backend = 'file' as const;
  readonly path: string;
  readonly keySource: VaultKeySource;
  private readonly key?: Buffer;
  private readonly passphrase?: string;
  private readonly N: number;
  private cache?: Map<string, Entry>;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: FileSecretStoreOptions) {
    if (opts.key) {
      if (opts.key.length !== 32) throw new BeamhopError('invalid_input', 'Vault key must be 32 bytes');
      this.key = opts.key;
    } else if (opts.passphrase) this.passphrase = opts.passphrase;
    else throw new BeamhopError('invalid_input', 'Vault passphrase must not be empty');
    this.path = opts.path ?? defaultVaultPath();
    this.keySource = opts.keySource ?? (this.key ? 'file' : 'passphrase');
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
    if (file.v !== 1 || (file.kdf !== 'scrypt' && file.kdf !== 'raw'))
      throw new BeamhopError('internal', 'Unsupported vault format');
    let key: Buffer;
    if (file.kdf === 'raw') {
      if (!this.key)
        throw new BeamhopError('unauthorized', 'This vault is locked with a key, not a passphrase');
      key = this.key;
    } else {
      if (!this.passphrase)
        throw new BeamhopError(
          'unauthorized',
          'This vault is locked with a passphrase (BEAMHOP_VAULT_PASSPHRASE)',
        );
      key = await scrypt(this.passphrase, Buffer.from(file.salt, 'base64'), 32, {
        ...this.params(file.N),
        r: file.r,
        p: file.p,
      });
    }
    let plain: string;
    try {
      const d = createDecipheriv('aes-256-gcm', key, Buffer.from(file.iv, 'base64'));
      d.setAAD(AAD);
      d.setAuthTag(Buffer.from(file.tag, 'base64'));
      plain = Buffer.concat([d.update(Buffer.from(file.ct, 'base64')), d.final()]).toString('utf8');
    } catch {
      throw new BeamhopError(
        'unauthorized',
        'Wrong vault key or passphrase (or the vault was tampered with)',
      );
    }
    const data = JSON.parse(plain) as { secrets: Record<string, Entry> };
    this.cache = new Map(Object.entries(data.secrets));
    return this.cache;
  }

  private async persist(map: Map<string, Entry>) {
    const iv = randomBytes(12);
    const body = JSON.stringify({ secrets: Object.fromEntries(map) });
    const seal = (key: Buffer) => {
      const c = createCipheriv('aes-256-gcm', key, iv);
      c.setAAD(AAD);
      const ct = Buffer.concat([c.update(body, 'utf8'), c.final()]);
      return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') };
    };
    let file: VaultFile;
    if (this.key) file = { v: 1, kdf: 'raw', ...seal(this.key) };
    else {
      const salt = randomBytes(16);
      const key = await scrypt(this.passphrase!, salt, 32, this.params(this.N));
      file = { v: 1, kdf: 'scrypt', N: this.N, r: 8, p: 1, salt: salt.toString('base64'), ...seal(key) };
    }
    await writeAtomic(this.path, JSON.stringify(file));
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  /** Decrypt now (validates the key / passphrase). */
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

// ───────────────────────────── OS keychain: one item ─────────────────────────────

/** A single OS keychain item (the vault key). */
export interface KeychainItem {
  get(): string | undefined;
  set(value: string): void;
  delete(): void;
}

type KeyringModule = {
  Entry: new (
    service: string,
    user: string,
  ) => { getPassword(): string | null; setPassword(p: string): void; deletePassword(): boolean };
};

export const KEYCHAIN_SERVICE = 'beamhop';
/** One item per beamhop home, so two homes (a dev daemon, a test run) never share or overwrite a key. */
export const keychainAccount = (home: string): string => `vault-key:${home}`;

/** The vault-key item via @napi-rs/keyring, or undefined when the module (or a keychain) is unavailable. */
export const osKeychainItem = async (
  account: string,
  service = KEYCHAIN_SERVICE,
): Promise<KeychainItem | undefined> => {
  let mod: KeyringModule;
  try {
    mod = (await import('@napi-rs/keyring')) as unknown as KeyringModule;
  } catch {
    return undefined;
  }
  const entry = () => new mod.Entry(service, account);
  return {
    get: () => {
      try {
        return entry().getPassword() ?? undefined;
      } catch {
        return undefined;
      }
    },
    set: (v) => entry().setPassword(v),
    delete: () => {
      try {
        entry().deletePassword();
      } catch {
        /* not present */
      }
    },
  };
};

// ───────────────────────────── the vault and its key ─────────────────────────────

export const vaultPaths = (home: string) => ({
  vault: join(home, 'vault.enc.json'),
  key: join(home, 'vault.key'),
  settings: join(home, 'vault.json'),
});

export interface VaultOptions {
  home: string;
  log?: Logger;
  /** Default: BEAMHOP_VAULT_PASSPHRASE. When set, it locks the vault and the key source is `passphrase`. */
  passphrase?: string;
  /** The keychain item (tests inject a fake). Default: the OS keychain. */
  keychain?: () => Promise<KeychainItem | undefined>;
  scryptN?: number;
}

const passphraseOf = (o: VaultOptions) => o.passphrase ?? process.env.BEAMHOP_VAULT_PASSPHRASE;

/** Where the vault key is kept (`<home>/vault.json`; default `file`). */
export const readKeySource = (o: VaultOptions): VaultKeySource => {
  if (passphraseOf(o)) return 'passphrase';
  try {
    const s = JSON.parse(readFileSync(vaultPaths(o.home).settings, 'utf8')) as { keySource?: unknown };
    if (s.keySource === 'keychain') return 'keychain';
  } catch {
    /* no settings yet */
  }
  return 'file';
};

const encodeKey = (k: Buffer) => k.toString('base64');
const decodeKey = (s: string, where: string): Buffer => {
  const k = Buffer.from(s.trim(), 'base64');
  if (k.length !== 32) throw new BeamhopError('internal', `The vault key in ${where} is malformed`);
  return k;
};

const keychainOf = async (o: VaultOptions): Promise<KeychainItem> => {
  const kc = await (o.keychain ?? (() => osKeychainItem(keychainAccount(o.home))))();
  if (!kc)
    throw new BeamhopError(
      'unavailable',
      'The system keychain is not available on this computer (on Linux it needs libsecret and a desktop session).',
    );
  return kc;
};

/**
 * Read the vault key from `source`. With `create` (no vault exists yet) a missing key is generated and
 * stored there; otherwise a missing key is an error, since the vault cannot be opened without it.
 */
const loadKey = async (o: VaultOptions, source: 'file' | 'keychain', create: boolean): Promise<Buffer> => {
  const p = vaultPaths(o.home);
  if (source === 'file') {
    if (existsSync(p.key)) return decodeKey(readFileSync(p.key, 'utf8'), p.key);
    if (!create)
      throw new BeamhopError(
        'internal',
        `The vault key file ${p.key} is missing, so ${p.vault} cannot be opened.`,
      );
    const k = randomBytes(32);
    await writeAtomic(p.key, `${encodeKey(k)}\n`);
    return k;
  }
  const kc = await keychainOf(o);
  const stored = kc.get();
  if (stored) return decodeKey(stored, 'the system keychain');
  if (!create)
    throw new BeamhopError(
      'internal',
      `The vault key is not in the system keychain (${KEYCHAIN_SERVICE} / ${keychainAccount(o.home)}), so ${p.vault} cannot be opened.`,
    );
  const k = randomBytes(32);
  kc.set(encodeKey(k));
  return k;
};

/** Open the vault (creating it, and its key, on first use). */
export const openVault = async (o: VaultOptions): Promise<FileSecretStore> => {
  const p = vaultPaths(o.home);
  const passphrase = passphraseOf(o);
  const store = passphrase
    ? new FileSecretStore({ path: p.vault, passphrase, keySource: 'passphrase', scryptN: o.scryptN })
    : await (async () => {
        const source = readKeySource(o) as 'file' | 'keychain';
        const key = await loadKey(o, source, !existsSync(p.vault));
        return new FileSecretStore({ path: p.vault, key, keySource: source });
      })();
  await store.unlock();
  return store;
};

/**
 * Move the vault key to `to` ('file' or 'keychain'): write it there, check it reads back, record the
 * choice, then remove it from the old place. The vault is not re-encrypted. Not available while a
 * passphrase (BEAMHOP_VAULT_PASSPHRASE) locks the vault.
 */
export const setKeySource = async (o: VaultOptions, to: 'file' | 'keychain'): Promise<void> => {
  if (passphraseOf(o))
    throw new BeamhopError(
      'conflict',
      'The vault is locked with BEAMHOP_VAULT_PASSPHRASE; unset it to keep the key in a file or the keychain.',
    );
  const from = readKeySource(o) as 'file' | 'keychain';
  if (from === to) return;
  const p = vaultPaths(o.home);
  const key = await loadKey(o, from, !existsSync(p.vault));
  const encoded = encodeKey(key);
  if (to === 'keychain') {
    const kc = await keychainOf(o);
    kc.set(encoded);
    if (kc.get() !== encoded)
      throw new BeamhopError(
        'internal',
        'The system keychain did not keep the vault key; nothing was changed.',
      );
  } else {
    await writeAtomic(p.key, `${encoded}\n`);
  }
  await writeAtomic(p.settings, `${JSON.stringify({ keySource: to }, null, 2)}\n`);
  if (from === 'file') await rm(p.key, { force: true });
  else (await keychainOf(o)).delete();
};

/** Whether the OS keychain module loads here (the UI offers the switch only then). */
export const keychainAvailable = async (o: Pick<VaultOptions, 'keychain'> = {}): Promise<boolean> =>
  Boolean(await (o.keychain ?? (() => osKeychainItem('probe')))());

// ───────────────────────────── factory ─────────────────────────────

export interface CreateSecretStoreOptions extends Partial<VaultOptions> {
  /** @deprecated the vault lives in `home`; kept for callers that pass a path's directory. */
  vaultPath?: string;
}

/** The daemon's secret store: the encrypted vault in `home` (default: the beamhop home). */
export const createSecretStore = async (opts: CreateSecretStoreOptions = {}): Promise<SecretStore> => {
  const home = opts.home ?? (opts.vaultPath ? dirname(opts.vaultPath) : beamhopHome());
  const store = await openVault({ ...opts, home });
  (opts.log ?? silentLogger).info('secret vault opened', { path: store.path, keySource: store.keySource });
  return store;
};
