/**
 * Inbox — SCREENS §2, JOURNEYS §2 (approvals triage).
 *
 * Mobile: a stack of transmission slips (top slip full, next two peeking), swipe as an accelerator
 * only — right commits "allow once" for LOW requests, opens the scope sheet for ELEVATED/HIGH,
 * access requests and deploys; left denies. Buttons are always visible. Long-press opens details.
 * Desktop: list (compact rows, checkboxes for batch decisions) + detail pane, J/K/A/D/U keys.
 * Both: filter chips, decided-elsewhere / expired slips, learning-mode suggestion cards,
 * "Waiting on others" (N-of-M), offline queue, "Decided recently (24 h)", an all-clear state.
 *
 * Research used (beyond JOURNEYS §2):
 * - Superhuman / Gmail triage: J/K focus, single-letter actions, Z undo, auto-advance to the next
 *   item after a decision — https://support.google.com/mail/answer/6594 ,
 *   https://help.superhuman.com/hc/en-us/articles/38458431506067-Customizing-Swipes-and-Triage-Bar
 * - Multi-party approval UIs show "N of M" progress, who voted, and keep the request pending until
 *   quorum — https://docs.dfns.co/guides/approve-transactions , https://posthog.com/docs/settings/approvals ,
 *   https://github.com/ctrliq/ascender/pull/579
 * - WAI-ARIA APG: one tab stop per composite widget, letter shortcuts listed in a help dialog and in
 *   button tooltips — https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/
 */
import type { ApprovalView, PolicySuggestion } from '@beamhop/core';
import {
  ArrowCounterClockwise,
  CaretDown,
  CaretLeft,
  CaretRight,
  Check,
  CloudSlash,
  Keyboard,
  Stop,
  X,
} from '@phosphor-icons/react';
import { Outlet, useNavigate, useParams } from '@tanstack/react-router';
import { motion } from 'motion/react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Link, ToggleButton, ToggleButtonGroup } from 'react-aria-components';
import { approvalTarget, RISK_LABEL, useApi, useMutationApi, useServerEvent } from '../../api/index.ts';
import { t } from '../../i18n/index.ts';
import { cx } from '../../lib/cx.ts';
import { clock, countdown, middleTruncate, pad2, when } from '../../lib/format.ts';
import { haptic } from '../../lib/haptics.ts';
import { announce } from '../../lib/live.ts';
import { useExpanded } from '../../lib/media.ts';
import { useNow } from '../../lib/useNow.ts';
import { Screen, SplitView } from '../../shell/Screen.tsx';
import { Button, IconButton, LinkButton } from '../../ui/Button.tsx';
import { TicketCard } from '../../ui/Card.tsx';
import { Checkbox } from '../../ui/Choice.tsx';
import { CliStrip } from '../../ui/CliStrip.tsx';
import { Badge, Eyebrow, Kbd, MetaLine, Readout, RiskTag } from '../../ui/Meta.tsx';
import { reduced, spring, useReduced } from '../../ui/motion.ts';
import { Banner, ErrorState, Skeleton, useDelayedLoading } from '../../ui/States.tsx';
import { RouteLine, StatusDot } from '../../ui/Status.tsx';
import { SwipeAction } from '../../ui/SwipeAction.tsx';
import { InboxContext, type InboxContextValue, useInbox } from './context.ts';
import { useMe } from './me.ts';
import {
  afterRemoval,
  burstAgents,
  filterGroups,
  filterOptions,
  groupApprovals,
  type InboxFilter,
  isMe,
  quorumOf,
  type SlipGroup,
  spokenLabel,
  step,
  swipeMode,
  waitingOnOthers,
  whoDecided,
} from './model.ts';
import { DecisionLayer } from './Sheets.tsx';
import { DecisionBar, SlipBody, SlipSlug } from './Slip.tsx';
import { SuggestionCard } from './Suggestions.tsx';
import {
  bumpVisits,
  hiddenStore,
  holdStore,
  openSheet,
  queuedIds,
  queueStore,
  returningStore,
  sheetStore,
  undoStore,
  useStore,
} from './store.ts';
import { useDecisions } from './useDecisions.tsx';

const DAY = 86_400_000;

