/**
 * New agent — SCREENS §4.3 / JOURNEYS §1.05. Preset-first: 01 Preset (four cards with the trade-off spelled
 * out: who can talk to it · what it can change · the deliberate cost) + name prefilled from the preset →
 * 02 Harness (from discovery, with status; not-ready ones show the fix, never a dead end) → 03 Folders
 * (PathPicker, read-only by default, locked RO for read-only presets) → 04 Review (grouped by step with
 * Edit links, live reach summary, CLI) → `Create <name>`.
 * Compact: stepper on top, one step at a time, sticky Back / Continue bar above the tab bar.
 * Expanded: two columns — the step on the left, a sticky live preview (reach + CLI) on the right.
 *
 * Research: presets as radio cards that pre-fill the rest and a final review grouped by step with inline
 * "Edit" back to that step (Cloudscape multi-page create, https://cloudscape.design/patterns/resource-management/create/multi-page-create ;
 * PatternFly wizard review step, https://www.patternfly.org/components/wizard/design-guidelines). Redundant entry
 * avoided (WCAG 3.3.7): the name is prefilled from the preset and never asked twice.
 */
import type { HarnessView, Mount } from '@beamhop/core';
import { ArrowClockwise, ArrowLeft, Check, PencilSimple } from '@phosphor-icons/react';
import { useNavigate } from '@tanstack/react-router';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Radio, RadioGroup } from 'react-aria-components';
import { harnessLamp, harnessMonogram, useApi, useMutationApi } from '../../api/index.ts';
import { t } from '../../i18n/index.ts';
import { cx } from '../../lib/cx.ts';
import { usd } from '../../lib/format.ts';
import { haptic } from '../../lib/haptics.ts';
import { Screen } from '../../shell/Screen.tsx';
import { Button } from '../../ui/Button.tsx';
import { CliStrip, CopyButton } from '../../ui/CliStrip.tsx';
import { TextField } from '../../ui/Field.tsx';
import { Badge, Eyebrow, LetterTile, MetaLine } from '../../ui/Meta.tsx';
import { ErrorState, Skeleton, useDelayedLoading } from '../../ui/States.tsx';
import { StatusDot } from '../../ui/Status.tsx';
import { Stepper } from '../../ui/Stepper.tsx';
import { useToast } from '../../ui/Toast.tsx';
import { createCli, PRESET_META, reachOf, suggestName, validateName } from './model.ts';
import { ReachSummary } from './parts.tsx';
import { AddMount, loginCommand, MountRow } from './sections/Setup.tsx';

type Profile = 'strict' | 'workspace' | 'custom';
const STEPS = ['preset', 'harness', 'folders', 'review'] as const;
type Step = (typeof STEPS)[number];
const stepLabel = (s: Step) => t(`agents.new.step.${s}` as 'agents.new.step.preset');

const cardClass =
  'group relative flex cursor-default flex-col gap-2 rounded-lg border bg-surface p-4 outline-none transition-colors duration-[var(--dur-fast)] data-[hovered]:border-line-strong data-[selected]:border-ink data-[selected]:bg-flare-wash data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-focus data-[disabled]:cursor-not-allowed';

const RadioDot = ({ on }: { on: boolean }) => (
  <span
    aria-hidden="true"
    className={cx(
      'grid size-6 shrink-0 place-items-center rounded-full border-[1.5px] bg-surface',
      on ? 'border-ink' : 'border-line-strong',
    )}
  >
    {on && <span className="size-3 rounded-full bg-ink" />}
  </span>
);

const Fact = ({ k, v }: { k: string; v: ReactNode }) => (
  <div className="grid grid-cols-[72px_1fr] gap-2">
    <dt className="type-meta text-ink-2">{k}</dt>
    <dd className="type-body-sm text-ink">{v}</dd>
  </div>
);

// ─────────── Steps ───────────

interface Preset {
  id: string;
  title: string;
  description: string;
  config: Record<string, unknown>;
}

