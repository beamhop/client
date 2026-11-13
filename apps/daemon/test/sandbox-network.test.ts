/**
 * Sandbox network: the hosts a harness needs must reach the compiled sandbox, the Codex sign-in must run
 * with macOS trustd (without it every TLS call fails silently), and "allow all" is an explicit per-agent mode.
 */
import { type HarnessPlugin, SandboxPolicy } from '@beamhop/core';
import { acpHarnessFromCatalog } from '@beamhop/harness-acp';
import { loadCatalog } from '@beamhop/harness-catalog';
import { claudeHarness } from '@beamhop/harness-claude';
import { codexHarness } from '@beamhop/harness-codex';
import { piHarness } from '@beamhop/harness-pi';
import { compilePolicy, toSrtConfig } from '@beamhop/sandbox';
import { describe, expect, it } from 'vitest';

const catalog = loadCatalog();

describe('catalog hosts reach the sandbox', () => {
  for (const h of catalog.harnesses) {
    const hosts = [
      ...(h.network ?? []),
      ...h.auth.methods.flatMap((m) => (m.kind === 'home' && m.home ? m.home.network : [])),
    ];
    if (hosts.length === 0) continue;
    it(`${h.id}: its own and sign-in hosts are allowed`, () => {
      const policy = compilePolicy('workspace', [], { net: { allow: hosts } });
      const srt = toSrtConfig(policy);
      for (const host of hosts) expect(srt.network.allowedDomains).toContain(host.toLowerCase());
    });
  }
});

describe('harness plugins carry the catalog sandbox fields', () => {
  // The session sandbox reads these from the plugin, not the catalog: a plugin that drops them silently
  // loses its hosts or trustd (Codex's TLS calls then fail with "workspace routing discovery failed").
  const built: Record<string, () => HarnessPlugin> = {
    codex: () => codexHarness(),
    claude: () => claudeHarness(),
    pi: () => piHarness(),
  };
  for (const h of catalog.harnesses) {
    const make = built[h.id] ?? (h.modes.acp ? () => acpHarnessFromCatalog(h) : undefined);
    if (!make) continue;
    it(`${h.id}`, () => {
      const p = make();
      expect(p.macosTrustd ?? false).toBe(h.macosTrustd);
      expect(p.network ?? []).toEqual(h.network);
      expect(p.homeEnv).toBe(h.homeEnv);
    });
  }
});

describe('codex sign-in', () => {
  const codex = catalog.harnesses.find((h) => h.id === 'codex');

  it('runs with macOS trustd, so its TLS calls can verify certificates in the sandbox', () => {
    expect(codex?.macosTrustd).toBe(true);
  });

  it('reaches chatgpt.com and auth.openai.com through its ChatGPT sign-in', () => {
    const chatgpt = codex?.auth.methods.find((m) => m.id === 'chatgpt');
    expect(chatgpt?.kind === 'home' && chatgpt.home?.network).toEqual(['chatgpt.com', 'auth.openai.com']);
  });
});

describe('network mode', () => {
  it('defaults to restricted', () => {
    expect(SandboxPolicy.parse({}).net.mode).toBe('restricted');
    expect(compilePolicy('workspace', []).net.mode).toBe('restricted');
  });

  it('allow all is kept for every profile and does not drop the deny list', () => {
    for (const profile of ['strict', 'workspace'] as const) {
      const p = compilePolicy(profile, [], { net: { mode: 'all', deny: ['evil.example'] } });
      expect(p.net.mode).toBe('all');
      expect(p.net.deny).toContain('evil.example');
    }
  });

  it('a custom profile keeps its own mode', () => {
    const p = compilePolicy('custom', [], { net: { mode: 'all', allow: [] } });
    expect(p.net.mode).toBe('all');
  });
});
