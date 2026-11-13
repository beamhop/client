import { readFile, stat, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  createDeployers,
  DEPLOY_PROVIDERS,
  DEPLOY_STATE_D_TAG,
  defaultStatePath,
  ENCRYPTED_CONTENT_PLACEHOLDER,
  isConfigured,
  mirrorStateEvent,
} from '../src/index.ts';
import { memorySecrets, provisioning, tmpState } from './helpers.ts';

const rec = (id: string) => ({
  id,
  provider: 'hetzner',
  agent: id.split(':')[1]!,
  status: 'running' as const,
  createdAt: '2026-11-13T00:00:00Z',
  resources: { serverId: '1' },
});

describe('DeployState', () => {
  it('upserts, merges resources, lists and removes', async () => {
    const s = await tmpState();
    expect(await s.list()).toEqual([]);
    await s.upsert(rec('hetzner:a'));
    await s.upsert({ ...rec('hetzner:a'), resources: { firewallId: '2' }, status: 'stopped' });
    const a = await s.get('hetzner:a');
    expect(a).toMatchObject({ status: 'stopped', resources: { serverId: '1', firewallId: '2' } });
    expect(a!.updatedAt).toBeTruthy();
    await s.remove('hetzner:a');
    expect(await s.get('hetzner:a')).toBeUndefined();
  });

  it('serializes concurrent writes and stores the file with mode 0600', async () => {
    const s = await tmpState();
    await Promise.all(Array.from({ length: 10 }, (_, i) => s.upsert(rec(`hetzner:a${i}`))));
    expect(await s.list()).toHaveLength(10);
    if (process.platform !== 'win32') expect((await stat(s.file)).mode & 0o777).toBe(0o600);
  });

  it('refuses to persist secret-looking values and rejects unknown formats', async () => {
    const s = await tmpState();
    await expect(
      s.upsert({ ...rec('hetzner:a'), resources: { leaked: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' } }),
    ).rejects.toThrow(/secret/);
    await writeFile(s.file, JSON.stringify({ version: 9 }));
    await expect(s.load()).rejects.toThrow(/unsupported/);
  });

  it('defaults to deployments.json in the beamhop home', () => {
    expect(defaultStatePath('/x/.beamhop').replace(/\\/g, '/')).toBe('/x/.beamhop/deployments.json');
  });
});

describe('mirrorStateEvent', () => {
  it('builds an unsigned kind 30078 template with a placeholder when no encrypt hook is given', async () => {
    const s = await tmpState();
    await s.upsert(rec('hetzner:a'));
    const { event, plaintext } = await mirrorStateEvent(await s.load(), {
      now: () => new Date(1_700_000_000_000),
    });
    expect(event).toEqual({
      kind: 30078,
      created_at: 1_700_000_000,
      tags: [['d', DEPLOY_STATE_D_TAG]],
      content: ENCRYPTED_CONTENT_PLACEHOLDER,
    });
    expect(event).not.toHaveProperty('sig');
    expect(event).not.toHaveProperty('pubkey');
    expect(JSON.parse(plaintext).deployments['hetzner:a'].agent).toBe('a');
    // nothing about the deployment leaks into tags
    expect(JSON.stringify(event.tags)).not.toContain('hetzner');
  });

  it('uses the encrypt hook and rejects a hook that returns plaintext', async () => {
    const st = { version: 1 as const, deployments: {} };
    const { event } = await mirrorStateEvent(st, { encrypt: async (p) => `enc(${p.length})` });
    expect(event.content).toBe('enc(30)');
    await expect(mirrorStateEvent(st, { encrypt: (p) => p })).rejects.toThrow(/plaintext/);
  });
});

describe('createDeployers', () => {
  it('creates all five deployers with kinds, and reports token configuration without values', async () => {
    const secrets = memorySecrets({ 'deploy.fly.token': 'tok' });
    const d = createDeployers({ secrets, provisioning: () => provisioning(), state: await tmpState() });
    expect(Object.keys(d)).toEqual([...DEPLOY_PROVIDERS]);
    expect(Object.values(d).map((x) => [x.id, x.kind])).toEqual([
      ['hetzner', 'vps'],
      ['digitalocean', 'vps'],
      ['fly', 'paas'],
      ['render', 'paas'],
      ['railway', 'paas'],
    ]);
    expect(await isConfigured({ secrets }, 'fly')).toBe(true);
    expect(await isConfigured({ secrets }, 'render')).toBe(false);
  });

  it('rejects a spec for the wrong provider or without harnesses', async () => {
    const d = createDeployers({
      secrets: memorySecrets(),
      provisioning: () => provisioning(),
      state: await tmpState(),
    });
    await expect(
      d.fly.plan({ agent: 'a', provider: 'render', mode: 'new', harnesses: ['claude'] }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      d.fly.plan({ agent: 'a', provider: 'fly', mode: 'new', harnesses: [] }),
    ).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(
      d.fly.plan({ agent: 'A B', provider: 'fly', mode: 'new', harnesses: ['claude'] }),
    ).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('never sends the provider token as part of state', async () => {
    const s = await tmpState();
    await s.upsert(rec('hetzner:a'));
    expect(await readFile(s.file, 'utf8')).not.toMatch(/token/i);
  });
});
