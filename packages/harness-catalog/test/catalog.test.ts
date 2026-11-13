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
      'kimi-code',
      'cline',
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
    const copilot = findHarness(cat, 'copilot')!;
    // Its own API is allowed in the sandbox, its state lives in the session dir, its token stays out of child envs.
    expect(copilot.network).toEqual(['api.githubcopilot.com', '*.githubcopilot.com']);
    expect(copilot.homeEnv).toBe('COPILOT_HOME');
    expect(launchFor(copilot, 'acp')).toMatchObject({
      command: 'copilot',
      args: ['--acp', '--secret-env-vars=COPILOT_GITHUB_TOKEN,GH_TOKEN,GITHUB_TOKEN'],
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

  it('has installers and login flows only from vendor URLs, without guessed checksums', () => {
    const claude = findHarness(cat, 'claude')!;
    expect(claude.install.native?.darwin).toEqual({ kind: 'script', url: 'https://claude.ai/install.sh' });
    expect(claude.auth.loginFlow).toMatchObject({
      args: ['setup-token'],
      kind: 'browser',
      capture: { method: 'claude-subscription' },
    });
    const re = new RegExp(claude.auth.loginFlow!.capture!.pattern);
    expect(re.exec(`token: sk-ant-oat01-${'a'.repeat(40)}\n`)?.[0]).toBe(`sk-ant-oat01-${'a'.repeat(40)}`);
    expect(findHarness(cat, 'auggie')!.auth.loginFlow).toBeUndefined();
    for (const h of cat.harnesses)
      for (const n of Object.values(h.install.native ?? {})) expect(n.url, h.id).toMatch(/^https:\/\//);
  });

  it('offers subscription sign-ins for the harnesses that have them', () => {
    const signIns = Object.fromEntries(
      cat.harnesses.map((h) => [h.id, h.auth.methods.filter((m) => m.kind === 'home').map((m) => m.id)]),
    );
    expect(signIns).toMatchObject({
      codex: ['chatgpt'],
      gemini: ['google-account'],
      cline: ['cline-account', 'chatgpt'],
      'kimi-code': ['kimi-account'],
      auggie: ['augment-account'],
      'cursor-agent': ['cursor-account'],
      pi: ['chatgpt', 'github-copilot', 'kimi'],
      opencode: ['chatgpt', 'github-copilot'],
    });
    for (const h of cat.harnesses)
      for (const m of h.auth.methods.filter((x) => x.kind === 'home')) {
        expect(m.home!.network.length, `${h.id}/${m.id} network`).toBeGreaterThan(0);
        // A sign-in listed first is what `beamhop harness login <id>` runs by default.
        expect(h.auth.methods.indexOf(m), `${h.id}/${m.id}`).toBeLessThan(3);
      }
  });

  it('rejects a login flow that captures into an unknown method, and bad installers', () => {
    const base = JSON.parse(readFileSync(BUNDLED_CATALOG_URL, 'utf8'));
    const claude = base.harnesses.find((h: { id: string }) => h.id === 'claude');
    claude.auth.loginFlow.capture.method = 'nope';
    expect(() => parseCatalog(JSON.stringify(base))).toThrow(/unknown method nope/);
    claude.auth.loginFlow.capture.method = 'claude-subscription';
    claude.install.native.linux = { kind: 'script', url: 'http://claude.ai/install.sh' };
    expect(() => parseCatalog(JSON.stringify(base))).toThrow(/schema/);
    claude.install.native.linux = {
      kind: 'archive',
      url: 'https://x.example/a.tgz',
      sha256: { x64: 'nope' },
      bin: 'a',
    };
    expect(() => parseCatalog(JSON.stringify(base))).toThrow(/schema/);
    claude.install.native.linux = {
      kind: 'archive',
      url: 'https://x.example/a.tgz',
      sha256: { x64: 'a'.repeat(64) },
      bin: '../../bin/sh',
    };
    expect(() => parseCatalog(JSON.stringify(base))).toThrow(/schema/);
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
