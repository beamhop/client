/**
 * Inspector (SCREENS §3 desktop, ⌘I; a sheet on compact): session facts, usage meter, files changed,
 * approvals in this session, and — for a finished session on a git worktree — Merge / Open PR.
 * Also the DiffSheet, the WorktreeActions block and the NewSessionSheet.
 */
import type { AgentView, ApprovalView, HarnessView, SessionView } from '@beamhop/core';
import { Eye, GitBranch, GitMerge, GitPullRequest, PencilSimple } from '@phosphor-icons/react';
import { useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { approvalTarget, harnessSlug, useMutationApi } from '../../api/index.ts';
import { t } from '../../i18n/index.ts';
import { clock, tokens, usd, when } from '../../lib/format.ts';
import { Button } from '../../ui/Button.tsx';
import { CliStrip, CopyButton } from '../../ui/CliStrip.tsx';
import { DiffView, parseDiff } from '../../ui/CodeBlock.tsx';
import { Select, TextField } from '../../ui/index.ts';
import { Eyebrow, MetaLine } from '../../ui/Meta.tsx';
import { ConfirmDialog, Sheet } from '../../ui/Sheet.tsx';
import { SegmentedMeter, StatusDot } from '../../ui/Status.tsx';
import { useToast } from '../../ui/Toast.tsx';

// ─────────── Worktree actions (merge / open PR) ───────────

/**
 * beamhop has no merge/PR RPC yet, so both actions are sent to the agent as a steering message (the agent
 * does the git work inside its sandbox, and `git push` still goes through approval). The CLI strip shows
 * the exact git commands for doing it by hand.
 */
export const useWorktreeActions = (session: SessionView) => {
  const send = useMutationApi('session.send');
  const toast = useToast();
  const branch = session.worktree?.branch ?? '';
  const [kind, setKind] = useState<'pr' | 'merge' | null>(null);
  const run = (k: 'pr' | 'merge') => {
    setKind(k);
    return send
      .mutateAsync({
        id: session.id,
        text: k === 'pr' ? t('session.wt.prMessage', { branch }) : t('session.wt.mergeMessage', { branch }),
      })
      .then(() =>
        toast.show({
          message:
            k === 'pr'
              ? t('session.wt.prSent', { agent: session.agent })
              : t('session.wt.mergeSent', { agent: session.agent }),
        }),
      )
      .catch((e: Error) => toast.show({ message: e.message, tone: 'error' }));
  };
  return { run, pending: send.isPending ? kind : null };
};

export const WorktreeActions = ({
  session,
  compact,
  disabled,
}: {
  session: SessionView;
  compact?: boolean;
  disabled?: boolean;
}) => {
  const { run, pending } = useWorktreeActions(session);
  const [confirm, setConfirm] = useState(false);
  if (!session.worktree) return null;
  const wt = session.worktree;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          size={compact ? 'sm' : 'md'}
          icon={<GitPullRequest size={18} aria-hidden="true" />}
          isPending={pending === 'pr'}
          isDisabled={disabled}
          onPress={() => void run('pr')}
        >
          {t('session.wt.openPr')}
        </Button>
        <Button
          variant="secondary"
          size={compact ? 'sm' : 'md'}
          icon={<GitMerge size={18} aria-hidden="true" />}
          isPending={pending === 'merge'}
          isDisabled={disabled}
          onPress={() => setConfirm(true)}
        >
          {t('session.wt.merge')}
        </Button>
      </div>
      <CliStrip
        command={`git -C ${wt.path} push -u origin ${wt.branch}\ngh pr create --head ${wt.branch} --fill`}
      />
      <ConfirmDialog
        isOpen={confirm}
        onOpenChange={setConfirm}
        title={t('session.wt.mergeTitle', { branch: wt.branch })}
        confirmLabel={t('session.wt.merge')}
        variant="primary"
        onConfirm={() => {
          setConfirm(false);
          void run('merge');
        }}
      >
        {t('session.wt.mergeBody', { agent: session.agent, branch: wt.branch })}
      </ConfirmDialog>
    </div>
  );
};

// ─────────── Diff sheet ───────────

