/**
 * Shared pieces for the Agents screens: section Block, the draft model + sticky SaveBar + review sheet
 * (plain-language diff, YAML patch, "Widen access" for widening changes), ReachSummary, OverflowMenu.
 */
import type { AgentConfig, AgentView } from '@beamhop/core';
import { DotsThreeVertical, LockSimple } from '@phosphor-icons/react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Menu, MenuItem, MenuTrigger, Popover, Button as RACButton, Separator } from 'react-aria-components';
import { useConnection, useMutationApi } from '../../api/index.ts';
import { t } from '../../i18n/index.ts';
import { cx } from '../../lib/cx.ts';
import { haptic } from '../../lib/haptics.ts';
import { Button } from '../../ui/Button.tsx';
import { CliStrip } from '../../ui/CliStrip.tsx';
import { CodeBlock } from '../../ui/CodeBlock.tsx';
import { Eyebrow } from '../../ui/Meta.tsx';
import { Sheet } from '../../ui/Sheet.tsx';
import { useToast } from '../../ui/Toast.tsx';
import { type Change, describeChanges, patchOf, type Reach, toYaml } from './model.ts';

// ─────────── Block ───────────

/** A titled block inside a section: micro eyebrow, optional one-line description, content, CLI strip. */
export const Block = ({
  title,
  id,
  description,
  action,
  cli,
  children,
  className,
}: {
  title: string;
  id: string;
  description?: ReactNode;
  action?: ReactNode;
  cli?: string;
  children: ReactNode;
  className?: string;
}) => (
  <section aria-labelledby={id} className={cx('flex flex-col gap-3', className)}>
    <div>
      <Eyebrow id={id} level={3} action={action} className="min-h-9">
        {title}
      </Eyebrow>
      {description && <p className="type-body-sm text-ink-2">{description}</p>}
    </div>
    {children}
    {cli && <CliStrip command={cli} />}
  </section>
);

/** Hairline list group (surface card with dividers). */
export const Rows = ({
  children,
  label,
  className,
}: {
  children: ReactNode;
  label?: string;
  className?: string;
}) => (
  <ul
    aria-label={label}
    className={cx('divide-y divide-line rounded-lg border border-line bg-surface', className)}
  >
    {children}
  </ul>
);

// ─────────── Draft ───────────

/**
 * A local, editable copy of the agent config. Re-syncs from the server while untouched (live events
 * keep it fresh); once dirty it is kept until saved or discarded.
 */
export const useAgentDraft = (agent: AgentView) => {
  const [draft, setDraft] = useState<AgentConfig>(agent.config);
  const base = useRef(agent.config);
  const patch = useMemo(() => patchOf(base.current, draft), [draft]);
  const dirty = Object.keys(patch).length > 0;
  useEffect(() => {
    if (!dirty) {
      base.current = agent.config;
      setDraft(agent.config);
    }
  }, [agent.config, dirty]);
  return {
    draft,
    base: base.current,
    patch,
    dirty,
    set: (fn: (c: AgentConfig) => AgentConfig) => setDraft((c) => fn(c)),
    reset: () => setDraft(base.current),
    /** After a successful save the server copy becomes the new base. */
    commit: (cfg: AgentConfig) => {
      base.current = cfg;
      setDraft(cfg);
    },
  };
};
export type AgentDraft = ReturnType<typeof useAgentDraft>;

// ─────────── Save bar + review ───────────

