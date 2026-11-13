/**
 * Home — SCREENS §1. The first screen of the day: what needs me, what's running, what it costs,
 * what happened since I last looked.
 *
 * - Briefing slug under the title: `Fri 13 Nov · 1 live · 3 need you · $5.82 today`.
 * - Needs you: compact transmission slips with the same risk-scaled decisions as the Inbox
 *   (LOW = Allow once in place, higher risk / access = the scope or role sheet in place, never a
 *   detour), identical requests collapsed `×3`, plus waiting-on-others and learning counts.
 * - Agents: live lamp + beam line that pulses while the agent streams, last activity, budget meter,
 *   one-tap Stop on live agents (asymmetric friction: stopping is one tap).
 * - Today: total spend against daily budgets + 14-day spend sparkline; month vs budgets.
 * - Recent activity: the audit tail, with "new since 09:12" marks from your last visit.
 * - Signals: security events, policy suggestions, catalog.
 * Refresh button in the bar (pull-to-refresh alternative); every section has its own loading/error.
 *
 * Research used: Linear's "Inbox / My issues" first-screen pattern (one actionable queue first,
 * then status); Vercel / Fly dashboards (spend-to-budget meters next to a short trend);
 * "since you were last here" digests (Slack "All unreads", GitHub dashboard) — mark, don't hide.
 */
import type { AgentView, ApprovalView, AuditEvent, SessionView } from '@beamhop/core';
import { ArrowClockwise, Check, Plus, Stop, X } from '@phosphor-icons/react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import type { LampState } from '../../api/derive.ts';
import {
  agentLamp,
  approvalTarget,
  harnessMonogram,
  RISK_LABEL,
  sortByLamp,
  targetLabel,
  useApi,
  useMutationApi,
  useServerEvent,
} from '../../api/index.ts';
import { t } from '../../i18n/index.ts';
import { cx } from '../../lib/cx.ts';
import { clock, countdown, shortDate, since, usd } from '../../lib/format.ts';
import { useExpanded, useMediaQuery } from '../../lib/media.ts';
import { useNow } from '../../lib/useNow.ts';
import { usePanicState } from '../../shell/panic.tsx';
import { Screen } from '../../shell/Screen.tsx';
import { Button, IconButton, LinkButton } from '../../ui/Button.tsx';
import { Card, TicketCard } from '../../ui/Card.tsx';
import { Sparkline } from '../../ui/Charts.tsx';
import { CliStrip } from '../../ui/CliStrip.tsx';
import { Badge, Eyebrow, LetterTile, MetaLine, RiskTag } from '../../ui/Meta.tsx';
import { ErrorState, Skeleton, useDelayedLoading } from '../../ui/States.tsx';
import { RouteLine, SegmentedMeter, StatusDot } from '../../ui/Status.tsx';
import { useToast } from '../../ui/Toast.tsx';
import { groupApprovals, type SlipGroup, swipeMode, waitingOnOthers } from '../inbox/model.ts';
import { DecisionLayer } from '../inbox/Sheets.tsx';
import { hiddenStore, mineStore, openSheet, useStore } from '../inbox/store.ts';
import { useDecisions } from '../inbox/useDecisions.tsx';

const LAST_VISIT_KEY = 'bh.home.lastVisit';
const WEEKDAYS = [
  t('home.home.sun'),
  t('home.home.mon'),
  t('home.home.tue'),
  t('home.home.wed'),
  t('home.home.thu'),
  t('home.home.fri'),
  t('home.home.sat'),
];