export const DiffSheet = ({
  diff,
  onClose,
  session,
}: {
  diff: string | null;
  onClose: () => void;
  session?: SessionView;
}) => {
  const stats = useMemo(() => {
    const files = parseDiff(diff ?? '');
    return {
      files: files.length,
      add: files.reduce((n, f) => n + f.added, 0),
      del: files.reduce((n, f) => n + f.removed, 0),
    };
  }, [diff]);
  const ended = session?.status === 'ended' || session?.status === 'idle';
  return (
    <Sheet
      isOpen={diff !== null}
      onOpenChange={(o) => !o && onClose()}
      full
      desktop="pane"
      title={t('session.diff.title')}
      subtitle={
        <>
          {t('session.changes.files', { count: stats.files })} ·{' '}
          <span className="text-go-text">+{stats.add}</span>{' '}
          <span className="text-stop-text">−{stats.del}</span>
          {session?.worktree && <> · {session.worktree.branch}</>}
        </>
      }
      footer={session?.worktree && ended ? <WorktreeActions session={session} compact /> : undefined}
    >
      {diff && <DiffView diff={diff} />}
    </Sheet>
  );
};

// ─────────── Inspector ───────────

const Fact = ({ k, children }: { k: string; children: React.ReactNode }) => (
  <>
    <dt className="type-meta text-ink-3">{k}</dt>
    <dd className="min-w-0 type-meta break-words text-ink">{children}</dd>
  </>
);

