/**
 * Transcript blocks on a tick rail (DESIGN §3.8, JOURNEYS §3): who said what, agent prose (never folded),
 * one-line tool rows that expand to input / output / diff, tool runs, inline approval slips that mirror
 * the Inbox, progress / system / error rows and the per-turn "files changed" summary.
 *
 * The list is a `role="log"` with `aria-live="off"` — announcements go through the shell's polite region
 * (hooks.ts useSessionAnnouncer). Each message carries an h3 (sender + time) for heading navigation.
 */
import type { ApprovalView, SessionEventView } from '@beamhop/core';
import {
  ArrowSquareOut,
  CaretRight,
  ChatTeardropText,
  Check,
  Copy,
  GitDiff,
  Info,
  Quotes,
  X,
} from '@phosphor-icons/react';
import { useNavigate } from '@tanstack/react-router';
import { AnimatePresence, motion } from 'motion/react';
import { memo, type ReactNode, useState } from 'react';
import { Button as RACButton } from 'react-aria-components';
import { approvalTarget, PROVIDER_NAMES, RISK_LABEL, useCall, useMutationApi } from '../../api/index.ts';
import { t } from '../../i18n/index.ts';
import { cx } from '../../lib/cx.ts';
import { clock, countdown } from '../../lib/format.ts';
import { haptic } from '../../lib/haptics.ts';
import { announce } from '../../lib/live.ts';
import { Button } from '../../ui/Button.tsx';
import { TicketCard } from '../../ui/Card.tsx';
import { CodeBlock, DiffView } from '../../ui/CodeBlock.tsx';
import { Gate, HopMeter } from '../../ui/glyphs/index.tsx';
import { Badge, RiskTag } from '../../ui/Meta.tsx';
import { spring, useReduced } from '../../ui/motion.ts';
import { StatusDot } from '../../ui/Status.tsx';
import { useToast } from '../../ui/Toast.tsx';
import { useSmoothText } from './hooks.ts';
import { OverflowMenu } from './Menu.tsx';
import { type Block, type ChangesSummary, diffStats, duration, runSummary, type ToolItem } from './model.ts';
import { Prose } from './prose.tsx';

export interface TranscriptCtx {
  agent: string;
  /** Channel name → provider, e.g. tg → telegram. */
  channelProvider?: string;
  approvals: Map<string, ApprovalView>;
  expandAll: boolean;
  now: number;
  onViewDiff: (diff: string) => void;
  onQuote: (text: string) => void;
}

// ─────────── Rail ───────────

const minuteOf = (iso: string) => clock(iso);

const blockAt = (b: Block): string =>
  b.kind === 'run'
    ? b.tools[0]!.startedAt
    : b.kind === 'tool'
      ? b.startedAt
      : b.kind === 'changes'
        ? b.at
        : b.ev.at;

/** One row on the rail: 4px tick per row, 8px + time label when the minute changes. */
const RailRow = ({
  at,
  showTime,
  fresh,
  children,
  kind,
}: {
  at: string;
  showTime: boolean;
  fresh: boolean;
  children: ReactNode;
  kind: Block['kind'];
}) => (
  <li className="tx-block relative pl-[52px] expanded:pl-[60px]" data-kind={kind}>
    {showTime && (
      <time
        dateTime={at}
        className="absolute top-[3px] left-0 w-9 text-right font-mono text-[11px] leading-4 text-ink-3 tabular-nums expanded:w-11"
      >
        {clock(at)}
      </time>
    )}
    <span
      aria-hidden="true"
      className={cx(
        'absolute top-[10px] h-px bg-line-strong',
        showTime ? 'left-[40px] w-2 expanded:left-[48px]' : 'left-[44px] w-1 expanded:left-[52px]',
        fresh && 'tx-tick-new',
      )}
    />
    {children}
  </li>
);

// ─────────── Messages ───────────

const providerOf = (principal?: string) => principal?.split(':')[0];

