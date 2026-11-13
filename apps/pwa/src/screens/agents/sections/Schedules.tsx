/**
 * Schedules for this agent (§6A.4): rows with kind, spec, human description, next run in the
 * schedule's timezone, target, pause switch, Run now, remove (undo; webhooks confirm because their
 * secret can't come back). `+ Add schedule` sheet: Cron | Webhook | File change | Nostr event, with a
 * live cron preview (plain sentence + next 3 runs), quick presets, prompt, target, and whose role/budget
 * applies. Webhook secrets are shown exactly once, in a non-dismissable sheet with copy.
 *
 * Research: cron editors pair a plain-English description with the next N run times and surface the
 * timezone explicitly (crontab.guru; https://jmrp.io/tools/cron-builder/). Signing secrets are shown once
 * at creation with an explicit "only time" warning and copy, recovery = rotate/recreate
 * (https://www.ayrshare.com/docs/apis/webhooks/rotate-signing-secret, https://docs.sent.dm/start/webhooks/signature-verification).
 */
import type { AgentView, ScheduleConfig } from '@beamhop/core';
import { Lightning, Play, Plus, Trash, WarningCircle } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';
import { Button as RACButton } from 'react-aria-components';
import { targetLabel, useApi, useCall, useMutationApi } from '../../../api/index.ts';
import { t } from '../../../i18n/index.ts';
import { cx } from '../../../lib/cx.ts';
import { middleTruncate } from '../../../lib/format.ts';
import { useNow } from '../../../lib/useNow.ts';
import { Button, IconButton } from '../../../ui/Button.tsx';
import { SegmentedControl, Select, Switch } from '../../../ui/Choice.tsx';
import { CopyButton } from '../../../ui/CliStrip.tsx';
import { SecretField, TextField } from '../../../ui/Field.tsx';
import { Badge } from '../../../ui/Meta.tsx';
import { ConfirmDialog, Sheet } from '../../../ui/Sheet.tsx';
import { EmptyState, ErrorState, Skeleton, useDelayedLoading } from '../../../ui/States.tsx';
import { useToast } from '../../../ui/Toast.tsx';
import {
  describeCron,
  formatRun,
  nextRuns,
  type ScheduleKind,
  tzLabel,
  validateSpec,
  validTimezone,
} from '../model.ts';
import { Block, Rows } from '../parts.tsx';

const KIND_TAG: Record<ScheduleKind, string> = {
  cron: 'CRON',
  webhook: 'WEBHOOK',
  'file-change': 'FILE',
  'nostr-event': 'NOSTR',
};

const localTz = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

const explain = (s: Pick<ScheduleConfig, 'kind' | 'spec' | 'timezone'>): string => {
  if (s.kind === 'cron') {
    const d = describeCron(s.spec, s.timezone);
    return typeof d === 'string' ? d : d.error;
  }
  if (s.kind === 'webhook') return t('agents.sch.explainWebhook');
  if (s.kind === 'file-change') return t('agents.sch.explainFile');
  return t('agents.sch.explainNostr');
};