const PresetStep = ({
  presets,
  value,
  onChange,
  name,
  setName,
  nameErr,
}: {
  presets: Preset[];
  value: string;
  onChange: (id: string) => void;
  name: string;
  setName: (v: string) => void;
  nameErr?: string;
}) => (
  <div className="flex flex-col gap-6">
    <RadioGroup
      value={value}
      onChange={onChange}
      aria-label={t('agents.new.presetLabel')}
      className="grid gap-3 medium:grid-cols-2"
    >
      {presets.map((p) => {
        const m = PRESET_META[p.id];
        const cfg = p.config as { sandbox?: { profile?: string }; budgets?: { dailyUsd?: number } };
        return (
          <Radio key={p.id} value={p.id} className={cx(cardClass, 'border-line')}>
            {({ isSelected }) => (
              <>
                <div className="flex items-start gap-3">
                  <RadioDot on={isSelected} />
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="type-title-3 text-ink">{p.title}</span>
                    <span className="type-body-sm text-ink-2">{p.description}</span>
                  </div>
                </div>
                {m && (
                  <div className="mt-1 flex flex-col gap-1 border-t border-line pt-2 pl-9">
                    <dl className="flex flex-col gap-1">
                      <Fact k={t('agents.new.who')} v={m.who} />
                      <Fact k={t('agents.new.changes')} v={m.writes} />
                      <Fact
                        k={t('agents.new.limits')}
                        v={
                          <span className="type-meta text-ink">
                            {cfg.sandbox?.profile ?? 'workspace'} · {usd(cfg.budgets?.dailyUsd ?? 5)}/day
                          </span>
                        }
                      />
                    </dl>
                    <p className="mt-1 type-body-sm text-ink">
                      <span className="type-micro text-caution-text">{t('agents.new.tradeoff')} </span>
                      {m.tradeoff}
                    </p>
                  </div>
                )}
              </>
            )}
          </Radio>
        );
      })}
    </RadioGroup>
    <TextField
      label={t('agents.new.name')}
      value={name}
      onChange={(v) => setName(v.toLowerCase())}
      mono
      isInvalid={!!nameErr}
      errorMessage={nameErr}
      description={t('agents.new.nameHint')}
    />
  </div>
);

const HarnessStep = ({
  list,
  value,
  onChange,
  onRescan,
  scanning,
}: {
  list: HarnessView[];
  value: string;
  onChange: (id: string) => void;
  onRescan: () => void;
  scanning: boolean;
}) => {
  const ready = list.filter((h) => h.status === 'ready');
  return (
    <div className="flex flex-col gap-4">
      {ready.length === 0 && (
        <p className="rounded-md bg-caution-wash px-3 py-2.5 type-body-sm text-ink">
          {t('agents.new.noReady')}
        </p>
      )}
      <RadioGroup
        value={value}
        onChange={onChange}
        aria-label={t('agents.new.harnessLabel')}
        className="flex flex-col gap-2"
      >
        {list.map((h) => {
          const fix =
            h.status === 'needs-login'
              ? loginCommand(h)
              : h.status === 'not-installed' || h.status === 'unsupported-version'
                ? (h.install?.npm ?? h.install?.brew)
                : undefined;
          return (
            <Radio
              key={h.id}
              value={h.id}
              isDisabled={h.status !== 'ready'}
              className={cx(cardClass, 'border-line py-3 data-[disabled]:bg-bg')}
            >
              {({ isSelected, isDisabled }) => (
                <>
                  <div className="flex items-center gap-3">
                    {isDisabled ? (
                      <span className="size-6 shrink-0" aria-hidden="true" />
                    ) : (
                      <RadioDot on={isSelected} />
                    )}
                    <LetterTile code={harnessMonogram(h.id)} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className={cx('type-title-3', isDisabled ? 'text-ink-2' : 'text-ink')}>
                        {h.displayName}
                      </span>
                      <MetaLine
                        items={[
                          h.version ?? t('agents.new.notFound'),
                          h.protocol,
                          h.path && { value: h.path, truncate: 22 },
                        ]}
                      />
                    </span>
                    <StatusDot
                      state={harnessLamp(h)}
                      label={t(`agents.harness.${h.status}` as 'agents.harness.ready')}
                    />
                  </div>
                  {fix && (
                    <div className="ml-9 flex flex-col gap-1">
                      {h.message && h.status !== 'needs-login' && (
                        <p className="type-meta text-ink-2">{h.message}</p>
                      )}
                      <div className="flex items-center gap-1 rounded-sm bg-sunken pl-3">
                        <code className="min-w-0 flex-1 truncate type-code text-ink">{fix}</code>
                        <CopyButton
                          value={fix}
                          label={t('agents.new.copyFix', { name: h.displayName })}
                          compact
                        />
                      </div>
                    </div>
                  )}
                </>
              )}
            </Radio>
          );
        })}
      </RadioGroup>
      <Button
        variant="quiet"
        size="sm"
        className="self-start"
        isPending={scanning}
        icon={<ArrowClockwise size={16} aria-hidden="true" />}
        onPress={onRescan}
      >
        {t('agents.new.rescan')}
      </Button>
    </div>
  );
};

