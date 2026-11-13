/**
 * Desktop status strip: one mono line across the top of the main area — daemon, link, panic state,
 * relay health. Like the header row of an instrument panel. Compact shows the same info in the top bar.
 */
import { useApi, useConnection } from '../api/index.ts';
import { since } from '../lib/format.ts';
import { Badge, Kbd } from '../ui/Meta.tsx';
import { StatusDot } from '../ui/Status.tsx';
import { useConnectionSummary } from './Connection.tsx';
import { usePanicState } from './panic.tsx';

export const StatusStrip = () => {
  const conn = useConnection();
  const status = useApi('system.status', undefined, { refetchInterval: 30_000 });
  const { relays, offline } = useConnectionSummary();
  const { panic } = usePanicState();
  const s = status.data;
  return (
    <div
      className="flex h-8 shrink-0 items-center gap-4 border-b border-line px-8 type-micro text-ink-3"
      data-status-strip=""
    >
      <span className="flex items-center gap-2">
        <span className="text-ink-2">beamhopd {s?.version ?? '—'}</span>
        <span aria-hidden="true">·</span>
        <span>{conn.kind === 'mock' ? 'demo' : conn.kind}</span>
        {s && (
          <>
            <span aria-hidden="true">·</span>
            <span>up {since(Date.now() - s.uptimeSec * 1000)}</span>
          </>
        )}
      </span>
      <span className="flex items-center gap-2">
        <StatusDot
          state={offline ? 'offline' : panic ? 'panic' : 'ready'}
          label={offline ? 'link down' : panic ? 'stopped by panic' : 'link up'}
        />
      </span>
      {relays && (
        <span>
          relays {relays.up}/{relays.total}
        </span>
      )}
      {s && (
        <span>
          {s.agents} agents · {s.channels} channels · {s.pendingApprovals} pending
        </span>
      )}
      <span className="ml-auto flex items-center gap-3">
        {conn.kind === 'mock' && <Badge tone="flare">demo data</Badge>}
        <span className="flex items-center gap-1 normal-case tracking-normal">
          <Kbd>g</Kbd>
          <Kbd>i</Kbd>
          <span className="type-meta">inbox</span>
        </span>
      </span>
    </div>
  );
};
