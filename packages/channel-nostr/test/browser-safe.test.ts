// The control client must stay importable in the PWA: no node-only imports in its module graph.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

const graph = (entry: string, seen = new Set<string>()): { files: Set<string>; bare: Set<string> } => {
  const bare = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const code = readFileSync(file, 'utf8');
    for (const m of code.matchAll(/^\s*(import|export)\s+(type\s+)?[^'"]*?from\s+['"]([^'"]+)['"]/gm)) {
      const isType = !!m[2];
      const spec = m[3]!;
      if (spec.startsWith('.')) walk(resolve(dirname(file), spec));
      else if (!isType) bare.add(spec);
    }
  };
  walk(entry);
  return { files: seen, bare };
};

describe('browser compatibility', () => {
  it('control client has no node-only runtime imports', () => {
    const { files, bare } = graph(join(src, 'control-client.ts'));
    expect(files.size).toBeGreaterThan(2);
    for (const spec of bare) {
      expect(spec.startsWith('node:'), spec).toBe(false);
      expect(['ws', 'https-proxy-agent'].includes(spec), spec).toBe(false);
      // @beamhop/core pulls node:os/node:path at runtime; only type imports are allowed.
      expect(spec, spec).not.toBe('@beamhop/core');
      expect(spec.startsWith('nostr-tools/'), spec).toBe(true);
    }
  });
});