const ScheduleRow = ({ s, now, label }: { s: ScheduleConfig; now: number; label: (x: string) => string }) => {
  const update = useMutationApi('schedule.update');
  const run = useMutationApi('schedule.run');
  const remove = useMutationApi('schedule.remove');
  const call = useCall();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const next = s.kind === 'cron' && !s.paused ? nextRuns(s.spec, s.timezone, now, 1)[0] : undefined;
  const doRemove = () =>
    remove
      .mutateAsync({ id: s.id })
      .then(() => {
        setConfirm(false);
        toast.show({
          message: t('agents.sch.removed'),
          onUndo:
            s.kind === 'webhook'
              ? undefined
              : async () => {
                  const { id: _id, ...rest } = s;
                  await call('schedule.add', rest);
                },
        });
      })
      .catch((e: Error) => {
        toast.show({ tone: 'error', message: e.message });
      });
  return (
    <li className={cx('relative flex flex-col gap-2 px-4 py-3', s.paused && 'text-ink-2')}>
      {s.paused && (
        <span aria-hidden="true" className="hatch pointer-events-none absolute inset-0 text-ink-3" />
      )}
      <div className="relative flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="outline">{KIND_TAG[s.kind]}</Badge>
            <code className="min-w-0 truncate type-meta text-ink" title={s.spec}>
              {middleTruncate(s.spec, 30)}
            </code>
            {s.paused && <Badge>{t('agents.sch.paused')}</Badge>}
          </div>
          <p className="type-body-sm text-ink">{explain(s)}</p>
          <p className="type-meta text-ink-2">
            {next ? t('agents.sch.next', { when: formatRun(next, s.timezone) }) : null}
            {next && s.postTo ? ' · ' : null}
            {s.postTo ? `→ ${label(s.postTo)}` : t('agents.sch.noPost')}
          </p>
          <p className="line-clamp-2 type-body-sm text-ink-2">“{s.prompt}”</p>
        </div>
      </div>
      <div className="relative flex flex-wrap items-center gap-1">
        <Switch
          className="w-auto flex-1"
          isSelected={!s.paused}
          isDisabled={update.isPending}
          onChange={(on) =>
            update
              .mutateAsync({ id: s.id, patch: { paused: !on } })
              .catch((e: Error) => toast.show({ tone: 'error', message: e.message }))
          }
        >
          <span className="type-label">{t('agents.sch.active')}</span>
        </Switch>
        <Button
          size="sm"
          variant="quiet"
          icon={<Play size={14} weight="fill" aria-hidden="true" />}
          isPending={run.isPending}
          onPress={() =>
            run
              .mutateAsync({ id: s.id })
              .then(() => toast.show({ message: t('agents.sch.ran') }))
              .catch((e: Error) => toast.show({ tone: 'error', message: e.message }))
          }
        >
          {t('agents.sch.runNow')}
        </Button>
        <IconButton
          label={t('agents.sch.remove', { spec: s.spec })}
          icon={<Trash size={18} />}
          variant="destructive-ghost"
          onPress={() => (s.kind === 'webhook' ? setConfirm(true) : void doRemove())}
        />
      </div>
      <ConfirmDialog
        isOpen={confirm}
        onOpenChange={setConfirm}
        title={t('agents.sch.removeTitle')}
        confirmLabel={t('agents.sch.removeConfirm')}
        isPending={remove.isPending}
        onConfirm={doRemove}
      >
        {t('agents.sch.removeWebhookBody', { path: s.spec })}
      </ConfirmDialog>
    </li>
  );
};

const CRON_PRESETS = [
  { id: '0 9 * * 1-5', label: 'agents.sch.presetWeekdays' },
  { id: '0 * * * *', label: 'agents.sch.presetHourly' },
  { id: '0 18 * * *', label: 'agents.sch.presetEvening' },
  { id: '0 8 * * 1', label: 'agents.sch.presetMonday' },
] as const;

const defaultSpec = (kind: ScheduleKind, agent: AgentView, n: number) =>
  kind === 'cron'
    ? '0 9 * * 1-5'
    : kind === 'webhook'
      ? `/hooks/${agent.config.name}-${n + 1}`
      : kind === 'file-change'
        ? `${agent.config.mounts[0]?.path ?? '~/code/app'}/**/*.md`
        : '{"kinds":[1],"#t":["deploy"]}';

