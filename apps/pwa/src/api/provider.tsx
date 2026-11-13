/**
 * The API runtime (client + transport + event bus) and <BeamhopProvider>.
 *
 * The runtime is created once, outside React (main.tsx), so StrictMode double-mounting never closes
 * the WebSocket or stops the mock daemon. It subscribes to pushed events exactly once, patches the
 * TanStack Query cache (events.ts), then fans the event out to `useServerEvent` listeners.
 * Screens never touch the client directly; they use hooks from `api/hooks.ts`.
 */
import { type BeamhopClient, createClient, type Transport, wsTransport } from '@beamhop/client';
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
import { createMockTransport, type MockTransport } from './mock/index.ts';

export interface BeamhopRuntime {
  client: BeamhopClient;
  connection: ConnectionConfig;
  queryClient: QueryClient;
  /** Present in mock mode: lets the kitchen sink / tests poke the fake daemon. */
  mock?: MockTransport;
  getStatus(): ConnectionStatus;
  onStatus(fn: () => void): () => void;
  /** Pushed events, delivered after the query cache has been patched. */
  subscribe(fn: (e: ServerEvent) => void): () => void;
  close(): void;
}

export const createRuntime = (
  connection: ConnectionConfig,
  queryClient: QueryClient,
  injected?: Transport,
): BeamhopRuntime => {
  let status: ConnectionStatus = 'connecting';
  let prev: ConnectionStatus = 'connecting';
  const statusListeners = new Set<() => void>();
  const setStatus = (s: ConnectionStatus) => {
    prev = status;
    status = s;
    // After a reconnect, refetch everything cached (events may have been missed while closed).
    if (prev === 'closed' && s === 'open') void queryClient.invalidateQueries({ queryKey: ['bh'] });
    for (const l of statusListeners) l();
  };

  let transport: Transport;
  let mock: MockTransport | undefined;
  if (injected) {
    transport = injected;
    queueMicrotask(() => setStatus('open'));
  } else if (connection.kind === 'local' && connection.baseUrl && connection.token) {
    transport = wsTransport(connection.baseUrl, connection.token, { onStatus: setStatus });
  } else if (connection.kind === 'nostr') {
    throw new Error('Hosted (Nostr) mode is not available yet.');
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
  subscribe: BeamhopRuntime['subscribe'];
}

const Ctx = createContext<BeamhopContextValue | null>(null);

export const BeamhopProvider = ({ runtime, children }: { runtime: BeamhopRuntime; children: ReactNode }) => {
  const status = useSyncExternalStore(runtime.onStatus, runtime.getStatus, runtime.getStatus);
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
      subscribe: runtime.subscribe,
    }),
    [runtime, status, online],
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

export const useConnection = () => {
  const { connection, status, online } = useBeamhop();
  return { ...connection, status, online };
};
