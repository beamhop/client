import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BUNDLED_CATALOG_URL,
  findHarness,
  generateCatalogKeyPair,
  launchFor,
  loadCatalog,
  parseCatalog,
  parseVersion,
  satisfies,
  signCatalog,
  verifyCatalog,
} from '../src/index.ts';

describe('bundled catalog', () => {
  const cat = loadCatalog();

  it('validates and contains the core harnesses', () => {
    const ids = cat.harnesses.map((h) => h.id);
    for (const id of [
      'claude',
      'codex',
      'copilot',
      'gemini',
      'opencode',
      'pi',
      'cursor-agent',
      'goose',
      'qwen-code',
      'auggie',
    ]) {
      expect(ids).toContain(id);
    }
  });

  it('has launch modes for each protocol', () => {
    expect(launchFor(findHarness(cat, 'gemini')!, 'acp')).toMatchObject({
      command: 'gemini',
      args: ['--acp'],
    });
    expect(launchFor(findHarness(cat, 'copilot')!, 'acp')).toMatchObject({
      command: 'copilot',
      args: ['--acp'],
    });
    expect(launchFor(findHarness(cat, 'opencode')!, 'acp')).toMatchObject({
      command: 'opencode',
      args: ['acp'],
    });
    expect(launchFor(findHarness(cat, 'codex')!, 'appServer')?.args).toEqual(['app-server']);
    expect(launchFor(findHarness(cat, 'pi')!, 'rpc')?.args).toEqual(['--mode', 'rpc']);
    expect(launchFor(findHarness(cat, 'claude')!, 'acp')?.npm).toBe('@agentclientprotocol/claude-agent-acp');
    expect(launchFor(findHarness(cat, 'claude')!, 'appServer')).toBeUndefined();
    for (const h of cat.harnesses) {
      const hasMode = Object.values(h.modes).some(Boolean);
      expect(hasMode, h.id).toBe(true);
    }
  });

  it('every ACP-protocol entry has an acp mode', () => {
    for (const h of cat.harnesses.filter((x) => x.protocol === 'acp'))
      expect(h.modes.acp, h.id).toBeDefined();
  });
});

describe('parseCatalog', () => {
  it('rejects malformed JSON and schema errors', () => {
    expect(() => parseCatalog('{')).toThrow(/not valid JSON/);
    expect(() => parseCatalog(JSON.stringify({ schema: 2, revision: '2026.01.01', harnesses: [] }))).toThrow(
      /schema/,
    );
    expect(() =>
      parseCatalog(
        JSON.stringify({
          schema: 1,
          revision: '2026.01.01',
          harnesses: [{ id: 'Bad Id', displayName: 'x', protocol: 'acp', binaries: ['x'] }],
        }),
      ),
    ).toThrow(/schema/);
  });

  it('rejects duplicate ids', () => {
    const h = { id: 'x', displayName: 'X', protocol: 'acp', binaries: ['x'] };
    expect(() =>
      parseCatalog(JSON.stringify({ schema: 1, revision: '2026.01.01', harnesses: [h, h] })),
    ).toThrow(/duplicate/);
  });
});

describe('signatures', () => {
  const raw = readFileSync(BUNDLED_CATALOG_URL, 'utf8');
  const kp = generateCatalogKeyPair();

  it('round-trips with raw and PEM keys', () => {
    const sig = signCatalog(raw, kp.privateKey);
    expect(verifyCatalog(raw, sig, kp.publicKeyRaw)).toBe(true);
    expect(verifyCatalog(raw, sig, kp.publicKey.export({ format: 'pem', type: 'spki' }).toString())).toBe(
      true,
    );
    expect(verifyCatalog(raw, sig, kp.publicKey)).toBe(true);
    expect(verifyCatalog(raw, sig, Buffer.from(kp.publicKeyRaw, 'base64').toString('hex'))).toBe(true);
  });

  it('rejects tampering, wrong keys and garbage', () => {
    const sig = signCatalog(raw, kp.privateKey);
    expect(verifyCatalog(`${raw} `, sig, kp.publicKeyRaw)).toBe(false);
    expect(verifyCatalog(raw, sig, generateCatalogKeyPair().publicKeyRaw)).toBe(false);
    expect(verifyCatalog(raw, 'not-a-sig', kp.publicKeyRaw)).toBe(false);
    expect(verifyCatalog(raw, sig, 'short')).toBe(false);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey;
    expect(verifyCatalog(raw, sig, rsa)).toBe(false);
    // any matching key in a list is accepted
    expect(verifyCatalog(raw, sig, [generateCatalogKeyPair().publicKeyRaw, kp.publicKeyRaw])).toBe(true);
  });

  it('loadCatalog requires a valid signature for external catalogs', () => {
    const sig = signCatalog(raw, kp.privateKey);
    expect(loadCatalog({ json: raw, sig, pubkeys: [kp.publicKeyRaw] }).harnesses.length).toBeGreaterThan(5);
    expect(() => loadCatalog({ json: raw, pubkeys: [kp.publicKeyRaw] })).toThrow(/signature/);
    expect(() => loadCatalog({ json: raw, sig })).toThrow(/signature/); // no trusted keys configured
    const tampered = raw.replace('"--acp"', '"--yolo"');
    expect(() => loadCatalog({ json: tampered, sig, pubkeys: [kp.publicKeyRaw] })).toThrow(/signature/);
  });

  it('rejects rollbacks', () => {
    const sig = signCatalog(raw, kp.privateKey);
    expect(() =>
      loadCatalog({ json: raw, sig, pubkeys: [kp.publicKeyRaw], minRevision: '2099.01.01' }),
    ).toThrow(/older/);
  });
});

describe('semver', () => {
  it('parses messy version output', () => {
    expect(parseVersion('codex-cli 0.167.2')).toEqual([0, 167, 2]);
    expect(parseVersion('2.1.3 (Claude Code)')).toEqual([2, 1, 3]);
    expect(parseVersion('v1.2')).toEqual([1, 2, 0]);
    expect(parseVersion('nope')).toBeUndefined();
  });
  it('checks ranges', () => {
    expect(satisfies('1.2.3', '>=1.0.0 <2.0.0')).toBe(true);
    expect(satisfies('2.0.0', '>=1.0.0 <2.0.0')).toBe(false);
    expect(satisfies('0.9.0', '>=1.0.0 || =0.9.0')).toBe(true);
    expect(satisfies('1.0.0', undefined)).toBe(true);
    expect(satisfies('garbage', '>=1.0.0')).toBe(false);
    expect(satisfies('1.0.0', '>1.0.0')).toBe(false);
    expect(satisfies('1.0.0', '<=1.0.0')).toBe(true);
  });
});
