import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import type { Logger, SandboxHandle } from '@beamhop/core';
import { spawnProcess } from '@beamhop/harness-kit';

/**
 * `spawnClaudeCodeProcess` must return synchronously, but `SandboxHandle.wrap` is async.
 * This returns a process facade immediately and connects it to the real (sandbox-wrapped)
 * child once wrapping resolves. stdin written before that is buffered by the PassThrough.
 */
export const sandboxedClaudeSpawner =
  (sandbox: SandboxHandle, log?: Logger) =>
  (opts: SpawnOptions): SpawnedProcess => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const events = new EventEmitter();
    let exitCode: number | null = null;
    let signalCode: NodeJS.Signals | null = null;
    let killed = false;
    let child: ReturnType<typeof spawnProcess> | undefined;
    let pendingKill: NodeJS.Signals | undefined;

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.env)) if (v !== undefined) env[k] = v;

    void sandbox
      .wrap(opts.command, opts.args)
      .then((w) => {
        if (pendingKill) {
          exitCode = null;
          signalCode = pendingKill;
          events.emit('exit', null, pendingKill);
          return;
        }
        log?.debug('spawn claude', { backend: sandbox.backend, cmd: w.cmd, argc: w.args.length });
        child = spawnProcess({ cmd: w.cmd, args: w.args, cwd: opts.cwd, env: { ...env, ...w.env } });
        stdin.pipe(child.stdin);
        child.stdout.pipe(stdout);
        child.stderr.on('data', (d) => log?.debug('claude stderr', { line: String(d).slice(0, 500) }));
        child.on('error', (e) => events.emit('error', e));
        child.on('exit', (code, sig) => {
          exitCode = code;
          signalCode = sig;
          stdout.end();
          events.emit('exit', code, sig);
        });
        opts.signal.addEventListener('abort', () => child?.kill('SIGTERM'), { once: true });
      })
      .catch((e: Error) => {
        exitCode = 1;
        stdout.end();
        events.emit('error', e);
        events.emit('exit', 1, null);
      });

    return {
      stdin,
      stdout,
      get killed() {
        return killed;
      },
      get exitCode() {
        return exitCode;
      },
      get signalCode() {
        return signalCode;
      },
      kill(signal: NodeJS.Signals) {
        killed = true;
        if (child) return child.kill(signal);
        pendingKill = signal;
        return true;
      },
      on: (event: 'exit' | 'error', listener: (...a: never[]) => void) => {
        events.on(event, listener as (...a: unknown[]) => void);
      },
      once: (event: 'exit' | 'error', listener: (...a: never[]) => void) => {
        events.once(event, listener as (...a: unknown[]) => void);
      },
      off: (event: 'exit' | 'error', listener: (...a: never[]) => void) => {
        events.off(event, listener as (...a: unknown[]) => void);
      },
    } as SpawnedProcess;
  };
