/**
 * Live session view — SCREENS §3, JOURNEYS §3. Route: /sessions/$sessionId (tab bar hidden on compact).
 *
 * Sticky header (lamp, beam line channel → agent, slug), transcript on a tick rail (Transcript.tsx), progress
 * strip + pill composer (Stop always one tap away while live, typing = Steer), prev/next session of the same
 * agent (buttons, `[` `]`, horizontal swipe on touch), Inspector pane ≥1024 (⌘I) or sheet, diff sheet,
 * merge / open PR at session end. Long transcripts render a window of the newest blocks with
 * "Load earlier" plus `content-visibility: auto` on every row.
 *
 * Research used (beyond JOURNEYS §3):
 * - Stick-to-bottom only while at the bottom, detach on upward scroll, "↓ N new" pill to re-attach:
 *   use-stick-to-bottom README (https://www.npmjs.com/package/use-stick-to-bottom), MUI X Chat scrolling
 *   (https://mui.com/x/react-chat/behavior/scrolling/), user reports on Claude desktop auto-scroll
 *   (https://claudeissues.com/issue/53382).
 * - Screen readers: keep the streaming body out of live regions, use a `log` container with live off and
 *   announce status + the finished message instead (https://azukiazusa.dev/en/blog/accessible-streaming-chat-ui,
 *   https://tianpan.co/blog/2026-06-29-streaming-tokens-meet-the-screen-reader, W3C ARIA23
 *   https://w3.org/WAI/WCAG22/Techniques/aria/ARIA23.html).
 */
import type { SessionEventView } from '@beamhop/core';
import {
  ArrowsInLineVertical,
  ArrowsOutLineVertical,
  CaretLeft,
  CaretRight,
  DownloadSimple,
  LinkSimple,
  Plus,
  SidebarSimple,
  Stop,
  StopCircle,
  TextAlignLeft,
} from '@phosphor-icons/react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { motion } from 'motion/react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  harnessSlug,
  sessionLamp,
  targetLabel,
  useApi,
  useConnection,
  useMutationApi,
} from '../../api/index.ts';
import { t } from '../../i18n/index.ts';
import { cx } from '../../lib/cx.ts';
import { clock, since, usd } from '../../lib/format.ts';
import { haptic } from '../../lib/haptics.ts';
import { announce } from '../../lib/live.ts';
import { useExpanded } from '../../lib/media.ts';
import { useNow } from '../../lib/useNow.ts';
import { usePanicState } from '../../shell/panic.tsx';
import { Screen } from '../../shell/Screen.tsx';
import { Button, IconButton, LinkButton } from '../../ui/Button.tsx';
import { MetaLine } from '../../ui/Meta.tsx';
import { reduced as reducedT, spring, useReduced } from '../../ui/motion.ts';
import { ConfirmDialog, Sheet } from '../../ui/Sheet.tsx';
import { EmptyState, ErrorState, Skeleton, SkeletonBlock, useDelayedLoading } from '../../ui/States.tsx';
import { RouteLine, StatusDot } from '../../ui/Status.tsx';
import { useToast } from '../../ui/Toast.tsx';
import { Composer, JumpPill, ProgressStrip } from './Composer.tsx';
import { useSessionAnnouncer, useSessionSwipe, useStickToBottom, useUnseen, useWidth } from './hooks.ts';
import { DiffSheet, Inspector, NewSessionSheet, WorktreeActions } from './Inspector.tsx';
import { OverflowMenu } from './Menu.tsx';
import { buildTranscript, currentActivity, neighbours, sessionDiff } from './model.ts';
import { EmptyTranscript, Transcript, type TranscriptCtx } from './Transcript.tsx';
import './sessions.css';

const WINDOW = 120;
const INSPECTOR_KEY = 'bh.session.inspector';

const readInspector = () => {
  try {
    return localStorage.getItem(INSPECTOR_KEY) !== '0';
  } catch {
    return true;
  }
};

const typing = (e: KeyboardEvent) => {
  const el = e.target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
};

