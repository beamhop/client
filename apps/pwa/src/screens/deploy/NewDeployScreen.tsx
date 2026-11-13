/**
 * New cloud agent / Move to cloud — SCREENS §8, JOURNEYS §7.
 * Steps: 01 Agent (move an existing local agent, or a new one) · 02 Provider (5 rows: VPS/PaaS
 * trade-off, sandbox note, inline API token → keychain) · 03 Size & region (monthly cost right-aligned)
 * · 04 Files & login (per-mount sync: git clone / rsync / Mutagen / leave here; harness auth: API key
 * brokered from this computer or a subscription login on the server) · 05 Plan (terraform-style + ~ → - diff with words, warnings needing an explicit "I understand",
 * estimated cost) → `Deploy · $4.90/mo` → deployment detail (apply timeline; leaving is safe).
 * Desktop: left steps form (640) + sticky live Plan preview with the cost readout.
 * Deep link: `/deploy/new?agent=reviewer` (Agent detail → Move to cloud) starts in move mode.
 *
 * Research used: Terraform/OpenTofu plan symbols; Vercel/Railway deploy timelines with phase logs;
 * Fly per-second billing and storage while stopped
 * (https://www.costbench.com/software/developer-tools/flyio/hidden-costs/).
 */
import type { Mount } from '@beamhop/core';
import {
  ArrowLeft,
  ArrowRight,
  CloudArrowUp,
  FolderSimple,
  GitBranch,
  LockSimple,
  Warning,
} from '@phosphor-icons/react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { deployMonogram, useApi, useMutationApi } from '../../api/index.ts';
import { t } from '../../i18n/index.ts';
import { cx } from '../../lib/cx.ts';
import { haptic } from '../../lib/haptics.ts';
import { useExpanded } from '../../lib/media.ts';
import { Screen } from '../../shell/Screen.tsx';
import { Button, TextLink } from '../../ui/Button.tsx';
import { Checkbox, Radio, RadioGroup, Select } from '../../ui/Choice.tsx';
import { CliStrip, CopyButton } from '../../ui/CliStrip.tsx';
import { SecretField, TextField } from '../../ui/Field.tsx';
import { Badge, Eyebrow, LetterTile, Readout } from '../../ui/Meta.tsx';
import { useIsGitRepo } from '../../ui/PathPicker.tsx';
import { ErrorState, Skeleton } from '../../ui/States.tsx';
import { Stepper } from '../../ui/Stepper.tsx';
import { useToast } from '../../ui/Toast.tsx';
import { AGENT_NAME_RE, PROVIDER_INFO, providerTokenSecret, usd } from './model.ts';
import { PlanDiff, TickRuler } from './PlanDiff.tsx';

const STEPS = [
  t('deploy.step.agent'),
  t('deploy.step.provider'),
  t('deploy.step.size'),
  t('deploy.step.files'),
  t('deploy.step.plan'),
];
const PLAN = STEPS.length - 1;
type Mode = 'move' | 'new';
type Sync = 'git-clone' | 'rsync' | 'mutagen' | 'skip';
type HarnessAuth = 'api-key' | 'subscription';

interface Draft {
  mode: Mode;
  agent: string;
  provider: string;
  size?: string;
  region?: string;
  /** Per-mount sync choice (move mode); unset mounts use the default for their kind. */
  sync: Record<string, Sync>;
  harnessAuth: HarnessAuth;
}

/** `deploy.plan` / `deploy.apply` params for a draft (mount choices only when moving an agent). */
const specOf = (d: Draft, mounts: Mount[]) => ({
  agent: d.agent,
  provider: d.provider,
  size: d.size,
  region: d.region,
  mode: d.mode,
  harnessAuth: d.harnessAuth,
  ...(d.mode === 'move' && mounts.length
    ? { mounts: mounts.map((m) => ({ path: m.path, sync: d.sync[m.path] ?? ('rsync' as Sync) })) }
    : {}),
});

const useAgentMounts = (d: Draft): Mount[] => {
  const agents = useApi('agent.list');
  return d.mode === 'move'
    ? (agents.data?.agents.find((a) => a.config.name === d.agent)?.config.mounts ?? [])
    : [];
};

