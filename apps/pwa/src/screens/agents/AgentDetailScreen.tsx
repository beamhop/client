/**
 * Agent detail — SCREENS §4.2. Routes: /agents/$name and /agents/$name/$section.
 * Header: tile, lamp + word, location, AI disclosure, npub · NIP-05 slug with copy, Doto "$1.80 left" +
 * segmented meter (the screen's one readout), Stop (one tap) / Start, `⋯` Clone · Move to cloud ·
 * Stop hard · Delete. Sections are routes: a single <nav> that is a sticky, horizontally scrolling strip
 * on narrow panes and a 160px left sub-nav when the pane is wide (container query), so the same
 * links serve phone, split view and wide desktop without duplicate landmarks.
 *
 * Research: section sub-navigation as links (not ARIA tabs) because every section is its own URL —
 * WAI-ARIA APG reserves the tabs pattern for in-page panels (https://www.w3.org/WAI/ARIA/apg/patterns/tabs/);
 * edit-in-place sections with one sticky save bar + review-before-save follow Cloudscape's "edit"
 * resource pattern (https://cloudscape.design/patterns/resource-management/edit/).
 */
import type { AgentView } from '@beamhop/core';
import { CloudArrowUp, Copy as CopyIcon, Play, Stop, Trash, XCircle } from '@phosphor-icons/react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link } from 'react-aria-components';
import { agentLamp, harnessMonogram, useApi, useMutationApi } from '../../api/index.ts';
import { type MessageKey, t } from '../../i18n/index.ts';
import { cx } from '../../lib/cx.ts';
import { middleTruncate, usd } from '../../lib/format.ts';
import { haptic } from '../../lib/haptics.ts';
import { useExpanded } from '../../lib/media.ts';
import { usePanicState } from '../../shell/panic.tsx';
import { Screen } from '../../shell/Screen.tsx';
import { Button, IconButton, LinkButton } from '../../ui/Button.tsx';
import { CopyButton } from '../../ui/CliStrip.tsx';
import { TextField } from '../../ui/Field.tsx';
import { LetterTile, Readout } from '../../ui/Meta.tsx';
import { ConfirmDialog, Sheet } from '../../ui/Sheet.tsx';
import { EmptyState, ErrorState, Skeleton, useDelayedLoading } from '../../ui/States.tsx';
import { SegmentedMeter, StatusDot } from '../../ui/Status.tsx';
import { useToast } from '../../ui/Toast.tsx';
import { AGENT_SECTIONS, type AgentSection, isSection, suggestName, validateName } from './model.ts';
import { OverflowMenu } from './parts.tsx';
import { BudgetsSection } from './sections/Budgets.tsx';
import { ChannelsSection } from './sections/Channels.tsx';
import { IdentitySection } from './sections/Identity.tsx';
import { OverviewSection } from './sections/Overview.tsx';
import { SandboxSection } from './sections/Sandbox.tsx';
import { SchedulesSection } from './sections/Schedules.tsx';
import { SetupSection } from './sections/Setup.tsx';

export { AGENT_SECTIONS };

const sectionLabel = (s: AgentSection) => t(`agents.section.${s}` as MessageKey);

// ─────────── Section nav ───────────