export const SessionScreen = () => {
  const { sessionId } = useParams({ strict: false }) as { sessionId: string };
  const navigate = useNavigate();
  const expanded = useExpanded();
  const reduce = useReduced();
  const toast = useToast();
  const conn = useConnection();
  const { panic } = usePanicState();
  const now = useNow(1000);

  const list = useApi('session.list');
  const events = useApi('session.events', { id: sessionId, afterSeq: 0 });
  const agents = useApi('agent.list');
  const harnesses = useApi('harness.list');
  const channels = useApi('channel.list');
  const approvalsQ = useApi('approval.list', { status: 'all' });

  const sessions = list.data?.sessions ?? [];
  const s = sessions.find((x) => x.id === sessionId);
  const agent = agents.data?.agents.find((a) => a.config.name === s?.agent);
  const evs = events.data?.events ?? [];
  const approvals = approvalsQ.data?.approvals ?? [];
  const approvalMap = useMemo(() => new Map(approvals.map((a) => [a.id, a])), [approvals]);
  const running = s?.status === 'running';
  const blocks = useMemo(() => buildTranscript(evs, running), [evs, running]);
  const activity = useMemo(
    () =>
      s
        ? currentActivity(
            s,
            evs,
            approvals.filter((a) => a.sessionId === s.id),
          )
        : null,
    [s, evs, approvals],
  );
  const diff = useMemo(() => sessionDiff(evs), [evs]);
  const nb = neighbours(sessions, s);

  // ── UI state
  const [limit, setLimit] = useState(WINDOW);
  const [expandAll, setExpandAll] = useState(false);
  const [diffOpen, setDiffOpen] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(readInspector);
  const [inspectorSheet, setInspectorSheet] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [hardStop, setHardStop] = useState(false);
  const [insert, setInsert] = useState<{ text: string; n: number }>();
  const [dir, setDir] = useState(0);
  const freshFrom = useRef<number | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset per session
  useEffect(() => {
    setLimit(WINDOW);
    setExpandAll(false);
    freshFrom.current = null;
  }, [sessionId]);
  if (freshFrom.current === null && events.isSuccess) freshFrom.current = evs.at(-1)?.seq ?? 0;

  // ── Scroll
  const contentRef = useRef<HTMLDivElement>(null);
  const ready = events.isSuccess && list.isSuccess && !!s;
  const { pinned, scrollToBottom } = useStickToBottom(contentRef, ready);
  const unseen = useUnseen(blocks.length, pinned);

  // Preserve position when older blocks are prepended.
  const prependAnchor = useRef<{ h: number; top: number } | null>(null);
  const loadEarlier = () => {
    const sc = contentRef.current?.closest('[data-scroll-root]') as HTMLElement | null;
    prependAnchor.current = sc
      ? { h: sc.scrollHeight, top: sc.scrollTop }
      : { h: document.documentElement.scrollHeight, top: window.scrollY };
    setLimit((l) => l + WINDOW);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs after limit grows
  useLayoutEffect(() => {
    const a = prependAnchor.current;
    if (!a) return;
    prependAnchor.current = null;
    const sc = contentRef.current?.closest('[data-scroll-root]') as HTMLElement | null;
    if (sc) sc.scrollTop = a.top + (sc.scrollHeight - a.h);
    else window.scrollTo({ top: a.top + (document.documentElement.scrollHeight - a.h) });
  }, [limit]);

  useSessionAnnouncer({ session: s, events: evs, activity, ready });

  // ── Mutations
  const send = useMutationApi('session.send');
  const stop = useMutationApi('session.stop');
  const stopAgent = useMutationApi('agent.stop');

  const doStop = useCallback(() => {
    if (!s) return;
    haptic('reject');
    stop
      .mutateAsync({ id: s.id })
      .then(() => toast.show({ message: t('session.stopped', { agent: s.agent, thread: s.threadId }) }))
      .catch((e: Error) => toast.show({ message: e.message, tone: 'error' }));
  }, [s, stop, toast]);

  const onSend = async (text: string) => {
    if (!s) return false;
    try {
      await send.mutateAsync({ id: s.id, text });
      scrollToBottom(!reduce);
      return true;
    } catch (e) {
      toast.show({ message: (e as Error).message, tone: 'error' });
      return false;
    }
  };

  const openInspector = useCallback(() => {
    if (expandedWide.current) {
      setInspectorOpen((o) => {
        try {
          localStorage.setItem(INSPECTOR_KEY, o ? '0' : '1');
        } catch {
          /* ignore */
        }
        return !o;
      });
    } else setInspectorSheet(true);
  }, []);

  const onSlash = (cmd: string) => {
    switch (cmd) {
      case '/stop':
        doStop();
        return true;
      case '/new':
        setNewOpen(true);
        return true;
      case '/details':
        setExpandAll((x) => !x);
        announce(expandAll ? t('session.details.off') : t('session.details.on'));
        return true;
      case '/usage':
        if (expandedWide.current) setInspectorOpen(true);
        else setInspectorSheet(true);
        return true;
      case '/status': {
        if (!s) return true;
        const msg = t('session.statusLine', {
          agent: s.agent,
          status: t(`session.status.${s.status}`),
          cost: usd(s.usage.usd),
          age: since(s.startedAt, now),
        });
        toast.show({ message: msg });
        return true;
      }
      default:
        return false;
    }
  };

  // ── Prev / next
  const go = useCallback(
    (to: 'prev' | 'next') => {
      const target = to === 'prev' ? nb.prev : nb.next;
      if (!target) return;
      setDir(to === 'prev' ? -1 : 1);
      void navigate({ to: '/sessions/$sessionId', params: { sessionId: target.id } });
    },
    [nb.prev, nb.next, navigate],
  );
  const swipe = useSessionSwipe({
    enabled: !expanded,
    onPrev: nb.prev ? () => go('prev') : undefined,
    onNext: nb.next ? () => go('next') : undefined,
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e) || e.altKey) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i') {
        e.preventDefault();
        openInspector();
        return;
      }
      if (e.metaKey || e.ctrlKey) return;
      if (e.key === '[') go('prev');
      else if (e.key === ']') go('next');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, openInspector]);

  // ── Layout: inspector as a column only when the pane is wide enough.
  const paneRef = useRef<HTMLDivElement>(null);
  const paneW = useWidth(paneRef);
  const wideEnough = expanded && paneW >= 980;
  const expandedWide = useRef(wideEnough);
  expandedWide.current = wideEnough;
  const [headerH, setHeaderH] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-find the header when the layout or data changes
  useEffect(() => {
    const header = paneRef.current?.closest('[data-scroll-root]')?.querySelector('header');
    if (!header || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setHeaderH(header.getBoundingClientRect().height));
    ro.observe(header);
    return () => ro.disconnect();
  }, [expanded, ready]);

  const showSkeleton = useDelayedLoading(list.isPending || (events.isPending && !!s));
  const channelProvider = channels.data?.channels.find((c) => c.config.name === s?.channel)?.config.provider;

  // ── Not found / errors
  if (list.isError) {
    return (
      <Shell title={t('session.title')}>
        <ErrorState title={t('session.error.list')} details={list.error} onRetry={() => void list.refetch()}>
          {list.error.message}
        </ErrorState>
      </Shell>
    );
  }
  if (list.isSuccess && !s) {
    return (
      <Shell title={t('session.title')}>
        <EmptyState
          title={t('session.notFound.title')}
          action={
            <LinkButton href="/sessions" variant="secondary">
              {t('session.notFound.back')}
            </LinkButton>
          }
          cli="beamhop session list"
        >
          {t('session.notFound.body', { id: sessionId })}
        </EmptyState>
      </Shell>
    );
  }
  if (!s) {
    return <Shell title={t('session.title')}>{showSkeleton && <TranscriptSkeleton />}</Shell>;
  }

  const lamp = panic && s.status !== 'ended' ? 'panic' : sessionLamp(s);
  const live = running && !panic;
  const queuedAhead =
    s.status === 'queued'
      ? sessions.filter((x) => x.agent === s.agent && x.status === 'queued' && x.startedAt < s.startedAt)
          .length
      : 0;
  const route = (
    <RouteLine
      nodes={[
        { label: targetLabel(`${s.channel}:${s.conversationId}`, channels.data?.channels), kind: 'channel' },
        { label: s.agent, kind: 'agent' },
      ]}
      live={live}
    />
  );
  const slugItems = [
    agent ? harnessSlug(agent.config.harness, harnesses.data?.harnesses) : null,
    `thread ${s.threadId}`,
    s.worktree ? { value: `worktree ${s.worktree.branch}`, truncate: 28 } : null,
    s.status === 'queued'
      ? { value: t('session.queued', { count: queuedAhead }), tone: 'caution' as const }
      : null,
    usd(s.usage.usd),
    since(s.startedAt, now),
  ];
  const disabledReason =
    !conn.online || conn.status === 'closed'
      ? t('session.composer.offline')
      : panic
        ? t('session.composer.panic')
        : undefined;

  const ctx: TranscriptCtx = {
    agent: s.agent,
    channelProvider,
    approvals: approvalMap,
    expandAll,
    now,
    onViewDiff: (d) => setDiffOpen(d),
    onQuote: (text) => setInsert({ text, n: Date.now() }),
  };
  const shown = blocks.slice(Math.max(0, blocks.length - limit));
  const hidden = blocks.length - shown.length;

  const navButtons = (
    <>
      <IconButton
        label={nb.prev ? t('session.prev', { title: nb.prev.title }) : t('session.prevNone')}
        shortcut="["
        icon={<CaretLeft size={20} />}
        isDisabled={!nb.prev}
        onPress={() => go('prev')}
      />
      <IconButton
        label={nb.next ? t('session.next', { title: nb.next.title }) : t('session.nextNone')}
        shortcut="]"
        icon={<CaretRight size={20} />}
        isDisabled={!nb.next}
        onPress={() => go('next')}
      />
    </>
  );
  const menu = (
    <OverflowMenu
      label={t('session.menu')}
      actions={[
        {
          id: 'details',
          label: t('session.menu.inspector'),
          icon: <SidebarSimple size={18} />,
          onAction: openInspector,
        },
        {
          id: 'tools',
          label: expandAll ? t('session.menu.collapseTools') : t('session.menu.expandTools'),
          icon: expandAll ? <ArrowsInLineVertical size={18} /> : <ArrowsOutLineVertical size={18} />,
          onAction: () => setExpandAll((x) => !x),
        },
        {
          id: 'new',
          label: t('session.menu.new'),
          icon: <Plus size={18} />,
          onAction: () => setNewOpen(true),
        },
        {
          id: 'link',
          label: t('session.menu.copyLink'),
          icon: <LinkSimple size={18} />,
          divider: true,
          onAction: () => {
            void navigator.clipboard?.writeText(`${location.origin}/sessions/${s.id}`).catch(() => undefined);
            announce(t('common.copied'));
            toast.show({ message: t('session.menu.linkCopied') });
          },
        },
        {
          id: 'export',
          label: t('session.menu.export'),
          icon: <DownloadSimple size={18} />,
          onAction: () => exportTranscript(s.id, evs),
        },
        {
          id: 'stop',
          label: t('session.menu.stop'),
          icon: <Stop size={18} />,
          tone: 'stop',
          divider: true,
          isDisabled: s.status === 'ended',
          onAction: doStop,
        },
        {
          id: 'hard',
          label: t('session.menu.stopAgent', { agent: s.agent }),
          icon: <StopCircle size={18} />,
          tone: 'stop',
          onAction: () => setHardStop(true),
        },
      ]}
    />
  );

  const subHeader = (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">{route}</div>
        <StatusDot state={lamp} label={s.status === 'queued' ? 'queued' : undefined} />
      </div>
      <MetaLine items={slugItems} />
    </div>
  );

  const inspector = (
    <Inspector
      session={s}
      agent={agent}
      harnesses={harnesses.data?.harnesses}
      approvals={approvals}
      diff={diff}
      onViewDiff={() => setDiffOpen(diff)}
    />
  );

  const footer = (
    <div className="relative">
      {!pinned && (
        <div className="pointer-events-none absolute -top-14 right-0 left-0 flex justify-end px-gutter expanded:px-8">
          <div className="pointer-events-auto">
            <JumpPill count={unseen} onPress={() => scrollToBottom(!reduce)} />
          </div>
        </div>
      )}
      <ProgressStrip activity={panic ? null : activity} agent={s.agent} now={now} />
      <Composer
        session={s}
        live={live}
        disabledReason={disabledReason}
        sending={send.isPending}
        stopping={stop.isPending}
        onSend={onSend}
        onStop={doStop}
        onSlash={onSlash}
        insert={insert}
      />
    </div>
  );

  const ended = s.status === 'ended';
  const body = (
    <div ref={paneRef} className="flex min-w-0 gap-8">
      <motion.div
        key={sessionId}
        initial={dir === 0 ? false : reduce ? { opacity: 0 } : { x: dir * 24, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        transition={reduce ? reducedT : spring.push}
        className="min-w-0 flex-1"
      >
        <div
          {...swipe.bind}
          className={cx(
            'min-h-[50dvh] touch-pan-y',
            !swipe.state.dragging && 'transition-transform duration-[var(--dur-base)] ease-[var(--ease-out)]',
          )}
          style={{ transform: swipe.state.dx ? `translateX(${swipe.state.dx}px)` : undefined }}
          data-testid="transcript-swipe"
        >
          <div ref={contentRef} className="max-w-[760px] pt-3 pb-6">
            {events.isError ? (
              <ErrorState
                title={t('session.error.events')}
                details={events.error}
                onRetry={() => void events.refetch()}
              >
                {events.error.message}
              </ErrorState>
            ) : events.isPending ? (
              showSkeleton && <TranscriptSkeleton />
            ) : (
              <>
                {hidden > 0 && (
                  <div className="pb-4 pl-[52px] expanded:pl-[60px]">
                    <Button variant="secondary" size="sm" onPress={loadEarlier}>
                      {t('session.loadEarlier', { count: Math.min(hidden, WINDOW) })}
                    </Button>
                    <p className="mt-1 type-meta text-ink-3">{t('session.hiddenCount', { count: hidden })}</p>
                  </div>
                )}
                {blocks.length === 0 ? (
                  <EmptyTranscript agent={s.agent} />
                ) : (
                  <Transcript blocks={shown} ctx={ctx} freshFrom={freshFrom.current ?? Infinity} />
                )}
                {ended && <EndCard at={s.lastActivityAt} session={s} disabled={!!disabledReason} />}
              </>
            )}
          </div>
        </div>
      </motion.div>
      {wideEnough && inspectorOpen && (
        <aside
          aria-label={t('session.insp.label')}
          className="sticky w-80 shrink-0 self-start overflow-y-auto border-l border-line py-3 pl-6 pane-scroll"
          style={{ top: headerH, maxHeight: `calc(100dvh - ${headerH + 120}px)` }}
        >
          {inspector}
        </aside>
      )}
    </div>
  );

  const sheets = (
    <>
      <DiffSheet diff={diffOpen} onClose={() => setDiffOpen(null)} session={s} />
      <Sheet
        isOpen={inspectorSheet}
        onOpenChange={setInspectorSheet}
        title={t('session.insp.title')}
        subtitle={`${s.agent} · thread ${s.threadId}`}
        desktop="pane"
      >
        {inspector}
      </Sheet>
      <NewSessionSheet
        isOpen={newOpen}
        onOpenChange={setNewOpen}
        agents={agents.data?.agents ?? []}
        defaultAgent={s.agent}
      />
      <ConfirmDialog
        isOpen={hardStop}
        onOpenChange={setHardStop}
        title={t('session.hardStop.title', { agent: s.agent })}
        confirmLabel={t('session.hardStop.confirm', { agent: s.agent })}
        isPending={stopAgent.isPending}
        onConfirm={async () => {
          await stopAgent
            .mutateAsync({ name: s.agent, hard: true })
            .then(() => {
              setHardStop(false);
              toast.show({ message: t('session.hardStop.done', { agent: s.agent }) });
            })
            .catch((e: Error) => {
              toast.show({ message: e.message, tone: 'error' });
            });
        }}
      >
        {t('session.hardStop.body', { agent: s.agent, count: agent?.activeSessions ?? 0 })}
      </ConfirmDialog>
    </>
  );

  return (
    <Screen
      title={s.agent}
      back={{ href: '/sessions', label: t('nav.sessions') }}
      pane="detail"
      bleed
      maxWidth="none"
      crumbs={[
        { label: t('nav.sessions'), href: '/sessions' },
        { label: s.agent, href: `/agents/${s.agent}` },
        { label: `thread ${s.threadId}` },
      ]}
      actions={
        expanded ? (
          <>
            {navButtons}
            <IconButton
              label={t('session.menu.inspector')}
              shortcut="⌘I"
              icon={<TextAlignLeft size={20} />}
              aria-pressed={wideEnough ? inspectorOpen : undefined}
              onPress={openInspector}
            />
            {menu}
          </>
        ) : (
          <>
            {navButtons}
            {menu}
          </>
        )
      }
      slug={expanded ? subHeader : undefined}
      footer={footer}
    >
      {!expanded && (
        <div
          {...swipe.bind}
          className="sticky top-[calc(52px+var(--bh-safe-top))] z-20 touch-pan-y border-b border-line bg-bg px-gutter pt-1 pb-2"
        >
          {subHeader}
          {(nb.prev || nb.next) && (
            <p className="sr-only">{t('session.swipeHint', { index: nb.index + 1, total: nb.total })}</p>
          )}
        </div>
      )}
      <div className={cx(expanded ? 'px-8' : 'px-gutter')}>{body}</div>
      {sheets}
    </Screen>
  );
};

/** Header-less frame for loading / not found. */
const Shell = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <Screen
    title={title}
    back={{ href: '/sessions', label: t('nav.sessions') }}
    pane="detail"
    crumbs={[{ label: t('nav.sessions'), href: '/sessions' }, { label: title }]}
  >
    {children}
  </Screen>
);