// ─────────── Data ───────────
const useInboxData = () => {
  const q = useApi('approval.list', { status: 'all' });
  const suggestionsQ = useApi('policy.suggestions');
  const me = useMe();
  const hidden = useStore(hiddenStore);
  const holds = useStore(holdStore);
  const queue = useStore(queueStore);
  const all = q.data?.approvals ?? [];
  const queued = queuedIds(queue);

  const pending = useMemo(
    () => all.filter((a) => a.status === 'pending').sort((x, y) => x.expiresAt.localeCompare(y.expiresAt)),
    [all],
  );
  const triage = pending.filter((a) => !hidden.has(a.id) && !queued.has(a.id) && !waitingOnOthers(a, me));
  const waiting = pending.filter((a) => waitingOnOthers(a, me) && !hidden.has(a.id));
  const queuedList = pending.filter((a) => queued.has(a.id));
  const recent = all
    .filter(
      (a) => a.status !== 'pending' && a.decidedAt && Date.now() - new Date(a.decidedAt).getTime() < DAY,
    )
    .sort((x, y) => (y.decidedAt ?? '').localeCompare(x.decidedAt ?? ''));
  const lastDecision = all
    .filter((a) => a.status !== 'pending' && a.decidedAt)
    .sort((x, y) => (y.decidedAt ?? '').localeCompare(x.decidedAt ?? ''))[0];
  const suggestions = (suggestionsQ.data?.suggestions ?? []).filter((s) => !holds[s.id]);
  return {
    q,
    suggestionsQ,
    all,
    pending,
    triage,
    waiting,
    queuedList,
    recent,
    lastDecision,
    suggestions,
    me,
  };
};