export const SaveBar = ({ agent, d }: { agent: AgentView; d: AgentDraft }) => {
  const [open, setOpen] = useState(false);
  const toast = useToast();
  const { online } = useConnection();
  const update = useMutationApi('agent.update');
  const changes: Change[] = useMemo(() => describeChanges(d.base, d.draft), [d.base, d.draft]);
  const widens = changes.some((c) => c.widens);
  if (!d.dirty) return null;
  const n = Math.max(1, changes.length);
  const save = () =>
    update
      .mutateAsync({ name: agent.config.name, patch: d.patch })
      .then((a) => {
        haptic('confirm');
        d.commit(a.config);
        setOpen(false);
        toast.show({
          tone: 'success',
          message:
            agent.activeSessions > 0
              ? t('agents.save.doneRunning', { name: agent.config.name, count: agent.activeSessions })
              : t('agents.save.done', { name: agent.config.name }),
        });
      })
      .catch((e: Error) => {
        haptic('error');
        toast.show({ tone: 'error', message: t('agents.save.failed', { reason: e.message }) });
      });
  return (
    <>
      <div
        className={cx(
          'sticky bottom-[calc(var(--bh-tabbar-h)+var(--bh-safe-bottom))] z-20 mt-8 -mx-4 border-t border-line bg-bg px-4 py-3 medium:-mx-6 medium:px-6',
          'expanded:bottom-0 expanded:mx-0 expanded:rounded-lg expanded:border expanded:bg-surface expanded:px-4 expanded:shadow-pop',
        )}
        data-savebar=""
      >
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 type-label text-ink" aria-live="polite">
            {t('agents.save.count', { count: n })}
            {widens && <span className="block type-meta text-caution-text">{t('agents.save.widens')}</span>}
          </p>
          <Button variant="quiet" size="sm" onPress={d.reset}>
            {t('agents.save.discard')}
          </Button>
          <Button variant="primary" size="sm" isDisabled={!online} onPress={() => setOpen(true)}>
            {t('agents.save.review')}
          </Button>
        </div>
        {!online && <p className="mt-1 type-meta text-ink-2">{t('agents.offlineSave')}</p>}
      </div>
      <Sheet
        isOpen={open}
        onOpenChange={setOpen}
        title={t('agents.save.title', { name: agent.config.name })}
        subtitle={`~/.beamhop/agents/${agent.config.name}.yaml`}
        footer={
          <div className="grid gap-2 expanded:grid-cols-2">
            <Button
              variant="primary"
              size="lg"
              fullWidth
              className="expanded:order-2"
              isPending={update.isPending}
              onPress={() => void save()}
            >
              {widens ? t('agents.save.widen') : t('agents.save.save')}
            </Button>
            <Button variant="secondary" size="lg" fullWidth onPress={() => setOpen(false)}>
              {t('agents.save.keepEditing')}
            </Button>
          </div>
        }
      >
        <ul className="flex flex-col gap-2">
          {changes.map((c) => (
            <li key={c.text} className="flex items-start gap-2 type-body-sm text-ink">
              <span
                aria-hidden="true"
                className={cx(
                  'mt-1.5 size-2 shrink-0 rounded-[1px]',
                  c.widens ? 'bg-caution-text' : 'bg-ink-2',
                )}
              />
              <span>
                {c.text}
                {c.widens && (
                  <span className="ml-1 type-meta text-caution-text">{t('agents.save.widensTag')}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
        {agent.activeSessions > 0 && (
          <p className="mt-3 type-body-sm text-ink-2">
            {t('agents.save.newSessions', { count: agent.activeSessions })}
          </p>
        )}
        <CodeBlock className="mt-4" label={t('agents.save.yaml')} code={toYaml(d.patch)} />
      </Sheet>
    </>
  );
};

// ─────────── Reach ───────────

const PathChip = ({ children, locked }: { children: ReactNode; locked?: boolean }) => (
  <li
    className={cx(
      'bh-chip relative inline-flex h-7 items-center gap-1 overflow-hidden rounded-sm px-2 type-meta',
      locked ? 'border border-line bg-sunken text-ink-2' : 'border border-line-strong bg-surface text-ink',
    )}
  >
    {locked && <span aria-hidden="true" className="hatch absolute inset-0 text-ink-2" />}
    {locked && <LockSimple size={12} weight="bold" aria-hidden="true" className="relative" />}
    <span className="relative">{children}</span>
  </li>
);

const ReachRow = ({ verb, children }: { verb: string; children: ReactNode }) => (
  <div className="grid grid-cols-[72px_1fr] items-start gap-3 py-2.5">
    <dt className="pt-1 type-label text-ink-2">{verb}</dt>
    <dd className="min-w-0">{children}</dd>
  </div>
);

/** Reach summary (JOURNEYS §5.1): Reads · Writes · Talks to · Never · Secrets, as plain rows. */
export const ReachSummary = ({
  reach,
  name,
  maxHosts = 4,
  className,
  branchNote,
}: {
  reach: Reach;
  name: string;
  maxHosts?: number;
  className?: string;
  branchNote?: boolean;
}) => {
  const [allHosts, setAllHosts] = useState(false);
  const [allNever, setAllNever] = useState(false);
  const hosts = allHosts ? reach.talksTo : reach.talksTo.slice(0, maxHosts);
  const never = allNever ? reach.never : reach.never.slice(0, 5);
  const none = <span className="type-body-sm text-ink-2">{t('agents.reach.nothing')}</span>;
  return (
    <dl
      aria-label={t('agents.reach.label', { name })}
      className={cx('divide-y divide-line rounded-lg border border-line bg-surface px-4', className)}
    >
      <ReachRow verb={t('agents.reach.reads')}>
        {reach.reads.length ? (
          <ul className="flex flex-wrap gap-1.5">
            {reach.reads.map((p) => (
              <PathChip key={p}>{p}</PathChip>
            ))}
          </ul>
        ) : (
          none
        )}
      </ReachRow>
      <ReachRow verb={t('agents.reach.writes')}>
        {reach.writes.length ? (
          <>
            <ul className="flex flex-wrap gap-1.5">
              {reach.writes.map((p) => (
                <PathChip key={p}>{p}</PathChip>
              ))}
            </ul>
            {branchNote && <p className="mt-1 type-meta text-ink-2">{t('agents.reach.branch')}</p>}
          </>
        ) : (
          none
        )}
      </ReachRow>
      <ReachRow verb={t('agents.reach.talks')}>
        <ul className="flex flex-wrap gap-1.5">
          {hosts.map((h) => (
            <PathChip key={h}>{h}</PathChip>
          ))}
          {reach.talksTo.length > maxHosts && (
            <li>
              <RACButton
                onPress={() => setAllHosts((v) => !v)}
                className="inline-flex min-h-7 items-center rounded-sm px-1.5 type-meta text-ink underline underline-offset-[3px] outline-none data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus"
              >
                {allHosts
                  ? t('agents.reach.less')
                  : t('agents.reach.more', { count: reach.talksTo.length - maxHosts })}
              </RACButton>
            </li>
          )}
        </ul>
      </ReachRow>
      <ReachRow verb={t('agents.reach.never')}>
        <ul className="flex flex-wrap gap-1.5">
          {never.map((p) => (
            <PathChip key={p} locked>
              {p}
            </PathChip>
          ))}
          {reach.never.length > 5 && (
            <li>
              <RACButton
                onPress={() => setAllNever((v) => !v)}
                className="inline-flex min-h-7 items-center rounded-sm px-1.5 type-meta text-ink underline underline-offset-[3px] outline-none data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus"
              >
                {allNever
                  ? t('agents.reach.less')
                  : t('agents.reach.more', { count: reach.never.length - 5 })}
              </RACButton>
            </li>
          )}
        </ul>
        <p className="mt-1 type-meta text-ink-2">{t('agents.reach.neverNote')}</p>
      </ReachRow>
      <ReachRow verb={t('agents.reach.secrets')}>
        <p className="pt-1 type-body-sm text-ink-2">
          {reach.secrets.length
            ? t('agents.reach.secretsSome', { hosts: reach.secrets.join(', ') })
            : t('agents.reach.secretsNone')}
        </p>
      </ReachRow>
    </dl>
  );
};

// ─────────── Overflow menu ───────────

export interface MenuAction {
  id: string;
  label: string;
  icon?: ReactNode;
  tone?: 'stop';
  isDisabled?: boolean;
  /** Draw a separator above this item. */
  separated?: boolean;
}

/** `⋯` menu (RAC MenuTrigger). Items are 44px; destructive ones in stop-text. */
export const OverflowMenu = ({
  label,
  actions,
  onAction,
}: {
  label: string;
  actions: MenuAction[];
  onAction: (id: string) => void;
}) => (
  <MenuTrigger>
    <RACButton
      aria-label={label}
      className="inline-grid size-11 shrink-0 place-items-center rounded-md text-ink outline-none data-[hovered]:bg-sunken data-[pressed]:bg-sunken data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus"
    >
      <DotsThreeVertical size={22} weight="bold" aria-hidden="true" />
    </RACButton>
    <Popover
      placement="bottom end"
      className="min-w-56 rounded-lg border border-line bg-surface p-1 shadow-pop outline-none"
    >
      <Menu className="outline-none" onAction={(k) => onAction(String(k))}>
        {actions.flatMap((a) => [
          ...(a.separated ? [<Separator key={`${a.id}-sep`} className="my-1 h-px bg-line" />] : []),
          <MenuItem
            key={a.id}
            id={a.id}
            textValue={a.label}
            isDisabled={a.isDisabled}
            className={cx(
              'flex min-h-11 cursor-default items-center gap-3 rounded-md px-3 type-label outline-none data-[focused]:bg-sunken data-[disabled]:opacity-45',
              a.tone === 'stop' ? 'text-stop-text' : 'text-ink',
            )}
          >
            {a.icon}
            {a.label}
          </MenuItem>,
        ])}
      </Menu>
    </Popover>
  </MenuTrigger>
);
