/**
 * Sessions list — SCREENS §3 "Sessions list", JOURNEYS §3. Route: /sessions (layout) → /sessions/$sessionId.
 *
 * Every session across agents with its live state: rows grouped by agent under sticky micro headers,
 * status filters `Live · Needs you · Today · All` (with counts) and an agent chip rail, a live activity line
 * for running sessions, partial swipe-left on a row to reveal Stop (no full swipe — stopping should be
 * easy, not accidental) with the same action in the row's ⋯ menu. Desktop: list pane + session detail.
 *
 * Research used: iOS `allowsFullSwipe: false` for destructive row actions (DESIGN §8.4); Linear-style dense
 * keyboardable list rows with a mono slug; Slack/Discord channel lists that surface "needs attention" as a
 * first-class filter rather than a sort order.
 */
import type { AgentView, SessionView } from '@beamhop/core';
import { ChatsTeardrop, LinkSimple, Plus, Stop } from '@phosphor-icons/react';
import { Outlet, useMatches, useNavigate } from '@tanstack/react-router';
import { animate, motion, useMotionValue } from 'motion/react';
import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-aria-components';
import type { LampState } from '../../api/derive.ts';
import { harnessMonogram, sessionLamp, targetLabel, useApi, useMutationApi } from '../../api/index.ts';
import { t } from '../../i18n/index.ts';
import { cx } from '../../lib/cx.ts';
import { ago, clock, shortDate, since, usd } from '../../lib/format.ts';
import { haptic } from '../../lib/haptics.ts';
import { announce } from '../../lib/live.ts';
import { useExpanded } from '../../lib/media.ts';
import { useNow } from '../../lib/useNow.ts';
import { usePanicState } from '../../shell/panic.tsx';
import { Screen, SplitView } from '../../shell/Screen.tsx';
import { useHasDetail } from '../../shell/ScreenStub.tsx';
import { Button, IconButton } from '../../ui/Button.tsx';
import { SegmentedControl } from '../../ui/Choice.tsx';
import { FilterRail } from '../../ui/FilterRail.tsx';
import { LetterTile, MetaLine } from '../../ui/Meta.tsx';
import { reduced, spring, useReduced } from '../../ui/motion.ts';
import { EmptyState, ErrorState, Skeleton, useDelayedLoading } from '../../ui/States.tsx';
import { StatusDot } from '../../ui/Status.tsx';
import { useToast } from '../../ui/Toast.tsx';
import { NewSessionSheet } from './Inspector.tsx';
import { OverflowMenu } from './Menu.tsx';
import {
  currentActivity,
  filterCounts,
  filterSessions,
  groupByAgent,
  isActive,
  needsYouSet,
  type SessionFilter,
} from './model.ts';
import './sessions.css';

const FILTER_KEY = 'bh.sessions.filter';
const AGENT_KEY = 'bh.sessions.agent';
const read = (k: string) => {
  try {
    return sessionStorage.getItem(k) ?? undefined;
  } catch {
    return undefined;
  }
};
const write = (k: string, v?: string) => {
  try {
    if (v) sessionStorage.setItem(k, v);
    else sessionStorage.removeItem(k);
  } catch {
    /* ignore */
  }
};

/** Compact list time: `4 min ago` under an hour, `10:42` today, `12 Nov` before. */
const rowTime = (iso: string, now: number) => {
  const d = new Date(iso);
  if (now - d.getTime() < 3_600_000) return ago(iso, now);
  return new Date(now).toDateString() === d.toDateString() ? clock(d) : shortDate(d);
};

const FILTERS: SessionFilter[] = ['all', 'live', 'needs-you', 'today'];
const REVEAL = 88;

// ─────────── Row ───────────

const LiveLine = ({ s }: { s: SessionView }) => {
  const q = useApi('session.events', { id: s.id, afterSeq: 0 });
  const approvals = useApi('approval.list', { status: 'pending' });
  const a = currentActivity(s, q.data?.events ?? [], approvals.data?.approvals ?? []);
  if (!a) return null;
  const text =
    a.kind === 'tool'
      ? (a.detail ?? a.label)
      : a.kind === 'waiting'
        ? t('session.activity.waiting', { what: a.label })
        : a.kind === 'responding'
          ? t('session.activity.responding', { agent: s.agent })
          : a.kind === 'queued'
            ? t('session.activity.queued')
            : t('session.activity.thinking', { agent: s.agent });
  return (
    <p className={cx('truncate type-meta', a.kind === 'waiting' ? 'text-caution-text' : 'text-flare-text')}>
      {text}
    </p>
  );
};

