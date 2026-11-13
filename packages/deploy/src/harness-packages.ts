import { BeamhopError } from '@beamhop/core';
import { assertNpmSpec } from './validate.ts';

/**
 * npm packages that provide each harness CLI on a cloud host. The harness catalog (§3.1) may
 * override this via `harnessPackages`; this table is the built-in fallback.
 */
export const HARNESS_NPM_PACKAGES: Record<string, string[]> = {
  claude: ['@anthropic-ai/claude-code'],
  'claude-code': ['@anthropic-ai/claude-code'],
  codex: ['@openai/codex'],
  gemini: ['@google/gemini-cli'],
  'gemini-cli': ['@google/gemini-cli'],
  copilot: ['@github/copilot'],
  opencode: ['opencode-ai'],
  pi: ['@earendil-works/pi-coding-agent'],
};

/** Resolve harness ids to validated npm specs (deduplicated, order preserved). */
export const resolveHarnessPackages = (
  harnesses: string[],
  overrides: Record<string, string[]> = {},
): string[] => {
  const out: string[] = [];
  for (const h of harnesses) {
    const pkgs = overrides[h] ?? HARNESS_NPM_PACKAGES[h];
    if (!pkgs) {
      throw new BeamhopError(
        'invalid_input',
        `unknown harness "${h}" for cloud install; pass harnessPackages to map it to npm packages`,
      );
    }
    for (const p of pkgs) {
      assertNpmSpec(p);
      if (!out.includes(p)) out.push(p);
    }
  }
  return out;
};
