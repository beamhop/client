/** One version for the CLI, daemon, desktop app and web UI (semver), as scripts/version.mjs keeps it. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: plain ESM script without types
import { bump, problems } from '../../../scripts/version.mjs';
import { VERSION } from '../src/version.ts';

const pkg = (p: string) =>
  JSON.parse(readFileSync(new URL(`../../../${p}`, import.meta.url), 'utf8')).version;

describe('version', () => {
  it('is the same semver version in every package', () => {
    expect(problems()).toEqual([]);
  });
  it('is what the code reports, and what the CLI and desktop app ship', () => {
    expect(VERSION).toBe(pkg('apps/cli/package.json'));
    expect(VERSION).toBe(pkg('apps/desktop/package.json'));
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
  it('bumps by semver', () => {
    expect(bump('0.2.3', 'patch')).toBe('0.2.4');
    expect(bump('0.2.3', 'minor')).toBe('0.3.0');
    expect(bump('0.2.3', 'major')).toBe('1.0.0');
    expect(() => bump('two', 'patch')).toThrow(/semver/);
  });
});
