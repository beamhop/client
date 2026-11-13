/**
 * Placeholder body for screens that parallel builders will own. Shows the spec section, the data the
 * screen needs (live-proved by calling the hooks), and the CLI equivalent — so even the placeholder
 * reads as part of the instrument. Delete it from your screen when you build the real thing.
 */
import type { MethodName, Params } from '@beamhop/core';
import { useMatches } from '@tanstack/react-router';
import { useApi } from '../api/index.ts';
import { CliStrip } from '../ui/CliStrip.tsx';
import { Badge } from '../ui/Meta.tsx';
import { StatusDot } from '../ui/Status.tsx';

export interface StubCall {
  method: MethodName;
  params?: unknown;
}

const countOf = (data: unknown): string => {
  if (!data || typeof data !== 'object') return 'ok';
  const arr = Object.values(data as Record<string, unknown>).find(Array.isArray) as unknown[] | undefined;
  return arr ? `${arr.length} ${arr.length === 1 ? 'row' : 'rows'}` : 'ok';
};

const CallRow = ({ call }: { call: StubCall }) => {
  const q = useApi(call.method, call.params as Params<typeof call.method>);
  return (
    <li className="flex min-h-10 items-center gap-3 px-3 type-meta">
      <span className="min-w-0 flex-1 truncate text-ink">{call.method}</span>
      {q.isPending ? (
        <StatusDot state="paused" label="loading" />
      ) : q.isError ? (
        <StatusDot state="error" label={q.error.message.slice(0, 40)} />
      ) : (
        <StatusDot state="ready" label={countOf(q.data)} />
      )}
    </li>
  );
};

export interface ScreenStubProps {
  /** e.g. `SCREENS §2 Inbox · JOURNEYS §2`. */
  spec: string;
  /** Directory the owning builder works in, e.g. `src/screens/inbox/`. */
  owner: string;
  /** What this screen will show, in a few bullets (from SCREENS.md). */
  outline: string[];
  calls?: StubCall[];
  cli?: string;
}

export const ScreenStub = ({ spec, owner, outline, calls = [], cli }: ScreenStubProps) => {
  const params = useMatches({ select: (ms) => ms.at(-1)?.params as Record<string, string> | undefined });
  const entries = Object.entries(params ?? {});
  return (
    <div className="flex flex-col gap-5 pt-2">
      <div className="relative overflow-hidden rounded-lg border border-dashed border-line-strong p-4">
        <span aria-hidden="true" className="hatch pointer-events-none absolute inset-0 text-ink-3" />
        <div className="relative flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="caution">placeholder</Badge>
            <span className="type-meta text-ink-2">{spec}</span>
          </div>
          <p className="type-body-sm text-ink-2">
            Owned by <code className="font-mono text-[0.875em] text-ink">{owner}</code>. The shell, data hooks and components are ready; this body is a stand-in.
          </p>
          {entries.length > 0 && (
            <p className="type-meta text-ink-2">
              params ·{' '}
              {entries.map(([k, v]) => (
                <span key={k} className="text-ink">
                  {k}={v}{' '}
                </span>
              ))}
            </p>
          )}
        </div>
      </div>
      <section aria-labelledby="stub-outline">
        <h2 id="stub-outline" className="mb-2 type-micro text-ink-2">
          Will show
        </h2>
        <ol className="flex flex-col gap-1.5">
          {outline.map((o, i) => (
            <li key={o} className="flex gap-3 type-body-sm text-ink">
              <span className="w-5 shrink-0 type-meta text-ink-3 tabular-nums">{String(i + 1).padStart(2, '0')}</span>
              {o}
            </li>
          ))}
        </ol>
      </section>
      {calls.length > 0 && (
        <section aria-labelledby="stub-data">
          <h2 id="stub-data" className="mb-2 type-micro text-ink-2">
            Data (live)
          </h2>
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
            {calls.map((c) => (
              <CallRow key={c.method + JSON.stringify(c.params ?? {})} call={c} />
            ))}
          </ul>
        </section>
      )}
      {cli && <CliStrip command={cli} />}
    </div>
  );
};

/** True when a child route other than the index is active below `layoutRouteId` (for SplitView). */
export const useHasDetail = (layoutRouteId: string): boolean =>
  useMatches({
    select: (ms) => {
      const i = ms.findIndex((m) => m.routeId === layoutRouteId);
      const child = i === -1 ? undefined : ms[i + 1];
      return !!child && !child.routeId.endsWith('/');
    },
  });
