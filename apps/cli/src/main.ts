#!/usr/bin/env node
import { CommanderError } from 'commander';
import { connectLocal, resolveLocal } from './connect.ts';
import { buildProgram, type CliIO } from './program.ts';

const io: CliIO = {
  out: (l) => process.stdout.write(`${l}\n`),
  err: (l) => process.stderr.write(`${l}\n`),
  readStdin: async () => {
    if (process.stdin.isTTY) process.stderr.write('enter value, then Ctrl-D: ');
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  },
  env: process.env,
  interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
};

const program = buildProgram({
  io,
  client: connectLocal,
  runDaemon: async (opts) => {
    // Loaded lazily so the CLI stays fast and works without the daemon installed.
    const mod = (await import('@beamhop/daemon' as string)) as {
      runDaemon(o: { port?: number }): Promise<void>;
    };
    await mod.runDaemon(opts);
  },
  uiUrl: async () => {
    const { url, token } = await resolveLocal();
    return `${url}/#token=${token}`;
  },
});

try {
  await program.parseAsync(process.argv);
} catch (e) {
  if (e instanceof CommanderError) process.exitCode = e.exitCode;
  else throw e;
}
if (io.exitCode) process.exitCode = io.exitCode;
