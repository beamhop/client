/**
 * Connection pill (DESIGN §9.2): hop meter + `3/4 relays` / `local` / `demo`. Tap → Connection sheet.
 */
import { CellTower, Laptop, Plugs } from '@phosphor-icons/react';
import { useState } from 'react';
import { Button as RACButton } from 'react-aria-components';
import { forgetToken, relayHealth, useApi, useConnection } from '../api/index.ts';
import { cx } from '../lib/cx.ts';
import { since } from '../lib/format.ts';
import { Button } from '../ui/Button.tsx';
import { Badge } from '../ui/Meta.tsx';
import { Sheet } from '../ui/Sheet.tsx';
import { SignalBars, StatusDot } from '../ui/Status.tsx';

export const useConnectionSummary = () => {
  const conn = useConnection();
  const channels = useApi('channel.list', undefined, { enabled: conn.status === 'open' });
  const relays = relayHealth(channels.data?.channels);
  const offline = !conn.online || conn.status === 'closed';
  const connecting = conn.status === 'connecting';
  return { conn, relays, offline, connecting };
};

export const ConnectionPill = ({ className, wide }: { className?: string; wide?: boolean }) => {
  const [open, setOpen] = useState(false);
  const { conn, relays, offline, connecting } = useConnectionSummary();
  const label = offline
    ? 'offline'
    : connecting
      ? 'connecting'
      : relays
        ? `${relays.up}/${relays.total} relays`
        : conn.kind === 'local'
          ? 'local'
          : 'demo';
  return (
    <>
      <RACButton
        onPress={() => setOpen(true)}
        className={cx(
          'inline-flex min-h-11 shrink-0 items-center gap-2 rounded-md px-2 type-meta text-ink-2 outline-none data-[hovered]:bg-sunken data-[pressed]:bg-sunken',
          className,
        )}
        data-connection={offline ? 'offline' : connecting ? 'connecting' : 'open'}
      >
        <span className="sr-only">Connection: </span>
        {offline ? (
          <StatusDot state="offline" />
        ) : (
          <SignalBars
            up={connecting ? 0 : (relays?.up ?? 1)}
            total={relays?.total ?? 4}
            busy={connecting}
            hideNumber={!relays}
            unit={relays && wide ? 'relays' : undefined}
          />
        )}
        {relays && !wide && !offline && <span className="sr-only">relays</span>}
        {!offline && !relays && <span className={connecting ? undefined : 'sr-only'}>{label}</span>}
        {conn.kind === 'mock' && <Badge tone="flare">demo</Badge>}
        <span className="sr-only">, show details</span>
      </RACButton>
      <ConnectionSheet isOpen={open} onOpenChange={setOpen} />
    </>
  );
};

export const ConnectionSheet = ({
  isOpen,
  onOpenChange,
}: {
  isOpen: boolean;
  onOpenChange: (o: boolean) => void;
}) => {
  const { conn, relays, offline } = useConnectionSummary();
  const status = useApi('system.status', undefined, { enabled: isOpen });
  const channels = useApi('channel.list', undefined, { enabled: isOpen });
  const nostr = channels.data?.channels.find((c) => c.config.provider === 'nostr');
  const relayList = (nostr?.config.settings.relays as string[] | undefined) ?? [];
  const up = new Set((nostr?.config.settings.relaysUp as string[] | undefined) ?? relayList);
  return (
    <Sheet
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title="Connection"
      subtitle={
        conn.kind === 'mock'
          ? 'Demo daemon in this browser'
          : conn.kind === 'local'
            ? `beamhopd · ${conn.baseUrl}`
            : 'Nostr control plane'
      }
    >
      <div className="flex flex-col gap-5">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 type-meta">
          <dt className="text-ink-2">Daemon</dt>
          <dd className="flex items-center gap-2 text-ink">
            {conn.kind === 'mock' ? (
              <Plugs size={14} aria-hidden="true" />
            ) : (
              <Laptop size={14} aria-hidden="true" />
            )}
            {conn.kind === 'mock' ? 'demo (mock)' : `beamhopd ${status.data?.version ?? ''}`}
          </dd>
          <dt className="text-ink-2">Link</dt>
          <dd>
            <StatusDot
              state={offline ? 'offline' : conn.status === 'open' ? 'ready' : 'paused'}
              label={offline ? 'offline' : conn.status}
            />
          </dd>
          {status.data && (
            <>
              <dt className="text-ink-2">Uptime</dt>
              <dd className="text-ink">{since(Date.now() - status.data.uptimeSec * 1000)}</dd>
              <dt className="text-ink-2">Home</dt>
              <dd className="text-ink">{status.data.home}</dd>
            </>
          )}
        </dl>
        {relays && (
          <section aria-labelledby="conn-relays">
            <h3 id="conn-relays" className="mb-1 flex items-center justify-between type-micro text-ink-2">
              Relays <SignalBars up={relays.up} total={relays.total} unit="up" />
            </h3>
            <ul className="divide-y divide-line rounded-lg border border-line">
              {relayList.map((r) => (
                <li key={r} className="flex min-h-11 items-center gap-3 px-3 type-meta text-ink">
                  <CellTower size={16} aria-hidden="true" className="text-ink-2" />
                  <span className="flex-1 truncate">{r.replace('wss://', '')}</span>
                  <StatusDot
                    state={up.has(r) ? 'ready' : 'offline'}
                    label={up.has(r) ? 'connected' : 'unreachable'}
                  />
                </li>
              ))}
            </ul>
          </section>
        )}
        {conn.kind === 'mock' ? (
          <p className="type-body-sm text-ink-2">
            This is demo data generated in your browser. To control your real agents, run{' '}
            <code className="font-mono text-[0.875em] text-ink">beamhop ui</code> on your computer and open
            the link it prints.
          </p>
        ) : (
          <Button
            variant="secondary"
            onPress={() => {
              forgetToken();
              window.location.assign('/?mock=1');
            }}
          >
            Disconnect this browser
          </Button>
        )}
      </div>
    </Sheet>
  );
};