const SessionRow = ({
  s,
  lamp,
  selected,
  channels,
  now,
  onNew,
}: {
  s: SessionView;
  lamp: LampState;
  selected: boolean;
  channels: Parameters<typeof targetLabel>[1];
  now: number;
  onNew: (agent: string) => void;
}) => {
  const reduce = useReduced();
  const toast = useToast();
  const navigate = useNavigate();
  const stop = useMutationApi('session.stop');
  const x = useMotionValue(0);
  const [open, setOpen] = useState(false);
  const moved = useRef(false);
  const canStop = isActive(s);
  const where = targetLabel(`${s.channel}:${s.conversationId}`, channels);

  const settle = (to: number) => {
    setOpen(to !== 0);
    void animate(x, to, reduce ? reduced : spring.settle);
  };
  const doStop = () => {
    haptic('reject');
    settle(0);
    stop
      .mutateAsync({ id: s.id })
      .then(() => toast.show({ message: t('session.stopped', { agent: s.agent, thread: s.threadId }) }))
      .catch((e: Error) => toast.show({ message: e.message, tone: 'error' }));
  };

  return (
    <li className="relative overflow-hidden border-b border-line last:border-b-0" data-session={s.id}>
      {canStop && (
        <div className="absolute inset-y-0 right-0 flex w-[88px] items-stretch" aria-hidden={!open}>
          <button
            type="button"
            tabIndex={open ? 0 : -1}
            onClick={doStop}
            className="flex w-full flex-col items-center justify-center gap-1 bg-stop type-label text-on-stop outline-none focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-on-stop"
          >
            <Stop size={20} weight="fill" aria-hidden="true" />
            {t('sessions.row.stop')}
          </button>
        </div>
      )}
      <motion.div
        style={{ x, touchAction: 'pan-y' }}
        drag={canStop ? 'x' : false}
        dragDirectionLock
        dragConstraints={{ left: -REVEAL, right: 0 }}
        dragElastic={{ left: 0.12, right: 0 }}
        dragMomentum={false}
        onDragStart={() => {
          moved.current = true;
        }}
        onDragEnd={(_e, info) => {
          const shouldOpen = info.offset.x < -64 || (open && info.offset.x < 24);
          if (shouldOpen && !open) haptic('tick');
          settle(shouldOpen ? -REVEAL : 0);
          setTimeout(() => {
            moved.current = false;
          }, 0);
        }}
        className={cx('relative flex items-stretch', selected ? 'bg-flare-wash' : 'bg-bg')}
      >
        {selected && <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[3px] bg-flare" />}
        <Link
          href={`/sessions/${s.id}`}
          aria-current={selected ? 'page' : undefined}
          onClickCapture={(e) => {
            if (moved.current || open) {
              e.preventDefault();
              e.stopPropagation();
              if (open) settle(0);
            }
          }}
          className="flex min-h-[76px] min-w-0 flex-1 items-start gap-3 py-3 pr-4 pl-4 outline-none data-[hovered]:bg-[color-mix(in_oklch,var(--bh-bg),var(--bh-ink)_3%)] data-[focus-visible]:outline-2 data-[focus-visible]:-outline-offset-2 data-[focus-visible]:outline-focus expanded:pl-5"
        >
          <span className="mt-[7px] shrink-0">
            <StatusDot state={lamp} hideLabel />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex items-baseline gap-2">
              <span className="line-clamp-2 min-w-0 flex-1 type-body-strong break-words text-ink">
                {s.title}
              </span>
              <span className="shrink-0 type-meta text-ink-3 tabular-nums">
                {rowTime(s.lastActivityAt, now)}
              </span>
            </span>
            <MetaLine
              as="span"
              className="pr-9"
              items={[
                { value: where, truncate: 22 },
                `thread ${s.threadId}`,
                s.status === 'running' ? since(s.startedAt, now) : null,
                usd(s.usage.usd),
                s.worktree ? { value: s.worktree.branch, truncate: 18 } : null,
              ]}
            />
            {(s.status === 'running' || s.status === 'queued') && (
              <span className="flex min-w-0 pr-9">
                <LiveLine s={s} />
              </span>
            )}
          </span>
        </Link>
        {/* Bottom-right, under the timestamp: the title keeps the full row width (two lines). */}
        <div className="absolute right-1 bottom-0.5 flex">
          <OverflowMenu
            label={t('sessions.row.menu', { title: s.title })}
            className="text-ink-2"
            actions={[
              {
                id: 'open',
                label: t('sessions.row.open'),
                icon: <ChatsTeardrop size={18} />,
                onAction: () => void navigate({ to: '/sessions/$sessionId', params: { sessionId: s.id } }),
              },
              {
                id: 'new',
                label: t('sessions.row.new', { agent: s.agent }),
                icon: <Plus size={18} />,
                onAction: () => onNew(s.agent),
              },
              {
                id: 'link',
                label: t('session.menu.copyLink'),
                icon: <LinkSimple size={18} />,
                onAction: () => {
                  void navigator.clipboard
                    ?.writeText(`${location.origin}/sessions/${s.id}`)
                    .catch(() => undefined);
                  announce(t('common.copied'));
                },
              },
              {
                id: 'stop',
                label: t('session.menu.stop'),
                icon: <Stop size={18} />,
                tone: 'stop',
                divider: true,
                isDisabled: !canStop,
                onAction: doStop,
              },
            ]}
          />
        </div>
      </motion.div>
    </li>
  );
};

// ─────────── Filters ───────────

const AgentRail = ({
  agents,
  value,
  onChange,
  counts,
}: {
  agents: AgentView[];
  value?: string;
  onChange: (a?: string) => void;
  counts: Record<string, number>;
}) => (
  <FilterRail
    label={t('sessions.filter.agent')}
    value={value ?? '*'}
    onChange={(k) => onChange(k === '*' ? undefined : k)}
    options={[
      { id: '*', label: t('sessions.filter.allAgents'), count: counts['*'] ?? 0 },
      ...agents.map((a) => ({
        id: a.config.name,
        label: a.config.name,
        count: counts[a.config.name] ?? 0,
        lead: <LetterTile code={harnessMonogram(a.config.harness)} size={24} />,
      })),
    ]}
  />
);

// ─────────── Screen ───────────

export const SessionsScreen = () => {
  const hasDetail = useHasDetail('/sessions');
  const expanded = useExpanded();
  const now = useNow(15_000);
  const { panic } = usePanicState();
  const q = useApi('session.list');
  const agentsQ = useApi('agent.list');
  const channels = useApi('channel.list');
  const pending = useApi('approval.list', { status: 'pending' });
  const currentId = useMatches({
    select: (ms) => (ms.at(-1)?.params as { sessionId?: string } | undefined)?.sessionId,
  });

  const [filter, setFilterState] = useState<SessionFilter>(
    () => (FILTERS.find((f) => f === read(FILTER_KEY)) as SessionFilter | undefined) ?? 'all',
  );
  const [agent, setAgentState] = useState<string | undefined>(() => read(AGENT_KEY));
  const [newFor, setNewFor] = useState<string | null>(null);
  const setFilter = (f: SessionFilter) => {
    setFilterState(f);
    write(FILTER_KEY, f);
  };
  const setAgent = (a?: string) => {
    setAgentState(a);
    write(AGENT_KEY, a);
  };

  const sessions = q.data?.sessions ?? [];
  const agents = agentsQ.data?.agents ?? [];
  const needsYou = useMemo(() => needsYouSet(pending.data?.approvals), [pending.data]);
  const validAgent = agent && agents.some((a) => a.config.name === agent) ? agent : undefined;
  const counts = filterCounts(sessions, needsYou, validAgent, now);
  const shown = filterSessions(sessions, { filter, agent: validAgent, needsYou, now });
  const groups = groupByAgent(shown);
  const perAgent = useMemo(() => {
    const base = filterSessions(sessions, { filter, needsYou, now });
    const m: Record<string, number> = { '*': base.length };
    for (const s of base) m[s.agent] = (m[s.agent] ?? 0) + 1;
    return m;
  }, [sessions, filter, needsYou, now]);
  const showSkeleton = useDelayedLoading(q.isPending);
  const agentOf = (name: string) => agents.find((a) => a.config.name === name);

  const lampOf = (s: SessionView): LampState =>
    panic && isActive(s) ? 'panic' : needsYou.has(s.id) ? 'needs-you' : sessionLamp(s);

  const filterLabel = (f: SessionFilter) => t(`sessions.filter.${f}` as 'sessions.filter.all');

  const list = (
    <Screen
      title={t('nav.sessions')}
      pane="list"
      actions={
        <IconButton
          label={t('session.menu.new')}
          icon={<Plus size={20} weight="bold" />}
          onPress={() => setNewFor(validAgent ?? agents[0]?.config.name ?? '')}
        />
      }
    >
      <div className="flex flex-col gap-3 pt-1 pb-3">
        <SegmentedControl
          label={t('sessions.filter.status')}
          size="md"
          className="w-full"
          value={filter}
          onChange={setFilter}
          options={FILTERS.map((f) => ({
            id: f,
            ariaLabel: `${filterLabel(f)}, ${counts[f]}`,
            label: (
              <span className="inline-flex items-baseline gap-1.5">
                {filterLabel(f)}
                <span
                  className={cx(
                    'type-meta tabular-nums',
                    f === 'needs-you' && counts[f] > 0 ? 'text-caution-text' : 'text-ink-3',
                  )}
                >
                  {counts[f]}
                </span>
              </span>
            ),
          }))}
        />
        {agents.length > 1 && (
          <AgentRail agents={agents} value={validAgent} onChange={setAgent} counts={perAgent} />
        )}
      </div>

      {q.isError ? (
        <ErrorState title={t('sessions.error')} details={q.error} onRetry={() => void q.refetch()}>
          {q.error.message}
        </ErrorState>
      ) : q.isPending ? (
        showSkeleton && <Skeleton variant="list" count={5} label={t('sessions.loading')} />
      ) : sessions.length === 0 ? (
        <EmptyState
          glyph={<ChatsTeardrop size={32} />}
          title={t('sessions.empty.title')}
          action={
            agents.length > 0 && (
              <Button variant="primary" onPress={() => setNewFor(agents[0]!.config.name)}>
                {t('session.menu.new')}
              </Button>
            )
          }
          cli={'beamhop session start reviewer "fix the login redirect"'}
        >
          {t('sessions.empty.body')}
        </EmptyState>
      ) : shown.length === 0 ? (
        <EmptyState
          glyph={<ChatsTeardrop size={32} />}
          title={t('sessions.emptyFiltered.title', {
            filter: filterLabel(filter).toLowerCase(),
            agent: validAgent ?? '',
          })}
          action={
            <Button
              variant="secondary"
              onPress={() => {
                setFilter('all');
                setAgent(undefined);
              }}
            >
              {t('sessions.emptyFiltered.reset', { count: sessions.length })}
            </Button>
          }
        >
          {t(`sessions.emptyFiltered.${filter}` as 'sessions.emptyFiltered.all')}
        </EmptyState>
      ) : (
        <div className="-mx-gutter expanded:-mx-5">
          {groups.map((g) => {
            const a = agentOf(g.agent);
            return (
              <section key={g.agent} aria-labelledby={`sg-${g.agent}`}>
                <h2
                  id={`sg-${g.agent}`}
                  className="sticky top-[calc(52px+var(--bh-safe-top))] z-10 flex h-9 items-center gap-2 border-b border-line bg-bg px-gutter type-micro text-ink-2 expanded:top-16 expanded:px-5"
                >
                  {a && <LetterTile code={harnessMonogram(a.config.harness)} size={20} />}
                  <span className="text-ink">{g.agent}</span>
                  <span className="tabular-nums">· {g.sessions.length}</span>
                </h2>
                <ul aria-label={t('sessions.group', { agent: g.agent })}>
                  {g.sessions.map((s) => (
                    <SessionRow
                      key={s.id}
                      s={s}
                      lamp={lampOf(s)}
                      selected={expanded && s.id === currentId}
                      channels={channels.data?.channels}
                      now={now}
                      onNew={setNewFor}
                    />
                  ))}
                </ul>
              </section>
            );
          })}
          <p className="px-gutter pt-4 type-meta text-ink-3 expanded:px-5 pointer-coarse:block pointer-fine:hidden">
            {t('sessions.swipeHint')}
          </p>
        </div>
      )}
      <NewSessionSheet
        isOpen={newFor !== null}
        onOpenChange={(o) => !o && setNewFor(null)}
        agents={agents}
        defaultAgent={newFor ?? undefined}
      />
    </Screen>
  );

  return (
    <SplitView
      hasDetail={hasDetail}
      list={list}
      empty={
        <NoSelection
          live={counts.live}
          needs={counts['needs-you']}
          lampOf={lampOf}
          attention={sessions
            .filter((s) => needsYou.has(s.id) || s.status === 'running' || s.status === 'queued')
            .slice(0, 4)}
        />
      }
    >
      <Outlet />
    </SplitView>
  );
};

const NoSelection = ({
  live,
  needs,
  attention,
  lampOf,
}: {
  live: number;
  needs: number;
  attention: SessionView[];
  lampOf: (s: SessionView) => LampState;
}) => (
  <div id="bh-main-content" className="flex h-full flex-col justify-center gap-3 px-8">
    <ChatsTeardrop size={32} aria-hidden="true" className="text-ink-2" />
    <h2 className="type-title-3 text-ink">{t('sessions.pick.title')}</h2>
    <p className="max-w-[44ch] type-body-sm text-ink-2">{t('sessions.pick.body', { live, needs })}</p>
    {attention.length > 0 && (
      <ul className="mt-3 flex max-w-[520px] flex-col gap-2" aria-label={t('sessions.pick.attention')}>
        {attention.map((s) => (
          <li key={s.id}>
            <Link
              href={`/sessions/${s.id}`}
              className="flex min-h-14 items-center gap-3 rounded-lg border border-line bg-surface px-4 py-2 outline-none data-[hovered]:border-line-strong data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-focus"
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate type-label text-ink">{s.title}</span>
                <MetaLine as="span" items={[s.agent, `thread ${s.threadId}`, usd(s.usage.usd)]} />
              </span>
              <StatusDot state={lampOf(s)} />
            </Link>
          </li>
        ))}
      </ul>
    )}
  </div>
);
