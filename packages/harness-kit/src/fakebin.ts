import { chmodSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Absolute path of the bundled fake ACP agent script (tests only). */
export const FAKE_ACP_AGENT = fileURLToPath(new URL('../fixtures/fake-acp-agent.mjs', import.meta.url));

/** Write a fake ACP agent executable named `name` into `dir`. */
export const writeFakeAcpAgent = (dir: string, name: string): string =>
  writeFakeBin(dir, name, `await import(${JSON.stringify(pathToFileURL(FAKE_ACP_AGENT).href)});\n`);

/**
 * Test helper: write an executable named `name` into `dir` that runs `source` (an ES module)
 * with the current Node binary. On Windows a `name.cmd` shim is written instead.
 * Returns the path of the executable to spawn.
 */
export const writeFakeBin = (dir: string, name: string, source: string): string => {
  const script = path.join(dir, `${name}.fake.mjs`);
  writeFileSync(script, source);
  if (process.platform === 'win32') {
    const shim = path.join(dir, `${name}.cmd`);
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" "%~dp0\\${name}.fake.mjs" %*\r\n`);
    return shim;
  }
  const bin = path.join(dir, name);
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
};