// ─────────── 01 Agent ───────────
const AgentStep = ({ d, set }: { d: Draft; set: (p: Partial<Draft>) => void }) => {
  const agents = useApi('agent.list');
  const local = (agents.data?.agents ?? []).filter((a) => a.location.kind === 'local');
  const taken = (agents.data?.agents ?? []).some((a) => a.config.name === d.agent);
  const nameBad = d.mode === 'new' && d.agent.length > 0 && (!AGENT_NAME_RE.test(d.agent) || taken);
  return (
    <div className="flex flex-col gap-6">
      <RadioGroup
        label={t('deploy.newDeploy.whatDoYouWant')}
        variant="cards"
        value={d.mode}
        onChange={(v) => set({ mode: v as Mode, agent: v === 'move' ? (local[0]?.config.name ?? '') : '' })}
      >
        <Radio value="move" description={t('deploy.newDeploy.sameAgentSameIdentity')}>
          {t('deploy.newDeploy.moveAnAgentTo')}
        </Radio>
        <Radio value="new" description={t('deploy.newDeploy.aFreshAgentThat')}>
          {t('deploy.deploy.newCloudAgent')}
        </Radio>
      </RadioGroup>
      {d.mode === 'move' ? (
        local.length ? (
          <RadioGroup
            label={t('deploy.newDeploy.agent')}
            variant="cards"
            value={d.agent || null}
            onChange={(v) => set({ agent: v })}
            description={t('deploy.newDeploy.itsKeyMovesTo')}
          >
            {local.map((a) => (
              <Radio
                key={a.config.name}
                value={a.config.name}
                description={
                  <span className="font-mono text-[12px]">
                    {a.config.harness} · {a.config.sandbox.profile} · {a.config.mounts.length}{' '}
                    {a.config.mounts.length === 1 ? 'mount' : 'mounts'}
                  </span>
                }
              >
                {a.config.name}
              </Radio>
            ))}
          </RadioGroup>
        ) : agents.isPending ? (
          <Skeleton variant="list" count={1} />
        ) : (
          <p className="type-body-sm text-ink-2">{t('deploy.newDeploy.everyAgentAlreadyRuns')}</p>
        )
      ) : (
        <TextField
          label={t('deploy.newDeploy.agentName')}
          mono
          value={d.agent}
          onChange={(v) => set({ agent: v.toLowerCase() })}
          placeholder="night-shift"
          description={t('deploy.newDeploy.lowercaseLettersDigitsAnd')}
          isInvalid={nameBad}
          errorMessage={
            taken ? `${d.agent} already exists.` : t('deploy.newDeploy.useLowercaseLettersDigits')
          }
        />
      )}
    </div>
  );
};

// ─────────── 02 Provider ───────────
const TokenInline = ({ provider, name }: { provider: string; name: string }) => {
  const [value, setValue] = useState('');
  const set = useMutationApi('secret.set', { invalidate: ['deploy.providers'] });
  const info = PROVIDER_INFO[provider];
  return (
    <div className="mt-1 mb-2 ml-9 flex flex-col gap-2 rounded-md border border-line bg-sunken p-3">
      <SecretField
        label={t('deploy.newDeploy.apiToken', { name })}
        value={value}
        onChange={setValue}
        description={info?.tokenHelp}
      />
      <p className="flex items-center gap-1.5 type-meta text-ink-2">
        <LockSimple size={14} aria-hidden="true" /> {t('deploy.newDeploy.tokenKeychain')}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          size="sm"
          isDisabled={!value.trim()}
          isPending={set.isPending}
          onPress={() => set.mutate({ name: providerTokenSecret(provider), value: value.trim() })}
        >
          {t('deploy.newDeploy.saveToken')}
        </Button>
        {info && (
          <TextLink href={info.tokenUrl} external className="type-body-sm">
            {t('deploy.newDeploy.getAToken')}
          </TextLink>
        )}
      </div>
      {set.isError && <p className="type-body-sm text-stop-text">{set.error.message}</p>}
    </div>
  );
};

