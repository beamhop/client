/**
 * Audit → Log: every event, newest first. The first page is a live query (pushed `audit` events land on
 * top); older pages load with `before` as you reach the end (IntersectionObserver) or via the visible
 * "Load older events" button. Search, type and date filters run on what's loaded; agent and severity
 * filter server-side.
 */
import type { AuditEvent } from '@beamhop/core';
import { DownloadSimple, FunnelSimple, MagnifyingGlass } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApi, useCall } from '../../api/index.ts';
import { t } from '../../i18n/index.ts';
import { clock, middleTruncate, shortDate } from '../../lib/format.ts';
import { useExpanded } from '../../lib/media.ts';
import { useNow } from '../../lib/useNow.ts';
import { Button } from '../../ui/Button.tsx';
import { Select } from '../../ui/Choice.tsx';
import { SearchField } from '../../ui/Field.tsx';
import { Sheet } from '../../ui/Sheet.tsx';
import { EmptyState, ErrorState, Skeleton, useDelayedLoading } from '../../ui/States.tsx';
import { matchLog } from './model.ts';
import { EventSheet, ExportSheet, LevelLamp } from './Sheets.tsx';

const PAGE = 50;
type Sev = 'all' | 'info' | 'warn' | 'security';
type Since = 'all' | '24h' | '7d';
const SINCE_MS: Record<Since, number | undefined> = {
  all: undefined,
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
};

