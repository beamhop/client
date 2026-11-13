import { beamhopHome, createLogger } from '@beamhop/core';
import { Daemon, type DaemonOptions } from './daemon.ts';

export * from './cron.ts';
export * from './daemon.ts';
export * from './home.ts';
export type { MeshProvider } from './mesh.ts';
export * from './output.ts';
export * from './registry.ts';
export { conversationTarget, matchMembership } from './router.ts';
export * from './rpc-server.ts';
export { stricterProfile } from './sessions.ts';

export interface RunDaemonOptions {
  port?: number;
  home?: string;
  host?: string;
  /** Extra overrides (tests). */
  daemon?: Partial<DaemonOptions>;
}

/**
 * Run the daemon in the foreground until SIGINT/SIGTERM. Called by `beamhop daemon` and `beamhopd`.
 * Resolves after a graceful shutdown.
 */
export const runDaemon = async (opts: RunDaemonOptions = {}): Promise<void> => {
  const home = opts.home ?? beamhopHome();
  const log = createLogger();
  const env = process.env;
  const port = opts.port ?? (env.BEAMHOP_PORT ? Number(env.BEAMHOP_PORT) : undefined);
  const daemon = new Daemon({
    home,
    log,
    api: { ...(port !== undefined ? { port } : {}), ...(opts.host ? { host: opts.host } : {}) },
    controlPlane: env.BEAMHOP_NO_CONTROL_PLANE !== '1',
    ...opts.daemon,
  });
  await daemon.start();
  log.info('beamhop daemon running', {
    home,
    url: daemon.api?.url,
    panic: daemon.isPanic(),
    awaitingProvisioning: daemon.deployEnv.awaitProvisioning,
  });
  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = (sig: string) => {
      if (stopping) return;
      stopping = true;
      log.info('shutting down', { signal: sig });
      const force = setTimeout(() => process.exit(1), 15_000);
      force.unref();
      void daemon.stop().finally(() => {
        clearTimeout(force);
        resolve();
      });
    };
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
  });
};
