/**
 * The API runtime (client + transport + event bus) and <BeamhopProvider>.
 *
 * The runtime is created once, outside React (main.tsx), so StrictMode double-mounting never closes
 * the WebSocket or stops the mock daemon. It subscribes to pushed events exactly once, patches the
 * TanStack Query cache (events.ts), then fans the event out to `useServerEvent` listeners.
 * Screens never touch the client directly; they use hooks from `api/hooks.ts`.
 */
import { type BeamhopClient, createClient, RpcError, type Transport, wsTransport } from '@beamhop/client';
import type { ServerEvent } from '@beamhop/core';
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ConnectionConfig, ConnectionStatus } from './connection.ts';
import { applyServerEvent } from './events.ts';
import { lazyNostrTransport } from './hosted-lazy.ts';
import type { HostedIdentity } from './identity.ts';
import { createMockTransport, type MockTransport } from './mock/index.ts';
import type { HostedHealth, NostrTransportOptions } from './nostr.ts';

export interface BeamhopRuntime {
  client: BeamhopClient;
  connection: ConnectionConfig;
  queryClient: QueryClient;
  /** Present in mock mode: lets the kitchen sink / tests poke the fake daemon. */
  mock?: MockTransport;
  getStatus(): ConnectionStatus;
  onStatus(fn: () => void): () => void;
  /** Hosted mode only: relays + daemon reachability (changes notify `onStatus` listeners). */
  getHosted(): HostedHealth | undefined;
  /** Pushed events, delivered after the query cache has been patched. */
  subscribe(fn: (e: ServerEvent) => void): () => void;
  close(): void;
}

export interface RuntimeOptions {
  /** Hosted mode: override the signing identity (tests). Default: the saved daemon's signer. */
  identity?: HostedIdentity | (() => Promise<HostedIdentity>);
  /** Hosted mode: extra transport options (tests: WebSocket, timeouts). */
  nostr?: Partial<NostrTransportOptions>;
}

/** `kind: 'none'`: nothing to talk to yet; every call fails with `not_paired` until the user pairs. */
const unpairedTransport = (): Transport => ({
  request: () =>
    Promise.reject(
      new RpcError(-32000, 'This browser is not connected to a computer yet. Pair it first.', {
        code: 'not_paired',
      }),
    ),
});

export const createRuntime = (
  connection: ConnectionConfig,
  queryClient: QueryClient,
  injected?: Transport,
  opts: RuntimeOptions = {},
): BeamhopRuntime => {
  let status: ConnectionStatus = 'connecting';
  let prev: ConnectionStatus = 'connecting';
  let hosted: HostedHealth | undefined;
  const statusListeners = new Set<() => void>();
  const setStatus = (s: ConnectionStatus) => {
    prev = status;
    status = s;
    // After a reconnect, refetch everything cached (events may have been missed while closed).
    if (prev === 'closed' && s === 'open') void queryClient.invalidateQueries({ queryKey: ['bh'] });
    for (const l of statusListeners) l();
  };
  const setHosted = (h: HostedHealth) => {
    hosted = h;
    for (const l of statusListeners) l();
  };

  let transport: Transport;
  let mock: MockTransport | undefined;
  if (injected) {
    transport = injected;
    queueMicrotask(() => setStatus('open'));
  } else if (connection.kind === 'local' && connection.baseUrl && connection.token) {
    transport = wsTransport(connection.baseUrl, connection.token, { onStatus: setStatus });
  } else if (connection.kind === 'nostr' && connection.daemon) {
    const d = connection.daemon;
    transport = lazyNostrTransport(
      {
        daemonPubkey: d.daemonPubkey,
        relays: d.relays,
        signer: d.signer,
        ...(opts.identity ? { identity: opts.identity } : {}),
        ...opts.nostr,
        onStatus: setStatus,
        onHealth: setHosted,
      },
      (nt) => setHosted(nt.health()),
      () => setStatus('closed'),
    );
  } else if (connection.kind === 'none' || connection.kind === 'nostr') {
    transport = unpairedTransport();
    queueMicrotask(() => setStatus('closed'));
  } else {
    mock = createMockTransport({ live: connection.live ?? true, failMethods: connection.failMethods ?? [] });
    transport = mock;
    queueMicrotask(() => setStatus('open'));
  }

  const client = createClient(transport);
  const listeners = new Set<(e: ServerEvent) => void>();
  const off = client.on((e) => {
    applyServerEvent(queryClient, e);
    for (const fn of listeners) fn(e);
  });

  return {
    client,
    connection,
    queryClient,
    mock,
    getStatus: () => status,
    getHosted: () => hosted,
    onStatus: (fn) => {
      statusListeners.add(fn);
      return () => {
        statusListeners.delete(fn);
      };
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    close: () => {
      off();
      client.close();
    },
  };
};

export interface BeamhopContextValue {
  client: BeamhopClient;
  connection: ConnectionConfig;
  status: ConnectionStatus;
  mock?: MockTransport;
  /** Browser online state (navigator.onLine). */
  online: boolean;
  /** Hosted mode: relay + daemon health for the connection pill / sheet. */
  hosted?: HostedHealth;
  subscribe: BeamhopRuntime['subscribe'];
}

const Ctx = createContext<BeamhopContextValue | null>(null);

export const BeamhopProvider = ({ runtime, children }: { runtime: BeamhopRuntime; children: ReactNode }) => {
  const status = useSyncExternalStore(runtime.onStatus, runtime.getStatus, runtime.getStatus);
  const hosted = useSyncExternalStore(runtime.onStatus, runtime.getHosted, runtime.getHosted);
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  const value = useMemo<BeamhopContextValue>(
    () => ({
      client: runtime.client,
      connection: runtime.connection,
      status,
      mock: runtime.mock,
      online,
      ...(hosted ? { hosted } : {}),
      subscribe: runtime.subscribe,
    }),
    [runtime, status, online, hosted],
  );
  return (
    <QueryClientProvider client={runtime.queryClient}>
      <Ctx.Provider value={value}>{children}</Ctx.Provider>
    </QueryClientProvider>
  );
};

export const useBeamhop = (): BeamhopContextValue => {
  const v = useContext(Ctx);
  if (!v) throw new Error('useBeamhop must be used inside <BeamhopProvider>');
  return v;
};

/** Like useBeamhop, but undefined outside the provider (hooks usable on bare pages / in tests). */
export const useMaybeBeamhop = (): BeamhopContextValue | undefined => useContext(Ctx) ?? undefined;

/**
 * Connection summary for the shell: `kind` (mock | local | nostr | none), `status`, `online`,
 * `hosted` (relays + daemon health in hosted mode), `needsPairing` (show the pair prompt).
 */
export const useConnection = () => {
  const { connection, status, online, hosted } = useBeamhop();
  return { ...connection, status, online, hosted, needsPairing: connection.kind === 'none' };
};
