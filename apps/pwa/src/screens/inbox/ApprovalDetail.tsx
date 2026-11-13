/**
 * Approval detail — SCREENS §2 desktop detail / JOURNEYS §2.7 Details.
 * Route: /inbox/$approvalId. The complete request (full command / diff / URL), the conversation
 * around it (last 3 messages before the request), the policy rule that caused "ask", who can decide,
 * and the same decision bar pinned at the bottom (keys D / A / ⇧A shown on pointer devices).
 */
import type { ApprovalView, SessionEventView } from '@beamhop/core';
import { ArrowSquareOut, Check, Clock, ShieldCheck, X } from '@phosphor-icons/react';
import { useParams } from '@tanstack/react-router';
import { approvalTarget, RISK_LABEL, useApi } from '../../api/index.ts';
import { t } from '../../i18n/index.ts';
import { cx } from '../../lib/cx.ts';
import { clock, when } from '../../lib/format.ts';
import { useExpanded } from '../../lib/media.ts';
import { useNow } from '../../lib/useNow.ts';
import { Screen } from '../../shell/Screen.tsx';
import { LinkButton } from '../../ui/Button.tsx';
import { Perforation } from '../../ui/glyphs/index.tsx';
import { Eyebrow, MetaLine, RiskTag } from '../../ui/Meta.tsx';
import { EmptyState, Skeleton, useDelayedLoading } from '../../ui/States.tsx';
import { useInbox } from './context.ts';
import { inputOf, quorumOf, type SlipGroup } from './model.ts';
import { DecisionBar, SlipBody, slipTitle, TimesBadge } from './Slip.tsx';
import { mineStore, useStore } from './store.ts';

const Context = ({ a }: { a: ApprovalView }) => {
  const q = useApi(
    'session.events',
    { id: a.sessionId, afterSeq: 0 },
    { enabled: a.sessionId !== 'ses_old' },
  );
  const events = q.data?.events ?? [];
  const at = events.findIndex((e) => e.approvalId === a.id);
  const before = (at === -1 ? events : events.slice(0, at)).filter(
    (e): e is SessionEventView & { text: string } =>
      (e.kind === 'user' || e.kind === 'assistant') && !!e.text,
  );
  const excerpt = before.slice(-3);
  if (q.isPending || excerpt.length === 0) return null;
  return (
    <section aria-labelledby="apr-context">
      <Eyebrow id="apr-context" level={2}>
        {t('inbox.detail.context')}
      </Eyebrow>
      <ol className="flex flex-col gap-2 border-l border-line pl-4">
        {excerpt.map((e) => (
          <li key={e.seq} className="relative">
            <span aria-hidden="true" className="absolute top-2.5 -left-4 h-px w-2 bg-line-strong" />
            <p className="flex items-baseline gap-2 type-meta text-ink-2">
              <span className="text-ink">
                {e.kind === 'assistant' ? a.agent : (e.from?.displayName ?? 'user')}
              </span>
              {e.kind === 'user' && e.from?.role && <span>({e.from.role})</span>}
              <span className="ml-auto tabular-nums">{clock(e.at)}</span>
            </p>
            <p className={cx('line-clamp-3 type-body-sm', e.kind === 'user' ? 'text-ink-2' : 'text-ink')}>
              {e.text}
            </p>
          </li>
        ))}
      </ol>
      <LinkButton
        href={`/sessions/${a.sessionId}`}
        variant="quiet"
        size="sm"
        className="mt-1 -ml-3"
        icon={<ArrowSquareOut size={16} aria-hidden="true" />}
      >
        {t('inbox.detail.openSession')}
      </LinkButton>
    </section>
  );
};

const STATUS_LINE = (a: ApprovalView): string =>
  a.status === 'expired'
    ? t('inbox.ghost.expired', { time: a.decidedAt ? when(a.decidedAt) : '' })
    : a.status === 'approved'
      ? t('inbox.detail.allowedBy', {
          who: a.decidedBy ?? 'an owner',
          time: a.decidedAt ? when(a.decidedAt) : '',
        })
      : t('inbox.detail.deniedBy', {
          who: a.decidedBy ?? 'an owner',
          time: a.decidedAt ? when(a.decidedAt) : '',
        });