const MessageMenu = ({ text, onQuote, who }: { text: string; onQuote: (t: string) => void; who: string }) => (
  <OverflowMenu
    label={t('session.msg.menu', { who })}
    className="-my-3 -mr-2 text-ink-3"
    actions={[
      {
        id: 'copy',
        label: t('session.msg.copy'),
        icon: <Copy size={18} />,
        onAction: () => {
          void navigator.clipboard?.writeText(text).catch(() => undefined);
          announce(t('common.copied'));
        },
      },
      {
        id: 'quote',
        label: t('session.msg.quote'),
        icon: <Quotes size={18} />,
        onAction: () => onQuote(text),
      },
    ]}
  />
);

const UserMessage = ({ ev, ctx }: { ev: SessionEventView; ctx: TranscriptCtx }) => {
  const [header, setHeader] = useState(false);
  const name = ev.from?.displayName ?? ev.from?.principal ?? 'someone';
  const provider = providerOf(ev.from?.principal);
  const via =
    provider === 'pwa' || ev.from?.role === 'owner'
      ? 'beamhop'
      : (PROVIDER_NAMES[provider ?? ''] ?? provider);
  const owner = ev.from?.role === 'owner';
  return (
    <article className="pb-4" aria-labelledby={`msg-${ev.seq}`}>
      <div className="flex min-h-5 items-center gap-2">
        <h3 id={`msg-${ev.seq}`} className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate type-label text-ink">{name}</span>
          {ev.from?.role && <Badge tone={owner ? 'flare' : 'outline'}>{ev.from.role}</Badge>}
          {via && <span className="truncate type-meta text-ink-3">{via}</span>}
          <span className="sr-only">{t('session.msg.at', { time: clock(ev.at) })}</span>
        </h3>
        {!owner && ev.from && (
          <RACButton
            aria-expanded={header}
            aria-label={t('session.msg.headerAria', { who: name })}
            onPress={() => setHeader((h) => !h)}
            className="-my-3 grid size-11 shrink-0 place-items-center rounded-md text-ink-3 outline-none data-[hovered]:text-ink data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus aria-expanded:text-ink"
          >
            <Info size={18} aria-hidden="true" />
          </RACButton>
        )}
        <MessageMenu text={ev.text ?? ''} onQuote={ctx.onQuote} who={name} />
      </div>
      {header && ev.from && (
        <div className="mt-1 rounded-md bg-sunken p-3 type-meta text-ink-2">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            <dt className="text-ink-3">principal</dt>
            <dd className="min-w-0 break-all text-ink">{ev.from.principal}</dd>
            <dt className="text-ink-3">role</dt>
            <dd className="text-ink">{ev.from.role ?? '—'}</dd>
            <dt className="text-ink-3">channel</dt>
            <dd className="text-ink">{via}</dd>
          </dl>
          <p className="mt-2 type-body-sm text-ink-2">{t('session.msg.untrusted')}</p>
        </div>
      )}
      <div className="mt-1 rounded-lg rounded-tl-sm border border-line bg-surface px-3 py-2">
        <p className="type-body whitespace-pre-wrap text-ink [overflow-wrap:anywhere]">{ev.text}</p>
      </div>
    </article>
  );
};

const AgentMessage = memo(
  ({ ev, streaming, ctx }: { ev: SessionEventView; streaming: boolean; ctx: TranscriptCtx }) => {
    const text = useSmoothText(ev.text ?? '', streaming);
    return (
      <article className="pb-4" aria-labelledby={`msg-${ev.seq}`} aria-busy={streaming || undefined}>
        <div className="flex min-h-5 items-center gap-2">
          <h3 id={`msg-${ev.seq}`} className="flex min-w-0 flex-1 items-center gap-2">
            <span className="truncate type-label text-ink">{ctx.agent}</span>
            <span className="type-meta text-ink-3">{t('session.msg.agent')}</span>
            <span className="sr-only">{t('session.msg.at', { time: clock(ev.at) })}</span>
          </h3>
          {streaming ? (
            <StatusDot state="live" label={t('session.msg.writing')} />
          ) : (
            <MessageMenu text={ev.text ?? ''} onQuote={ctx.onQuote} who={ctx.agent} />
          )}
        </div>
        <div className="mt-1">
          <Prose text={text} caret={streaming} />
        </div>
      </article>
    );
  },
);

