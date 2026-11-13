/**
 * Mock transport: an in-browser fake beamhopd. Used with `?mock=1`, when no daemon token is present,
 * in component tests and in the kitchen sink. See README § Mock backend.
 */
import { RpcError, type Transport } from '@beamhop/client';
import type { ServerEvent } from '@beamhop/core';
import { MockDaemon } from './daemon.ts';
import { Simulator } from './sim.ts';

export interface MockOptions {
  /** Run timers (streaming, new approvals, relay flicker). Default true. */
  live?: boolean;
  /** Methods that always fail with `unavailable` (error-state development). */
  failMethods?: string[];
  /** Simulated latency in ms: [min, max]. Default [60, 180]; [0, 0] in tests. */
  latency?: [number, number];
  now?: number;
}

export interface MockTransport extends Transport {
  daemon: MockDaemon;
  simulator: Simulator;
  /** Push a server event as if the daemon sent it. */
  emit(e: ServerEvent): void;
}

export const createMockTransport = (opts: MockOptions = {}): MockTransport => {
  const daemon = new MockDaemon(opts.now);
  const simulator = new Simulator(daemon);
  if (opts.live !== false) simulator.start();
  const [lo, hi] = opts.latency ?? (opts.live === false ? [10, 30] : [60, 180]);
  const fails = new Set(opts.failMethods ?? []);
  const wait = () =>
    new Promise<void>((r) => {
      const ms = lo + Math.random() * (hi - lo);
      if (ms <= 0) queueMicrotask(r);
      else setTimeout(r, ms);
    });

  return {
    daemon,
    simulator,
    emit: (e) => daemon.emit(e),
    async request(method, params) {
      await wait();
      if (fails.has(method)) {
        throw new RpcError(-32010, `Couldn't reach the daemon for ${method} (simulated)`, {
          code: 'unavailable',
        });
      }
      // Structured clone so callers can't mutate daemon state through results.
      return structuredClone(await daemon.handle(method, params));
    },
    subscribe(fn) {
      return daemon.subscribe((e) => fn(structuredClone(e)));
    },
    close() {
      simulator.stop();
    },
  };
};
