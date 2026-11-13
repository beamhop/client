/**
 * Setup: harness (from discovery, with status), model, harness login, mounts (PathPicker, RO|RW,
 * git worktree note, parallel-unsafe with warning, reorder by buttons), concurrency + timeouts.
 * Edits go into the draft; the sticky SaveBar reviews and saves them.
 */
import type { AgentView, HarnessView, Mount } from '@beamhop/core';
import {
  ArrowDown,
  ArrowUp,
  FolderSimple,
  GitBranch,
  LockSimpleOpen,
  Plus,
  Trash,
  WarningCircle,
} from '@phosphor-icons/react';
import { useState } from 'react';
import { harnessLamp, useApi } from '../../../api/index.ts';
import { t } from '../../../i18n/index.ts';
import { Button } from '../../../ui/Button.tsx';
import { Radio, RadioGroup, SegmentedControl, Select } from '../../../ui/Choice.tsx';
import { CopyButton } from '../../../ui/CliStrip.tsx';
import { NumberField, TextField } from '../../../ui/Field.tsx';
import { PathPicker } from '../../../ui/PathPicker.tsx';
import { StatusDot } from '../../../ui/Status.tsx';
import { looksGit, validateMountPath } from '../model.ts';
import { Block, OverflowMenu, Rows, SaveBar, useAgentDraft } from '../parts.tsx';

const harnessDescription = (h: HarnessView) =>
  [h.version, h.status === 'ready' ? t('agents.setup.ready') : (h.message ?? h.status)]
    .filter(Boolean)
    .join(' · ');

export const loginCommand = (h: HarnessView) =>
  h.message?.startsWith('Run: ') ? h.message.slice(5) : `${h.command} login`;

