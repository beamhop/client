import { createClient, RpcError } from '@beamhop/client';
import { QueryClient } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ConnectionConfig } from '../api/connection.ts';
import type { HostedHealth } from '../api/nostr.ts';
import { BeamhopProvider, type BeamhopRuntime } from '../api/provider.tsx';
import { ToastProvider } from '../ui/Toast.tsx';
import { ConnectionPill } from './Connection.tsx';

const DAEMON = 'npub1daemon0000000000000000000000000000000000000000000000000000';

const health = (h: Partial<HostedHealth> = {}): HostedHealth => ({
  relays: [
    { url: 'wss://relay.one', connected: true },
    { url: 'wss://relay.two', connected: true },
    { url: 'wss://relay.three', connected: false, lastError: 'connection refused' },
  ],
  up: 2,
  total: 3,
  daemon: 'reachable',
  queued: 0,
  daemonNpub: DAEMON,
  ...h,
});

/** A runtime with a scripted connection state (no transport behind it). */
const runtime = (
  connection: ConnectionConfig,
  status: 'open' | 'closed',
  hosted?: HostedHealth,
): BeamhopRuntime => {
  const client = createClient({
    request: () => Promise.reject(new RpcError(-32000, 'offline in tests', { code: 'unavailable' })),
  });
  return {
    client,
    connection,
    queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    getStatus: () => status,
    getHosted: () => hosted,
    onStatus: () => () => {},
    subscribe: () => () => {},
    close: () => {},
  };
};

const renderPill = (rt: BeamhopRuntime) =>
  render(
    <BeamhopProvider runtime={rt}>
      <ToastProvider>
        <ConnectionPill />
      </ToastProvider>
    </BeamhopProvider>,
  );

describe('ConnectionPill', () => {
  it('hosted + healthy: relays this browser holds, and the sheet lists each relay with its error', async () => {
    renderPill(runtime({ kind: 'nostr', reason: 'saved-daemon' }, 'open', health()));
    const pill = screen.getByRole('button', { name: /Connection/ });
    expect(pill).toHaveTextContent('2/3');
    await userEvent.click(pill);
    const sheet = await screen.findByRole('dialog', { name: 'Connection' });
    expect(within(sheet).getByText('Relays from this browser')).toBeInTheDocument();
    expect(within(sheet).getByText('connection refused')).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Disconnect this browser' })).toBeInTheDocument();
  });

  it('hosted + unpaired by the daemon: says so and offers Pair again', async () => {
    renderPill(runtime({ kind: 'nostr', reason: 'saved-daemon' }, 'closed', health({ daemon: 'unpaired' })));
    const pill = screen.getByRole('button', { name: /Connection/ });
    expect(pill).toHaveTextContent('unpaired');
    await userEvent.click(pill);
    const sheet = await screen.findByRole('dialog', { name: 'Connection' });
    expect(within(sheet).getByRole('link', { name: 'Pair again' })).toHaveAttribute('href', '/pair');
  });

  it('hosted + daemon not answering + queued requests', () => {
    renderPill(
      runtime(
        { kind: 'nostr', reason: 'saved-daemon' },
        'open',
        health({ daemon: 'unreachable', queued: 2 }),
      ),
    );
    const pill = screen.getByRole('button', { name: /Connection/ });
    expect(pill).toHaveTextContent('no answer');
    expect(pill).toHaveTextContent('2 queued');
  });

  it('never paired: not paired, and the sheet offers pairing (not "offline")', async () => {
    renderPill(runtime({ kind: 'none', reason: 'unpaired' }, 'closed'));
    const pill = screen.getByRole('button', { name: /Connection/ });
    expect(pill).toHaveTextContent('not paired');
    expect(pill).not.toHaveTextContent('offline');
    await userEvent.click(pill);
    const sheet = await screen.findByRole('dialog', { name: 'Connection' });
    expect(within(sheet).getByRole('link', { name: 'Pair this browser' })).toBeInTheDocument();
  });
});