const TranscriptSkeleton = () => (
  <Skeleton label={t('session.loading')}>
    {[0, 1, 2].map((i) => (
      <div key={i} className="flex flex-col gap-2 pl-[52px]">
        <SkeletonBlock className="h-3 w-28" rounded="sm" />
        <SkeletonBlock className={i === 1 ? 'h-24 w-full' : 'h-12 w-4/5'} />
        <SkeletonBlock className="h-3 w-48" rounded="sm" />
      </div>
    ))}
  </Skeleton>
);

const EndCard = ({
  at,
  session,
  disabled,
}: {
  at: string;
  session: Parameters<typeof WorktreeActions>[0]['session'];
  disabled: boolean;
}) => (
  <section
    aria-labelledby="session-end"
    className="mt-2 ml-[52px] rounded-lg border border-line bg-surface p-4 expanded:ml-[60px]"
  >
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 id="session-end" className="type-title-3 text-ink">
        {t('session.end.title')}
      </h2>
      <span className="type-meta text-ink-2">{clock(at)}</span>
    </div>
    <p className="mt-1 type-body-sm text-ink-2">
      {session.worktree
        ? t('session.end.worktree', { branch: session.worktree.branch })
        : t('session.end.plain', { agent: session.agent })}
    </p>
    {session.worktree && (
      <div className="mt-3">
        <WorktreeActions session={session} disabled={disabled} />
      </div>
    )}
  </section>
);

const exportTranscript = (id: string, events: SessionEventView[]) => {
  const blob = new Blob([`${events.map((e) => JSON.stringify(e)).join('\n')}\n`], {
    type: 'application/x-ndjson',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${id}.jsonl`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
