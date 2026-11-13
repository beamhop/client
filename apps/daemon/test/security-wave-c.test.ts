// Regression tests for docs/security/REVIEW-wave-c.md: pairing (PAIR-1), owner key export (OWN-1).

import { generateAgentKey } from '@beamhop/channel-nostr';
import type { RpcError } from '@beamhop/client';
import { afterEach, describe, expect, it } from 'vitest';
import { buildRule, ruleMatches } from '../src/rules.ts';
import { makeEnv, type TestEnv } from './helpers.ts';

let env: TestEnv | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});
const code = (e: unknown) => (e as RpcError).beamhopCode ?? (e as { code?: string }).code;

describe('PAIR-1: a cancelled pairing cannot be completed with its code', () => {
  it('cancel before any device answered, then the code is refused and nothing is allowlisted', async () => {
    env = await makeEnv();
    const s = await env.client.call('device.pairStart', { name: 'Phone' });
    const st = await env.client.call('device.pairConfirm', { pairingId: s.pairingId!, accept: false });
    expect(st.status).toBe('rejected');
    const dk = generateAgentKey();
    await expect(
      env.client.call('device.pairComplete', { code: s.code, pubkey: dk.npub, name: 'x' }),
    ).rejects.toSatisfy((e) => code(e) === 'unauthorized');
    expect((await env.client.call('device.list')).devices).toEqual([]);
    expect(env.d.controlAllowlist()).not.toContain(dk.npub);
    expect(env.d.store.audit.query({ type: 'pairing.failed' }).at(-1)?.data.reason).toBe('pairing-rejected');
  });

  it('an uncancelled pairing still works', async () => {
    env = await makeEnv();
    const s = await env.client.call('device.pairStart', { name: 'Phone' });
    const dk = generateAgentKey();
    const dev = await env.client.call('device.pairComplete', { code: s.code, pubkey: dk.npub, name: 'x' });
    expect(dev.pubkey).toBe(dk.npub);
  });
});

describe('OWN-1: owner key export is local-only by allowlist', () => {
  it('refuses any caller that is not the local client, whatever the transport', async () => {
    env = await makeEnv();
    await env.client.call('identity.ownerCreate');
    for (const ctx of [
      { caller: 'nostr:npub1x', transport: 'nostr' as const },
      { caller: 'nostr:npub1x', transport: 'http' as const },
      { caller: 'telegram:1', transport: 'direct' as const },
    ]) {
      const res = await env.d.dispatch({ jsonrpc: '2.0', id: 1, method: 'identity.ownerExport' }, ctx);
      expect('error' in res && res.error.message).toMatch(/only be exported on this computer/);
    }
    // The local client still can, once.
    expect((await env.client.call('identity.ownerExport')).nsec).toMatch(/^nsec1/);
  });
});

describe('RULE-1: command prefix rules cannot be widened into "run anything"', () => {
  const meta = { at: '2026-11-13T10:00:00Z', by: 'local:owner' };
  const bash = (command: string) => ({ tool: 'bash', input: { command }, role: 'user' });
  const refused = (cmd: string, prefix: string) => {
    try {
      buildRule(bash(cmd), `bash:${prefix}`, meta);
      return false;
    } catch (e) {
      return (e as { code?: string }).code === 'invalid_input';
    }
  };

  it('refuses env-assignment, quoted, versioned and .exe interpreter prefixes', () => {
    expect(refused('FOO=1 bash -c id', 'FOO=1')).toBe(true);
    expect(refused('"bash" -c id', '"bash"')).toBe(true);
    expect(refused('python3.12 -c x', 'python3.12')).toBe(true);
    expect(refused('node22 -e x', 'node22')).toBe(true);
    expect(refused('PowerShell.exe -c x', 'PowerShell.exe')).toBe(true);
    expect(refused('npx cowsay', 'npx')).toBe(true);
    expect(refused('sed -n 1e evil.txt', 'sed -n')).toBe(true);
    expect(refused('find . -exec sh {} +', 'find .')).toBe(true);
    expect(refused('git -c alias.x=!sh x', 'git')).toBe(true);
    expect(refused('git -c core.pager=x log', 'git -c')).toBe(true);
    // Ordinary prefixes still work.
    expect(refused('npm test -- --watch', 'npm test')).toBe(false);
    expect(refused('ls -la src', 'ls')).toBe(false);
  });

  it('a prefix rule never matches a request that quotes or groups an argument', () => {
    const rule = buildRule(bash('git log --oneline'), 'bash:git log', meta);
    expect(ruleMatches(rule, bash('git log -5'))).toBe(true);
    expect(ruleMatches(rule, bash("git log '--output=/tmp/x'"))).toBe(false);
    expect(ruleMatches(rule, bash('git log $(id)'))).toBe(false);
    expect(ruleMatches(rule, bash('git log !x'))).toBe(false);
  });
});
