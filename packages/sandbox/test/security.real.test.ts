// Regression tests for docs/security/REVIEW-wave-a.md (real srt + bubblewrap, Linux only).
import { spawn, spawnSync } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BeamhopSandbox, compilePolicy, createSandbox } from '../src/index.ts';
import { hasBwrap, makeFixture, NO_BWRAP_REASON, runIn } from './helpers.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pgrep = (pattern: string) => spawnSync('pgrep', ['-f', pattern]).stdout.toString().trim();

describe.skipIf(!hasBwrap)(
  `sandbox security regressions ${hasBwrap ? '' : `— skipped: ${NO_BWRAP_REASON}`}`,
  () => {
    const fx = makeFixture();
    const sourceEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
    const policy = compilePolicy('workspace', [{ path: fx.ws, mode: 'rw' }], {}, { home: fx.home });
    let sbx: BeamhopSandbox;

    beforeAll(async () => {
      sbx = await createSandbox(policy, { backend: 'srt', sourceEnv, home: fx.home, tmpDir: fx.root });
    });
    afterAll(async () => {
      await sbx?.close();
      rmSync(fx.root, { recursive: true, force: true });
    });

    it('SBX-1: a hard kill of the runner also kills every process in the sandbox', async () => {
      const marker = `9${Date.now() % 1_000_000}7`;
      // The payload ignores SIGTERM and leaves a setsid'd grandchild behind.
      const w = await sbx.wrap('sh', ['-c', `trap "" TERM; (setsid sleep ${marker} &); sleep ${marker}`]);
      const child = spawn(w.cmd, w.args, { env: w.env, stdio: 'ignore' });
      try {
        for (let i = 0; i < 50 && !pgrep(`^sleep ${marker}$`); i++) await sleep(100);
        expect(pgrep(`^sleep ${marker}$`)).not.toBe('');
        child.kill('SIGKILL'); // e.g. the daemon crashed or `panic` hard-killed the session
        for (let i = 0; i < 30 && pgrep(`sleep ${marker}`); i++) await sleep(100);
        expect(pgrep(`sleep ${marker}`)).toBe('');
      } finally {
        spawnSync('pkill', ['-KILL', '-f', `sleep ${marker}`]);
      }
    }, 20_000);

    it('SBX-2: the per-sandbox runner dir (config + violation socket) is not readable inside', async () => {
      const dir = readdirSync(fx.root).find((d) => d.startsWith('bh-sbx-'));
      expect(dir).toBeDefined();
      const abs = join(fx.root, dir ?? '');
      await sbx.wrap('true', []); // writes a cfg file
      const r = await runIn(sbx, 'sh', ['-c', `ls ${abs}; cat ${abs}/cfg-*.json`]);
      expect(r.stdout).not.toContain('cfg-');
      expect(r.stdout).not.toContain('allowedDomains');
    });

    it('SBX-3: allow-listing "localhost" does not open arbitrary host loopback ports', () => {
      const p = compilePolicy(
        'custom',
        [],
        { net: { allow: ['localhost', '*.localhost', '127.0.0.1', '[::1]', '0.0.0.0', 'example.com'] } },
        { home: fx.home },
      );
      expect(p.net.allow).toEqual(['example.com']);
    });
  },
);