const ReviewGroup = ({
  title,
  onEdit,
  children,
}: {
  title: string;
  onEdit: () => void;
  children: ReactNode;
}) => (
  <section className="flex flex-col gap-1 border-b border-line pb-4 last:border-b-0">
    <div className="flex items-center justify-between gap-2">
      <h3 className="type-micro text-ink-2">{title}</h3>
      <Button
        variant="quiet"
        size="sm"
        icon={<PencilSimple size={14} aria-hidden="true" />}
        onPress={onEdit}
        aria-label={t('agents.new.editStep', { step: title })}
      >
        {t('agents.new.edit')}
      </Button>
    </div>
    {children}
  </section>
);

// ─────────── Screen ───────────

export const NewAgentScreen = () => {
  const navigate = useNavigate();
  const toast = useToast();
  const presetsQ = useApi('agent.presets');
  const harnessQ = useApi('harness.list');
  const scan = useMutationApi('harness.scan');
  const agentsQ = useApi('agent.list');
  const create = useMutationApi('agent.create');
  const showSkel = useDelayedLoading(presetsQ.isPending || harnessQ.isPending);

  const presets = (presetsQ.data?.presets ?? []) as Preset[];
  const harnesses = harnessQ.data?.harnesses ?? [];
  const taken = useMemo(() => (agentsQ.data?.agents ?? []).map((a) => a.config.name), [agentsQ.data]);

  const [step, setStep] = useState(0);
  const [presetId, setPresetId] = useState('code-reviewer');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [harness, setHarness] = useState('');
  const [mounts, setMounts] = useState<Mount[]>([]);
  const [tried, setTried] = useState(false);
  const top = useRef<HTMLDivElement>(null);

  const preset = presets.find((p) => p.id === presetId);
  const meta = PRESET_META[presetId];
  const profile = ((preset?.config as { sandbox?: { profile?: Profile } } | undefined)?.sandbox?.profile ??
    'workspace') as Profile;
  const lockRo = meta?.lockMode === 'ro';

  // Prefill the name from the preset until the user types their own (WCAG 3.3.7).
  useEffect(() => {
    if (!nameTouched && meta && agentsQ.data) setName(suggestName(meta.name, taken));
  }, [agentsQ.data, nameTouched, meta, taken]);
  useEffect(() => {
    if (!harness) {
      const first = harnesses.find((h) => h.status === 'ready');
      if (first) setHarness(first.id);
    }
  }, [harnesses, harness]);
  useEffect(() => {
    if (lockRo)
      setMounts((ms) =>
        ms.some((m) => m.mode === 'rw')
          ? ms.map((m) => ({ ...m, mode: 'ro' as const, parallelUnsafe: false }))
          : ms,
      );
  }, [lockRo]);

  const nameErr = validateName(name, taken);
  const harnessOk = harnesses.some((h) => h.id === harness && h.status === 'ready');
  const current = STEPS[step]!;
  const blocker =
    current === 'preset'
      ? (nameErr ?? (!preset ? t('agents.new.pickPreset') : undefined))
      : current === 'harness' && !harnessOk
        ? t('agents.new.pickHarness')
        : undefined;

  const cfg = useMemo(
    () => ({ harness: harness || 'claude', mounts, sandbox: { profile } }),
    [harness, mounts, profile],
  );
  const reach = reachOf(cfg);
  const cli = createCli({ name, preset: presetId, harness, mounts });
  const harnessName = harnesses.find((h) => h.id === harness)?.displayName ?? harness;

  const go = (i: number) => {
    setStep(i);
    setTried(false);
    top.current?.scrollIntoView({ block: 'start' });
    window.setTimeout(() => top.current?.querySelector<HTMLElement>('h2')?.focus(), 0);
  };
  const next = () => {
    setTried(true);
    if (blocker) {
      haptic('error');
      return;
    }
    go(step + 1);
  };
  const submit = () =>
    create
      .mutateAsync({ preset: presetId, config: { name, harness, mounts, sandbox: { profile } } })
      .then((a) => {
        haptic('confirm');
        toast.show({ tone: 'success', message: t('agents.new.created', { name: a.config.name }) });
        void navigate({ to: '/agents/$name', params: { name: a.config.name } });
      })
      .catch(() => haptic('error'));

  const loading = presetsQ.isPending || harnessQ.isPending;
  const loadErr = presetsQ.error ?? harnessQ.error;

  const stepBody =
    current === 'preset' ? (
      <PresetStep
        presets={presets}
        value={presetId}
        onChange={setPresetId}
        name={name}
        setName={(v) => {
          setNameTouched(true);
          setName(v);
        }}
        nameErr={tried || nameTouched ? nameErr : undefined}
      />
    ) : current === 'harness' ? (
      <HarnessStep
        list={harnesses}
        value={harness}
        onChange={setHarness}
        scanning={scan.isPending}
        onRescan={() => scan.mutate({})}
      />
    ) : current === 'folders' ? (
      <div className="flex flex-col gap-4">
        {lockRo && (
          <p className="type-body-sm text-ink-2">
            {t('agents.new.lockedRo', { preset: preset?.title ?? '' })}
          </p>
        )}
        {mounts.length > 0 ? (
          <ul
            aria-label={t('agents.setup.mountsLabel')}
            className="divide-y divide-line rounded-lg border border-line bg-surface"
          >
            {mounts.map((m, i) => (
              <MountRow
                key={m.path}
                m={m}
                i={i}
                count={mounts.length}
                lockRo={lockRo ? t('agents.new.roNote') : undefined}
                onChange={(nm) => setMounts((ms) => ms.map((x, j) => (j === i ? nm : x)))}
                onRemove={() => setMounts((ms) => ms.filter((_, j) => j !== i))}
              />
            ))}
          </ul>
        ) : (
          <p className="type-body-sm text-ink-2">{t('agents.new.noFolders', { name: name || 'it' })}</p>
        )}
        <AddMount mounts={mounts} lockRo={lockRo} onAdd={(m) => setMounts((ms) => [...ms, m])} />
      </div>
    ) : (
      <div className="flex flex-col gap-4">
        <ReviewGroup title={stepLabel('preset')} onEdit={() => go(0)}>
          <p className="type-title-3 text-ink">{name}</p>
          <MetaLine items={[preset?.title ?? presetId, profile, meta?.who]} className="whitespace-normal" />
        </ReviewGroup>
        <ReviewGroup title={stepLabel('harness')} onEdit={() => go(1)}>
          <p className="flex items-center gap-2 type-body text-ink">
            <LetterTile code={harnessMonogram(harness)} /> {harnessName}
          </p>
        </ReviewGroup>
        <ReviewGroup title={stepLabel('folders')} onEdit={() => go(2)}>
          {mounts.length ? (
            <ul className="flex flex-col gap-0.5">
              {mounts.map((m) => (
                <li key={m.path} className="type-meta text-ink">
                  {m.path} <Badge tone={m.mode === 'rw' ? 'caution' : 'neutral'}>{m.mode}</Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="type-body-sm text-ink-2">{t('agents.new.chatOnly')}</p>
          )}
        </ReviewGroup>
        {create.error && (
          <ErrorState title={t('agents.new.createError', { name })} details={create.error}>
            {create.error.message}
          </ErrorState>
        )}
        <div className="@min-[50rem]/new:hidden">
          <Eyebrow level={3}>{t('agents.new.reach', { name })}</Eyebrow>
          <ReachSummary reach={reach} name={name} branchNote={mounts.some((m) => m.mode === 'rw')} />
          <CliStrip command={cli} className="mt-3" />
        </div>
      </div>
    );

  const footer = (
    <div className="flex items-center gap-2">
      {step > 0 && (
        <Button
          variant="secondary"
          icon={<ArrowLeft size={16} aria-hidden="true" />}
          onPress={() => go(step - 1)}
        >
          {t('agents.new.back')}
        </Button>
      )}
      <div className="min-w-0 flex-1">
        {tried && blocker && (
          <p className="type-meta text-stop-text" role="alert">
            {blocker}
          </p>
        )}
      </div>
      {current === 'review' ? (
        <Button
          variant="primary"
          isPending={create.isPending}
          icon={<Check size={16} weight="bold" aria-hidden="true" />}
          onPress={() => void submit()}
        >
          {t('agents.new.create', { name })}
        </Button>
      ) : (
        <Button variant="primary" onPress={next}>
          {current === 'folders' && mounts.length === 0
            ? t('agents.new.skipFolders')
            : t('agents.new.continue', { step: stepLabel(STEPS[step + 1]!) })}
        </Button>
      )}
    </div>
  );

  return (
    <Screen
      title={t('agents.new.title')}
      back={{ href: '/agents', label: t('nav.agents') }}
      pane="detail"
      maxWidth="none"
      crumbs={[{ label: t('nav.agents'), href: '/agents' }, { label: t('agents.new.title') }]}
    >
      {loading ? (
        showSkel && <Skeleton variant="cards" count={2} label={t('agents.new.loading')} />
      ) : loadErr && !presets.length ? (
        <ErrorState
          title={t('agents.new.loadError')}
          details={loadErr}
          onRetry={() => {
            void presetsQ.refetch();
            void harnessQ.refetch();
          }}
        />
      ) : (
        <div className="@container/new" ref={top}>
          <div className="grid gap-8 @min-[50rem]/new:grid-cols-[minmax(0,1fr)_320px]">
            <div className="flex min-w-0 max-w-[640px] flex-col gap-6">
              <Stepper steps={STEPS.map(stepLabel)} current={step} onStepPress={go} showLabels={false} />
              <div>
                <h2 tabIndex={-1} className="type-title-2 text-ink outline-none">
                  {t(`agents.new.h.${current}` as 'agents.new.h.preset')}
                </h2>
                <p className="mt-1 type-body-sm text-ink-2">
                  {t(`agents.new.sub.${current}` as 'agents.new.sub.preset', { name: name || 'it' })}
                </p>
              </div>
              {stepBody}
              <div
                className={cx(
                  'sticky bottom-[calc(var(--bh-tabbar-h)+var(--bh-safe-bottom))] z-20 -mx-4 border-t border-line bg-bg px-4 py-3 medium:-mx-6 medium:px-6',
                  'expanded:bottom-0 expanded:mx-0 expanded:px-0',
                )}
              >
                {footer}
              </div>
            </div>
            <aside
              aria-label={t('agents.new.previewLabel')}
              className="hidden flex-col gap-3 self-start @min-[50rem]/new:sticky @min-[50rem]/new:top-4 @min-[50rem]/new:flex"
            >
              <Eyebrow level={2}>{t('agents.new.reach', { name: name || '…' })}</Eyebrow>
              <ReachSummary
                reach={reach}
                name={name}
                maxHosts={3}
                branchNote={mounts.some((m) => m.mode === 'rw')}
              />
              <CliStrip command={cli} />
            </aside>
          </div>
        </div>
      )}
    </Screen>
  );
};
