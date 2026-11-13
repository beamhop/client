/**
 * Create an agent on one page, the same in first-run setup and in Agents → New (desktop UX audit,
 * docs/design/desktop-ux-audit.md): what it's for · name · AI account · folders · where it listens.
 * The agent is reachable when the flow ends: it always answers in this app, it joins the channels ticked
 * here, and "Connect a new channel" opens that channel's setup with this agent already picked to join.
 *
 * `useCreateAgent` returns the pieces (form, live preview, submit) so each host lays them out its own way.
 */
import type { AgentView, ChannelView, HarnessView, Mount } from '@beamhop/core';
import { CaretRight, ChatCircle, Plus } from '@phosphor-icons/react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { Radio, RadioGroup } from 'react-aria-components';
import { harnessMonogram, providerMonogram, useApi, useMutationApi } from '../../api/index.ts';
import { t } from '../../i18n/index.ts';
import { cx } from '../../lib/cx.ts';
import { useShowCli } from '../../lib/desktop.ts';
import { usd } from '../../lib/format.ts';
import { haptic } from '../../lib/haptics.ts';
import { Checkbox, SegmentedControl } from '../../ui/Choice.tsx';
import { CliStrip } from '../../ui/CliStrip.tsx';
import { TextField } from '../../ui/Field.tsx';
import { Eyebrow, LetterTile } from '../../ui/Meta.tsx';
import { ErrorState } from '../../ui/States.tsx';
import { readDraft, writeDraft } from '../channels/draft.ts';
import { channelChats, PROVIDERS } from '../channels/providers.ts';
import { HarnessJobControls } from '../harnesses/HarnessJob.tsx';
import { DEFAULT_MODEL, ModelField } from './ModelField.tsx';
import {
  createCli,
  PRESET_META,
  reachOf,
  SCRATCH,
  SCRATCH_NAME,
  suggestName,
  validateName,
} from './model.ts';
import { ReachSummary } from './parts.tsx';
import { AddMount, MountRow } from './sections/Setup.tsx';

type Profile = 'strict' | 'workspace' | 'custom';

interface Preset {
  id: string;
  title: string;
  description: string;
  config: Record<string, unknown>;
}

/** The AI account a harness signs in with, in the owner's words (the harness name stays in Advanced). */
const AI_ACCOUNT: Record<string, { name: string; account: string }> = {
  claude: { name: 'Claude', account: 'Anthropic' },
  codex: { name: 'ChatGPT', account: 'OpenAI' },
  gemini: { name: 'Gemini', account: 'Google' },
  copilot: { name: 'GitHub Copilot', account: 'GitHub' },
  cursor: { name: 'Cursor', account: 'Cursor' },
  opencode: { name: 'Any AI provider', account: 'OpenCode' },
  pi: { name: 'Any AI provider', account: 'pi' },
};
export const aiAccountOf = (h: Pick<HarnessView, 'id' | 'displayName'>) =>
  AI_ACCOUNT[h.id] ?? { name: h.displayName, account: h.displayName };

/** Channel providers by their everyday name (the setup picker says "Nostr group (NIP-29)" and the like). */
const PLACE: Record<string, string> = {
  telegram: 'Telegram',
  slack: 'Slack',
  discord: 'Discord',
  nostr: 'Nostr',
};
const placeName = (provider: string) => PLACE[provider] ?? PROVIDERS[provider]?.name ?? provider;

/** New-channel providers offered inline (plugins keep their own setup). */
const NEW_CHANNELS = ['telegram', 'slack', 'discord', 'nostr'] as const;

/** One place an agent can listen: a channel's DMs, or a known group/channel in it. */
export interface ListenOption {
  target: string;
  channel: string;
  provider: string;
  label: string;
  detail: string;
}

export const listenOptions = (channels: ChannelView[]): ListenOption[] =>
  channels
    .filter((c) => c.config.enabled !== false && c.status !== 'disabled' && c.status !== 'error')
    .flatMap((c) => {
      const name = c.config.name;
      const provider = c.config.provider;
      const who = c.self?.handle ?? name;
      const pname = placeName(provider);
      return [
        {
          target: `${name}:dm`,
          channel: name,
          provider,
          label: t('agents.create.listen.dms', { provider: pname }),
          detail: who,
        },
        ...channelChats(c).map((chat) => ({
          target: `${name}:${chat.target}`,
          channel: name,
          provider,
          label: chat.title,
          detail: `${pname} · ${who}`,
        })),
      ];
    });

/** Who the preset lets talk to it once it listens somewhere (owners always can). */
const membershipFor = (presetId: string, target: string) => {
  const dm = target.endsWith(':dm');
  if (presetId === 'personal-assistant')
    return { target, defaultRole: 'viewer', triggers: dm ? ['dm'] : ['mention', 'reply'] };
  return {
    target,
    defaultRole: presetId === 'team-dev-bot' ? 'user' : 'viewer',
    triggers: dm ? ['dm', 'mention', 'reply'] : ['mention', 'reply'],
  };
};

