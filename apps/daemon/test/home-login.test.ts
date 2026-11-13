import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SecretStore } from '@beamhop/core';
import { type LoginMethod, LoginMethod as LoginMethodSchema } from '@beamhop/harness-catalog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeBlob, encodeBlob, HomeLoginSync, homeEnv, readHome, writeHome } from '../src/home-login.ts';

const method: LoginMethod = LoginMethodSchema.parse({
  id: 'chatgpt',
  label: 'ChatGPT plan',
  kind: 'home',
  secret: 'CODEX_CHATGPT_LOGIN',
  home: {
    env: 'CODEX_HOME',
    files: ['auth.json'],
    seed: [{ path: 'config.toml', content: 'preferred_auth_method = "chatgpt"\n' }],
    network: ['chatgpt.com'],
  },
  signIn: { args: ['login'] },
});

const memSecrets = () => {
  const m = new Map<string, string>();
  return {
    m,
    store: {
      get: async (k: string) => m.get(k),
      set: async (k: string, v: string) => void m.set(k, v),
      delete: async (k: string) => void m.delete(k),
      list: async () => [...m.keys()].map((name) => ({ name, updatedAt: '' })),
    } as unknown as SecretStore,
  };
};

describe('home logins', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bh-home-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('rejects a home method without home/signIn', () => {
    expect(() => LoginMethodSchema.parse({ id: 'x', label: 'X', kind: 'home', secret: 'X' })).toThrow();
    expect(() =>
      LoginMethodSchema.parse({ ...method, home: { ...method.home, files: ['../escape'] } }),
    ).toThrow();
  });

  it('writes seed + credential files 0600 and reads them back only when complete', () => {
    writeHome(dir, method.home!);
    expect(readFileSync(join(dir, 'config.toml'), 'utf8')).toContain('chatgpt');
    expect(readHome(dir, method.home!)).toBeUndefined();
    writeHome(dir, method.home!, { v: 1, files: { 'auth.json': '{"t":1}', 'other.txt': 'ignored' } });
    expect(readHome(dir, method.home!)).toEqual({ 'auth.json': '{"t":1}' });
    expect(statSync(join(dir, 'auth.json')).mode & 0o777).toBe(0o600);
    expect(homeEnv(dir, method.home!)).toEqual({ CODEX_HOME: dir });
  });

  it('blob round trip; damaged values decode to undefined', () => {
    expect(decodeBlob(encodeBlob({ a: 'b' }))).toEqual({ v: 1, files: { a: 'b' } });
    expect(decodeBlob('not json')).toBeUndefined();
    expect(decodeBlob(undefined)).toBeUndefined();
  });

  it('syncs a refreshed token back to the vault, and never an incomplete set', async () => {
    const { m, store } = memSecrets();
    const blob = { v: 1 as const, files: { 'auth.json': '{"refresh":"r1"}' } };
    m.set(method.secret, encodeBlob(blob.files));
    const sync = await HomeLoginSync.open(store, method, dir, blob);
    await sync.sync();
    expect(m.get(method.secret)).toBe(encodeBlob(blob.files)); // unchanged: nothing written

    writeFileSync(join(dir, 'auth.json'), '{"refresh":"r2"}');
    await sync.sync();
    expect(decodeBlob(m.get(method.secret))?.files['auth.json']).toBe('{"refresh":"r2"}');

    writeFileSync(join(dir, 'auth.json'), '');
    await sync.stop();
    expect(decodeBlob(m.get(method.secret))?.files['auth.json']).toBe('{"refresh":"r2"}');
  });

  it('removes the sign-in copy when the session stops, keeping the rest of the home', async () => {
    const { m, store } = memSecrets();
    const blob = { v: 1 as const, files: { 'auth.json': '{"refresh":"r1"}' } };
    m.set(method.secret, encodeBlob(blob.files));
    const sync = await HomeLoginSync.open(store, method, dir, blob);
    writeFileSync(join(dir, 'history.jsonl'), 'resume me\n');
    writeFileSync(join(dir, 'auth.json'), '{"refresh":"r3"}'); // refreshed during the session
    await sync.stop();
    expect(existsSync(join(dir, 'auth.json'))).toBe(false);
    expect(existsSync(join(dir, 'history.jsonl'))).toBe(true);
    expect(existsSync(join(dir, 'config.toml'))).toBe(true);
    // Saved before it was removed.
    expect(decodeBlob(m.get(method.secret))?.files['auth.json']).toBe('{"refresh":"r3"}');
  });

  it('keeps the copy when the last save failed (it may hold the only refreshed token)', async () => {
    const { m, store } = memSecrets();
    const blob = { v: 1 as const, files: { 'auth.json': '{"refresh":"r1"}' } };
    m.set(method.secret, encodeBlob(blob.files));
    const errors: unknown[] = [];
    const failing = { ...store, set: async () => Promise.reject(new Error('vault locked')) } as SecretStore;
    const sync = await HomeLoginSync.open(failing, method, dir, blob, { onError: (e) => errors.push(e) });
    writeFileSync(join(dir, 'auth.json'), '{"refresh":"r4"}');
    await sync.stop();
    expect(readFileSync(join(dir, 'auth.json'), 'utf8')).toBe('{"refresh":"r4"}');
    expect(errors.length).toBeGreaterThan(0);
  });
});
