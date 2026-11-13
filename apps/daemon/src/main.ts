#!/usr/bin/env node
/** beamhopd: `beamhopd [--port N] [--home DIR] [--host H]` */
import { runDaemon } from './index.ts';

// The desktop app starts this file with its Electron binary in Node mode. Drop the switch so it does
// not leak into harness environments; spawns that need it add it back (nodeExecEnv in @beamhop/core).
delete process.env.ELECTRON_RUN_AS_NODE;

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const port = flag('port');
const home = flag('home');
const host = flag('host');
try {
  await runDaemon({
    ...(port ? { port: Number(port) } : {}),
    ...(home ? { home } : {}),
    ...(host ? { host } : {}),
  });
} catch (e) {
  process.stderr.write(`beamhopd: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
}