const cardClass =
  'group relative flex cursor-default flex-col gap-1 rounded-lg border bg-surface p-3.5 outline-none transition-colors duration-[var(--dur-fast)] data-[hovered]:border-line-strong data-[selected]:border-ink data-[selected]:bg-flare-wash data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-focus data-[disabled]:cursor-not-allowed';

const Section = ({
  id,
  title,
  hint,
  children,
}: {
  id: string;
  title: string;
  hint?: string;
  children: ReactNode;
}) => (
  <section aria-labelledby={id} className="flex flex-col gap-3">
    <div>
      <h2 id={id} className="type-title-3 text-ink">
        {title}
      </h2>
      {hint && <p className="mt-0.5 type-body-sm text-ink-2">{hint}</p>}
    </div>
    {children}
  </section>
);

export interface CreatedAgent {
  agent: AgentView;
  /** A channel the owner chose to connect next (its setup is primed to join this agent). */
  connect?: string;
}

export const useCreateAgent = ({ onCreated }: { onCreated: (r: CreatedAgent) => void }) => {
  const presetsQ = useApi('agent.presets');
  const harnessQ = useApi('harness.list');
  const agentsQ = useApi('agent.list');
  const channelsQ = useApi('channel.list');
  const create = useMutationApi('agent.create');
  const showCli = useShowCli();

  const presets = (presetsQ.data?.presets ?? []) as Preset[];
  const harnesses = harnessQ.data?.harnesses ?? [];
  const taken = useMemo(() => (agentsQ.data?.agents ?? []).map((a) => a.config.name), [agentsQ.data]);
  const options = useMemo(() => listenOptions(channelsQ.data?.channels ?? []), [channelsQ.data]);

  const [presetId, setPresetId] = useState('personal-assistant');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [harness, setHarness] = useState('');
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [mounts, setMounts] = useState<Mount[]>([]);
  const [listens, setListens] = useState<string[] | undefined>();
  const [connect, setConnect] = useState<string | undefined>();
  const [tried, setTried] = useState(false);
  const [scratchProfile, setScratchProfile] = useState<'strict' | 'workspace'>('workspace');

  const scratch = presetId === SCRATCH;
  const preset = presets.find((p) => p.id === presetId);
  const meta = PRESET_META[presetId];
  const profile: Profile = scratch
    ? scratchProfile
    : (((preset?.config as { sandbox?: { profile?: Profile } } | undefined)?.sandbox?.profile ??
        'workspace') as Profile);
  // The strict profile makes every mount read-only (sandbox compilePolicy), whatever its mode says.
  const lockRo = scratch ? scratchProfile === 'strict' : meta?.lockMode === 'ro';
  const baseName = scratch ? SCRATCH_NAME : meta?.name;

  useEffect(() => {
    if (!nameTouched && baseName && agentsQ.data) setName(suggestName(baseName, taken));
  }, [agentsQ.data, nameTouched, baseName, taken]);
  useEffect(() => {
    if (!harness) {
      const first = harnesses.find((h) => h.status === 'ready');
      if (first) setHarness(first.id);
    }
  }, [harnesses, harness]);
  useEffect(() => {
    if (lockRo && mounts.some((m) => m.mode === 'rw'))
      setMounts((ms) => ms.map((m) => ({ ...m, mode: 'ro' as const, parallelUnsafe: false })));
  }, [lockRo, mounts]);

  // Until the owner ticks something, follow the preset: its own targets, else every connected DM for the
  // assistant (it is for you, wherever you are), nothing for agents meant for shared spaces.
  const presetTargets = (
    ((preset?.config as { memberships?: { target: string }[] } | undefined)?.memberships ?? []) as {
      target: string;
    }[]
  ).map((m) => m.target);
  const suggested = options
    .filter((o) =>
      presetTargets.length
        ? presetTargets.includes(o.target)
        : presetId === 'personal-assistant' && o.target.endsWith(':dm'),
    )
    .map((o) => o.target);
  const chosen = listens ?? suggested;
  const toggle = (target: string, on: boolean) =>
    setListens(on ? [...new Set([...chosen, target])] : chosen.filter((x) => x !== target));

  const nameErr = validateName(name, taken);
  const harnessOk = harnesses.some((h) => h.id === harness && h.status === 'ready');
  const blocker = nameErr ?? (!harnessOk ? t('agents.create.pickAccount') : undefined);
  const reach = reachOf({ harness: harness || 'claude', mounts, sandbox: { profile } });
  const cli = scratch
    ? createCli({ name, harness, model, mounts, profile })
    : createCli({ name, preset: presetId, harness, model, mounts });

  const submit = async () => {
    setTried(true);
    if (blocker) {
      haptic('error');
      return;
    }
    try {
      const agent = await create.mutateAsync({
        ...(scratch ? {} : { preset: presetId }),
        config: {
          name,
          harness,
          model,
          mounts,
          sandbox: { profile },
          memberships: chosen.map((target) => membershipFor(presetId, target)),
        },
      });
      haptic('confirm');
      if (connect) {
        // Prime that channel's setup: its last step ("Join") picks this agent, and finishing returns here.
        const d = readDraft(connect);
        const values = { ...(d?.values ?? {}), agents: [agent.config.name], forAgent: agent.config.name };
        const updatedAt = new Date().toISOString();
        writeDraft(d ? { ...d, values, updatedAt } : { provider: connect, step: 1, values, updatedAt });
      }
      onCreated({ agent, ...(connect ? { connect } : {}) });
    } catch {
      haptic('error');
    }
  };

  const loading = presetsQ.isPending || harnessQ.isPending;
  const loadError = presetsQ.error ?? harnessQ.error;
  const selectedHarness = harnesses.find((h) => h.id === harness);

  const form = (
    <div className="flex min-w-0 max-w-[640px] flex-col gap-8">
      <Section id="create-what" title={t('agents.create.what')}>
        <RadioGroup
          value={presetId}
          onChange={setPresetId}
          aria-labelledby="create-what"
          className="grid gap-2 medium:grid-cols-2"
        >
          {[
            ...presets.map((p) => ({
              id: p.id,
              title: p.title,
              who: PRESET_META[p.id]?.who ?? p.description,
            })),
            { id: SCRATCH, title: t('agents.new.scratch.title'), who: t('agents.new.scratch.who') },
          ].map((p) => {
            const cfg = presets.find((x) => x.id === p.id)?.config as
              | { budgets?: { dailyUsd?: number } }
              | undefined;
            return (
              <Radio
                key={p.id}
                value={p.id}
                className={cx(
                  cardClass,
                  p.id === SCRATCH ? 'border-dashed border-line-strong' : 'border-line',
                )}
              >
                <span className="type-body text-ink">{p.title}</span>
                <span className="type-body-sm text-ink-2">{p.who}</span>
                <span className="type-meta text-ink-3">
                  {t('agents.create.perDay', { usd: usd(cfg?.budgets?.dailyUsd ?? 5) })}
                </span>
              </Radio>
            );
          })}
        </RadioGroup>
        {meta && <p className="type-body-sm text-ink-2">{meta.tradeoff}</p>}
        {scratch && (
          <div className="flex flex-col gap-2">
            <SegmentedControl
              label={t('agents.new.scratch.sandbox')}
              value={scratchProfile}
              onChange={setScratchProfile}
              className="self-start"
              options={[
                { id: 'workspace', label: t('agents.new.scratch.workspace') },
                { id: 'strict', label: t('agents.new.scratch.strict') },
              ]}
            />
            <p className="type-body-sm text-ink-2">
              {t(
                scratchProfile === 'strict'
                  ? 'agents.new.scratch.strictHint'
                  : 'agents.new.scratch.workspaceHint',
              )}
            </p>
          </div>
        )}
      </Section>

      <TextField
        label={t('agents.create.name')}
        value={name}
        onChange={(v) => {
          setNameTouched(true);
          setName(v.toLowerCase());
        }}
        mono
        isInvalid={(tried || nameTouched) && !!nameErr}
        errorMessage={nameErr}
        description={t('agents.create.nameHint')}
      />

      <Section id="create-ai" title={t('agents.create.ai')} hint={t('agents.create.aiHint')}>
        <RadioGroup
          value={harness}
          onChange={(id) => {
            if (id !== harness) setModel(DEFAULT_MODEL);
            setHarness(id);
          }}
          aria-labelledby="create-ai"
          className="flex flex-col gap-2"
        >
          {harnesses
            .filter((h) => h.status !== 'error')
            .map((h) => {
              const ai = aiAccountOf(h);
              const ready = h.status === 'ready';
              return (
                <div key={h.id} className="flex flex-col gap-1.5">
                  <Radio value={h.id} isDisabled={!ready} className={cx(cardClass, 'border-line py-3')}>
                    <span className="flex items-center gap-3">
                      <LetterTile code={harnessMonogram(h.id)} />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className={cx('type-body', ready ? 'text-ink' : 'text-ink-2')}>{ai.name}</span>
                        <span className="type-meta text-ink-3">
                          {ready
                            ? t('agents.create.aiReady', { account: ai.account })
                            : h.status === 'needs-login'
                              ? t('agents.create.aiSignIn', { account: ai.account })
                              : h.status === 'unsupported-version'
                                ? t('agents.create.aiUpdate')
                                : t('agents.create.aiInstall')}
                        </span>
                      </span>
                    </span>
                  </Radio>
                  {!ready && <HarnessJobControls h={h} className="ml-12" />}
                </div>
              );
            })}
        </RadioGroup>
        <details className="group rounded-md border border-line px-3 py-2">
          <summary className="cursor-default type-body-sm text-ink-2 marker:content-none">
            <CaretRight
              size={12}
              className="mr-1 inline transition-transform group-open:rotate-90"
              aria-hidden="true"
            />
            {t('agents.create.advanced')}
          </summary>
          <div className="mt-3 flex flex-col gap-3">
            {selectedHarness && (
              <p className="type-meta text-ink-2">
                {t('agents.create.runsOn', {
                  harness: selectedHarness.displayName,
                  version: selectedHarness.version ?? '',
                })}
              </p>
            )}
            <ModelField harness={selectedHarness} value={model} onChange={setModel} />
          </div>
        </details>
      </Section>

      <Section id="create-folders" title={t('agents.create.folders')} hint={t('agents.create.foldersHint')}>
        {mounts.length > 0 && (
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
        )}
        <AddMount mounts={mounts} lockRo={lockRo} onAdd={(m) => setMounts((ms) => [...ms, m])} />
      </Section>

      <Section
        id="create-listen"
        title={t('agents.create.listen')}
        hint={t('agents.create.listenHint', { name: name || 'it' })}
      >
        <div className="flex flex-col rounded-lg border border-line bg-surface px-4 py-1">
          <p className="flex min-h-12 items-center gap-3 border-b border-line py-2 type-body text-ink last:border-b-0">
            <ChatCircle size={20} className="shrink-0 text-ink-2" aria-hidden="true" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span>{t('agents.create.listen.app')}</span>
              <span className="type-meta text-ink-3">{t('agents.create.listen.appHint')}</span>
            </span>
          </p>
          {options.map((o) => (
            <Checkbox
              key={o.target}
              isSelected={chosen.includes(o.target)}
              onChange={(on) => toggle(o.target, on)}
              description={o.detail}
              className="border-b border-line py-1 last:border-b-0"
            >
              {o.label}
            </Checkbox>
          ))}
        </div>
        <div className="flex flex-col gap-2">
          <span className="type-body-sm text-ink-2">{t('agents.create.listen.new')}</span>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('agents.create.listen.new')}>
            {NEW_CHANNELS.map((p) => (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={connect === p}
                onClick={() => setConnect((c) => (c === p ? undefined : p))}
                className={cx(
                  'flex items-center gap-2 rounded-md border px-3 py-2 type-body-sm',
                  connect === p
                    ? 'border-ink bg-flare-wash text-ink'
                    : 'border-line text-ink-2 hover:border-line-strong',
                )}
              >
                <LetterTile code={providerMonogram(p)} />
                {placeName(p)}
              </button>
            ))}
          </div>
          {connect && (
            <p className="type-body-sm text-ink-2" aria-live="polite">
              {t('agents.create.listen.after', {
                provider: placeName(connect),
                minutes: PROVIDERS[connect]?.minutes ?? 3,
              })}
            </p>
          )}
        </div>
      </Section>

      {create.error && (
        <ErrorState title={t('agents.new.createError', { name })} details={create.error}>
          {create.error.message}
        </ErrorState>
      )}
    </div>
  );

  const preview = (
    <div className="flex flex-col gap-3">
      <Eyebrow level={2}>{t('agents.new.reach', { name: name || '…' })}</Eyebrow>
      <ReachSummary reach={reach} name={name} maxHosts={3} branchNote={mounts.some((m) => m.mode === 'rw')} />
      <Eyebrow level={2}>{t('agents.create.listensTitle')}</Eyebrow>
      <ul className="flex flex-col gap-1 type-body-sm text-ink">
        <li>{t('agents.create.listen.app')}</li>
        {options
          .filter((o) => chosen.includes(o.target))
          .map((o) => (
            <li key={o.target}>
              {o.label} <span className="text-ink-3">· {o.detail}</span>
            </li>
          ))}
        {connect && <li>{t('agents.create.listen.next', { provider: placeName(connect) })}</li>}
      </ul>
      {showCli && <CliStrip command={cli} />}
    </div>
  );

  return {
    loading,
    loadError,
    retry: () => {
      void presetsQ.refetch();
      void harnessQ.refetch();
    },
    form,
    preview,
    name,
    blocker: tried ? blocker : undefined,
    pending: create.isPending,
    submit,
    connect,
    submitLabel: connect
      ? t('agents.create.submitConnect', {
          name: name || 'agent',
          provider: placeName(connect),
        })
      : t('agents.new.create', { name: name || 'agent' }),
    submitIcon: <Plus size={16} weight="bold" aria-hidden="true" />,
  };
};
