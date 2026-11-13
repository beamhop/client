/**
 * Applies pushed `ServerEvent`s to TanStack Query caches so every screen updates live without refetching.
 * Pure function of (QueryClient, event) — unit-testable and transport-agnostic.
 */

import type { MethodName, Params, Result, ServerEvent } from '@beamhop/core';
import type { QueryClient } from '@tanstack/react-query';

type R<M extends MethodName> = Result<M>;

const upsert = <T>(list: T[], item: T, key: (x: T) => string, prepend = false): T[] => {
  const k = key(item);
  const i = list.findIndex((x) => key(x) === k);
  if (i === -1) return prepend ? [item, ...list] : [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
};

/** Iterate cached queries of one method with their params. */
const each = <M extends MethodName>(
  qc: QueryClient,
  method: M,
  fn: (params: Params<M>, data: R<M> | undefined, key: readonly unknown[]) => R<M> | undefined,
) => {
  for (const q of qc.getQueryCache().findAll({ queryKey: ['bh', method] })) {
    const params = (q.queryKey[2] ?? {}) as Params<M>;
    const data = q.state.data as R<M> | undefined;
    const next = fn(params, data, q.queryKey);
    if (next !== undefined && next !== data) qc.setQueryData(q.queryKey, next);
  }
};

export const applyServerEvent = (qc: QueryClient, e: ServerEvent): void => {
  switch (e.type) {
    case 'agent.updated': {
      const name = e.agent.config.name;
      each(qc, 'agent.list', (_p, d) => d && { agents: upsert(d.agents, e.agent, (a) => a.config.name) });
      each(qc, 'agent.get', (p, d) => ((p as { name?: string }).name === name ? e.agent : d));
      break;
    }
    case 'session.updated': {
      const s = e.session;
      each(qc, 'session.list', (p, d) => {
        if (!d) return d;
        const agent = (p as { agent?: string }).agent;
        if (agent && agent !== s.agent) return d;
        const sessions = upsert(d.sessions, s, (x) => x.id, true).sort((a, b) =>
          b.lastActivityAt.localeCompare(a.lastActivityAt),
        );
        return { sessions };
      });
      break;
    }
    case 'session.event': {
      each(qc, 'session.events', (p, d) => {
        if (!d || (p as { id?: string }).id !== e.sessionId) return d;
        // Same seq = the daemon re-sent that event with more content (streaming text): replace it.
        const i = d.events.findIndex((x) => x.seq === e.event.seq);
        if (i !== -1) {
          const events = d.events.slice();
          events[i] = e.event;
          return { events };
        }
        return { events: [...d.events, e.event].sort((a, b) => a.seq - b.seq) };
      });
      break;
    }
    case 'approval.created':
    case 'approval.updated': {
      const a = e.approval;
      each(qc, 'approval.list', (p, d) => {
        if (!d) return d;
        const status = (p as { status?: string }).status ?? 'pending';
        if (status === 'pending') {
          // Same order as the daemon: soonest auto-deny first.
          const approvals =
            a.status === 'pending'
              ? upsert(d.approvals, a, (x) => x.id).sort((x, y) => x.expiresAt.localeCompare(y.expiresAt))
              : d.approvals.filter((x) => x.id !== a.id);
          return { approvals };
        }
        return { approvals: upsert(d.approvals, a, (x) => x.id, true) };
      });
      // Counts (badge) come from system.status; refetch rather than guess transitions (undo, N-of-M).
      void qc.invalidateQueries({ queryKey: ['bh', 'system.status'] });
      break;
    }
    case 'channel.updated': {
      each(
        qc,
        'channel.list',
        (_p, d) => d && { channels: upsert(d.channels, e.channel, (c) => c.config.name) },
      );
      break;
    }
    case 'audit': {
      const ev = e.event;
      each(qc, 'audit.query', (p, d) => {
        if (!d) return d;
        const q = p as { agent?: string; severity?: string; limit?: number; before?: string };
        if (q.before) return d;
        if (q.agent && q.agent !== ev.agent) return d;
        if (q.severity && q.severity !== ev.severity) return d;
        if (d.events.some((x) => x.id === ev.id)) return d;
        return { events: [ev, ...d.events].slice(0, q.limit ?? 200) };
      });
      break;
    }
    case 'panic': {
      each(qc, 'system.status', (_p, d) => d && { ...d, panic: e.active });
      // Panic changes nearly everything (sessions, agents, approvals, schedules): refetch the rest.
      void qc.invalidateQueries({
        queryKey: ['bh'],
        predicate: (q) => q.queryKey[1] !== 'system.status',
      });
      break;
    }
  }
};
