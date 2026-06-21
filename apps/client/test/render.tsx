import type { ReactElement, ReactNode } from "react";
import { render, renderHook } from "@testing-library/react";
import { StoreProvider } from "@beamhop/state";
import type { NostrClient } from "@beamhop/nostr";
import { persist, type Identity } from "@beamhop/nostr";
import { clientWithFakePool, type FakePool } from "./fake-pool.ts";

export * from "@testing-library/react";
export { clientWithFakePool, FakePool } from "./fake-pool.ts";

type StoreOptions = {
  /** Persisted before render so the provider boots signed-in. */
  identity?: Identity;
  /** Reuse a specific client; otherwise a fresh fake-pool client is created. */
  client?: NostrClient;
  pool?: FakePool;
};

const buildClient = (options: StoreOptions): { client: NostrClient; pool?: FakePool } => {
  if (options.client) return { client: options.client, pool: options.pool };
  const made = clientWithFakePool();
  return { client: made.client, pool: made.pool };
};

/** Render a component inside a real StoreProvider wired to a fake-pool client. */
export const renderWithStore = (ui: ReactElement, options: StoreOptions = {}) => {
  if (options.identity) persist(options.identity);
  const { client, pool } = buildClient(options);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <StoreProvider client={client}>{children}</StoreProvider>
  );
  return { ...render(ui, { wrapper }), pool, client };
};

/** Render a hook inside a real StoreProvider wired to a fake-pool client. */
export const renderHookWithStore = <T,>(hook: () => T, options: StoreOptions = {}) => {
  if (options.identity) persist(options.identity);
  const made = clientWithFakePool();
  const client = options.client ?? made.client;
  const pool = options.pool ?? made.pool;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <StoreProvider client={client}>{children}</StoreProvider>
  );
  return { ...renderHook(hook, { wrapper }), pool, client };
};
