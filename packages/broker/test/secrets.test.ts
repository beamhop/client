import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createSecretStore, FileSecretStore, KeychainSecretStore, MemorySecretStore } from '../src/index.ts';

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
    await expect(wrong.get('k')).rejects.toThrow(/Wrong vault passphrase/);
    await expect(wrong.unlock()).rejects.toThrow(/Wrong vault passphrase/);
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

describe('createSecretStore', () => {
  it('falls back to file when a passphrase is given and the keychain is skipped', async () => {
    const s = await createSecretStore({
      noKeychain: true,
      passphrase: 'pw',
      vaultPath: join(dir, 'v5.json'),
    });
    expect(s.backend).toBe('file');
  });
  it('falls back to memory with a warning', async () => {
    const warnings: string[] = [];
    const log = {
      debug() {},
      info() {},
      warn: (m: string) => warnings.push(m),
      error() {},
      child() {
        return log;
      },
    };
    const prev = process.env.BEAMHOP_VAULT_PASSPHRASE;
    delete process.env.BEAMHOP_VAULT_PASSPHRASE;
    try {
      const s = await createSecretStore({ noKeychain: true, log });
      expect(s.backend).toBe('memory');
      expect(warnings[0]).toMatch(/memory/);
    } finally {
      if (prev !== undefined) process.env.BEAMHOP_VAULT_PASSPHRASE = prev;
    }
  });
});

const keychain = await KeychainSecretStore.tryCreate('beamhop-test');
describe.skipIf(!keychain)(
  `KeychainSecretStore ${keychain ? '' : '— skipped: no usable OS keychain backend (e.g. no libsecret/D-Bus session)'}`,
  () => {
    it('round-trips and maintains the index', async () => {
      const s = keychain!;
      const name = `test-${Date.now()}`;
      await s.set(name, 'kc-value');
      expect(await s.get(name)).toBe('kc-value');
      expect((await s.list()).some((e) => e.name === name)).toBe(true);
      await s.delete(name);
      expect(await s.get(name)).toBeUndefined();
      expect((await s.list()).some((e) => e.name === name)).toBe(false);
    });
  },
);