/** The previous visit (read once per mount); this visit is stored for next time. */
const useLastVisit = (): number | null => {
  const [prev] = useState(() => {
    try {
      const v = Number(localStorage.getItem(LAST_VISIT_KEY));
      return Number.isFinite(v) && v > 0 ? v : null;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    const save = () => {
      try {
        localStorage.setItem(LAST_VISIT_KEY, String(Date.now()));
      } catch {
        /* private mode */
      }
    };
    window.addEventListener('pagehide', save);
    return () => {
      save();
      window.removeEventListener('pagehide', save);
    };
  }, []);
  return prev;
};

// ─────────── Needs you ───────────
const SlipPreview = ({ g, now }: { g: SlipGroup; now: number }) => {
  const { decide } = useDecisions();
  const navigate = useNavigate();
  const a = g.lead;
  const left = new Date(a.expiresAt).getTime() - now;
  const target = a.kind === 'access-request' ? t('home.needs.wantsToTalk') : approvalTarget(a);
  const commit = swipeMode(g) === 'commit';
  const [busy, setBusy] = useState<'allow' | 'deny' | null>(null);
  const run = async (allow: boolean) => {
    setBusy(allow ? 'allow' : 'deny');
    await decide(g, allow);
    setBusy(null);
  };
  const allow = () => {
    if (a.kind === 'access-request') openSheet({ type: 'access', approval: a });
    else if (!commit) openSheet({ type: 'scope', group: g });
    else void run(true);
  };
  return (
    <li className="min-w-0">
      <TicketCard
        compact
        decision={
          <div className="flex items-center gap-2">
            <span
              className={cx(
                'min-w-0 flex-1 truncate pl-1 type-meta',
                left < 120_000 ? 'text-caution-text' : 'text-ink-2',
              )}
            >
              <span className="hidden min-[400px]:inline">{t('inbox.slip.autoDenies')} </span>
              <span className={cx('tabular-nums', left >= 120_000 && 'text-ink')}>{countdown(left)}</span>
            </span>
            <Button
              variant="deny"
              size="sm"
              icon={<X size={16} weight="bold" aria-hidden="true" />}
              onPress={() => void run(false)}
              isPending={busy === 'deny'}
              aria-label={`${a.kind === 'access-request' ? t('inbox.btn.ignore') : t('inbox.btn.deny')} ${a.agent}: ${target}`}
            >
              {a.kind === 'access-request' ? t('inbox.btn.ignore') : t('inbox.btn.deny')}
            </Button>
            <Button
              variant="allow"
              size="sm"
              icon={<Check size={16} weight="bold" aria-hidden="true" />}
              onPress={allow}
              isPending={busy === 'allow'}
              aria-label={
                commit
                  ? `${t('inbox.btn.allowOnce')} ${a.agent}: ${target}`
                  : `${t('inbox.btn.allowScoped')} ${a.agent}: ${target} (${t('home.needs.chooseScope')})`
              }
            >
              {commit ? t('inbox.btn.allowOnce') : t('inbox.btn.allowScoped')}
            </Button>
          </div>
        }
      >
        <button
          type="button"
          onClick={() => void navigate({ to: '/inbox/$approvalId', params: { approvalId: a.id } })}
          className="-mx-1 -my-1 flex w-[calc(100%+8px)] min-w-0 flex-col gap-1 rounded-md px-1 py-1 text-left outline-none hover:bg-sunken focus-visible:outline-2 focus-visible:outline-focus"
        >
          <span className="flex w-full min-w-0 items-center gap-2">
            <StatusDot state="needs-you" hideLabel />
            <span className="shrink-0 type-label text-ink">{a.agent}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[13px] leading-5 text-ink" title={target}>
              <span aria-hidden="true" className="text-ink-3">
                ·{' '}
              </span>
              {target}
            </span>
            {g.items.length > 1 && <Badge tone="outline">×{g.items.length}</Badge>}
            <RiskTag risk={RISK_LABEL[a.risk]} />
          </span>
          <span className="truncate pl-[18px] type-body-sm text-ink-2">{a.title}</span>
        </button>
      </TicketCard>
    </li>
  );
};

const NeedsYou = ({
  pending,
  now,
  suggestions,
}: {
  pending: ApprovalView[];
  now: number;
  suggestions: number;
}) => {
  const expanded = useExpanded();
  const medium = useMediaQuery('(min-width: 37.5rem)');
  const mine = useStore(mineStore);
  const hidden = useStore(hiddenStore);
  const waiting = pending.filter((a) => waitingOnOthers(a, mine));
  const groups = groupApprovals(pending.filter((a) => !hidden.has(a.id) && !waitingOnOthers(a, mine)));
  const shown = groups.slice(0, expanded || medium ? 3 : 1);
  const more = groups.length - shown.length;
  const extras = [
    more > 0 ? t('home.needs.more', { count: more }) : null,
    waiting.length > 0 ? t('home.needs.waiting', { count: waiting.length }) : null,
    suggestions > 0 ? t('home.needs.learning', { count: suggestions }) : null,
  ].filter(Boolean) as string[];
  return (
    <section aria-labelledby="home-needs">
      <Eyebrow id="home-needs" count={groups.length} href="/inbox">
        {t('home.needs.title')}
      </Eyebrow>
      {groups.length === 0 ? (
        <div className="flex items-center gap-3 rounded-lg border border-dashed border-line-strong px-4 py-3">
          <StatusDot state="ready" hideLabel />
          <p className="type-body-sm text-ink-2">
            <span className="text-ink">{t('inbox.clear.title')}</span> {t('inbox.clear.short')}
          </p>
        </div>
      ) : (
        <ul
          className={cx(
            'grid gap-2',
            !expanded && medium && 'grid-cols-3',
            !expanded && medium && shown.length < 3 && 'grid-cols-2',
          )}
        >
          {shown.map((g) => (
            <SlipPreview key={g.key} g={g} now={now} />
          ))}
        </ul>
      )}
      {extras.length > 0 && (
        <p className="mt-1.5 flex flex-wrap items-center gap-x-1 type-body-sm text-ink-2">
          <LinkButton href="/inbox" variant="quiet" size="sm" className="-ml-3">
            {extras[0]}
          </LinkButton>
          {extras.slice(1).map((x) => (
            <span key={x} className="type-meta">
              <span aria-hidden="true">· </span>
              {x}
            </span>
          ))}
        </p>
      )}
    </section>
  );
};

// ─────────── Agent card ───────────
const AgentCard = ({
  a,
  lamp,
  session,
  channels,
}: {
  a: AgentView;
  lamp: LampState;
  session?: SessionView;
  channels: Parameters<typeof targetLabel>[1];
}) => {
  const toast = useToast();
  const stop = useMutationApi('agent.stop');
  const live = session?.status === 'running';
  const streaming = a.status === 'busy';
  const events = useApi(
    'session.events',
    { id: session?.id ?? '', afterSeq: 0 },
    { enabled: !!session && live },
  );
  const [pulse, setPulse] = useState(0);
  useServerEvent((e) => {
    if (
      e.type === 'session.event' &&
      e.sessionId === session?.id &&
      (e.event.kind === 'tool_call' || e.event.kind === 'user')
    )
      setPulse((p) => p + 1);
  });
  const last = [...(events.data?.events ?? [])]
    .reverse()
    .find((e) => e.kind === 'progress' || e.kind === 'assistant' || e.kind === 'permission');
  const lastText = !live
    ? undefined
    : last?.kind === 'permission'
      ? t('home.agent.waiting', { what: last.text ?? '' })
      : last?.text;
  const membership = session
    ? `${session.channel}:${session.conversationId}`
    : a.config.memberships[0]?.target;
  const budget = a.config.budgets.dailyUsd ?? 0;
  const href = session && live ? `/sessions/${session.id}` : `/agents/${a.config.name}`;
  const learning = a.config.sandbox.profile === 'custom' && a.config.public;
  const word =
    lamp === 'needs-you' ? t('home.home.needsYou') : learning && lamp === 'ready' ? 'learning' : undefined;
  return (
    <Card
      href={href}
      linkLabel={t(live ? 'home.agent.openLive' : 'home.agent.open', {
        name: a.config.name,
        state: word ?? lamp,
      })}
      className="flex h-full flex-col"
    >
      <div className="flex flex-col gap-2.5">
        <div className="flex items-center gap-3">
          <LetterTile code={harnessMonogram(a.config.harness)} />
          <h3 className="min-w-0 flex-1 truncate type-title-3 text-ink">{a.config.name}</h3>
          <StatusDot state={lamp} label={word} />
          {streaming && (
            <Button
              variant="destructive-outline"
              size="sm"
              className="-my-1.5 pointer-fine:-my-1"
              icon={<Stop size={14} weight="fill" aria-hidden="true" />}
              aria-label={t('home.agent.stop', { name: a.config.name })}
              isPending={stop.isPending}
              onPress={() =>
                stop
                  .mutateAsync({ name: a.config.name })
                  .then(() => toast.show({ message: t('home.agent.stopped', { name: a.config.name }) }))
                  .catch((e: Error) => toast.show({ message: e.message, tone: 'error' }))
              }
            >
              {t('home.agent.stopShort')}
            </Button>
          )}
        </div>
        <MetaLine
          items={[
            `${a.config.harness}${a.config.model !== 'default' ? ` · ${a.config.model}` : ''}`,
            a.config.sandbox.profile,
            a.location.kind === 'cloud' ? `${a.location.provider ?? 'cloud'}` : 'local',
          ]}
        />
        {membership && (
          <RouteLine
            nodes={[
              { label: targetLabel(membership, channels), kind: 'channel' },
              { label: a.config.name, kind: 'agent' },
            ]}
            pulse={pulse}
            live={streaming}
            state={lamp === 'error' ? 'broken' : 'ok'}
            reason={lamp === 'error' ? a.error : undefined}
          />
        )}
        <p className="flex items-baseline gap-3 type-body-sm text-ink-2">
          <span className={cx('min-w-0 flex-1 truncate', lastText && 'text-ink')}>
            {lastText
              ? `“${lastText}”`
              : a.status === 'stopped'
                ? t('home.agent.stoppedLine')
                : a.lastActivityAt
                  ? t('home.agent.idle', { since: since(a.lastActivityAt) })
                  : t('home.agent.never')}
          </span>
          {session && live && (
            <span className="shrink-0 type-meta">
              thread {session.threadId} · {since(session.startedAt)}
            </span>
          )}
        </p>
      </div>
      {budget > 0 && (
        <div className="mt-auto pt-3">
          <SegmentedMeter
            name={`${a.config.name} budget today`}
            value={a.usageToday.usd}
            max={budget}
            label={`${usd(a.usageToday.usd)} / ${usd(budget)} today`}
            valueText={`${usd(a.usageToday.usd)} of ${usd(budget)} used today`}
          />
        </div>
      )}
    </Card>
  );
};

// ─────────── Today (budgets) ───────────
const Spend = ({ agents }: { agents: AgentView[] }) => {
  const usage = useApi('usage.query', { days: 30 });
  const today = agents.reduce((s, a) => s + a.usageToday.usd, 0);
  const daily = agents.reduce((s, a) => s + (a.config.budgets.dailyUsd ?? 0), 0);
  const rows = usage.data?.rows ?? [];
  const byDay = new Map<string, number>();
  for (const r of rows) byDay.set(r.day, (byDay.get(r.day) ?? 0) + r.usd);
  const days = [...byDay.keys()].sort().slice(-14);
  const trend = days.map((d) => Math.round((byDay.get(d) ?? 0) * 100) / 100);
  const month = rows.reduce((s, r) => s + r.usd, 0);
  const monthBudget = daily * 30;
  const near = agents.filter(
    (a) => (a.config.budgets.dailyUsd ?? 0) > 0 && a.usageToday.usd / (a.config.budgets.dailyUsd ?? 1) >= 0.8,
  );
  return (
    <section aria-labelledby="home-spend">
      <Eyebrow id="home-spend" href="/audit">
        {t('home.spend.title')}
      </Eyebrow>
      <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
        <div className="flex items-end justify-between gap-4">
          <p className="flex flex-col">
            <span className="font-mono text-[28px] leading-8 font-medium tabular-nums text-ink">
              {usd(today)}
            </span>
            <span className="type-meta text-ink-2">{t('home.spend.today', { budget: usd(daily, 0) })}</span>
          </p>
          {trend.length > 1 && (
            // The sparkline's sr-only data table is wider than the card: clip it (no page overflow).
            <span className="relative block overflow-hidden">
              <Sparkline
                values={trend}
                width={112}
                height={28}
                label={t('home.spend.trend', {
                  days: trend.length,
                  total: usd(trend.reduce((s, v) => s + v, 0)),
                })}
                labels={days.map((d) => shortDate(d))}
              />
            </span>
          )}
        </div>
        <SegmentedMeter
          name={t('home.spend.todayMeter')}
          value={today}
          max={daily}
          label={`${Math.round((today / Math.max(daily, 0.01)) * 100)}% of daily`}
          valueText={`${usd(today)} of ${usd(daily)} daily budgets used`}
        />
        {usage.data && (
          <SegmentedMeter
            name={t('home.spend.monthMeter')}
            value={month}
            max={monthBudget}
            label={t('home.spend.month', { spent: usd(month), budget: usd(monthBudget, 0) })}
            valueText={`${usd(month)} of ${usd(monthBudget, 0)} monthly budgets used`}
          />
        )}
        {near.length > 0 && (
          <p className="type-body-sm text-caution-text">
            {t('home.spend.near', { names: near.map((a) => a.config.name).join(', '), count: near.length })}
          </p>
        )}
      </div>
    </section>
  );
};

// ─────────── Recent activity ───────────
const SEVERITY_LAMP: Record<AuditEvent['severity'], LampState> = {
  info: 'stopped',
  warn: 'needs-you',
  security: 'error',
};

const Recent = ({ lastVisit }: { lastVisit: number | null }) => {
  const audit = useApi('audit.query', { limit: 30 });
  const expanded = useExpanded();
  const events = (audit.data?.events ?? []).slice(0, expanded ? 7 : 5);
  const fresh = lastVisit
    ? (audit.data?.events ?? []).filter((e) => new Date(e.at).getTime() > lastVisit).length
    : 0;
  return (
    <section aria-labelledby="home-recent">
      <Eyebrow
        id="home-recent"
        href="/audit?tab=log"
        action={
          lastVisit && fresh > 0 ? (
            <span className="type-meta text-flare-text">
              {t('home.recent.new', { count: fresh, time: clock(lastVisit) })}
            </span>
          ) : undefined
        }
      >
        {t('home.recent.title')}
      </Eyebrow>
      {audit.isError ? (
        <ErrorState
          title={t('home.recent.error')}
          onRetry={() => void audit.refetch()}
          details={audit.error}
        />
      ) : events.length === 0 ? (
        <p className="type-body-sm text-ink-2">{audit.isPending ? '' : t('home.recent.empty')}</p>
      ) : (
        <ol className="flex flex-col border-l border-line">
          {events.map((e) => {
            const isNew = !!lastVisit && new Date(e.at).getTime() > lastVisit;
            return (
              <li key={e.id} className="relative flex min-h-11 items-start gap-3 py-1.5 pl-4">
                <span
                  aria-hidden="true"
                  className={cx(
                    'absolute top-[15px] left-0 h-px w-2.5',
                    isNew ? 'bg-flare' : 'bg-line-strong',
                  )}
                />
                <span className="w-11 shrink-0 pt-0.5 type-meta tabular-nums text-ink-2">{clock(e.at)}</span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-start gap-2">
                    {e.severity === 'info' ? (
                      <span className="mt-[9px] size-1.5 shrink-0 rounded-full bg-ink-3">
                        <span className="sr-only">info</span>
                      </span>
                    ) : (
                      <StatusDot
                        state={SEVERITY_LAMP[e.severity]}
                        label={e.severity}
                        hideLabel
                        className="mt-[5px]"
                      />
                    )}
                    <span className="min-w-0 type-body-sm text-ink">{e.summary}</span>
                  </span>
                  {isNew && <span className="sr-only">{t('home.recent.newMark')}</span>}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
};

// ─────────── Signals ───────────
const Signals = () => {
  const audit = useApi('audit.query', { severity: 'security', limit: 200 });
  const suggestions = useApi('policy.suggestions');
  const harnesses = useApi('harness.list');
  const channels = useApi('channel.list');
  const today = new Date().toDateString();
  const sec = (audit.data?.events ?? []).filter((e) => new Date(e.at).toDateString() === today).length;
  const sug = suggestions.data?.suggestions.length ?? 0;
  const broken = (channels.data?.channels ?? []).filter((c) => c.status === 'error');
  const rows: Array<{ lamp: LampState; text: string; href?: string; word: string }> = [
    ...broken.map((c) => ({
      lamp: 'error' as LampState,
      word: 'error',
      text: t('home.signals.channel', { name: c.config.name, error: c.error ?? 'error' }),
      href: `/channels/${c.config.name}`,
    })),
    {
      lamp: sec > 0 ? 'error' : 'ready',
      word: sec > 0 ? 'attention' : 'clear',
      text: t('home.signals.security', { count: sec }),
      href: '/audit?tab=security',
    },
    {
      lamp: sug > 0 ? 'needs-you' : 'ready',
      word: sug > 0 ? t('home.home.needsYou') : 'clear',
      text: t('home.signals.policy', { count: sug }),
      href: '/policy',
    },
    {
      lamp: 'stopped',
      word: 'info',
      text: t('home.signals.catalog', { count: harnesses.data?.harnesses.length ?? 0 }),
      href: '/harnesses',
    },
  ];
  return (
    <section aria-labelledby="home-signals">
      <Eyebrow id="home-signals">{t('home.signals.title')}</Eyebrow>
      <ul className="-mx-2 flex flex-col">
        {rows.map((r) => (
          <li key={r.text}>
            <LinkRow href={r.href ?? '/'}>
              <StatusDot state={r.lamp} label={r.word} hideLabel />
              <span className="flex-1 type-body-sm text-ink">{r.text}</span>
              <span aria-hidden="true" className="font-mono text-ink-3">
                →
              </span>
            </LinkRow>
          </li>
        ))}
      </ul>
    </section>
  );
};

const LinkRow = ({ href, children }: { href: string; children: React.ReactNode }) => {
  const navigate = useNavigate();
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        void navigate({ href });
      }}
      className="flex min-h-11 items-center gap-3 rounded-md px-2 outline-none hover:bg-sunken focus-visible:outline-2 focus-visible:outline-focus"
    >
      {children}
    </a>
  );
};

// ─────────── Empty (no agents) ───────────
const FirstAgent = () => {
  const presets = useApi('agent.presets');
  return (
    <section aria-labelledby="home-first" className="flex max-w-[560px] flex-col gap-5 py-4">
      <div className="rounded-lg border border-line bg-surface p-4">
        <RouteLine
          nodes={[
            { label: t('inbox.clear.you'), kind: 'device' },
            { label: 'relays', kind: 'relay' },
            { label: t('home.first.agent'), kind: 'agent' },
          ]}
          aria-label={t('home.first.route')}
        />
      </div>
      <div>
        <h2 id="home-first" className="type-title-2 text-ink">
          {t('home.first.title')}
        </h2>
        <p className="mt-1 type-body text-ink-2">{t('home.first.body')}</p>
      </div>
      {(presets.data?.presets.length ?? 0) > 0 && (
        <ul className="-mx-2 flex flex-col">
          {presets.data?.presets.map((p) => (
            <li key={p.id}>
              <LinkRow href={`/agents/new?preset=${p.id}`}>
                <span className="flex min-w-0 flex-1 flex-col py-1.5">
                  <span className="type-label text-ink">{p.title}</span>
                  <span className="type-body-sm text-ink-2">{p.description}</span>
                </span>
                <span aria-hidden="true" className="font-mono text-ink-3">
                  →
                </span>
              </LinkRow>
            </li>
          ))}
        </ul>
      )}
      <LinkButton href="/agents/new" variant="primary" className="self-start">
        {t('home.first.cta')}
      </LinkButton>
      <CliStrip command="beamhop agent create" />
    </section>
  );
};

// ─────────── Screen ───────────
export const HomeScreen = () => {
  const now = useNow(1000);
  const qc = useQueryClient();
  const agents = useApi('agent.list');
  const approvals = useApi('approval.list', { status: 'pending' });
  const sessions = useApi('session.list');
  const channels = useApi('channel.list');
  const suggestions = useApi('policy.suggestions');
  const { panic } = usePanicState();
  const showSkeleton = useDelayedLoading(agents.isPending);
  const lastVisit = useLastVisit();
  const expanded = useExpanded();
  const [refreshing, setRefreshing] = useState(false);

  const cards = useMemo(() => {
    const pending = approvals.data?.approvals ?? [];
    const ses = sessions.data?.sessions ?? [];
    return sortByLamp(
      (agents.data?.agents ?? []).map((a) => {
        const lamp = agentLamp(a, {
          pending: pending.filter((p) => p.agent === a.config.name).length,
          panic: panic && a.status === 'stopped',
        });
        const session =
          ses.find((s) => s.agent === a.config.name && s.status === 'running') ??
          ses.find((s) => s.agent === a.config.name);
        return { a, lamp, session, last: a.lastActivityAt };
      }),
    );
  }, [agents.data, approvals.data, sessions.data, panic]);

  const pending = approvals.data?.approvals ?? [];
  const list = cards.map((c) => c.a);
  const live = list.filter((a) => a.status === 'busy').length;
  const spent = list.reduce((s, a) => s + a.usageToday.usd, 0);
  const d = new Date(now);
  const needs = groupApprovals(pending).length;
  const briefing = agents.data ? (
    <MetaLine
      className="whitespace-normal"
      items={[
        expanded ? `${WEEKDAYS[d.getDay()]} ${shortDate(d)}` : shortDate(d),
        live > 0 ? { value: `${live} live`, tone: 'flare' } : t('home.brief.quiet'),
        needs > 0 ? { value: `${needs} need you`, tone: 'caution' } : t('home.brief.clear'),
        `${usd(spent)} today`,
      ]}
    />
  ) : undefined;

  const refresh = async () => {
    setRefreshing(true);
    await qc.invalidateQueries({ queryKey: ['bh'] });
    setRefreshing(false);
  };

  const sugCount = suggestions.data?.suggestions.length ?? 0;

  return (
    <>
      <Screen
        title={t('nav.home')}
        maxWidth="none"
        slug={briefing}
        actions={
          <IconButton
            label={refreshing ? t('home.refreshing') : t('home.refresh')}
            icon={
              <ArrowClockwise
                size={20}
                className={cx(refreshing && 'animate-spin motion-reduce:animate-none')}
              />
            }
            onPress={() => void refresh()}
            isDisabled={refreshing}
          />
        }
      >
        {agents.isError ? (
          <ErrorState title={t('home.error')} details={agents.error} onRetry={() => void agents.refetch()}>
            {agents.error.message}
          </ErrorState>
        ) : agents.isPending ? (
          showSkeleton ? (
            <Skeleton variant="cards" count={3} label={t('home.loading')} />
          ) : null
        ) : cards.length === 0 ? (
          <>
            {pending.length > 0 && <NeedsYou pending={pending} now={now} suggestions={sugCount} />}
            <FirstAgent />
          </>
        ) : (
          <div className="flex flex-col gap-8 expanded:grid expanded:grid-cols-[minmax(320px,400px)_1fr] expanded:items-start expanded:gap-x-10">
            <div className="flex flex-col gap-8 expanded:sticky expanded:top-[72px]">
              <NeedsYou pending={pending} now={now} suggestions={sugCount} />
              <div className="hidden expanded:flex expanded:flex-col expanded:gap-8">
                <Spend agents={list} />
                <Signals />
              </div>
            </div>
            <div className="flex min-w-0 flex-col gap-8">
              <section aria-labelledby="home-agents" className="min-w-0">
                <Eyebrow
                  id="home-agents"
                  count={cards.length}
                  href="/agents"
                  action={
                    <LinkButton
                      href="/agents/new"
                      variant="quiet"
                      size="sm"
                      icon={<Plus size={16} weight="bold" aria-hidden="true" />}
                    >
                      {t('home.agents.new')}
                    </LinkButton>
                  }
                >
                  {t('home.agents.title')}
                </Eyebrow>
                <ul className="grid grid-cols-1 gap-3 medium:grid-cols-2 expanded:grid-cols-[repeat(auto-fill,minmax(280px,1fr))]">
                  {cards.map((c) => (
                    <li key={c.a.config.name} className="min-w-0">
                      <AgentCard
                        a={c.a}
                        lamp={c.lamp}
                        session={c.session}
                        channels={channels.data?.channels}
                      />
                    </li>
                  ))}
                </ul>
              </section>
              <div className="flex flex-col gap-8 expanded:hidden">
                <Spend agents={list} />
              </div>
              <Recent lastVisit={lastVisit} />
              <div className="expanded:hidden">
                <Signals />
              </div>
            </div>
          </div>
        )}
      </Screen>
      <DecisionLayer />
    </>
  );
};