const ProviderStep = ({ d, set }: { d: Draft; set: (p: Partial<Draft>) => void }) => {
  const q = useApi('deploy.providers');
  if (q.isError)
    return (
      <ErrorState
        title={t('deploy.newDeploy.couldnTLoadProviders')}
        details={q.error}
        onRetry={() => void q.refetch()}
      >
        {q.error.message}
      </ErrorState>
    );
  if (!q.data) return <Skeleton variant="list" count={5} label={t('deploy.newDeploy.loadingProviders')} />;
  const groups = [
    {
      kind: 'vps' as const,
      title: t('deploy.newDeploy.vpsYourOwnServer'),
      note: t('deploy.newDeploy.fullSandboxFixedMonthly'),
    },
    {
      kind: 'paas' as const,
      title: t('deploy.newDeploy.platformManagedRuntime'),
      note: t('deploy.newDeploy.lessToRunThe'),
    },
  ];
  return (
    <div className="flex flex-col gap-6">
      <RadioGroup
        label={t('deploy.newDeploy.provider')}
        hideLabel
        value={d.provider || null}
        onChange={(v) => set({ provider: v, size: undefined, region: undefined })}
      >
        {groups.map((g) => (
          <section key={g.kind} aria-label={g.title} className="flex flex-col">
            <Eyebrow level={3}>{g.title}</Eyebrow>
            <p className="-mt-2 mb-1 type-body-sm text-ink-2">{g.note}</p>
            <div className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
              {q.data.providers
                .filter((p) => p.kind === g.kind)
                .map((p) => {
                  const info = PROVIDER_INFO[p.id];
                  return (
                    <div key={p.id} className={cx('px-4', d.provider === p.id && 'bg-flare-wash')}>
                      <Radio
                        value={p.id}
                        description={
                          <span className="flex flex-col gap-1">
                            <span className="font-mono text-[12px] leading-4 text-ink-2">
                              {info?.fit ?? p.kind}
                            </span>
                            {d.provider === p.id && info && (
                              <>
                                <span>{info.sandboxNote}</span>
                                <span>{info.billing}</span>
                              </>
                            )}
                          </span>
                        }
                      >
                        <span className="flex items-center gap-2">
                          <LetterTile code={deployMonogram(p.id)} size={24} />
                          {p.displayName}
                          {p.configured ? (
                            <Badge tone="go">{t('deploy.newDeploy.tokenSaved')}</Badge>
                          ) : (
                            <Badge tone="outline">{t('deploy.newDeploy.needsToken')}</Badge>
                          )}
                        </span>
                      </Radio>
                      {d.provider === p.id && !p.configured && (
                        <TokenInline provider={p.id} name={p.displayName} />
                      )}
                    </div>
                  );
                })}
            </div>
          </section>
        ))}
      </RadioGroup>
    </div>
  );
};

// ─────────── 03 Size & region ───────────
const SizeStep = ({ d, set }: { d: Draft; set: (p: Partial<Draft>) => void }) => {
  const q = useApi('deploy.options', { provider: d.provider }, { enabled: !!d.provider });
  useEffect(() => {
    if (q.data && !d.size) set({ size: q.data.sizes[0]?.id, region: d.region ?? q.data.regions[0]?.id });
  }, [q.data, d.size, d.region, set]);
  if (q.isError)
    return (
      <ErrorState
        title={t('deploy.newDeploy.couldnTLoadSizes')}
        details={q.error}
        onRetry={() => void q.refetch()}
      >
        {q.error.message}
      </ErrorState>
    );
  if (!q.data) return <Skeleton variant="list" count={3} label={t('deploy.newDeploy.loadingSizes')} />;
  return (
    <div className="flex flex-col gap-6">
      <RadioGroup
        label={t('deploy.newDeploy.size')}
        variant="cards"
        value={d.size ?? null}
        onChange={(v) => set({ size: v })}
      >
        {q.data.sizes.map((s) => (
          <Radio key={s.id} value={s.id}>
            <span className="flex items-baseline gap-3">
              <span
                className="min-w-0 flex-1 font-mono text-[14px]"
                style={{ fontVariationSettings: '"wdth" 87.5' }}
              >
                {s.label}
              </span>
              <span className="shrink-0 type-meta text-ink tabular-nums">{usd(s.monthlyUsd)}/mo</span>
            </span>
          </Radio>
        ))}
      </RadioGroup>
      <p className="-mt-4 type-meta text-ink-2">{t('deploy.newDeploy.estimatesFromTheProvider')}</p>
      <RadioGroup
        label={t('deploy.newDeploy.region')}
        value={d.region ?? null}
        onChange={(v) => set({ region: v })}
        description={t('deploy.newDeploy.pickOneCloseTo')}
      >
        {q.data.regions.map((r) => (
          <Radio key={r.id} value={r.id}>
            {r.label}
          </Radio>
        ))}
      </RadioGroup>
    </div>
  );
};