export const MountRow = ({
  m,
  i,
  count,
  onChange,
  onMove,
  onRemove,
  lockRo,
}: {
  m: Mount;
  i: number;
  count: number;
  onChange: (m: Mount) => void;
  onMove?: (dir: -1 | 1) => void;
  onRemove: () => void;
  lockRo?: string;
}) => {
  const git = looksGit(m.path);
  const note =
    m.mode === 'rw'
      ? git
        ? t('agents.mount.branch')
        : m.parallelUnsafe
          ? t('agents.mount.unsafe')
          : t('agents.mount.lock')
      : t('agents.mount.ro');
  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex items-center gap-2">
        {git ? (
          <GitBranch size={18} aria-label={t('agents.mount.git')} className="shrink-0 text-ink-2" />
        ) : (
          <FolderSimple size={18} aria-hidden="true" className="shrink-0 text-ink-2" />
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-[14px] text-ink" title={m.path}>
          {m.path}
        </span>
        <SegmentedControl
          size="sm"
          label={t('agents.mount.access', { path: m.path })}
          value={m.mode}
          isDisabled={!!lockRo}
          onChange={(mode) =>
            onChange({ ...m, mode, parallelUnsafe: mode === 'ro' ? false : m.parallelUnsafe })
          }
          options={[
            { id: 'ro', label: 'RO', ariaLabel: t('agents.mount.readOnly') },
            { id: 'rw', label: 'RW', ariaLabel: t('agents.mount.readWrite') },
          ]}
        />
        <OverflowMenu
          label={t('agents.mount.menu', { path: m.path })}
          onAction={(id) => {
            if (id === 'up') onMove?.(-1);
            else if (id === 'down') onMove?.(1);
            else if (id === 'unsafe') onChange({ ...m, parallelUnsafe: !m.parallelUnsafe });
            else if (id === 'remove') onRemove();
          }}
          actions={[
            ...(onMove
              ? [
                  {
                    id: 'up',
                    label: t('agents.mount.up'),
                    icon: <ArrowUp size={18} aria-hidden="true" />,
                    isDisabled: i === 0,
                  },
                  {
                    id: 'down',
                    label: t('agents.mount.down'),
                    icon: <ArrowDown size={18} aria-hidden="true" />,
                    isDisabled: i === count - 1,
                  },
                ]
              : []),
            ...(m.mode === 'rw' && !git
              ? [
                  {
                    id: 'unsafe',
                    label: m.parallelUnsafe ? t('agents.mount.requireLock') : t('agents.mount.allowParallel'),
                    icon: <LockSimpleOpen size={18} aria-hidden="true" />,
                  },
                ]
              : []),
            {
              id: 'remove',
              label: t('agents.mount.remove'),
              icon: <Trash size={18} aria-hidden="true" />,
              tone: 'stop' as const,
              separated: true,
            },
          ]}
        />
      </div>
      <p
        className={
          m.parallelUnsafe ? 'flex items-start gap-1.5 type-meta text-caution-text' : 'type-meta text-ink-2'
        }
      >
        {m.parallelUnsafe && (
          <WarningCircle size={14} weight="bold" aria-hidden="true" className="mt-px shrink-0" />
        )}
        {lockRo ?? note}
      </p>
    </li>
  );
};

/** Inline "+ Add folder": path picker + RO|RW, validated (never ~, never locked paths, no duplicates). */
export const AddMount = ({
  mounts,
  onAdd,
  lockRo,
}: {
  mounts: Mount[];
  onAdd: (m: Mount) => void;
  lockRo?: boolean;
}) => {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState('');
  const [mode, setMode] = useState<'ro' | 'rw'>('ro');
  const [err, setErr] = useState<string>();
  if (!open)
    return (
      <Button
        variant="secondary"
        icon={<Plus size={16} weight="bold" aria-hidden="true" />}
        onPress={() => setOpen(true)}
        className="self-start"
      >
        {t('agents.mount.add')}
      </Button>
    );
  const submit = () => {
    const p = path.trim().replace(/\/+$/, '');
    const e = validateMountPath(p, mounts);
    if (e) return setErr(e);
    onAdd({ path: p, mode: lockRo ? 'ro' : mode, parallelUnsafe: false });
    setPath('');
    setMode('ro');
    setErr(undefined);
    setOpen(false);
  };
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
      <PathPicker
        label={t('agents.mount.folder')}
        value={path}
        onChange={(v) => {
          setPath(v);
          setErr(undefined);
        }}
        description={t('agents.mount.folderHint')}
      />
      {err && (
        <p role="alert" className="flex items-start gap-1.5 type-body-sm text-stop-text">
          <WarningCircle size={16} weight="bold" aria-hidden="true" className="mt-0.5 shrink-0" />
          {err}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedControl
          label={t('agents.mount.accessNew')}
          value={lockRo ? 'ro' : mode}
          isDisabled={lockRo}
          onChange={setMode}
          options={[
            { id: 'ro', label: t('agents.mount.readOnly') },
            { id: 'rw', label: t('agents.mount.readWrite') },
          ]}
        />
        {mode === 'rw' && looksGit(path) && (
          <span className="type-meta text-ink-2">{t('agents.mount.branch')}</span>
        )}
      </div>
      <div className="flex gap-2">
        <Button variant="secondary" onPress={submit}>
          {t('agents.mount.addThis')}
        </Button>
        <Button variant="quiet" onPress={() => setOpen(false)}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
};

export const SetupSection = ({ agent }: { agent: AgentView }) => {
  const d = useAgentDraft(agent);
  const c = d.draft;
  const name = c.name;
  const harnesses = useApi('harness.list');
  const list = harnesses.data?.harnesses ?? [];
  const current = list.find((h) => h.id === c.harness);
  const setMounts = (fn: (m: Mount[]) => Mount[]) => d.set((x) => ({ ...x, mounts: fn(x.mounts) }));
  const strictLock = c.sandbox.profile === 'strict' ? t('agents.mount.strictLock') : undefined;

  return (
    <div className="flex flex-col gap-10">
      <Block
        id="setup-harness"
        title={t('agents.setup.harness')}
        cli={`beamhop agent set ${name} --harness ${c.harness} --model ${c.model}`}
      >
        <Select
          label={t('agents.setup.harnessRuns', { name })}
          selectedKey={c.harness}
          onSelectionChange={(k) => k && d.set((x) => ({ ...x, harness: String(k) }))}
          options={list.map((h) => ({
            id: h.id,
            label: h.displayName,
            description: harnessDescription(h),
            isDisabled: h.status !== 'ready' && h.status !== 'needs-login',
          }))}
        />
        {current && current.status !== 'ready' && (
          <div className="flex flex-col gap-2 rounded-md bg-caution-wash px-3 py-2.5">
            <StatusDot
              state={harnessLamp(current)}
              label={t('agents.setup.harnessNeeds', { name: current.displayName })}
            />
            {current.status === 'needs-login' && (
              <div className="flex items-center gap-2 rounded-sm bg-surface pl-3">
                <code className="min-w-0 flex-1 truncate type-code text-ink">{loginCommand(current)}</code>
                <CopyButton value={loginCommand(current)} label={t('agents.setup.copyLogin')} compact />
              </div>
            )}
          </div>
        )}
        <TextField
          label={t('agents.setup.model')}
          value={c.model}
          onChange={(v) => d.set((x) => ({ ...x, model: v.trim() || 'default' }))}
          mono
          description={t('agents.setup.modelHint')}
        />
        <RadioGroup
          label={t('agents.setup.auth')}
          value={c.harnessAuth}
          onChange={(v) => d.set((x) => ({ ...x, harnessAuth: v as 'api-key' | 'subscription' }))}
          variant="cards"
        >
          <Radio value="api-key" description={t('agents.setup.authKeyHint')}>
            {t('agents.setup.authKey')}
          </Radio>
          <Radio value="subscription" description={t('agents.setup.authSubHint')}>
            {t('agents.setup.authSub')}
          </Radio>
        </RadioGroup>
      </Block>

      <Block
        id="setup-mounts"
        title={t('agents.setup.mounts', { count: c.mounts.length })}
        description={t('agents.setup.mountsHint')}
        cli={`beamhop agent mount ${name} ${c.mounts[0]?.path ?? '~/code/app'} --${c.mounts[0]?.mode ?? 'ro'}`}
      >
        {c.mounts.length > 0 ? (
          <Rows label={t('agents.setup.mountsLabel')}>
            {c.mounts.map((m, i) => (
              <MountRow
                key={m.path}
                m={m}
                i={i}
                count={c.mounts.length}
                lockRo={strictLock}
                onChange={(nm) => setMounts((ms) => ms.map((x, j) => (j === i ? nm : x)))}
                onMove={(dir) =>
                  setMounts((ms) => {
                    const next = ms.slice();
                    const [it] = next.splice(i, 1);
                    next.splice(i + dir, 0, it!);
                    return next;
                  })
                }
                onRemove={() => setMounts((ms) => ms.filter((_, j) => j !== i))}
              />
            ))}
          </Rows>
        ) : (
          <p className="type-body-sm text-ink-2">{t('agents.setup.noMounts', { name })}</p>
        )}
        <AddMount mounts={c.mounts} lockRo={!!strictLock} onAdd={(m) => setMounts((ms) => [...ms, m])} />
      </Block>

      <Block
        id="setup-concurrency"
        title={t('agents.setup.concurrency')}
        cli={`beamhop agent set ${name} --max-sessions ${c.concurrency.maxSessions}`}
      >
        <div className="grid gap-5 medium:grid-cols-2">
          <NumberField
            label={t('agents.setup.maxSessions')}
            value={c.concurrency.maxSessions}
            minValue={1}
            maxValue={20}
            onChange={(v) => !Number.isNaN(v) && d.set((x) => ({ ...x, concurrency: { maxSessions: v } }))}
            description={t('agents.setup.maxSessionsHint')}
          />
          <NumberField
            label={t('agents.setup.idle')}
            value={c.sessionIdleMinutes}
            minValue={5}
            maxValue={1440}
            step={5}
            unit="min"
            onChange={(v) => !Number.isNaN(v) && d.set((x) => ({ ...x, sessionIdleMinutes: v }))}
          />
          <NumberField
            label={t('agents.setup.approvalTimeout')}
            value={c.approvalTimeoutMinutes}
            minValue={1}
            maxValue={240}
            unit="min"
            onChange={(v) => !Number.isNaN(v) && d.set((x) => ({ ...x, approvalTimeoutMinutes: v }))}
            description={t('agents.setup.approvalTimeoutHint')}
          />
        </div>
      </Block>
      <SaveBar agent={agent} d={d} />
    </div>
  );
};
