/**
 * Home — SCREENS §1. A basic real version built by the foundation to prove the data layer
 * (queries, live events, mutations with undo). The home builder may refine it (pull-to-refresh,
 * card overflow menu, empty-state presets, medium 3-slip row).
 * Owns: src/screens/home/**.
 */
import type { AgentView, ApprovalView, SessionView } from '@beamhop/core';
import { Check, Plus, X } from '@phosphor-icons/react';
import { useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import type { LampState } from '../../api/derive.ts';
import {
  agentLamp,
  approvalTarget,
  harnessMonogram,
  RISK_LABEL,
  sortByLamp,
  targetLabel,
  useApi,
  useCall,
  useMutationApi,
  useServerEvent,
} from '../../api/index.ts';
import { cx } from '../../lib/cx.ts';
import { countdown, since, usd } from '../../lib/format.ts';
import { haptic } from '../../lib/haptics.ts';
import { useExpanded } from '../../lib/media.ts';
import { useNow } from '../../lib/useNow.ts';
import { usePanicState } from '../../shell/panic.tsx';
import { Screen } from '../../shell/Screen.tsx';
import { Button, LinkButton } from '../../ui/Button.tsx';
import { Card, TicketCard } from '../../ui/Card.tsx';
import { Eyebrow, LetterTile, MetaLine, RiskTag } from '../../ui/Meta.tsx';
import { EmptyState, ErrorState, Skeleton, useDelayedLoading } from '../../ui/States.tsx';
import { RouteLine, SegmentedMeter, StatusDot } from '../../ui/Status.tsx';
import { useToast } from '../../ui/Toast.tsx';

// ─────────── Needs you ───────────
const SlipPreview = ({ a, now }: { a: ApprovalView; now: number }) => {
  const toast = useToast();
  const navigate = useNavigate();
  const decide = useMutationApi('approval.decide');
  const call = useCall();
  const left = new Date(a.expiresAt).getTime() - now;
  const low = a.risk === 'low';
  const target = approvalTarget(a);
  const run = (allow: boolean) => {
    haptic(allow ? 'confirm' : 'reject');
    // mutateAsync, not mutate({onSuccess}): the slip unmounts as soon as the decision event lands,
    // and per-call mutate callbacks never fire after unmount.
    decide
      .mutateAsync({ id: a.id, allow })
      .then(() =>
        toast.show({
          message: (
            <>
              {allow ? 'Allowed once' : 'Denied'} · <span className="font-mono text-[0.9em]">{target}</span>
            </>
          ),
          spoken: `${allow ? 'Allowed once' : 'Denied'}: ${target}`,
          onUndo: async () => {
            try {
              await call('approval.undo', { id: a.id });
            } catch (e) {
              toast.show({ message: (e as Error).message, tone: 'error' });
            }
          },
        }),
      )
      .catch((e: Error) => toast.show({ message: e.message, tone: 'error' }));
  };
  return (
    <li>
      <TicketCard
        compact
        decision={
          <div className="flex items-center gap-2">
            <span
              className={cx(
                'min-w-0 flex-1 pl-1 type-meta',
                left < 120_000 ? 'text-caution-text' : 'text-ink-2',
              )}
            >
              Auto-denies in <span className="text-ink tabular-nums">{countdown(left)}</span>
            </span>
            <Button
              variant="deny"
              size="sm"
              icon={<X size={16} weight="bold" aria-hidden="true" />}
              onPress={() => run(false)}
              aria-label={`Deny ${a.agent}: ${target}`}
              isPending={decide.isPending && decide.variables?.allow === false}
            >
              Deny
            </Button>
            {low ? (
              <Button
                variant="allow"
                size="sm"
                icon={<Check size={16} weight="bold" aria-hidden="true" />}
                onPress={() => run(true)}
                aria-label={`Allow once ${a.agent}: ${target}`}
                isPending={decide.isPending && decide.variables?.allow === true}
              >
                Allow once
              </Button>
            ) : (
              <Button
                variant="allow"
                size="sm"
                icon={<Check size={16} weight="bold" aria-hidden="true" />}
                onPress={() => void navigate({ to: '/inbox/$approvalId', params: { approvalId: a.id } })}
                aria-label={`Allow… ${a.agent}: ${target} (choose scope)`}
              >
                Allow…
              </Button>
            )}
          </div>
        }
      >
        <div className="flex items-center gap-2">
          <StatusDot state="needs-you" hideLabel />
          <span className="shrink-0 type-label text-ink">{a.agent}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[13px] leading-5 text-ink" title={target}>
            <span aria-hidden="true" className="text-ink-3">
              ·{' '}
            </span>
            {target}
          </span>
          <RiskTag risk={RISK_LABEL[a.risk]} />
        </div>
      </TicketCard>
    </li>
  );
};

const NeedsYou = ({ approvals, now }: { approvals: ApprovalView[]; now: number }) => {
  const expanded = useExpanded();
  const shown = approvals.slice(0, expanded ? 3 : 1);
  return (
    <section aria-labelledby="home-needs">
      <Eyebrow id="home-needs" count={approvals.length} href="/inbox">
        Needs you
      </Eyebrow>
      {approvals.length === 0 ? (
        <p className="type-body-sm text-ink-2">Inbox clear. Nothing is waiting on you.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {shown.map((a) => (
            <SlipPreview key={a.id} a={a} now={now} />
          ))}
        </ul>
      )}
      {approvals.length > shown.length && (
        <LinkButton href="/inbox" variant="quiet" size="sm" className="mt-1 -ml-3">
          + {approvals.length - shown.length} more
        </LinkButton>
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
  const live = session?.status === 'running';
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
  const lastText = last?.kind === 'permission' ? `waiting for approval: ${last.text ?? ''}` : last?.text;
  const membership = session
    ? `${session.channel}:${session.conversationId}`
    : a.config.memberships[0]?.target;
  const budget = a.config.budgets.dailyUsd ?? 0;
  const href = session && live ? `/sessions/${session.id}` : `/agents/${a.config.name}`;
  const learning = a.config.sandbox.profile === 'custom' && a.config.public;
  return (
    <Card
      href={href}
      linkLabel={`${a.config.name}, ${lamp === 'live' ? 'live' : lamp}. Open ${live ? 'live session' : 'agent'}`}
      className="flex flex-col"
    >
      <div className="flex flex-col gap-2.5">
        <div className="flex items-center gap-3">
          <LetterTile code={harnessMonogram(a.config.harness)} />
          <h3 className="min-w-0 flex-1 truncate type-title-3 text-ink">{a.config.name}</h3>
          <StatusDot
            state={lamp}
            label={lamp === 'needs-you' ? 'needs you' : learning && lamp === 'ready' ? 'learning' : undefined}
          />
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
            state={lamp === 'error' ? 'broken' : 'ok'}
          />
        )}
        <p className="flex items-baseline gap-3 type-body-sm text-ink-2">
          <span className="min-w-0 flex-1 truncate">
            {lastText
              ? `“${lastText}”`
              : a.status === 'stopped'
                ? 'stopped'
                : `idle ${a.lastActivityAt ? since(a.lastActivityAt) : ''}`}
          </span>
          {session && live && (
            <span className="shrink-0 type-meta">
              thread {session.threadId} · {since(session.startedAt)}
            </span>
          )}
        </p>
        {budget > 0 && (
          <SegmentedMeter
            name={`${a.config.name} budget today`}
            value={a.usageToday.usd}
            max={budget}
            label={`${usd(a.usageToday.usd)} / ${usd(budget)} today`}
            valueText={`${usd(a.usageToday.usd)} of ${usd(budget)} used today`}
          />
        )}
      </div>
    </Card>
  );
};

// ─────────── Signals ───────────
const Signals = () => {
  const audit = useApi('audit.query', { severity: 'security', limit: 200 });
  const suggestions = useApi('policy.suggestions');
  const harnesses = useApi('harness.list');
  const today = new Date().toDateString();
  const sec = (audit.data?.events ?? []).filter((e) => new Date(e.at).toDateString() === today).length;
  const sug = suggestions.data?.suggestions.length ?? 0;
  const rows: Array<{ lamp: LampState; text: string; href?: string; word: string }> = [
    {
      lamp: sec > 0 ? 'error' : 'ready',
      word: sec > 0 ? 'attention' : 'clear',
      text: `${sec} security ${sec === 1 ? 'event' : 'events'} today`,
      href: '/audit?tab=security',
    },
    {
      lamp: sug > 0 ? 'needs-you' : 'ready',
      word: sug > 0 ? 'needs you' : 'clear',
      text: `Policy: ${sug} learning ${sug === 1 ? 'suggestion' : 'suggestions'}`,
      href: '/policy',
    },
    {
      lamp: 'stopped',
      word: 'info',
      text: `Catalog updated · ${harnesses.data?.harnesses.length ?? 0} harnesses`,
    },
  ];
  return (
    <section aria-labelledby="home-signals">
      <Eyebrow id="home-signals">Signals</Eyebrow>
      <ul className="-mx-2 flex flex-col">
        {rows.map((r) => {
          const inner = (
            <>
              <StatusDot state={r.lamp} label={r.word} hideLabel />
              <span className="flex-1 type-body-sm text-ink">{r.text}</span>
              {r.href && (
                <span aria-hidden="true" className="font-mono text-ink-3">
                  →
                </span>
              )}
            </>
          );
          return (
            <li key={r.text}>
              {r.href ? (
                <LinkRow href={r.href}>{inner}</LinkRow>
              ) : (
                <div className="flex min-h-11 items-center gap-3 px-2">{inner}</div>
              )}
            </li>
          );
        })}
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
      className="flex min-h-11 items-center gap-3 rounded-md px-2 outline-none hover:bg-sunken"
    >
      {children}
    </a>
  );
};

const MonthSpend = ({ agents }: { agents: AgentView[] }) => {
  const usage = useApi('usage.query', { days: 30 });
  const total = (usage.data?.rows ?? []).reduce((a, r) => a + r.usd, 0);
  const budgets = agents.reduce((a, x) => a + (x.config.budgets.dailyUsd ?? 0), 0) * 30;
  if (!usage.data) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="type-micro text-ink-2">This month</span>
      <SegmentedMeter
        name="Spend this month against budgets"
        value={total}
        max={budgets}
        label={`${usd(total)} of ${usd(budgets, 0)} budgets`}
        valueText={`${usd(total)} of ${usd(budgets, 0)} monthly budgets`}
      />
    </div>
  );
};

// ─────────── Screen ───────────
export const HomeScreen = () => {
  const now = useNow(1000);
  const agents = useApi('agent.list');
  const approvals = useApi('approval.list', { status: 'pending' });
  const sessions = useApi('session.list');
  const channels = useApi('channel.list');
  const { panic } = usePanicState();
  const showSkeleton = useDelayedLoading(agents.isPending);

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

  return (
    <Screen title="Home" maxWidth="none">
      {agents.isError ? (
        <ErrorState
          title="Couldn't load your agents."
          details={agents.error}
          onRetry={() => void agents.refetch()}
        >
          {agents.error.message}
        </ErrorState>
      ) : agents.isPending ? (
        showSkeleton ? (
          <Skeleton variant="cards" count={3} label="Loading agents" />
        ) : null
      ) : cards.length === 0 ? (
        <EmptyState
          title="Create your first agent."
          cli="beamhop agent create"
          action={
            <LinkButton href="/agents/new" variant="primary">
              New agent
            </LinkButton>
          }
        >
          An agent is a harness (Claude Code, Codex…) in a sandbox, reachable from your channels. You decide
          what it can read and talk to.
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-8 expanded:grid expanded:grid-cols-[minmax(320px,400px)_1fr] expanded:items-start expanded:gap-8">
          <div className="flex flex-col gap-8 expanded:sticky expanded:top-[72px]">
            <NeedsYou approvals={pending} now={now} />
            <div className="hidden expanded:flex expanded:flex-col expanded:gap-8">
              <Signals />
              <MonthSpend agents={cards.map((c) => c.a)} />
            </div>
          </div>
          <section aria-labelledby="home-agents" className="min-w-0">
            <Eyebrow id="home-agents" count={cards.length} href="/agents">
              Agents
            </Eyebrow>
            <ul className="grid grid-cols-1 gap-3 medium:grid-cols-2 expanded:grid-cols-[repeat(auto-fill,minmax(300px,1fr))]">
              {cards.map((c) => (
                <li key={c.a.config.name} className="min-w-0">
                  <AgentCard a={c.a} lamp={c.lamp} session={c.session} channels={channels.data?.channels} />
                </li>
              ))}
            </ul>
            <LinkButton
              href="/agents/new"
              variant="secondary"
              className="mt-4"
              icon={<Plus size={16} weight="bold" aria-hidden="true" />}
            >
              New agent
            </LinkButton>
          </section>
          <div className="flex flex-col gap-8 expanded:hidden">
            <Signals />
            <MonthSpend agents={cards.map((c) => c.a)} />
          </div>
        </div>
      )}
    </Screen>
  );
};