// ─────────── Filter chips ───────────
const FilterChips = ({
  options,
  value,
  onChange,
}: {
  options: ReturnType<typeof filterOptions>;
  value: InboxFilter;
  onChange: (f: InboxFilter) => void;
}) =>
  options.length <= 2 ? null : (
    <ToggleButtonGroup
      aria-label={t('inbox.filter.label')}
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[value]}
      onSelectionChange={(keys) => {
        const k = [...keys][0];
        if (k !== undefined) onChange(k as InboxFilter);
      }}
      className="-mx-gutter flex gap-2 overflow-x-auto px-gutter pb-1 [scrollbar-width:none] expanded:mx-0 expanded:flex-wrap expanded:px-0"
    >
      {options.map((o) => (
        <ToggleButton
          key={o.id}
          id={o.id}
          className={cx(
            'bh-chip inline-flex h-11 shrink-0 items-center gap-1.5 rounded-sm border px-3 type-label outline-none pointer-fine:h-8',
            'data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-focus',
            'border-line-strong bg-surface text-ink data-[hovered]:bg-sunken',
            'data-[selected]:border-ink data-[selected]:bg-ink data-[selected]:text-bg',
          )}
        >
          {o.id.startsWith('agent:') ? <span className="font-mono text-[13px]">{o.label}</span> : o.label}
          <span className="type-meta tabular-nums opacity-80">{o.count}</span>
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );

// ─────────── Mobile stack ───────────
const LONG_PRESS_MS = 500;

const useLongPress = (fn: () => void) => {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const start = useRef<{ x: number; y: number } | null>(null);
  const clear = () => {
    clearTimeout(timer.current);
    start.current = null;
  };
  return {
    onPointerDown: (e: React.PointerEvent) => {
      if ((e.target as HTMLElement).closest('button,a')) return;
      start.current = { x: e.clientX, y: e.clientY };
      timer.current = setTimeout(() => {
        haptic('tick');
        fn();
      }, LONG_PRESS_MS);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 8) clear();
    },
    onPointerUp: clear,
    onPointerCancel: clear,
  };
};

const StackSlip = ({ g, now, peek }: { g: SlipGroup; now: number; peek: number }) => {
  const ctx = useInbox() as InboxContextValue;
  const me = useMe();
  const reduce = useReduced();
  const returning = useStore(returningStore)[g.lead.id];
  const quorum = quorumOf(g.lead, me);
  const press = useLongPress(() => ctx.act.details(g));
  const mode = swipeMode(g);

  useEffect(() => {
    if (returning)
      returningStore.set((r) => {
        const { [g.lead.id]: _x, ...rest } = r;
        return rest;
      });
  }, [returning, g.lead.id]);

  const initial = returning
    ? reduce
      ? { opacity: 0 }
      : { x: returning === 'right' ? 420 : -420, opacity: 1 }
    : reduce
      ? { opacity: 0 }
      : { scale: 0.96, y: 8, opacity: 1 };

  return (
    <div className={cx('relative', peek > 1 ? 'pb-4' : peek > 0 ? 'pb-2' : undefined)}>
      {/* Next slips peek 8 / 16 px below the top one (≈ scale .96 / .92). */}
      {peek > 1 && (
        <div
          aria-hidden="true"
          className="absolute inset-x-[14px] top-8 bottom-0 rounded-lg border border-line bg-surface"
        />
      )}
      {peek > 0 && (
        <div
          aria-hidden="true"
          className="absolute inset-x-[7px] top-6 bottom-2 rounded-lg border border-line bg-surface"
        />
      )}
      <motion.div
        key={g.key}
        initial={initial}
        animate={{ x: 0, y: 0, scale: 1, opacity: 1 }}
        transition={reduce ? reduced : spring.settle}
        className="relative"
        {...press}
      >
        <SwipeAction
          aria-label={spokenLabel(g, now)}
          hint={t(mode === 'commit' ? 'inbox.stack.hintCommit' : 'inbox.stack.hintIntent')}
          rightMode={mode}
          rightStamp={t('inbox.stamp.allow')}
          leftStamp={g.lead.kind === 'access-request' ? t('inbox.stamp.ignore') : t('inbox.stamp.deny')}
          keys={{}}
          onSwipeRight={() => ctx.act.allow(g)}
          onSwipeLeft={() => ctx.act.deny(g)}
        >
          {({ commit, dragging }) => (
            <TicketCard
              state={dragging ? 'dragging' : 'resting'}
              eyebrow={
                <>
                  {g.lead.kind === 'access-request' ? t('inbox.eyebrow.access') : t('inbox.eyebrow.approval')}{' '}
                  · #{g.lead.id.replace(/^apr_/, '')}
                </>
              }
              tag={<RiskTag risk={RISK_LABEL[g.lead.risk]} />}
              maxTopHeight="calc(100dvh - 360px)"
              decision={
                <DecisionBar
                  g={g}
                  quorum={quorum}
                  onDeny={() => commit('left')}
                  onDetails={() => ctx.act.details(g)}
                  detailsLabel={`${t('inbox.btn.details')}: ${g.lead.agent}, ${approvalTarget(g.lead)}`}
                  onAllow={() => (mode === 'commit' ? commit('right') : ctx.act.allow(g))}
                />
              }
            >
              <SlipBody g={g} now={now} focused quorum={quorum} />
            </TicketCard>
          )}
        </SwipeAction>
      </motion.div>
    </div>
  );
};

const Stack = ({
  groups,
  now,
  cursor,
  setCursor,
}: {
  groups: SlipGroup[];
  now: number;
  cursor?: string;
  setCursor: (k: string) => void;
}) => {
  const i = Math.max(
    0,
    groups.findIndex((g) => g.key === cursor),
  );
  const top = groups[i];
  const [visits] = useState(() => bumpVisits());
  if (!top) return null;
  const keys = groups.map((g) => g.key);
  return (
    <section aria-label={t('inbox.stack.label')} className="flex flex-col">
      <div className="mb-2 flex min-h-11 items-center justify-between gap-2">
        <p className="type-meta text-ink-2" aria-live="off">
          {t('inbox.stack.position', { n: i + 1, total: groups.length })}
        </p>
        <div className="flex">
          <IconButton
            label={t('inbox.stack.prev')}
            icon={<CaretLeft size={20} />}
            isDisabled={i === 0}
            onPress={() => setCursor(step(keys, top.key, -1) ?? top.key)}
            shortcut="K"
          />
          <IconButton
            label={t('inbox.stack.next')}
            icon={<CaretRight size={20} />}
            isDisabled={i >= groups.length - 1}
            onPress={() => setCursor(step(keys, top.key, 1) ?? top.key)}
            shortcut="J"
          />
        </div>
      </div>
      <StackSlip key={top.key} g={top} now={now} peek={Math.min(2, groups.length - i - 1)} />
      {visits <= 3 && <p className="mt-3 type-body-sm text-ink-3">{t('inbox.stack.swipeHint')}</p>}
    </section>
  );
};

// ─────────── Desktop list rows ───────────
const Row = ({
  g,
  now,
  active,
  selected,
  onSelect,
}: {
  g: SlipGroup;
  now: number;
  active: boolean;
  selected: boolean;
  onSelect: (on: boolean) => void;
}) => {
  const a = g.lead;
  const left = new Date(a.expiresAt).getTime() - now;
  return (
    <li
      className={cx(
        'relative flex items-stretch rounded-md border',
        active ? 'border-line-strong bg-flare-wash' : 'border-transparent hover:bg-sunken',
      )}
    >
      {active && <span aria-hidden="true" className="absolute top-2 bottom-2 -left-[13px] w-0.5 bg-flare" />}
      <div className="flex shrink-0 items-start pt-2.5 pl-1">
        <Checkbox
          isSelected={selected}
          onChange={onSelect}
          aria-label={`${t('inbox.batch.select')} ${a.agent}, ${approvalTarget(a)}`}
        >
          <span className="sr-only">{t('inbox.batch.select')}</span>
        </Checkbox>
      </div>
      <Link
        href={`/inbox/${a.id}`}
        aria-current={active ? 'true' : undefined}
        data-inbox-row={g.key}
        className="flex min-w-0 flex-1 flex-col gap-1 rounded-md py-2.5 pr-2 pl-1 outline-none data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus"
      >
        <span className="flex min-w-0 items-center gap-2">
          <StatusDot state="needs-you" hideLabel />
          <span className="shrink-0 type-label text-ink">{a.agent}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[13px] leading-5 text-ink">
            <span aria-hidden="true" className="text-ink-3">
              ·{' '}
            </span>
            {a.kind === 'access-request' ? t('inbox.row.access') : approvalTarget(a)}
          </span>
          {g.items.length > 1 && <Badge tone="outline">×{g.items.length}</Badge>}
        </span>
        <span className="flex items-center gap-2 pl-[18px]">
          <RiskTag risk={RISK_LABEL[a.risk]} />
          {a.quorum && a.quorum.needed > 1 && (
            <span className="type-meta text-ink-2">
              {(a.votes ?? []).filter((v) => v.allow).length}/{a.quorum.needed}
            </span>
          )}
          <span
            className={cx(
              'ml-auto type-meta tabular-nums',
              left < 120_000 ? 'text-caution-text' : 'text-ink-2',
            )}
          >
            <span className="sr-only">{t('inbox.slip.autoDenies')} </span>
            {countdown(left)}
          </span>
        </span>
      </Link>
    </li>
  );
};

const BatchBar = ({ selected, onClear }: { selected: SlipGroup[]; onClear: () => void }) => {
  const { decide } = useDecisions();
  const [busy, setBusy] = useState<'allow' | 'deny' | null>(null);
  const allLow = selected.every((g) => swipeMode(g) === 'commit');
  const run = async (allow: boolean) => {
    setBusy(allow ? 'allow' : 'deny');
    const merged: SlipGroup = {
      key: 'batch',
      lead: selected[0]!.lead,
      items: selected.flatMap((g) => g.items),
    };
    await decide(merged, allow);
    setBusy(null);
    onClear();
  };
  return (
    <div className="sticky top-16 z-10 -mx-5 mb-2 flex flex-col gap-2 border-y border-line bg-sunken px-5 py-2.5">
      <div className="flex items-center gap-2">
        <span className="type-label text-ink">{t('inbox.batch.count', { count: selected.length })}</span>
        <Button variant="quiet" size="sm" className="ml-auto" onPress={onClear}>
          {t('inbox.batch.clear')}
        </Button>
      </div>
      <div className="flex gap-2">
        <Button
          variant="deny"
          size="sm"
          className="flex-1"
          icon={<X size={14} weight="bold" aria-hidden="true" />}
          isPending={busy === 'deny'}
          onPress={() => void run(false)}
        >
          {t('inbox.batch.deny', { count: selected.length })}
        </Button>
        <Button
          variant="allow"
          size="sm"
          className="flex-1"
          icon={<Check size={14} weight="bold" aria-hidden="true" />}
          isDisabled={!allLow}
          isPending={busy === 'allow'}
          onPress={() => void run(true)}
        >
          {t('inbox.batch.allow', { count: selected.length })}
        </Button>
      </div>
      {!allLow && <p className="type-meta text-ink-2">{t('inbox.batch.needsChoice')}</p>}
    </div>
  );
};

// ─────────── Ghosts: decided elsewhere / expired ───────────
interface Ghost {
  a: ApprovalView;
  kind: 'elsewhere' | 'expired';
}

const GhostSlip = ({ ghost, onDismiss }: { ghost: Ghost; onDismiss: () => void }) => {
  const a = ghost.a;
  const at = a.decidedAt ? clock(a.decidedAt) : '';
  const line =
    ghost.kind === 'expired'
      ? t('inbox.ghost.expired', { time: at })
      : t(a.status === 'approved' ? 'inbox.ghost.allowedBy' : 'inbox.ghost.deniedBy', {
          who: a.decidedBy ?? 'another owner',
          time: at,
        });
  return (
    <TicketCard
      compact
      state={ghost.kind === 'expired' ? 'expired' : 'decided'}
      statusLine={
        <span className="flex w-full items-center gap-2">
          <span className="min-w-0 flex-1" role={ghost.kind === 'elsewhere' ? 'status' : undefined}>
            {line}
          </span>
          {ghost.kind === 'expired' && (
            <Button variant="quiet" size="sm" onPress={onDismiss}>
              {t('inbox.ghost.dismiss')}
            </Button>
          )}
        </span>
      }
    >
      <SlipSlug a={a} />
      <p className="mt-1 truncate font-mono text-[13px] text-ink">{approvalTarget(a)}</p>
    </TicketCard>
  );
};

// ─────────── Sections below the stack / list ───────────
const MiniRow = ({ a, children, href }: { a: ApprovalView; children?: ReactNode; href?: string }) => {
  const body = (
    <>
      <span className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 type-label text-ink">{a.agent}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-ink">{approvalTarget(a)}</span>
      </span>
      {children}
    </>
  );
  return (
    <li>
      {href ? (
        <Link
          href={href}
          className="flex min-h-12 flex-col justify-center gap-0.5 rounded-md px-2 py-1.5 outline-none data-[hovered]:bg-sunken data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus"
        >
          {body}
        </Link>
      ) : (
        <div className="flex min-h-12 flex-col justify-center gap-0.5 px-2 py-1.5">{body}</div>
      )}
    </li>
  );
};

const STATUS_WORD: Record<ApprovalView['status'], string> = {
  approved: 'allowed',
  denied: 'denied',
  expired: 'auto-denied',
  pending: 'pending',
};

const Recent = ({ list }: { list: ApprovalView[] }) => {
  const [open, setOpen] = useState(false);
  const me = useMe();
  if (list.length === 0) return null;
  return (
    <section aria-labelledby="inbox-recent" className="mt-8">
      <h2 id="inbox-recent" className="type-micro text-ink-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="-mx-2 inline-flex min-h-11 items-center gap-2 rounded-md px-2 outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-focus"
        >
          <CaretDown size={14} aria-hidden="true" className={cx(!open && '-rotate-90')} />
          {t('inbox.recent.title')} · {list.length}
        </button>
      </h2>
      {open && (
        <ul className="-mx-2 flex flex-col">
          {list.map((a) => (
            <MiniRow key={a.id} a={a} href={`/inbox/${a.id}`}>
              <MetaLine
                items={[
                  {
                    value: STATUS_WORD[a.status],
                    tone: a.status === 'approved' ? 'go' : a.status === 'denied' ? 'stop' : 'caution',
                  },
                  a.decidedBy ? `by ${whoDecided(me, a.decidedBy, '')}` : 'the agent was told',
                  a.decidedAt ? when(a.decidedAt) : undefined,
                ]}
              />
            </MiniRow>
          ))}
        </ul>
      )}
    </section>
  );
};

const Waiting = ({ list, now }: { list: ApprovalView[]; now: number }) => {
  const me = useMe();
  if (list.length === 0) return null;
  return (
    <section aria-labelledby="inbox-waiting" className="mt-8">
      <Eyebrow id="inbox-waiting" count={list.length}>
        {t('inbox.waiting.title')}
      </Eyebrow>
      <ul className="-mx-2 flex flex-col">
        {list.map((a) => {
          const q = quorumOf(a, me);
          return (
            <MiniRow key={a.id} a={a} href={`/inbox/${a.id}`}>
              <MetaLine
                items={[
                  q
                    ? { value: t('inbox.quorum.progress', { yes: q.yes, needed: q.needed }), tone: 'caution' }
                    : undefined,
                  `${t('inbox.slip.autoDenies')} ${countdown(new Date(a.expiresAt).getTime() - now)}`,
                ]}
              />
            </MiniRow>
          );
        })}
      </ul>
    </section>
  );
};

const Queued = ({ list }: { list: ApprovalView[] }) =>
  list.length === 0 ? null : (
    <section aria-labelledby="inbox-queued" className="mt-8">
      <Eyebrow id="inbox-queued" count={list.length}>
        {t('inbox.queue.title')}
      </Eyebrow>
      <ul className="-mx-2 flex flex-col">
        {list.map((a) => (
          <MiniRow key={a.id} a={a}>
            <span className="flex items-center gap-1.5 type-meta text-caution-text">
              <CloudSlash size={14} aria-hidden="true" />
              {t('inbox.queue.line')}
            </span>
          </MiniRow>
        ))}
      </ul>
    </section>
  );

const Learning = ({ list }: { list: PolicySuggestion[] }) => {
  if (list.length === 0) return null;
  return (
    <section aria-labelledby="inbox-learning" className="mt-8">
      <Eyebrow id="inbox-learning" count={list.length} href="/policy">
        {t('inbox.learning.title')}
      </Eyebrow>
      <p className="-mt-1 mb-3 type-body-sm text-ink-2">{t('inbox.learning.body', { count: list.length })}</p>
      <ul className="flex flex-col gap-3">
        {list.map((s) => (
          <li key={s.id}>
            <SuggestionCard s={s} />
          </li>
        ))}
      </ul>
    </section>
  );
};

// ─────────── All clear ───────────
const AllClear = ({ last, compact }: { last?: ApprovalView; compact?: boolean }) => {
  const agents = useApi('agent.list');
  const status = useApi('system.status');
  const n = agents.data?.agents.length ?? 0;
  const live = (agents.data?.agents ?? []).filter((a) => a.status === 'busy').length;
  return (
    <section
      aria-labelledby="inbox-clear"
      className={cx(
        'flex w-full min-w-0 flex-col items-start gap-4',
        compact ? 'py-4' : 'py-8 expanded:max-w-[520px]',
      )}
    >
      <div className="w-full max-w-[360px] rounded-lg border border-line bg-surface p-4">
        <RouteLine
          nodes={[
            { label: t('inbox.clear.agents', { count: n }), kind: 'agent' },
            { label: 'beamhop', kind: 'relay' },
            { label: t('inbox.clear.you'), kind: 'device' },
          ]}
          aria-label={t('inbox.clear.route', { count: n })}
        />
        <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 type-meta whitespace-nowrap text-ink-2">
          <StatusDot state="ready" label={t('inbox.clear.quiet')} />
          <span aria-hidden="true">·</span>
          <span>{live > 0 ? t('inbox.clear.live', { count: live }) : t('inbox.clear.idle')}</span>
          {status.data && (
            <>
              <span aria-hidden="true">·</span>
              <span>{t('inbox.clear.up', { version: status.data.version })}</span>
            </>
          )}
        </p>
      </div>
      <div>
        <h2 id="inbox-clear" className="type-title-2 text-ink">
          {t('inbox.clear.title')}
        </h2>
        <p className="mt-1 type-body text-ink-2">{t('inbox.clear.body')}</p>
        {last && (
          <p className="mt-2 type-meta break-words text-ink-2">
            {t('inbox.clear.last', {
              verb: STATUS_WORD[last.status],
              target: middleTruncate(approvalTarget(last), 36),
              time: last.decidedAt ? when(last.decidedAt) : '',
            })}
          </p>
        )}
      </div>
      <LinkButton href="/settings" variant="secondary" size="sm">
        {t('inbox.clear.notifications')}
      </LinkButton>
      <CliStrip command="beamhop approvals list --all" className="w-full max-w-[520px]" />
    </section>
  );
};

// ─────────── Screen ───────────
const typing = (el: EventTarget | null) => {
  const x = el as HTMLElement | null;
  return (
    !!x &&
    (x.tagName === 'INPUT' || x.tagName === 'TEXTAREA' || x.tagName === 'SELECT' || x.isContentEditable)
  );
};

export const InboxScreen = () => {
  const expanded = useExpanded();
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { approvalId?: string };
  const hasDetail = !!params.approvalId;
  const now = useNow(1000);
  const data = useInboxData();
  const { decide, undoLast, offline } = useDecisions();
  const stopAgent = useMutationApi('agent.stop');
  const [filter, setFilter] = useState<InboxFilter>('all');
  const [cursor, setCursor] = useState<string | undefined>();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [ghosts, setGhosts] = useState<Ghost[]>([]);
  const showSkeleton = useDelayedLoading(data.q.isPending);

  const allGroups = useMemo(() => groupApprovals(data.triage), [data.triage]);
  const options = useMemo(() => filterOptions(allGroups), [allGroups]);
  const effectiveFilter = options.some((o) => o.id === filter) ? filter : 'all';
  const groups = useMemo(() => filterGroups(allGroups, effectiveFilter), [allGroups, effectiveFilter]);
  const keys = groups.map((g) => g.key);
  const bursts = burstAgents(data.pending);

  const groupOf = (id?: string) => (id ? groups.find((g) => g.items.some((a) => a.id === id)) : undefined);
  const routeGroup = groupOf(params.approvalId);
  const current = expanded
    ? routeGroup
    : hasDetail
      ? routeGroup
      : (groups.find((g) => g.key === cursor) ?? groups[0]);

  // Desktop: open the first request in the detail pane (Superhuman-style), keep URL addressable.
  const firstId = groups[0]?.lead.id;
  useEffect(() => {
    if (expanded && !hasDetail && firstId) {
      void navigate({ to: '/inbox/$approvalId', params: { approvalId: firstId }, replace: true });
    }
  }, [expanded, hasDetail, firstId, navigate]);

  /** After deciding `g`, where does focus go? */
  const advance = (g: SlipGroup) => {
    const next = afterRemoval(keys, g.key);
    const nextGroup = groups.find((x) => x.key === next && x.key !== g.key);
    if (!expanded) {
      if (hasDetail) void navigate({ to: '/inbox' });
      if (nextGroup) setCursor(nextGroup.key);
      return;
    }
    if (params.approvalId && g.items.some((a) => a.id === params.approvalId)) {
      if (nextGroup) void navigate({ to: '/inbox/$approvalId', params: { approvalId: nextGroup.lead.id } });
      else void navigate({ to: '/inbox' });
    }
  };

  const act: InboxContextValue['act'] = {
    allow: (g, o) => {
      if (g.lead.kind === 'access-request') {
        openSheet({ type: 'access', approval: g.lead, onDone: () => advance(g) });
        return;
      }
      if (o?.forceSheet || swipeMode(g) === 'intent') {
        openSheet({ type: 'scope', group: g, onDone: () => advance(g) });
        return;
      }
      advance(g);
      void decide(g, true);
    },
    deny: (g) => {
      advance(g);
      void decide(g, false);
    },
    details: (g) => void navigate({ to: '/inbox/$approvalId', params: { approvalId: g.lead.id } }),
  };

  // Decided elsewhere (2 s) and expired-while-open slips (stay until dismissed).
  const visible = useRef(new Set<string>());
  visible.current = new Set(data.triage.map((a) => a.id));
  const meRef = useRef(data.me);
  meRef.current = data.me;
  useServerEvent((e) => {
    if (e.type !== 'approval.updated' || e.approval.status === 'pending') return;
    const a = e.approval;
    if (!visible.current.has(a.id)) return;
    if (a.status === 'expired') {
      setGhosts((gs) => [...gs.filter((x) => x.a.id !== a.id), { a, kind: 'expired' }]);
      announce(t('inbox.ghost.expiredSpoken', { agent: a.agent, target: approvalTarget(a) }));
    } else if (!isMe(meRef.current, a.decidedBy)) {
      setGhosts((gs) => [...gs.filter((x) => x.a.id !== a.id), { a, kind: 'elsewhere' }]);
      setTimeout(() => setGhosts((gs) => gs.filter((x) => x.a.id !== a.id || x.kind !== 'elsewhere')), 2000);
    }
  });

  // One assertive announcement per approval at 60 s left (DESIGN §12 live regions).
  const warned = useRef(new Set<string>());
  useEffect(() => {
    for (const a of data.triage) {
      const left = new Date(a.expiresAt).getTime() - now;
      if (left > 0 && left <= 60_000 && !warned.current.has(a.id)) {
        warned.current.add(a.id);
        announce(t('inbox.slip.lastMinute', { id: a.id.replace(/^apr_/, ''), agent: a.agent }), 'assertive');
      }
    }
  }, [now, data.triage]);

  // Keyboard triage: J/K move, A allow, ⇧A scope, D deny, ↵ details, U/Z undo, R reason, X select, ? help.
  const latest = useRef({ current, keys, act, groups, expanded, hasDetail });
  latest.current = { current, keys, act, groups, expanded, hasDetail };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        void undoLast();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      if (sheetStore.get() || document.querySelector('[role="dialog"],[role="alertdialog"]')) return;
      const L = latest.current;
      const g = L.current;
      const k = e.key;
      const move = (dir: 1 | -1) => {
        const next = L.keys.length ? step(L.keys, g?.key, dir) : undefined;
        const ng = L.groups.find((x) => x.key === next);
        if (!ng) return;
        if (L.expanded || L.hasDetail) {
          void navigate({ to: '/inbox/$approvalId', params: { approvalId: ng.lead.id } });
          requestAnimationFrame(() =>
            document.querySelector<HTMLElement>(`[data-inbox-row="${CSS.escape(ng.key)}"]`)?.focus(),
          );
        } else setCursor(ng.key);
      };
      const handled = (() => {
        switch (k) {
          case 'j':
          case 'ArrowDown':
            if (k === 'ArrowDown' && !L.expanded) return false;
            move(1);
            return true;
          case 'k':
          case 'ArrowUp':
            if (k === 'ArrowUp' && !L.expanded) return false;
            move(-1);
            return true;
          case 'a':
            if (g) L.act.allow(g);
            return !!g;
          case 'A':
            if (g) L.act.allow(g, { forceSheet: true });
            return !!g;
          case 'd':
            if (g) L.act.deny(g);
            return !!g;
          case 'Enter':
            if (
              g &&
              !L.hasDetail &&
              (e.target as HTMLElement).tagName !== 'BUTTON' &&
              (e.target as HTMLElement).tagName !== 'A'
            ) {
              L.act.details(g);
              return true;
            }
            return false;
          case 'u':
          case 'z':
            void undoLast();
            return true;
          case 'r': {
            const u = undoStore.get();
            if (!u?.reasonFor || u.until < Date.now()) return false;
            openSheet({ type: 'reason', ...u.reasonFor });
            return true;
          }
          case 'x':
            if (g && L.expanded)
              setSelected((s) => {
                const n = new Set(s);
                if (n.has(g.key)) n.delete(g.key);
                else n.add(g.key);
                return n;
              });
            return !!g && L.expanded;
          case '?':
            openSheet({ type: 'help' });
            return true;
          default:
            return false;
        }
      })();
      if (handled) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, undoLast]);

  const ctx: InboxContextValue = { groups, all: data.all, me: data.me, now, act };
  const selectedGroups = groups.filter((g) => selected.has(g.key));
  const empty = groups.length === 0;

  const header = (
    <>
      <FilterChips options={options} value={effectiveFilter} onChange={setFilter} />
      {offline && (
        <p className="mt-2 flex items-center gap-2 type-body-sm text-caution-text">
          <CloudSlash size={16} aria-hidden="true" />
          {t('inbox.offline')}
        </p>
      )}
      {bursts.map((b) => (
        <Banner
          key={b.agent}
          tone="caution"
          className="-mx-gutter mt-3 expanded:-mx-5"
          action={
            <Button
              variant="secondary"
              size="sm"
              icon={<Stop size={14} weight="fill" aria-hidden="true" />}
              isPending={stopAgent.isPending}
              onPress={() => stopAgent.mutate({ name: b.agent })}
            >
              {t('inbox.burst.pause', { agent: b.agent })}
            </Button>
          }
        >
          {t('inbox.burst.line', { agent: b.agent, count: b.count })}
        </Banner>
      ))}
      {ghosts.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2" aria-label={t('inbox.ghost.label')}>
          {ghosts.map((gh) => (
            <li key={gh.a.id}>
              <GhostSlip
                ghost={gh}
                onDismiss={() => setGhosts((gs) => gs.filter((x) => x.a.id !== gh.a.id))}
              />
            </li>
          ))}
        </ul>
      )}
    </>
  );

  const below = (
    <>
      <Learning list={data.suggestions} />
      <Queued list={data.queuedList} />
      <Waiting list={data.waiting} now={now} />
      <Recent list={data.recent} />
    </>
  );

  const body = data.q.isError ? (
    <ErrorState title={t('inbox.error.title')} details={data.q.error} onRetry={() => void data.q.refetch()}>
      {data.q.error.message}
    </ErrorState>
  ) : data.q.isPending ? (
    showSkeleton ? (
      <Skeleton variant={expanded ? 'list' : 'cards'} count={expanded ? 5 : 1} label={t('inbox.loading')} />
    ) : null
  ) : expanded ? (
    <>
      {header}
      {selectedGroups.length > 0 && (
        <div className="mt-3">
          <BatchBar selected={selectedGroups} onClear={() => setSelected(new Set())} />
        </div>
      )}
      {empty ? (
        <p className="mt-4 type-body-sm text-ink-2">{t('inbox.clear.short')}</p>
      ) : (
        <section aria-labelledby="inbox-pending" className="mt-3">
          <h2 id="inbox-pending" className="sr-only">
            {t('inbox.pending.title')}
          </h2>
          <ul className="flex flex-col gap-1 pl-3">
            {groups.map((g) => (
              <Row
                key={g.key}
                g={g}
                now={now}
                active={!!routeGroup && routeGroup.key === g.key}
                selected={selected.has(g.key)}
                onSelect={(on) =>
                  setSelected((s) => {
                    const n = new Set(s);
                    if (on) n.add(g.key);
                    else n.delete(g.key);
                    return n;
                  })
                }
              />
            ))}
          </ul>
          {groups.length > 1 && (
            <Button
              variant="quiet"
              size="sm"
              className="mt-1"
              onPress={() =>
                setSelected(selected.size === groups.length ? new Set() : new Set(groups.map((g) => g.key)))
              }
            >
              {selected.size === groups.length ? t('inbox.batch.none') : t('inbox.batch.all')}
            </Button>
          )}
        </section>
      )}
      {below}
      <p className="mt-8 flex flex-wrap items-center gap-x-3 gap-y-1 type-meta text-ink-2">
        <span>
          <Kbd>J</Kbd>/<Kbd>K</Kbd> {t('inbox.keys.moveShort')}
        </span>
        <span>
          <Kbd>A</Kbd> {t('inbox.keys.allowShort')}
        </span>
        <span>
          <Kbd>D</Kbd> {t('inbox.keys.denyShort')}
        </span>
        <span>
          <Kbd>U</Kbd> {t('inbox.keys.undoShort')}
        </span>
        <Button
          variant="quiet"
          size="sm"
          icon={<Keyboard size={14} aria-hidden="true" />}
          onPress={() => openSheet({ type: 'help' })}
        >
          {t('inbox.keys.all')}
        </Button>
      </p>
    </>
  ) : (
    <>
      {header}
      <div className="mt-3">
        {empty ? (
          <AllClear last={data.lastDecision} compact={data.suggestions.length > 0} />
        ) : (
          <Stack groups={groups} now={now} cursor={cursor} setCursor={setCursor} />
        )}
      </div>
      {below}
    </>
  );

  const undoEntry = useStore(undoStore);
  const undo = undoEntry && undoEntry.until > now ? undoEntry : null;
  const titleAside = (
    <span
      className="flex items-baseline gap-2"
      aria-label={t('inbox.pendingCount', {
        count: data.q.isPending ? 0 : data.pending.length - data.waiting.length,
      })}
      role="status"
    >
      <Readout size="md">{pad2(data.q.isPending ? 0 : data.pending.length - data.waiting.length)}</Readout>
      <span className="type-micro text-ink-2" aria-hidden="true">
        {t('inbox.pending.short')}
      </span>
    </span>
  );

  return (
    <InboxContext.Provider value={ctx}>
      <SplitView
        hasDetail={hasDetail}
        empty={
          <div className="pane-scroll h-full px-8" id="bh-main-content">
            <AllClear last={data.lastDecision} />
          </div>
        }
        list={
          <Screen
            title={t('nav.inbox')}
            pane="list"
            titleAside={titleAside}
            actions={
              undo && expanded ? (
                <IconButton
                  label={`${t('inbox.undo.label')}: ${undo.label}`}
                  icon={<ArrowCounterClockwise size={18} />}
                  onPress={() => void undoLast()}
                  shortcut="U"
                />
              ) : undefined
            }
          >
            {body}
          </Screen>
        }
      >
        <Outlet />
      </SplitView>
      <DecisionLayer />
    </InboxContext.Provider>
  );
};