// ─────────── 04 Files & login ───────────
const SYNC_LABEL: Record<Sync, { label: string; description: string }> = {
  'git-clone': { label: 'Clone from git', description: 'The server clones the repository from its remote.' },
  rsync: {
    label: 'Copy once',
    description: 'Copied over at deploy time (rsync). Later edits stay where they are.',
  },
  mutagen: {
    label: 'Keep in sync',
    description: 'Two-way sync with this computer (Mutagen) while both are online.',
  },
  skip: { label: 'Leave it here', description: 'Not copied. The cloud agent works without this folder.' },
};

const MountChoice = ({
  m,
  value,
  onChange,
}: {
  m: Mount;
  value: Sync | undefined;
  onChange: (s: Sync) => void;
}) => {
  const git = useIsGitRepo(m.path);
  // Default: clone git repos, copy everything else (set once the git check lands).
  useEffect(() => {
    if (value === undefined && git !== undefined) onChange(git ? 'git-clone' : 'rsync');
  }, [git, value, onChange]);
  const choices: Sync[] = git ? ['git-clone', 'rsync', 'mutagen', 'skip'] : ['rsync', 'mutagen', 'skip'];
  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <span className="flex items-center gap-2">
        {git ? (
          <GitBranch size={18} aria-label="git repository" className="shrink-0 text-ink-2" />
        ) : (
          <FolderSimple size={18} aria-hidden="true" className="shrink-0 text-ink-2" />
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-[14px] text-ink">{m.path}</span>
        <Badge>{m.mode === 'rw' ? 'read-write' : 'read-only'}</Badge>
      </span>
      <Select
        label={`How ${m.path} gets to the server`}
        hideLabel
        options={choices.map((c) => ({ id: c, ...SYNC_LABEL[c] }))}
        selectedKey={value ?? null}
        onSelectionChange={(k) => onChange(String(k) as Sync)}
      />
    </li>
  );
};

const FilesStep = ({
  d,
  set,
  setSync,
}: {
  d: Draft;
  set: (p: Partial<Draft>) => void;
  setSync: (path: string, s: Sync) => void;
}) => {
  const mounts = useAgentMounts(d);
  const agents = useApi('agent.list');
  const harness = agents.data?.agents.find((a) => a.config.name === d.agent)?.config.harness;
  return (
    <div className="flex flex-col gap-6">
      {d.mode === 'move' && (
        <section aria-labelledby="dep-files" className="flex flex-col gap-2">
          <Eyebrow id="dep-files" level={3}>
            Folders · {mounts.length}
          </Eyebrow>
          {mounts.length === 0 ? (
            <p className="type-body-sm text-ink-2">{d.agent} has no mounted folders. Nothing to copy.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface">
              {mounts.map((m) => (
                <MountChoice key={m.path} m={m} value={d.sync[m.path]} onChange={(s) => setSync(m.path, s)} />
              ))}
            </ul>
          )}
        </section>
      )}
      <RadioGroup
        label={`How ${harness ?? 'the harness'} logs in on the server`}
        variant="cards"
        value={d.harnessAuth}
        onChange={(v) => set({ harnessAuth: v as HarnessAuth })}
      >
        <Radio
          value="api-key"
          description="The key stays in this computer's keychain; the server asks for each request through the broker."
        >
          API key from this computer
        </Radio>
        <Radio
          value="subscription"
          description="You sign in to your plan on the server once, after it's up. Nothing leaves this computer."
        >
          Subscription login on the server
        </Radio>
      </RadioGroup>
    </div>
  );
};

// ─────────── 05 Plan ───────────
const usePlan = (d: Draft, enabled: boolean) => {
  const mounts = useAgentMounts(d);
  return useApi('deploy.plan', specOf(d, mounts), {
    enabled: enabled && !!d.agent && !!d.provider,
    staleTime: 10_000,
  });
};

const cliFor = (d: Draft) =>
  `beamhop deploy plan ${d.agent || '<agent>'} --provider ${d.provider || '<provider>'}${d.size ? ` --size ${d.size}` : ''}${d.region ? ` --region ${d.region}` : ''}${d.mode === 'new' ? ' --new' : ''} --json`;

const PlanBlock = ({
  d,
  compact,
  ack,
  setAck,
}: {
  d: Draft;
  compact?: boolean;
  ack?: boolean;
  setAck?: (v: boolean) => void;
}) => {
  const plan = usePlan(d, true);
  const sizes = useApi('deploy.options', { provider: d.provider }, { enabled: !!d.provider });
  const sizeCost = sizes.data?.sizes.find((s) => s.id === d.size)?.monthlyUsd;
  if (!d.provider || !d.agent)
    return <p className="type-body-sm text-ink-2">{t('deploy.newDeploy.chooseAnAgentAnd')}</p>;
  if (plan.isError)
    return (
      <ErrorState
        title={t('deploy.newDeploy.couldnTPlanThis')}
        details={plan.error}
        onRetry={() => void plan.refetch()}
      >
        {plan.error.message}
      </ErrorState>
    );
  if (!plan.data) return <Skeleton variant="detail" count={2} label={t('deploy.newDeploy.planning')} />;
  const cost = sizeCost ?? plan.data.monthlyCostUsd;
  return (
    <div className="flex flex-col gap-4" data-plan="">
      <PlanDiff actions={plan.data.actions} />
      {plan.data.warnings.length > 0 && (
        <div className="flex flex-col gap-2 rounded-md border-l-[3px] border-caution-text bg-caution-wash px-3 py-2.5">
          {plan.data.warnings.map((w) => (
            <p key={w} className="flex items-start gap-2 type-body-sm text-ink">
              <Warning
                size={16}
                weight="bold"
                className="mt-0.5 shrink-0 text-caution-text"
                aria-hidden="true"
              />
              <span>
                <span className="font-mono text-caution-text">{t('deploy.newDeploy.sandbox')}</span> {w}
              </span>
            </p>
          ))}
          {setAck && (
            <Checkbox isSelected={ack} onChange={setAck}>
              {t('deploy.newDeploy.iUnderstandTheSandbox')}
            </Checkbox>
          )}
        </div>
      )}
      <TickRuler />
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="type-micro text-ink-2">{t('deploy.newDeploy.estimated')}</p>
          <p className="type-meta text-ink-2">{t('deploy.newDeploy.bandwidth', { provider: d.provider })}</p>
        </div>
        {compact ? (
          <p className="type-title-2 text-ink tabular-nums">{usd(cost)}/mo</p>
        ) : (
          <Readout size="md">{usd(cost)}/mo</Readout>
        )}
      </div>
    </div>
  );
};

// ─────────── screen ───────────
export const NewDeployScreen = () => {
  const search = useSearch({ strict: false }) as { agent?: string; mode?: string };
  const expanded = useExpanded();
  const navigate = useNavigate();
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [ack, setAck] = useState(false);
  const [d, setD] = useState<Draft>({
    mode: search.mode === 'new' ? 'new' : 'move',
    agent: search.agent ?? '',
    provider: '',
    sync: {},
    harnessAuth: 'api-key',
  });
  const set = useMemo(() => (p: Partial<Draft>) => setD((x) => ({ ...x, ...p })), []);
  const setSync = useMemo(
    () => (path: string, s: Sync) => setD((x) => ({ ...x, sync: { ...x.sync, [path]: s } })),
    [],
  );
  const agents = useApi('agent.list');
  const providers = useApi('deploy.providers');
  const plan = usePlan(d, step === PLAN);
  const mounts = useAgentMounts(d);
  const apply = useMutationApi('deploy.apply', { invalidate: ['deploy.list', 'agent.list'] });

  // Default the agent once agents load (move mode).
  useEffect(() => {
    if (d.mode === 'move' && !d.agent) {
      const first = agents.data?.agents.find((a) => a.location.kind === 'local');
      if (first) set({ agent: first.config.name });
    }
  }, [agents.data, d.mode, d.agent, set]);

  const prov = providers.data?.providers.find((p) => p.id === d.provider);
  const taken = (agents.data?.agents ?? []).some((a) => a.config.name === d.agent);
  const canNext = [
    d.mode === 'move' ? !!d.agent : AGENT_NAME_RE.test(d.agent) && !taken,
    !!prov && prov.configured,
    !!d.size && !!d.region,
    mounts.every((m) => !!d.sync[m.path]),
    !!plan.data && (plan.data.warnings.length === 0 || ack),
  ][step];
  const sizeCost = useApi(
    'deploy.options',
    { provider: d.provider },
    { enabled: !!d.provider },
  ).data?.sizes.find((s) => s.id === d.size)?.monthlyUsd;
  const cost = sizeCost ?? plan.data?.monthlyCostUsd;

  const deploy = async () => {
    try {
      const dep = await apply.mutateAsync(specOf(d, mounts));
      haptic('confirm');
      toast.show({
        message: `Deploying · ${d.agent} to ${prov?.displayName ?? d.provider}`,
        tone: 'success',
      });
      void navigate({ to: '/deploy/$deploymentId', params: { deploymentId: dep.id } });
    } catch (e) {
      haptic('error');
      toast.show({ message: `Couldn't start the deploy: ${(e as Error).message}`, tone: 'error' });
    }
  };

  const title =
    d.mode === 'move'
      ? d.agent
        ? `Move ${d.agent} to the cloud`
        : t('deploy.newDeploy.moveToCloud')
      : t('deploy.deploy.newCloudAgent');
  const body = [
    <AgentStep key="a" d={d} set={set} />,
    <ProviderStep key="p" d={d} set={set} />,
    <SizeStep key="s" d={d} set={set} />,
    <FilesStep key="f" d={d} set={set} setSync={setSync} />,
    <div key="plan" className="flex flex-col gap-4">
      <p className="type-body-sm text-ink-2">{t('deploy.newDeploy.nothingIsCreatedUntil')}</p>
      <PlanBlock d={d} ack={ack} setAck={setAck} />
      <div className="flex flex-wrap items-center gap-2">
        <CopyButton value={cliFor(d)} label={t('deploy.newDeploy.copyPlanAsCli')} />
      </div>
    </div>,
  ][step];

  const footer = (
    <div className="flex items-center gap-2 px-gutter py-3 expanded:px-8">
      {step > 0 && (
        <Button
          variant="secondary"
          icon={<ArrowLeft size={16} aria-hidden="true" />}
          onPress={() => setStep((s) => s - 1)}
          aria-label={t('a11y.backTo', { label: STEPS[step - 1] ?? '' })}
        >
          {t('deploy.newDeploy.back')}
        </Button>
      )}
      <span className="flex-1" />
      {step < PLAN ? (
        <Button
          variant="primary"
          isDisabled={!canNext}
          onPress={() => setStep((s) => s + 1)}
          icon={<ArrowRight size={16} weight="bold" aria-hidden="true" />}
        >
          {t('deploy.newDeploy.continue', { step: STEPS[step + 1] ?? '' })}
        </Button>
      ) : (
        <Button
          variant="primary"
          isDisabled={!canNext}
          isPending={apply.isPending}
          icon={<CloudArrowUp size={18} weight="bold" aria-hidden="true" />}
          onPress={() => void deploy()}
        >
          {cost !== undefined
            ? t('deploy.newDeploy.deployCost', { cost: usd(cost) })
            : t('deploy.newDeploy.deploy')}
        </Button>
      )}
    </div>
  );

  return (
    <Screen
      title={title}
      back={{ href: '/deploy', label: 'Deploy' }}
      pane="detail"
      maxWidth="none"
      crumbs={[
        { label: 'Deploy', href: '/deploy' },
        { label: d.mode === 'move' ? t('deploy.newDeploy.moveToCloud') : t('deploy.newDeploy.new') },
      ]}
      footer={footer}
    >
      <div
        className={cx(
          'flex flex-col gap-6',
          expanded && 'grid grid-cols-[minmax(0,640px)_minmax(300px,1fr)] items-start gap-10',
        )}
      >
        <div className="flex min-w-0 flex-col gap-6">
          <Stepper steps={STEPS} current={step} onStepPress={(i) => setStep(i)} showLabels={expanded} />
          <h2 className="type-title-2 text-ink">
            {
              [
                t('deploy.newDeploy.whichAgent'),
                t('deploy.newDeploy.whereShouldItRun'),
                t('deploy.newDeploy.howBigAndWhere'),
                t('deploy.newDeploy.filesLogin'),
                t('deploy.newDeploy.reviewThePlan'),
              ][step]
            }
          </h2>
          {body}
          <CliStrip command={cliFor(d)} />
        </div>
        {expanded && step < PLAN && (
          <aside
            aria-label={t('deploy.newDeploy.planPreview')}
            className="sticky top-[88px] flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
          >
            <Eyebrow level={2}>{t('deploy.newDeploy.planPreview')}</Eyebrow>
            <PlanBlock d={d} compact />
          </aside>
        )}
      </div>
    </Screen>
  );
};