export const Inspector = ({
  session,
  agent,
  harnesses,
  approvals,
  diff,
  onViewDiff,
}: {
  session: SessionView;
  agent?: AgentView;
  harnesses?: HarnessView[];
  approvals: ApprovalView[];
  diff: string;
  onViewDiff: () => void;
}) => {
  const files = useMemo(() => parseDiff(diff), [diff]);
  const budget = agent?.config.budgets.dailyUsd ?? 0;
  const today = agent?.usageToday.usd ?? 0;
  const mine = approvals.filter((a) => a.sessionId === session.id);
  return (
    <div className="flex flex-col gap-6" data-testid="inspector">
      <section aria-labelledby="insp-session">
        <Eyebrow id="insp-session" level={3}>
          {t('session.insp.session')}
        </Eyebrow>
        <dl className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-1.5">
          <Fact k={t('session.insp.status')}>
            <StatusDot
              state={
                session.status === 'running'
                  ? 'live'
                  : session.status === 'error'
                    ? 'error'
                    : session.status === 'queued'
                      ? 'paused'
                      : session.status === 'idle'
                        ? 'ready'
                        : 'stopped'
              }
              label={t(`session.status.${session.status}`)}
            />
          </Fact>
          {agent && <Fact k={t('session.insp.harness')}>{harnessSlug(agent.config.harness, harnesses)}</Fact>}
          {agent && <Fact k={t('session.insp.model')}>{agent.config.model}</Fact>}
          {agent && <Fact k={t('session.insp.profile')}>{agent.config.sandbox.profile}</Fact>}
          <Fact k={t('session.insp.started')}>{when(session.startedAt)}</Fact>
          <Fact k={t('session.insp.thread')}>
            {session.channel}:{session.conversationId} · {session.threadId}
          </Fact>
          {session.worktree && (
            <Fact k={t('session.insp.worktree')}>
              <span className="inline-flex items-center gap-1.5">
                <GitBranch size={14} aria-hidden="true" />
                {session.worktree.branch}
              </span>
              <span className="mt-0.5 flex items-center gap-1 text-ink-2">
                <span className="min-w-0 truncate" title={session.worktree.path}>
                  {session.worktree.path}
                </span>
                <CopyButton
                  value={session.worktree.path}
                  label={t('session.insp.copyPath')}
                  compact
                  className="-my-2"
                />
              </span>
            </Fact>
          )}
          {agent && agent.config.mounts.length > 0 && (
            <Fact k={t('session.insp.mounts')}>
              <ul className="flex flex-col gap-0.5">
                {agent.config.mounts.map((m) => (
                  <li key={m.path} className="flex items-center gap-1.5">
                    {m.mode === 'rw' ? (
                      <PencilSimple size={14} aria-hidden="true" />
                    ) : (
                      <Eye size={14} aria-hidden="true" />
                    )}
                    {m.path} <span className="text-ink-2">{m.mode}</span>
                  </li>
                ))}
              </ul>
            </Fact>
          )}
        </dl>
      </section>

      <section aria-labelledby="insp-usage">
        <Eyebrow id="insp-usage" level={3}>
          {t('session.insp.usage')}
        </Eyebrow>
        <p className="type-title-3 text-ink tabular-nums">{usd(session.usage.usd)}</p>
        <MetaLine
          items={[
            t('session.insp.tokensIn', { n: tokens(session.usage.inputTokens) }),
            t('session.insp.tokensOut', { n: tokens(session.usage.outputTokens) }),
          ]}
        />
        {agent && budget > 0 && (
          <SegmentedMeter
            className="mt-3"
            name={t('session.insp.budgetName', { agent: agent.config.name })}
            value={today}
            max={budget}
            label={t('session.insp.budget', { used: usd(today), max: usd(budget) })}
            valueText={t('session.insp.budgetSpoken', { used: usd(today), max: usd(budget) })}
          />
        )}
      </section>

      <section aria-labelledby="insp-files">
        <Eyebrow
          id="insp-files"
          level={3}
          count={files.length}
          action={
            files.length > 0 && (
              <Button variant="quiet" size="sm" onPress={onViewDiff}>
                {t('session.changes.view')}
              </Button>
            )
          }
        >
          {t('session.insp.files')}
        </Eyebrow>
        {files.length === 0 ? (
          <p className="type-body-sm text-ink-2">{t('session.insp.noFiles')}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {files.map((f, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a file may appear in several edits
              <li key={`${f.path}-${i}`} className="flex items-center gap-2 type-meta">
                <span className="min-w-0 flex-1 truncate text-ink" title={f.path}>
                  {f.path}
                </span>
                <span className="text-go-text">+{f.added}</span>
                <span className="text-stop-text">−{f.removed}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="insp-approvals">
        <Eyebrow id="insp-approvals" level={3} count={mine.length}>
          {t('session.insp.approvals')}
        </Eyebrow>
        {mine.length === 0 ? (
          <p className="type-body-sm text-ink-2">{t('session.insp.noApprovals')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {mine.map((a) => (
              <li key={a.id} className="flex flex-col gap-0.5">
                <span className="truncate font-mono text-[13px] text-ink">{approvalTarget(a)}</span>
                <StatusDot
                  state={a.status === 'pending' ? 'needs-you' : a.status === 'approved' ? 'ready' : 'stopped'}
                  label={
                    a.status === 'pending'
                      ? t('session.insp.apPending')
                      : t(`session.insp.ap.${a.status}`, {
                          who: a.decidedBy ?? '',
                          time: a.decidedAt ? clock(a.decidedAt) : clock(a.expiresAt),
                        })
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      {session.worktree && (session.status === 'ended' || session.status === 'idle') && (
        <section aria-labelledby="insp-wt">
          <Eyebrow id="insp-wt" level={3}>
            {t('session.insp.branch')}
          </Eyebrow>
          <WorktreeActions session={session} compact />
        </section>
      )}
    </div>
  );
};

// ─────────── New session ───────────

export const NewSessionSheet = ({
  isOpen,
  onOpenChange,
  agents,
  defaultAgent,
}: {
  isOpen: boolean;
  onOpenChange: (o: boolean) => void;
  agents: AgentView[];
  defaultAgent?: string;
}) => {
  const [agent, setAgent] = useState<string | undefined>(defaultAgent);
  const [text, setText] = useState('');
  const start = useMutationApi('session.start');
  const navigate = useNavigate();
  const toast = useToast();
  const chosen = agent ?? defaultAgent ?? agents[0]?.config.name;
  const submit = () => {
    if (!chosen || !text.trim()) return;
    start
      .mutateAsync({ agent: chosen, text: text.trim() })
      .then((s) => {
        setText('');
        onOpenChange(false);
        void navigate({ to: '/sessions/$sessionId', params: { sessionId: s.id } });
      })
      .catch((e: Error) => toast.show({ message: e.message, tone: 'error' }));
  };
  return (
    <Sheet
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={t('session.new.title')}
      subtitle={t('session.new.subtitle')}
      footer={
        <Button
          variant="primary"
          size="lg"
          fullWidth
          isPending={start.isPending}
          isDisabled={!text.trim() || !chosen}
          onPress={submit}
        >
          {t('session.new.start', { agent: chosen ?? '' })}
        </Button>
      }
    >
      <form
        className="flex flex-col gap-4 pt-1"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Select
          label={t('session.new.agent')}
          options={agents.map((a) => ({
            id: a.config.name,
            label: a.config.name,
            description: `${a.config.harness} · ${a.status}`,
          }))}
          selectedKey={chosen ?? null}
          onSelectionChange={(k) => setAgent(String(k))}
        />
        <TextField
          label={t('session.new.message', { agent: chosen ?? 'the agent' })}
          multiline
          rows={4}
          value={text}
          onChange={setText}
          autoFocus
          description={t('session.new.hint')}
        />
      </form>
    </Sheet>
  );
};