const SectionNav = ({ name, current }: { name: string; current: AgentSection }) => {
  const ref = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const ul = ref.current;
    const el = ul?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!ul || !el || ul.scrollWidth <= ul.clientWidth) return;
    const left = el.offsetLeft - ul.offsetLeft;
    if (left < ul.scrollLeft || left + el.offsetWidth > ul.scrollLeft + ul.clientWidth)
      ul.scrollLeft = left - 16;
  }, []);
  return (
    <nav
      aria-label={t('agents.sectionsNav', { name })}
      className={cx(
        'sticky top-[calc(52px+var(--bh-safe-top))] z-10 -mx-4 bg-bg px-4 medium:-mx-6 medium:px-6',
        'expanded:top-0 expanded:mx-0 expanded:px-0',
        '@min-[44rem]/detail:static @min-[44rem]/detail:self-start',
      )}
    >
      <ul
        ref={ref}
        className={cx(
          'flex overflow-x-auto border-b border-line [scrollbar-width:none]',
          '@min-[44rem]/detail:sticky @min-[44rem]/detail:top-4 @min-[44rem]/detail:flex-col @min-[44rem]/detail:overflow-visible @min-[44rem]/detail:border-b-0',
        )}
      >
        {AGENT_SECTIONS.map((s) => {
          const active = s === current;
          return (
            <li key={s} className="shrink-0">
              <Link
                href={`/agents/${name}/${s}`}
                aria-current={active ? 'page' : undefined}
                className={cx(
                  'relative flex min-h-11 items-center px-3 type-label outline-none data-[focus-visible]:outline-2 data-[focus-visible]:-outline-offset-2 data-[focus-visible]:outline-focus',
                  active ? 'text-ink' : 'text-ink-2 data-[hovered]:text-ink',
                  '@min-[44rem]/detail:min-h-10 @min-[44rem]/detail:rounded-md @min-[44rem]/detail:px-3',
                  active && '@min-[44rem]/detail:bg-sunken',
                )}
              >
                {sectionLabel(s)}
                {active && (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-3 -bottom-px h-0.5 bg-flare @min-[44rem]/detail:inset-x-auto @min-[44rem]/detail:top-2 @min-[44rem]/detail:bottom-2 @min-[44rem]/detail:left-0 @min-[44rem]/detail:h-auto @min-[44rem]/detail:w-0.5"
                  />
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
};

// ─────────── Header ───────────

const Header = ({ a, lampPending, panic }: { a: AgentView; lampPending: number; panic: boolean }) => {
  const status = useApi('system.status');
  const owner = status.data?.owner.npub;
  const budget = a.config.budgets.dailyUsd ?? 0;
  const left = budget - a.usageToday.usd;
  const lamp = agentLamp(a, { pending: lampPending, panic });
  const npub = a.config.identity.npub;
  return (
    <div className="flex flex-col gap-3 pt-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <LetterTile code={harnessMonogram(a.config.harness)} />
        <StatusDot
          state={lamp}
          label={lamp === 'needs-you' ? t('agents.lamp.needs', { count: lampPending }) : undefined}
        />
        <span className="type-meta text-ink-2">
          · {a.location.kind === 'cloud' ? (a.location.provider ?? 'cloud') : t('agents.local')}
        </span>
      </div>
      <div className="flex flex-col gap-0.5">
        <p className="type-body-sm text-ink-2">
          {t('agents.aiDisclosure', { owner: owner ? middleTruncate(owner, 14) : t('agents.you') })}
        </p>
        <div className="flex min-w-0 items-center gap-1">
          <p className="min-w-0 truncate type-meta text-ink-2">
            <span title={npub}>{npub ? middleTruncate(npub, 15) : t('agents.noNpub')}</span>
            {a.config.identity.nip05 && <span> · {a.config.identity.nip05}</span>}
          </p>
          {npub && <CopyButton value={npub} label={t('agents.copyNpub')} compact className="-my-2" />}
        </div>
      </div>
      {a.status === 'error' && a.error && (
        <p className="flex items-start gap-1.5 type-body-sm text-stop-text">
          <XCircle size={16} weight="bold" aria-hidden="true" className="mt-0.5 shrink-0" />
          {a.error}
        </p>
      )}
      {budget > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-end gap-3">
            <Readout
              tone={left < 0 ? 'stop' : left < budget * 0.2 ? 'caution' : 'ink'}
              className="leading-none"
            >
              {usd(Math.abs(left))}
            </Readout>
            <span className="pb-1 type-micro text-ink-2">
              {left >= 0 ? t('agents.leftToday') : t('agents.overToday')}
            </span>
          </div>
          <span className="sr-only">
            {left >= 0 ? t('agents.left', { amount: usd(left) }) : t('agents.over', { amount: usd(-left) })}
          </span>
          <SegmentedMeter
            name={t('agents.budgetName', { name: a.config.name })}
            value={a.usageToday.usd}
            max={budget}
            label={t('agents.budgetLabel', { used: usd(a.usageToday.usd), max: usd(budget) })}
            valueText={t('agents.budgetText', { used: usd(a.usageToday.usd), max: usd(budget) })}
          />
        </div>
      )}
    </div>
  );
};

// ─────────── Lifecycle actions ───────────

const Lifecycle = ({ a, panic }: { a: AgentView; panic: boolean }) => {
  const expanded = useExpanded();
  const navigate = useNavigate();
  const toast = useToast();
  const stop = useMutationApi('agent.stop');
  const start = useMutationApi('agent.start');
  const del = useMutationApi('agent.delete');
  const clone = useMutationApi('agent.clone');
  const all = useApi('agent.list');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  const name = a.config.name;
  const taken = (all.data?.agents ?? []).map((x) => x.config.name);
  const [newName, setNewName] = useState('');
  const cloneErr = cloneOpen ? validateName(newName, taken) : undefined;
  const running = a.status !== 'stopped' && a.status !== 'error';

  const doStop = (hard = false) => {
    haptic('tick');
    stop
      .mutateAsync({ name, hard })
      .then(() => toast.show({ message: t(hard ? 'agents.stoppedHard' : 'agents.stopped', { name }) }))
      .catch((e: Error) => toast.show({ tone: 'error', message: e.message }));
  };
  const doStart = () =>
    start
      .mutateAsync({ name })
      .then(() => toast.show({ message: t('agents.started', { name }) }))
      .catch((e: Error) => toast.show({ tone: 'error', message: e.message }));

  const primary = panic ? (
    <LinkButton href="/panic" size="sm" variant="secondary">
      {t('panic.review')}
    </LinkButton>
  ) : running ? (
    expanded ? (
      <Button
        size="sm"
        variant="destructive-outline"
        icon={<Stop size={16} weight="fill" aria-hidden="true" />}
        isPending={stop.isPending}
        onPress={() => doStop()}
      >
        {t('agents.stop')}
      </Button>
    ) : (
      <IconButton
        label={t('agents.stopName', { name })}
        icon={<Stop size={20} weight="fill" className="text-stop-text" />}
        isDisabled={stop.isPending}
        onPress={() => doStop()}
      />
    )
  ) : expanded ? (
    <Button
      size="sm"
      variant="secondary"
      icon={<Play size={16} weight="fill" aria-hidden="true" />}
      isPending={start.isPending}
      onPress={doStart}
    >
      {t('agents.start')}
    </Button>
  ) : (
    <IconButton
      label={t('agents.startName', { name })}
      icon={<Play size={20} weight="fill" />}
      onPress={doStart}
    />
  );

  return (
    <>
      {primary}
      <OverflowMenu
        label={t('agents.more', { name })}
        actions={[
          { id: 'clone', label: t('agents.clone'), icon: <CopyIcon size={18} aria-hidden="true" /> },
          ...(a.location.kind === 'local'
            ? [
                {
                  id: 'cloud',
                  label: t('agents.moveCloud'),
                  icon: <CloudArrowUp size={18} aria-hidden="true" />,
                },
              ]
            : []),
          ...(running && !panic
            ? [{ id: 'hard', label: t('agents.stopHard'), icon: <Stop size={18} aria-hidden="true" /> }]
            : []),
          {
            id: 'delete',
            label: t('agents.delete'),
            icon: <Trash size={18} aria-hidden="true" />,
            tone: 'stop' as const,
            separated: true,
          },
        ]}
        onAction={(id) => {
          if (id === 'clone') {
            setNewName(suggestName(`${name}-copy`, taken));
            setCloneOpen(true);
          } else if (id === 'cloud') void navigate({ href: `/deploy/new?agent=${name}` });
          else if (id === 'hard') doStop(true);
          else if (id === 'delete') setConfirmDelete(true);
        }}
      />
      <ConfirmDialog
        isOpen={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('agents.deleteTitle', { name })}
        confirmLabel={t('agents.deleteConfirm', { name })}
        isPending={del.isPending}
        onConfirm={() =>
          del
            .mutateAsync({ name })
            .then(() => {
              haptic('reject');
              setConfirmDelete(false);
              toast.show({ message: t('agents.deleted', { name }) });
              void navigate({ to: '/agents' });
            })
            .catch((e: Error) => {
              toast.show({ tone: 'error', message: e.message });
            })
        }
      >
        {t('agents.deleteBody', {
          days: a.config.retention.transcriptDays,
          sessions: a.activeSessions,
        })}
      </ConfirmDialog>
      <Sheet
        isOpen={cloneOpen}
        onOpenChange={setCloneOpen}
        title={t('agents.cloneTitle', { name })}
        footer={
          <Button
            variant="primary"
            size="lg"
            fullWidth
            isDisabled={!!cloneErr}
            isPending={clone.isPending}
            onPress={() =>
              clone
                .mutateAsync({ name, newName })
                .then(() => {
                  setCloneOpen(false);
                  toast.show({ tone: 'success', message: t('agents.cloned', { name: newName }) });
                  void navigate({ to: '/agents/$name', params: { name: newName } });
                })
                .catch((e: Error) => toast.show({ tone: 'error', message: e.message }))
            }
          >
            {t('agents.cloneConfirm', { name: newName || '…' })}
          </Button>
        }
      >
        <div className="flex flex-col gap-3">
          <TextField
            label={t('agents.cloneName')}
            value={newName}
            onChange={(v) => setNewName(v.toLowerCase())}
            mono
            autoFocus
            isInvalid={!!cloneErr}
            errorMessage={cloneErr}
            description={t('agents.cloneHint')}
          />
        </div>
      </Sheet>
    </>
  );
};

// ─────────── Screen ───────────

const SECTION: Record<AgentSection, (p: { agent: AgentView }) => ReactNode> = {
  overview: OverviewSection,
  setup: SetupSection,
  sandbox: SandboxSection,
  channels: ChannelsSection,
  schedules: SchedulesSection,
  budgets: BudgetsSection,
  identity: IdentitySection,
};

export const AgentDetailScreen = () => {
  const params = useParams({ strict: false }) as { name: string; section?: string };
  const name = params.name;
  const section: AgentSection = isSection(params.section) ? params.section : 'overview';
  const q = useApi('agent.get', { name });
  const approvals = useApi('approval.list');
  const { panic } = usePanicState();
  const showSkeleton = useDelayedLoading(q.isPending);
  const a = q.data;
  const pending = (approvals.data?.approvals ?? []).filter((x) => x.agent === name).length;
  const notFound = (q.error as { beamhopCode?: string } | null)?.beamhopCode === 'not_found';
  const Body = SECTION[section];

  return (
    <Screen
      title={name}
      back={{ href: '/agents', label: t('nav.agents') }}
      pane="detail"
      maxWidth="none"
      crumbs={[
        { label: t('nav.agents'), href: '/agents' },
        { label: name, href: `/agents/${name}` },
        { label: sectionLabel(section) },
      ]}
      actions={a ? <Lifecycle a={a} panic={panic} /> : undefined}
      slug={a ? <Header a={a} lampPending={pending} panic={panic} /> : undefined}
    >
      {q.isPending ? (
        showSkeleton ? (
          <Skeleton variant="detail" count={3} label={t('agents.loadingOne', { name })} />
        ) : null
      ) : notFound ? (
        <EmptyState
          title={t('agents.notFound', { name })}
          action={<LinkButton href="/agents">{t('agents.backToList')}</LinkButton>}
          cli="beamhop agent list"
        >
          {t('agents.notFoundBody')}
        </EmptyState>
      ) : !a ? (
        <ErrorState
          title={t('agents.loadOneError', { name })}
          details={q.error}
          onRetry={() => void q.refetch()}
        >
          {t('agents.loadErrorBody')}
        </ErrorState>
      ) : (
        <div className="@container/detail">
          <div className="flex flex-col gap-4 @min-[44rem]/detail:grid @min-[44rem]/detail:grid-cols-[152px_minmax(0,1fr)] @min-[44rem]/detail:gap-8">
            <SectionNav name={name} current={section} />
            <div className="min-w-0 max-w-[640px] pt-2" key={section}>
              <h2 className="sr-only">{sectionLabel(section)}</h2>
              <Body agent={a} />
            </div>
          </div>
        </div>
      )}
    </Screen>
  );
};