// ─────────── Tools ───────────

const ToolGlyph = ({ status }: { status: ToolItem['status'] }) => (
  <span className="grid w-5 shrink-0 place-items-center">
    {status === 'running' ? (
      <HopMeter up={3} total={3} busy tone="flare" />
    ) : status === 'ok' ? (
      <Check size={14} weight="bold" aria-hidden="true" className="text-go-text" />
    ) : status === 'failed' ? (
      <span aria-hidden="true" className="size-2.5 bg-stop" />
    ) : (
      <Gate />
    )}
  </span>
);

const fmtInput = (input: unknown): string | undefined => {
  if (input === undefined || input === null) return undefined;
  if (typeof input === 'string') return input;
  const o = input as Record<string, unknown>;
  if (typeof o.command === 'string' && Object.keys(o).length === 1) return `$ ${o.command}`;
  return JSON.stringify(input, null, 2);
};

const Expand = ({ open, children }: { open: boolean; children: ReactNode }) => {
  const reduce = useReduced();
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          initial={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
          animate={reduce ? { opacity: 1 } : { height: 'auto', opacity: 1 }}
          exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
          transition={reduce ? { duration: 0 } : spring.snap}
          className="overflow-hidden"
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export const ToolRow = ({ tool, ctx, nested }: { tool: ToolItem; ctx: TranscriptCtx; nested?: boolean }) => {
  const [openState, setOpen] = useState<boolean | null>(null);
  const open = openState ?? ctx.expandAll;
  const ds = tool.diff ? diffStats(tool.diff) : undefined;
  const stats = ds && { add: ds.added, del: ds.removed };
  const ms = tool.endedAt
    ? new Date(tool.endedAt).getTime() - new Date(tool.startedAt).getTime()
    : ctx.now - new Date(tool.startedAt).getTime();
  const input = fmtInput(tool.input);
  const label = tool.target ? `${tool.verb} ${tool.target}` : tool.verb;
  // Titles often end in `+14 −3`; the row shows live diff stats instead, so drop the duplicate.
  const target = stats ? tool.target.replace(/\s*\+\d+\s*[−-]\d+\s*$/, '') : tool.target;
  const tail = tool.status === 'running' ? tool.progress.slice(-6) : [];
  return (
    <div className={cx(nested ? 'py-0' : 'pb-2')}>
      <RACButton
        aria-expanded={open}
        onPress={() => setOpen(!open)}
        className={cx(
          'group -mx-2 flex min-h-10 w-[calc(100%+16px)] items-center gap-2 rounded-md px-2 text-left outline-none pointer-coarse:min-h-11',
          'data-[hovered]:bg-sunken data-[pressed]:bg-sunken data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus',
        )}
      >
        <ToolGlyph status={tool.status} />
        <span className="shrink-0 type-label text-ink">{tool.verb}</span>
        <span
          className={cx(
            'min-w-0 flex-1 truncate font-mono text-[13px] leading-5',
            tool.status === 'failed' || tool.status === 'denied' ? 'text-stop-text' : 'text-ink-2',
          )}
          title={tool.target}
        >
          {target}
        </span>
        {stats && (
          <span className="shrink-0 type-meta tabular-nums">
            <span className="text-go-text">+{stats.add}</span>{' '}
            <span className="text-stop-text">−{stats.del}</span>
          </span>
        )}
        <span
          className={cx(
            'shrink-0 type-meta tabular-nums',
            tool.status === 'running' ? 'text-flare-text' : 'text-ink-3',
          )}
        >
          {duration(ms)}
        </span>
        <span className="sr-only">, {t(`session.tool.${tool.status}` as 'session.tool.ok')}</span>
        <CaretRight
          size={14}
          aria-hidden="true"
          className={cx('shrink-0 text-ink-3 group-data-[hovered]:text-ink', open && 'rotate-90')}
        />
      </RACButton>
      {!open && tail.length > 0 && (
        <pre
          aria-hidden="true"
          className="mt-0.5 ml-7 overflow-hidden type-code whitespace-pre-wrap text-ink-3 [overflow-wrap:anywhere]"
        >
          {tail.join('\n')}
        </pre>
      )}
      <Expand open={open}>
        <div className="flex flex-col gap-2 pt-1 pb-2 pl-7">
          {input && <CodeBlock code={input} label={t('session.tool.input', { tool: tool.name })} wrap />}
          {tool.status === 'running' && tool.progress.length > 0 && (
            <CodeBlock code={tool.progress.join('\n')} label={t('session.tool.live')} copy={false} />
          )}
          {tool.diff && <DiffView diff={tool.diff} />}
          {tool.output && (
            <CodeBlock
              code={tool.output}
              label={t('session.tool.output', { label })}
              maxLines={40}
              className={tool.status === 'failed' ? 'border-l-[3px] border-stop-text' : undefined}
            />
          )}
          {!input && !tool.output && !tool.diff && tool.status !== 'running' && (
            <p className="type-meta text-ink-3">{t('session.tool.noOutput')}</p>
          )}
        </div>
      </Expand>
    </div>
  );
};

const ToolRun = ({ tools, ctx }: { tools: ToolItem[]; ctx: TranscriptCtx }) => {
  const [openState, setOpen] = useState<boolean | null>(null);
  const open = openState ?? ctx.expandAll;
  const s = runSummary(tools);
  const ms = s.running ? ctx.now - new Date(tools[0]!.startedAt).getTime() : s.ms;
  const summary = [
    t('session.run.calls', { count: s.count }),
    s.edits ? t('session.run.edits', { count: s.edits }) : null,
    s.failed ? t('session.run.failed', { count: s.failed }) : null,
    duration(ms),
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="pb-2">
      <RACButton
        aria-expanded={open}
        onPress={() => setOpen(!open)}
        className="group -mx-2 flex min-h-10 w-[calc(100%+16px)] items-center gap-2 rounded-md px-2 text-left outline-none data-[hovered]:bg-sunken data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus pointer-coarse:min-h-11"
      >
        <span className="grid w-5 shrink-0 place-items-center">
          {s.running ? (
            <HopMeter up={3} total={3} busy tone="flare" />
          ) : s.failed ? (
            <span aria-hidden="true" className="size-2.5 bg-stop" />
          ) : (
            <span aria-hidden="true" className="flex flex-col gap-[2px]">
              <span className="h-px w-3 bg-ink-2" />
              <span className="h-px w-3 bg-ink-2" />
              <span className="h-px w-3 bg-ink-2" />
            </span>
          )}
        </span>
        <span className="min-w-0 flex-1 truncate type-meta text-ink-2">{summary}</span>
        <CaretRight
          size={14}
          aria-hidden="true"
          className={cx('shrink-0 text-ink-3 group-data-[hovered]:text-ink', open && 'rotate-90')}
        />
      </RACButton>
      {!open && s.running && (
        <div className="border-l border-line pl-3">
          <ToolRow tool={s.running} ctx={ctx} nested />
        </div>
      )}
      <Expand open={open}>
        <div className="ml-2 border-l border-line pt-1 pl-3">
          {tools.map((tool) => (
            <ToolRow key={tool.key} tool={tool} ctx={ctx} nested />
          ))}
        </div>
      </Expand>
    </div>
  );
};

// ─────────── Inline approval (mirrors the Inbox) ───────────

const InlineApproval = ({ ev, ctx }: { ev: SessionEventView; ctx: TranscriptCtx }) => {
  const a = ev.approvalId ? ctx.approvals.get(ev.approvalId) : undefined;
  const toast = useToast();
  const navigate = useNavigate();
  const call = useCall();
  const decide = useMutationApi('approval.decide');
  const target = a ? approvalTarget(a) : (ev.text ?? '');
  const shortId = (ev.approvalId ?? '').replace(/^apr_/, '');
  const run = (allow: boolean) => {
    if (!a) return;
    haptic(allow ? 'confirm' : 'reject');
    decide
      .mutateAsync({ id: a.id, allow })
      .then(() =>
        toast.show({
          message: (
            <>
              {allow ? t('session.approval.allowed') : t('session.approval.denied')} ·{' '}
              <span className="font-mono text-[0.9em]">{target}</span>
            </>
          ),
          spoken: `${allow ? t('session.approval.allowed') : t('session.approval.denied')}: ${target}`,
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
  const status = a?.status ?? 'pending';
  const left = a ? new Date(a.expiresAt).getTime() - ctx.now : 0;
  const statusLine =
    status === 'approved'
      ? t('session.approval.statusAllowed', {
          who: a?.decidedBy ?? 'you',
          time: a?.decidedAt ? clock(a.decidedAt) : '',
        })
      : status === 'denied'
        ? t('session.approval.statusDenied', {
            who: a?.decidedBy ?? 'you',
            time: a?.decidedAt ? clock(a.decidedAt) : '',
          })
        : status === 'expired'
          ? t('session.approval.statusExpired', { time: a ? clock(a.expiresAt) : '' })
          : undefined;
  return (
    <div className="pb-4">
      <TicketCard
        compact
        state={status === 'expired' ? 'expired' : status === 'pending' ? 'resting' : 'decided'}
        eyebrow={
          <span className="inline-flex items-center gap-2">
            <StatusDot
              state={status === 'pending' ? 'needs-you' : status === 'approved' ? 'ready' : 'stopped'}
              hideLabel
            />
            {t('session.approval.eyebrow', { id: shortId })}
          </span>
        }
        tag={a && <RiskTag risk={RISK_LABEL[a.risk]} />}
        statusLine={
          statusLine && (
            <span className="inline-flex items-center gap-2">
              {status === 'approved' ? (
                <Check size={16} weight="bold" aria-hidden="true" className="text-go-text" />
              ) : (
                <X size={16} weight="bold" aria-hidden="true" className="text-stop-text" />
              )}
              {statusLine}
            </span>
          )
        }
        decision={
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cx(
                'min-w-0 flex-1 pl-1 type-meta',
                left < 120_000 ? 'text-caution-text' : 'text-ink-2',
              )}
            >
              {a ? (
                <>
                  {t('session.approval.autoDeny')}{' '}
                  <span className="text-ink tabular-nums">{countdown(left)}</span>
                </>
              ) : (
                t('session.approval.loading')
              )}
            </span>
            <Button
              variant="deny"
              size="sm"
              icon={<X size={16} weight="bold" aria-hidden="true" />}
              isDisabled={!a}
              isPending={decide.isPending && decide.variables?.allow === false}
              onPress={() => run(false)}
              aria-label={t('session.approval.denyAria', { target })}
            >
              {t('session.approval.deny')}
            </Button>
            {a?.risk === 'low' ? (
              <Button
                variant="allow"
                size="sm"
                icon={<Check size={16} weight="bold" aria-hidden="true" />}
                isPending={decide.isPending && decide.variables?.allow === true}
                onPress={() => run(true)}
                aria-label={t('session.approval.allowOnceAria', { target })}
              >
                {t('session.approval.allowOnce')}
              </Button>
            ) : (
              <Button
                variant="allow"
                size="sm"
                isDisabled={!a}
                icon={<Check size={16} weight="bold" aria-hidden="true" />}
                onPress={() =>
                  void navigate({ to: '/inbox/$approvalId', params: { approvalId: ev.approvalId! } })
                }
                aria-label={t('session.approval.allowScopeAria', { target })}
              >
                {t('session.approval.allowScope')}
              </Button>
            )}
          </div>
        }
      >
        <p className="font-mono text-[13px] leading-5 text-ink [overflow-wrap:anywhere]">{target}</p>
        {a && (
          <p className="mt-1 type-meta text-ink-2">
            {t('session.approval.by', {
              tool: a.tool,
              who: a.requestedBy.displayName ?? a.requestedBy.principal,
              role: a.requestedBy.role,
            })}
          </p>
        )}
      </TicketCard>
    </div>
  );
};

// ─────────── Small rows ───────────

const ChangesRow = ({ b, ctx }: { b: ChangesSummary; ctx: TranscriptCtx }) => (
  <div className="pb-4">
    <div className="flex min-h-11 items-center gap-3 rounded-md border border-line bg-surface py-1 pr-1 pl-3">
      <GitDiff size={18} aria-hidden="true" className="shrink-0 text-ink-2" />
      <span className="min-w-0 flex-1 type-meta text-ink">
        {t('session.changes.files', { count: b.files })} · <span className="text-go-text">+{b.added}</span>{' '}
        <span className="text-stop-text">−{b.removed}</span>
      </span>
      <Button variant="quiet" size="sm" onPress={() => ctx.onViewDiff(b.diff)}>
        {t('session.changes.view')}
      </Button>
    </div>
  </div>
);

const SystemRow = ({ ev }: { ev: SessionEventView }) => (
  <p className="flex min-h-6 items-center gap-2 pb-3 type-meta text-ink-2">
    <span aria-hidden="true" className="h-px w-3 bg-line-strong" />
    {ev.text}
  </p>
);

const ProgressRow = ({ ev }: { ev: SessionEventView }) => (
  <p className="flex min-h-6 items-center gap-2 pb-2 type-meta text-ink-2">
    <HopMeter up={2} total={3} />
    {ev.text}
  </p>
);

const ErrorRow = ({ ev }: { ev: SessionEventView }) => (
  <div className="mb-4 rounded-md border-l-[3px] border-stop-text bg-stop-wash px-3 py-2" role="note">
    <p className="type-label text-stop-text">{t('session.error.title')}</p>
    {ev.text && (
      <pre className="mt-1 type-code whitespace-pre-wrap text-ink [overflow-wrap:anywhere]">{ev.text}</pre>
    )}
  </div>
);

// ─────────── List ───────────

export const Transcript = ({
  blocks,
  ctx,
  freshFrom,
}: {
  blocks: Block[];
  ctx: TranscriptCtx;
  /** Rows with seq above this get the flare tick flash. */
  freshFrom: number;
}) => {
  let prevMinute = '';
  return (
    <div role="log" aria-live="off" aria-label={t('session.transcript', { agent: ctx.agent })}>
      <ol className="relative before:absolute before:top-0 before:bottom-0 before:left-[44px] before:w-px before:bg-line expanded:before:left-[52px]">
        {blocks.map((b) => {
          const at = blockAt(b);
          const minute = minuteOf(at);
          const showTime = minute !== prevMinute;
          prevMinute = minute;
          const seq = Number(b.key.replace(/\D+/g, '')) || 0;
          const fresh = seq > freshFrom;
          return (
            <RailRow key={b.key} at={at} showTime={showTime} fresh={fresh} kind={b.kind}>
              {b.kind === 'user' && <UserMessage ev={b.ev} ctx={ctx} />}
              {b.kind === 'assistant' && <AgentMessage ev={b.ev} streaming={b.streaming} ctx={ctx} />}
              {b.kind === 'tool' && <ToolRow tool={b} ctx={ctx} />}
              {b.kind === 'run' && <ToolRun tools={b.tools} ctx={ctx} />}
              {b.kind === 'permission' && <InlineApproval ev={b.ev} ctx={ctx} />}
              {b.kind === 'progress' && <ProgressRow ev={b.ev} />}
              {b.kind === 'system' && <SystemRow ev={b.ev} />}
              {b.kind === 'error' && <ErrorRow ev={b.ev} />}
              {b.kind === 'changes' && <ChangesRow b={b} ctx={ctx} />}
            </RailRow>
          );
        })}
      </ol>
    </div>
  );
};

export const EmptyTranscript = ({ agent }: { agent: string }) => (
  <div className="flex items-start gap-3 py-8 pl-[52px] text-ink-2">
    <ChatTeardropText size={20} aria-hidden="true" className="mt-0.5 shrink-0" />
    <p className="type-body-sm">{t('session.empty', { agent })}</p>
  </div>
);

export const OpenInInboxLink = ({ id }: { id: string }) => (
  <a href={`/inbox/${id}`} className="inline-flex items-center gap-1 type-meta text-ink-2 underline">
    {id}
    <ArrowSquareOut size={12} aria-hidden="true" />
  </a>
);