export const ApprovalDetail = () => {
  const { approvalId } = useParams({ strict: false }) as { approvalId: string };
  const ctx = useInbox();
  const fallback = useApi('approval.list', { status: 'all' }, { enabled: !ctx });
  const now = useNow(1000);
  const expanded = useExpanded();
  const mine = useStore(mineStore);
  const all = ctx?.all ?? fallback.data?.approvals ?? [];
  const a = all.find((x) => x.id === approvalId);
  const group: SlipGroup | undefined =
    ctx?.groups.find((g) => g.items.some((x) => x.id === approvalId)) ??
    (a ? { key: a.id, lead: a, items: [a] } : undefined);
  const loading = !a && (ctx ? ctx.all.length === 0 : fallback.isPending);
  const showSkeleton = useDelayedLoading(loading);
  const short = approvalId.replace(/^apr_/, '');
  const quorum = a ? quorumOf(a, mine) : null;
  const pending = a?.status === 'pending';
  const waiting = !!quorum?.youVoted;

  const frame = (children: React.ReactNode, footer?: React.ReactNode) => (
    <Screen
      title={a ? slipTitle(a) : t('inbox.detail.title', { id: short })}
      back={{ href: '/inbox', label: t('nav.inbox') }}
      pane="detail"
      maxWidth="prose"
      crumbs={[{ label: t('nav.inbox'), href: '/inbox' }, { label: `#${short}` }]}
      footer={footer}
    >
      {children}
    </Screen>
  );

  if (loading) return frame(showSkeleton ? <Skeleton variant="detail" label={t('inbox.loading')} /> : null);
  if (!a || !group)
    return frame(
      <EmptyState
        title={t('inbox.detail.goneTitle')}
        action={
          <LinkButton href="/inbox" variant="secondary">
            {t('inbox.detail.back')}
          </LinkButton>
        }
      >
        {t('inbox.detail.gone')}
      </EmptyState>,
    );

  const i = inputOf(a);
  const decision =
    pending && !waiting && ctx ? (
      <div className="px-gutter py-3 expanded:px-8">
        <div className="max-w-[760px]">
          <DecisionBar
            g={group}
            quorum={quorum}
            hints={expanded}
            onDeny={() => ctx.act.deny(group)}
            onAllow={() => ctx.act.allow(group)}
          />
        </div>
      </div>
    ) : undefined;

  return frame(
    <article aria-labelledby="apr-what" className="flex flex-col gap-8 pt-2">
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <span className="type-micro text-ink-2">
            {a.kind === 'access-request' ? t('inbox.eyebrow.access') : t('inbox.eyebrow.approval')} · #{short}
          </span>
          <span className="flex items-center gap-2">
            {pending && <TimesBadge n={group.items.length} />}
            <RiskTag risk={RISK_LABEL[a.risk]} />
          </span>
        </div>
        <h2 id="apr-what" className="sr-only">
          {a.title}: {approvalTarget(a)}
        </h2>
        {pending ? (
          <SlipBody g={group} now={now} focused quorum={quorum} full hideTitle />
        ) : (
          <>
            <SlipBody g={{ ...group, items: [a] }} now={now} full hideTitle />
            <p
              className={cx(
                'flex items-center gap-2 rounded-md px-3 py-2 type-body-sm',
                a.status === 'approved'
                  ? 'bg-go-wash text-go-text'
                  : a.status === 'denied'
                    ? 'bg-stop-wash text-stop-text'
                    : 'bg-caution-wash text-caution-text',
              )}
            >
              {a.status === 'approved' ? (
                <Check size={16} weight="bold" aria-hidden="true" />
              ) : a.status === 'denied' ? (
                <X size={16} weight="bold" aria-hidden="true" />
              ) : (
                <Clock size={16} weight="bold" aria-hidden="true" />
              )}
              {STATUS_LINE(a)}
            </p>
          </>
        )}
        {waiting && quorum && (
          <p className="rounded-md bg-caution-wash px-3 py-2 type-body-sm text-ink">
            {t('inbox.detail.waiting', { count: quorum.remaining })}
          </p>
        )}
      </div>
      <Perforation className="text-line-strong" />
      <Context a={a} />
      {i.rule && (
        <section aria-labelledby="apr-policy">
          <Eyebrow id="apr-policy">{t('inbox.detail.policy')}</Eyebrow>
          <p className="flex items-center gap-2 type-meta text-ink">
            <ShieldCheck size={16} aria-hidden="true" className="text-ink-2" />
            {i.rule}
          </p>
          <LinkButton href="/policy" variant="quiet" size="sm" className="mt-1 -ml-3">
            {t('inbox.detail.editPolicy')}
          </LinkButton>
        </section>
      )}
      <section aria-labelledby="apr-who">
        <Eyebrow id="apr-who">{t('inbox.detail.who')}</Eyebrow>
        <MetaLine
          className="whitespace-normal"
          items={[
            a.quorum && a.quorum.needed > 1
              ? t('inbox.detail.quorumRule', { needed: a.quorum.needed, pool: a.quorum.pool })
              : t('inbox.detail.anyOwner'),
            t('inbox.detail.requested', { time: when(a.createdAt) }),
            `id ${a.id}`,
          ]}
        />
        <p className="mt-2 type-body-sm text-ink-2">
          {t('inbox.detail.nostr')}{' '}
          <code className="font-mono text-[0.875em] text-ink">/approve {short}</code>
        </p>
      </section>
    </article>,
    decision,
  );
};
