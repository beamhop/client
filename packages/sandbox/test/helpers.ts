import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SandboxHandle } from '@beamhop/core';

export const hasBwrap = (() => {
  if (process.platform !== 'linux') return false;
  return spawnSync('which', ['bwrap'], { stdio: 'ignore' }).status === 0;
})();

export const NO_BWRAP_REASON = 'bubblewrap (bwrap) is not installed; real sandbox tests need it';

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export const runIn = async (
  sbx: SandboxHandle,
  cmd: string,
  args: string[],
  cwd?: string,
): Promise<RunResult> => {
  const w = await sbx.wrap(cmd, args);
  return new Promise((resolve, reject) => {
    const child = spawn(w.cmd, w.args, { env: w.env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
};

/** A temp HOME with a fake ssh key, an rw workspace and a dir outside any mount. */
export const makeFixture = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bh-sbx-test-')));
  const home = join(root, 'home');
  const ws = join(root, 'ws');
  const outside = join(root, 'outside');
  const ro = join(root, 'ro');
  for (const d of [join(home, '.ssh'), ws, outside, ro]) mkdirSync(d, { recursive: true });
  writeFileSync(join(home, '.ssh', 'id_x'), 'FAKE-PRIVATE-KEY\n');
  writeFileSync(join(ro, 'readme.txt'), 'read only\n');
  return { root, home, ws, outside, ro };
};
