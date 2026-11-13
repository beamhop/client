import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createSecretStore,
  FileSecretStore,
  type KeychainItem,
  keychainAvailable,
  MemorySecretStore,
  openVault,
  readKeySource,
  setKeySource,
  vaultPaths,
} from '../src/index.ts';

const dir = mkdtempSync(join(tmpdir(), 'bh-vault-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const N = 2 ** 10; // fast scrypt for tests

describe('MemorySecretStore', () => {
  it('get/set/delete/list', async () => {
    const s = new MemorySecretStore({ A: '1' });
    await s.set('B', '2');
    expect(await s.get('A')).toBe('1');
    expect((await s.list()).map((e) => e.name)).toEqual(['A', 'B']);
    await s.delete('A');
    expect(await s.get('A')).toBeUndefined();
    expect(s.backend).toBe('memory');
    await expect(s.set('bad name', 'x')).rejects.toThrow(/Invalid secret name/);
  });
});

describe('FileSecretStore', () => {
  it('round-trips through an encrypted file', async () => {
    const path = join(dir, 'v1.json');
    const a = new FileSecretStore({ path, passphrase: 'correct horse', scryptN: N });
    await a.set('OPENROUTER_API_KEY', 'sk-or-v1-supersecretvalue');
    await a.set('other', 'x');
    await a.delete('other');

    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain('supersecretvalue');
    expect(raw).not.toContain('OPENROUTER_API_KEY');
    expect(JSON.parse(raw)).toMatchObject({ v: 1, kdf: 'scrypt' });
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);

    const b = new FileSecretStore({ path, passphrase: 'correct horse' });
    expect(await b.get('OPENROUTER_API_KEY')).toBe('sk-or-v1-supersecretvalue');
    const list = await b.list();
    expect(list.map((e) => e.name)).toEqual(['OPENROUTER_API_KEY']);
    expect(list[0]!.updatedAt).toMatch(/^\d{4}-/);
    expect(b.backend).toBe('file');
  });

  it('rejects a wrong passphrase', async () => {
    const path = join(dir, 'v2.json');
    await new FileSecretStore({ path, passphrase: 'right', scryptN: N }).set('k', 'v');
    const wrong = new FileSecretStore({ path, passphrase: 'wrong' });
    await expect(wrong.get('k')).rejects.toThrow(/Wrong vault/);
    await expect(wrong.unlock()).rejects.toThrow(/Wrong vault/);
  });

  it('detects tampering', async () => {
    const path = join(dir, 'v3.json');
    await new FileSecretStore({ path, passphrase: 'pw', scryptN: N }).set('k', 'value-value');
    const f = JSON.parse(readFileSync(path, 'utf8'));
    const ct = Buffer.from(f.ct, 'base64');
    ct[0] = (ct[0] ?? 0) ^ 0xff;
    f.ct = ct.toString('base64');
    writeFileSync(path, JSON.stringify(f));
    await expect(new FileSecretStore({ path, passphrase: 'pw' }).get('k')).rejects.toThrow(
      /passphrase|tampered/,
    );
  });

  it('missing file = empty vault; concurrent writes serialize', async () => {
    const path = join(dir, 'sub', 'v4.json');
    const s = new FileSecretStore({ path, passphrase: 'pw', scryptN: N });
    expect(await s.list()).toEqual([]);
    await Promise.all(Array.from({ length: 5 }, (_, i) => s.set(`k${i}`, `v${i}`)));
    const fresh = new FileSecretStore({ path, passphrase: 'pw' });
    expect((await fresh.list()).length).toBe(5);
  });

  it('refuses an empty passphrase', () => {
    expect(() => new FileSecretStore({ path: join(dir, 'x'), passphrase: '' })).toThrow();
  });
});

/** An in-memory stand-in for the one OS keychain item (tests never touch the real keychain). */
const fakeKeychain = () => {
  let value: string | undefined;
  const item: KeychainItem & { reads: number } = {
    reads: 0,
    get: () => {
      item.reads++;
      return value;
    },
    set: (v) => {
      value = v;
    },
    delete: () => {
      value = undefined;
    },
  };
  return item;
};

describe('the vault and its key', () => {
  const freshHome = () => mkdtempSync(join(dir, 'home-'));
  const noPass = { passphrase: '' };

  it('default: a random key in vault.key (0600) unlocks vault.enc.json; no keychain involved', async () => {
    const home = freshHome();
    const kc = fakeKeychain();
    const a = await openVault({ home, ...noPass, keychain: async () => kc });
    expect(a.keySource).toBe('file');
    await a.set('TELEGRAM_TOKEN', '123:AAsupersecret');
    const p = vaultPaths(home);
    expect(readFileSync(p.vault, 'utf8')).not.toContain('supersecret');
    expect(JSON.parse(readFileSync(p.vault, 'utf8'))).toMatchObject({ v: 1, kdf: 'raw' });
    expect(Buffer.from(readFileSync(p.key, 'utf8').trim(), 'base64')).toHaveLength(32);
    if (process.platform !== 'win32') expect(statSync(p.key).mode & 0o777).toBe(0o600);
    expect(kc.reads).toBe(0);
    const b = await openVault({ home, ...noPass, keychain: async () => kc });
    expect(await b.get('TELEGRAM_TOKEN')).toBe('123:AAsupersecret');
  });

  it('opt into the keychain: the key moves to one keychain item, vault.key is removed, secrets stay readable', async () => {
    const home = freshHome();
    const kc = fakeKeychain();
    const o = { home, ...noPass, keychain: async () => kc };
    await (await openVault(o)).set('A', '1');
    await setKeySource(o, 'keychain');
    expect(readKeySource(o)).toBe('keychain');
    expect(existsSync(vaultPaths(home).key)).toBe(false);
    expect(kc.get()).toBeTruthy();
    const v = await openVault(o);
    expect(v.keySource).toBe('keychain');
    expect(await v.get('A')).toBe('1');
    // ...and back to the file.
    await setKeySource(o, 'file');
    expect(kc.get()).toBeUndefined();
    expect(existsSync(vaultPaths(home).key)).toBe(true);
    expect(await (await openVault(o)).get('A')).toBe('1');
  });

  it('opening a keychain-locked vault reads the keychain once, however many secrets it holds', async () => {
    const home = freshHome();
    const kc = fakeKeychain();
    const o = { home, ...noPass, keychain: async () => kc };
    await setKeySource(o, 'keychain');
    const v = await openVault(o);
    for (let i = 0; i < 10; i++) await v.set(`S${i}`, `v${i}`);
    kc.reads = 0;
    const again = await openVault(o);
    for (let i = 0; i < 10; i++) expect(await again.get(`S${i}`)).toBe(`v${i}`);
    expect(kc.reads).toBe(1);
  });

  it('refuses to open (and never re-keys) a vault whose key is gone', async () => {
    const home = freshHome();
    const o = { home, ...noPass, keychain: async () => fakeKeychain() };
    await (await openVault(o)).set('A', '1');
    rmSync(vaultPaths(home).key);
    await expect(openVault(o)).rejects.toThrow(/vault key file .* is missing/);
  });

  it('keychain unavailable: switching fails and nothing changes', async () => {
    const home = freshHome();
    const o = { home, ...noPass, keychain: async () => undefined };
    await (await openVault(o)).set('A', '1');
    await expect(setKeySource(o, 'keychain')).rejects.toThrow(/not available/);
    expect(readKeySource(o)).toBe('file');
    expect(await (await openVault(o)).get('A')).toBe('1');
    expect(await keychainAvailable(o)).toBe(false);
  });

  it('a keychain that does not keep the key: switching fails and the key file stays', async () => {
    const home = freshHome();
    const broken: KeychainItem = { get: () => undefined, set: () => {}, delete: () => {} };
    const o = { home, ...noPass, keychain: async () => broken };
    await (await openVault(o)).set('A', '1');
    await expect(setKeySource(o, 'keychain')).rejects.toThrow(/did not keep the vault key/);
    expect(existsSync(vaultPaths(home).key)).toBe(true);
    expect(readKeySource(o)).toBe('file');
  });

  it('BEAMHOP_VAULT_PASSPHRASE locks the vault with scrypt and blocks switching', async () => {
    const home = freshHome();
    const o = { home, passphrase: 'correct horse', scryptN: N };
    const v = await openVault(o);
    expect(v.keySource).toBe('passphrase');
    await v.set('A', '1');
    expect(JSON.parse(readFileSync(vaultPaths(home).vault, 'utf8')).kdf).toBe('scrypt');
    expect(existsSync(vaultPaths(home).key)).toBe(false);
    await expect(setKeySource(o, 'keychain')).rejects.toThrow(/BEAMHOP_VAULT_PASSPHRASE/);
  });

  it('createSecretStore opens the vault in the given home', async () => {
    const home = freshHome();
    const s = await createSecretStore({ home, ...noPass, keychain: async () => undefined });
    expect(s.backend).toBe('file');
    expect(s.keySource).toBe('file');
  });
});