const AddSheet = ({
  open,
  onOpenChange,
  agent,
  count,
  onWebhook,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  agent: AgentView;
  count: number;
  onWebhook: (w: { url: string; secret: string }) => void;
}) => {
  const status = useApi('system.status');
  const channels = useApi('channel.list');
  const add = useMutationApi('schedule.add');
  const toast = useToast();
  const now = useNow(30_000);
  const [kind, setKind] = useState<ScheduleKind>('cron');
  const [spec, setSpec] = useState(defaultSpec('cron', agent, count));
  const [tz, setTz] = useState(localTz);
  const [prompt, setPrompt] = useState('');
  const [postTo, setPostTo] = useState<string>(agent.config.memberships[0]?.target ?? '');
  const [touched, setTouched] = useState(false);
  const ownerPrincipal = status.data?.owner.npub ? `nostr:${status.data.owner.npub}` : undefined;
  const [owner, setOwner] = useState<string | null>(null);
  const ownerValue = owner ?? ownerPrincipal ?? Object.keys(agent.config.grants)[0] ?? '';
  const specErr = validateSpec(kind, spec, agent.config.mounts);
  const tzErr = kind === 'cron' && !validTimezone(tz) ? t('agents.sch.badTz') : undefined;
  const promptErr = prompt.trim() ? undefined : t('agents.sch.needPrompt');
  const runs = useMemo(
    () => (kind === 'cron' && !specErr && !tzErr ? nextRuns(spec, tz, now, 3) : []),
    [kind, spec, tz, now, specErr, tzErr],
  );
  const desc = kind === 'cron' && !specErr ? describeCron(spec, tz) : undefined;
  const label = (x: string) => targetLabel(x, channels.data?.channels);

  const submit = () => {
    setTouched(true);
    if (specErr || tzErr || promptErr || !ownerValue) return;
    add
      .mutateAsync({
        agent: agent.config.name,
        kind,
        spec: spec.trim(),
        timezone: kind === 'cron' ? tz : 'UTC',
        prompt: prompt.trim(),
        postTo: postTo || undefined,
        owner: ownerValue,
      })
      .then((r) => {
        onOpenChange(false);
        setPrompt('');
        setTouched(false);
        if (r.webhook) onWebhook(r.webhook);
        else toast.show({ tone: 'success', message: t('agents.sch.added') });
      })
      .catch((e: Error) => toast.show({ tone: 'error', message: e.message }));
  };

  return (
    <Sheet
      isOpen={open}
      onOpenChange={onOpenChange}
      title={t('agents.sch.addTitle', { name: agent.config.name })}
      footer={
        <Button variant="primary" size="lg" fullWidth isPending={add.isPending} onPress={submit}>
          {kind === 'webhook' ? t('agents.sch.createWebhook') : t('agents.sch.addConfirm')}
        </Button>
      }
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <span className="type-label text-ink">{t('agents.sch.kind')}</span>
          <SegmentedControl
            label={t('agents.sch.kind')}
            value={kind}
            onChange={(k) => {
              setKind(k);
              setSpec(defaultSpec(k, agent, count));
            }}
            options={[
              { id: 'cron', label: t('agents.sch.kindCron') },
              { id: 'webhook', label: t('agents.sch.kindWebhook') },
              { id: 'file-change', label: t('agents.sch.kindFile'), ariaLabel: t('agents.sch.kindFileLong') },
              {
                id: 'nostr-event',
                label: t('agents.sch.kindNostr'),
                ariaLabel: t('agents.sch.kindNostrLong'),
              },
            ]}
          />
        </div>

        {kind === 'cron' && (
          <div className="flex flex-col gap-3">
            <TextField
              label={t('agents.sch.cron')}
              value={spec}
              onChange={setSpec}
              mono
              isInvalid={!!specErr}
              errorMessage={specErr}
              description={t('agents.sch.cronHint')}
            />
            <div className="flex flex-wrap gap-2" role="group" aria-label={t('agents.sch.quick')}>
              {CRON_PRESETS.map((p) => (
                <RACButton
                  key={p.id}
                  onPress={() => setSpec(p.id)}
                  aria-pressed={spec === p.id}
                  className="min-h-11 rounded-sm border border-line-strong bg-surface px-3 type-label text-ink outline-none aria-pressed:border-ink aria-pressed:bg-sunken data-[hovered]:bg-sunken data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus pointer-fine:min-h-8"
                >
                  {t(p.label)}
                </RACButton>
              ))}
            </div>
            <TextField
              label={t('agents.sch.tz')}
              value={tz}
              onChange={setTz}
              mono
              isInvalid={!!tzErr}
              errorMessage={tzErr}
            />
            {desc && typeof desc === 'string' && (
              <div className="rounded-md bg-sunken px-3 py-2.5" aria-live="polite">
                <p className="type-body-strong text-ink">
                  {desc === 'Custom schedule' ? t('agents.sch.custom') : desc}
                </p>
                {runs.length > 0 && (
                  <ol className="mt-1 flex flex-col gap-0.5" aria-label={t('agents.sch.nextRuns')}>
                    {runs.map((r) => (
                      <li key={r} className="type-meta text-ink-2 tabular-nums">
                        {formatRun(r, tz)} <span className="text-ink-3">· {tzLabel(tz)}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            )}
          </div>
        )}
        {kind === 'webhook' && (
          <TextField
            label={t('agents.sch.path')}
            value={spec}
            onChange={setSpec}
            mono
            isInvalid={!!specErr}
            errorMessage={specErr}
            description={t('agents.sch.pathHint')}
          />
        )}
        {kind === 'file-change' && (
          <TextField
            label={t('agents.sch.glob')}
            value={spec}
            onChange={setSpec}
            mono
            isInvalid={!!specErr}
            errorMessage={specErr}
            description={t('agents.sch.globHint')}
          />
        )}
        {kind === 'nostr-event' && (
          <TextField
            label={t('agents.sch.filter')}
            value={spec}
            onChange={setSpec}
            mono
            multiline
            rows={3}
            isInvalid={!!specErr}
            errorMessage={specErr}
            description={t('agents.sch.filterHint')}
          />
        )}

        <TextField
          label={t('agents.sch.prompt')}
          value={prompt}
          onChange={setPrompt}
          multiline
          rows={3}
          placeholder={t('agents.sch.promptPlaceholder')}
          isInvalid={touched && !!promptErr}
          errorMessage={promptErr}
        />
        <Select
          label={t('agents.sch.postTo')}
          selectedKey={postTo || '__none'}
          onSelectionChange={(k) => setPostTo(k === '__none' || !k ? '' : String(k))}
          options={[
            { id: '__none', label: t('agents.sch.noPostOption') },
            ...agent.config.memberships.map((m) => ({ id: m.target, label: label(m.target) })),
            ...agent.config.routes
              .filter((r) => !agent.config.memberships.some((m) => m.target === r.to))
              .map((r) => ({ id: r.to, label: label(r.to) })),
          ]}
        />
        <Select
          label={t('agents.sch.owner')}
          selectedKey={ownerValue || null}
          onSelectionChange={(k) => k && setOwner(String(k))}
          description={t('agents.sch.ownerHint')}
          options={[
            ...(ownerPrincipal
              ? [
                  {
                    id: ownerPrincipal,
                    label: t('agents.sch.ownerYou'),
                    description: middleTruncate(ownerPrincipal, 24),
                  },
                ]
              : []),
            ...Object.entries(agent.config.grants).map(([p, r]) => ({
              id: p,
              label: middleTruncate(p, 28),
              description: r,
            })),
          ]}
        />
      </div>
    </Sheet>
  );
};

/** The one and only time a webhook secret is shown (non-dismissable; explicit "I've saved it"). */
const SecretOnce = ({
  hook,
  onDone,
}: {
  hook: { url: string; secret: string } | null;
  onDone: () => void;
}) => (
  <Sheet
    isOpen={!!hook}
    onOpenChange={(o) => !o && onDone()}
    isDismissable={false}
    title={t('agents.sch.secretTitle')}
    footer={
      <Button variant="primary" size="lg" fullWidth onPress={onDone}>
        {t('agents.sch.secretDone')}
      </Button>
    }
  >
    {hook && (
      <div className="flex flex-col gap-4">
        <p className="flex items-start gap-2 rounded-md bg-caution-wash px-3 py-2.5 type-body-sm text-ink">
          <WarningCircle
            size={18}
            weight="bold"
            aria-hidden="true"
            className="mt-0.5 shrink-0 text-caution-text"
          />
          {t('agents.sch.secretWarn')}
        </p>
        <div className="flex flex-col gap-1.5">
          <span className="type-label text-ink">{t('agents.sch.hookUrl')}</span>
          <div className="flex items-center gap-1 rounded-md border border-line-strong bg-sunken pl-3">
            <code className="min-w-0 flex-1 truncate type-meta text-ink" title={hook.url}>
              {hook.url}
            </code>
            <CopyButton value={hook.url} label={t('agents.sch.copyUrl')} compact />
          </div>
        </div>
        <SecretField label={t('agents.sch.secret')} value={hook.secret} isReadOnly allowPaste={false} />
        <CopyButton
          value={hook.secret}
          label={t('agents.sch.copySecret')}
          className="self-start border border-line-strong"
        />
      </div>
    )}
  </Sheet>
);

export const SchedulesSection = ({ agent }: { agent: AgentView }) => {
  const name = agent.config.name;
  const q = useApi('schedule.list', { agent: name });
  const channels = useApi('channel.list');
  const now = useNow(30_000);
  const [adding, setAdding] = useState(false);
  const [hook, setHook] = useState<{ url: string; secret: string } | null>(null);
  const showSkel = useDelayedLoading(q.isPending);
  const list = q.data?.schedules ?? [];
  const label = (x: string) => targetLabel(x, channels.data?.channels);
  const addButton = (
    <Button
      variant="secondary"
      icon={<Plus size={16} weight="bold" aria-hidden="true" />}
      onPress={() => setAdding(true)}
    >
      {t('agents.sch.add')}
    </Button>
  );
  return (
    <div className="flex flex-col gap-6">
      <Block
        id="sch-list"
        title={t('agents.sch.title', { count: list.length })}
        description={t('agents.sch.hint', { name })}
        cli={`beamhop schedule add ${name} --cron "0 9 * * 1-5" --prompt "…"`}
      >
        {q.isPending ? (
          showSkel && <Skeleton count={2} />
        ) : q.isError ? (
          <ErrorState title={t('agents.sch.loadError')} onRetry={() => void q.refetch()} details={q.error} />
        ) : list.length === 0 ? (
          <EmptyState
            glyph={<Lightning size={32} aria-hidden="true" />}
            title={t('agents.sch.emptyTitle')}
            action={addButton}
          >
            {t('agents.sch.emptyBody', { name })}
          </EmptyState>
        ) : (
          <>
            <Rows label={t('agents.sch.listLabel')}>
              {list.map((s) => (
                <ScheduleRow key={s.id} s={s} now={now} label={label} />
              ))}
            </Rows>
            <div>{addButton}</div>
          </>
        )}
      </Block>
      <AddSheet
        open={adding}
        onOpenChange={setAdding}
        agent={agent}
        count={list.length}
        onWebhook={setHook}
      />
      <SecretOnce hook={hook} onDone={() => setHook(null)} />
    </div>
  );
};