export const LogTab = () => {
  const call = useCall();
  const now = useNow(60_000);
  const expanded = useExpanded();
  const agents = useApi('agent.list');
  const [agent, setAgent] = useState<string>('all');
  const [sev, setSev] = useState<Sev>('all');
  const [type, setType] = useState<string>('all');
  const [since, setSince] = useState<Since>('all');
  const [q, setQ] = useState('');
  const params = {
    limit: PAGE,
    ...(agent !== 'all' ? { agent } : {}),
    ...(sev !== 'all' ? { severity: sev } : {}),
  };
  const first = useApi('audit.query', params);
  const [older, setOlder] = useState<AuditEvent[]>([]);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [olderError, setOlderError] = useState<Error>();
  const [open, setOpen] = useState<AuditEvent | null>(null);
  const [exporting, setExporting] = useState(false);
  const [filters, setFilters] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const showSkeleton = useDelayedLoading(first.isPending);

  // Reset paging whenever server-side filters change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by filters
  useEffect(() => {
    setOlder([]);
    setDone(false);
    setOlderError(undefined);
  }, [agent, sev]);

  const all = useMemo(() => {
    const head = first.data?.events ?? [];
    const seen = new Set(head.map((e) => e.id));
    return [...head, ...older.filter((e) => !seen.has(e.id))];
  }, [first.data, older]);
  const firstFull = (first.data?.events.length ?? 0) >= PAGE;
  const hasMore = !done && firstFull;

  const loadMore = async () => {
    if (loading || !hasMore) return;
    const last = all.at(-1);
    if (!last) return;
    setLoading(true);
    setOlderError(undefined);
    try {
      const r = await call('audit.query', { ...params, before: last.at });
      setOlder((o) => [...o, ...r.events]);
      if (r.events.length < PAGE) setDone(true);
    } catch (e) {
      setOlderError(e as Error);
    } finally {
      setLoading(false);
    }
  };
  const loadRef = useRef(loadMore);
  loadRef.current = loadMore;

  useEffect(() => {
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((es) => es[0]?.isIntersecting && void loadRef.current(), {
      rootMargin: '400px 0px',
    });
    io.observe(el);
    return () => io.disconnect();
  });

  const types = useMemo(() => [...new Set(all.map((e) => e.type))].sort(), [all]);
  const shown = all.filter((e) =>
    matchLog(e, { q, type: type === 'all' ? undefined : type, sinceMs: SINCE_MS[since] }, now),
  );
  const groups = useMemo(() => {
    const g: Array<{ day: string; events: AuditEvent[] }> = [];
    for (const e of shown) {
      const d = shortDate(e.at);
      const cur = g.at(-1);
      if (cur?.day === d) cur.events.push(e);
      else g.push({ day: d, events: [e] });
    }
    return g;
  }, [shown]);
  const activeFilters = [agent !== 'all', sev !== 'all', type !== 'all', since !== 'all'].filter(
    Boolean,
  ).length;

  const filterFields = (
    <>
      <Select
        label={t('audit.log.agent')}
        selectedKey={agent}
        onSelectionChange={(k) => setAgent(String(k))}
        options={[
          { id: 'all', label: t('audit.log.anyAgent') },
          ...(agents.data?.agents ?? []).map((a) => ({ id: a.config.name, label: a.config.name })),
        ]}
      />
      <Select
        label={t('audit.log.severity')}
        selectedKey={sev}
        onSelectionChange={(k) => setSev(k as Sev)}
        options={[
          { id: 'all', label: t('audit.log.anySeverity') },
          { id: 'security', label: t('audit.level.high') },
          { id: 'warn', label: t('audit.level.medium') },
          { id: 'info', label: t('audit.level.low') },
        ]}
      />
      <Select
        label={t('audit.log.type')}
        selectedKey={type}
        onSelectionChange={(k) => setType(String(k))}
        options={[{ id: 'all', label: t('audit.log.anyType') }, ...types.map((x) => ({ id: x, label: x }))]}
      />
      <Select
        label={t('audit.log.since')}
        selectedKey={since}
        onSelectionChange={(k) => setSince(k as Since)}
        options={[
          { id: 'all', label: t('audit.log.anyTime') },
          { id: '24h', label: t('audit.sec.range.24h') },
          { id: '7d', label: t('audit.sec.range.7d') },
        ]}
      />
    </>
  );

  if (first.error)
    return (
      <ErrorState title={t('audit.log.error')} details={first.error} onRetry={() => void first.refetch()}>
        {first.error.message}
      </ErrorState>
    );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-2">
        <SearchField
          label={t('audit.log.search')}
          hideLabel
          placeholder={t('audit.log.searchPh')}
          value={q}
          onChange={setQ}
          className="min-w-0 basis-full expanded:basis-0 expanded:flex-1"
        />
        {!expanded && (
          <Button
            variant="secondary"
            icon={<FunnelSimple size={18} aria-hidden="true" />}
            onPress={() => setFilters(true)}
            aria-label={t('audit.log.filtersAria', { count: activeFilters })}
          >
            {activeFilters ? String(activeFilters) : t('audit.log.filters')}
          </Button>
        )}
        <Button
          variant="secondary"
          icon={<DownloadSimple size={18} aria-hidden="true" />}
          onPress={() => setExporting(true)}
        >
          {t('audit.log.export')}
        </Button>
      </div>
      {expanded && <div className="grid grid-cols-4 gap-3">{filterFields}</div>}
      <p className="type-meta text-ink-2" aria-live="polite">
        {t('audit.log.count', { count: shown.length, loaded: all.length })}
      </p>
      {first.isPending ? (
        showSkeleton ? (
          <Skeleton variant="list" count={8} />
        ) : null
      ) : shown.length === 0 ? (
        <EmptyState
          glyph={<MagnifyingGlass size={32} aria-hidden="true" />}
          title={all.length ? t('audit.log.noMatch') : t('audit.log.emptyTitle')}
          action={
            all.length ? (
              <Button
                variant="secondary"
                onPress={() => {
                  setQ('');
                  setType('all');
                  setSince('all');
                  setAgent('all');
                  setSev('all');
                }}
              >
                {t('audit.log.clear')}
              </Button>
            ) : undefined
          }
          cli="beamhop audit --limit 50"
        >
          {all.length ? t('audit.log.noMatchBody') : t('audit.log.emptyBody')}
        </EmptyState>
      ) : (
        <div className="flex flex-col">
          {groups.map((g) => (
            <section key={g.day} aria-label={g.day}>
              <h2 className="sticky top-[52px] z-10 border-b border-line bg-bg py-1.5 type-micro text-ink-2 expanded:top-[72px]">
                {g.day}
              </h2>
              <ul className="tick-rail ml-1 pl-3">
                {g.events.map((e) => (
                  <li key={e.id}>
                    <button
                      type="button"
                      onClick={() => setOpen(e)}
                      className="flex min-h-12 w-full items-start gap-3 border-b border-line py-2.5 text-left outline-none hover:bg-sunken focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
                    >
                      <span className="w-11 shrink-0 pt-0.5 font-mono text-[12px] text-ink-2 tabular-nums">
                        {clock(e.at)}
                      </span>
                      <LevelLamp e={e} />
                      <span className="min-w-0 flex-1">
                        <span className="block type-body-sm text-ink [overflow-wrap:anywhere]">
                          {e.summary}
                        </span>
                        <span className="block truncate type-meta text-ink-2">
                          {middleTruncate(e.actor, 28)} · {e.type}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          <div ref={sentinel} aria-hidden="true" className="h-px" />
          <div className="flex min-h-14 items-center justify-center">
            {olderError ? (
              <Button variant="secondary" onPress={() => void loadMore()}>
                {t('audit.log.retryOlder')}
              </Button>
            ) : hasMore ? (
              <Button variant="quiet" isDisabled={loading} onPress={() => void loadMore()}>
                {loading ? t('audit.log.loading') : t('audit.log.older')}
              </Button>
            ) : (
              <p className="type-meta text-ink-3">{t('audit.log.end')}</p>
            )}
          </div>
        </div>
      )}
      <EventSheet event={open} onClose={() => setOpen(null)} />
      <ExportSheet
        isOpen={exporting}
        onOpenChange={setExporting}
        events={shown}
        agent={agent === 'all' ? undefined : agent}
      />
      <Sheet
        isOpen={filters}
        onOpenChange={setFilters}
        title={t('audit.log.filters')}
        footer={
          <div className="flex justify-end">
            <Button variant="primary" onPress={() => setFilters(false)}>
              {t('audit.log.showN', { count: shown.length })}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">{filterFields}</div>
      </Sheet>
    </div>
  );
};
