/**
 * Onboarding 03 Identity, 04 Phone, 05 Agent (JOURNEYS §1.03–05).
 * Identity: create a new owner key (default; OS keychain) or use an existing one via a NIP-07 extension
 * or a NIP-46 bunker; backup offered, not forced. Phone: the computer-side pairing panel (QR + 4 words,
 * confirmation here), `Skip for now`. Agent: preset cards prefill the rest, ready harnesses only, folder
 * read-only by default, live exposure summary, `Create <name>`.
 */
import { npubEncode, tryDecodePubkey } from '@beamhop/channel-nostr/keys';
import { Check, Key, Plus } from '@phosphor-icons/react';
import { useEffect, useMemo, useState } from 'react';
import { Disclosure, DisclosurePanel, Heading, Button as RACButton } from 'react-aria-components';
import { useApi, useMutationApi } from '../../api/index.ts';
import { t } from '../../i18n/index.ts';
import { middleTruncate } from '../../lib/format.ts';
import { haptic } from '../../lib/haptics.ts';
import { Button } from '../../ui/Button.tsx';
import { Radio, RadioGroup, SegmentedControl } from '../../ui/Choice.tsx';
import { CopyButton } from '../../ui/CliStrip.tsx';
import { TextField } from '../../ui/Field.tsx';
import { Badge, LetterTile, MetaLine } from '../../ui/Meta.tsx';
import { PathPicker } from '../../ui/PathPicker.tsx';
import { ErrorState, Skeleton } from '../../ui/States.tsx';
import { AGENT_NAME_RE } from '../deploy/model.ts';
import { PairingPanel } from '../pair/PairingPanel.tsx';
import { markDone, markSkipped, useSetupProgress } from './progress.ts';
import { StepFrame, useGoStep } from './StepFrame.tsx';

// ─────────── 03 Identity ───────────
type IdChoice = 'create' | 'nip07' | 'nip46';

/** `bunker://<hex pubkey>?relay=…` → npub, or null. */
export const npubFromBunker = (url: string): string | null => {
  const m = /^bunker:\/\/([0-9a-f]{64})(\?|$)/i.exec(url.trim());
  const hex = m?.[1] ? tryDecodePubkey(m[1]) : undefined;
  return hex ? npubEncode(hex) : null;
};

const WhatsThisKey = () => (
  <Disclosure className="rounded-md border border-line">
    <Heading level={2}>
      <RACButton
        slot="trigger"
        className="flex min-h-11 w-full items-center px-3 text-left type-label text-ink outline-none data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus"
      >
        {t('setup.setup.whatSThisKey')}
      </RACButton>
    </Heading>
    <DisclosurePanel>
      <ul className="flex list-disc flex-col gap-1 px-3 pb-3 pl-7 type-body-sm text-ink-2">
        <li>{t('setup.setup.itSignsRoleChanges')}</li>
        <li>{t('setup.setup.eachAgentGetsIts')}</li>
        <li>{t('setup.setup.itSANostr')}</li>
      </ul>
    </DisclosurePanel>
  </Disclosure>
);

export const StepIdentity = () => {
  const q = useApi('identity.get');
  const create = useMutationApi('identity.ownerCreate', { invalidate: ['identity.get', 'system.status'] });
  const imp = useMutationApi('identity.ownerImport', { invalidate: ['identity.get', 'system.status'] });
  const [, update] = useSetupProgress();
  const go = useGoStep();
  const [replace, setReplace] = useState(false);
  const [choice, setChoice] = useState<IdChoice>('create');
  const [bunker, setBunker] = useState('');
  const [backup, setBackup] = useState<'offer' | 'later' | 'done'>('offer');
  const exp = useMutationApi('identity.ownerExport');
  const hasExt = typeof window !== 'undefined' && 'nostr' in window;
  const have = q.data?.npub && !replace;
  const bunkerNpub = npubFromBunker(bunker);
  const err = create.error ?? imp.error;

  const submit = async () => {
    try {
      if (choice === 'create') await create.mutateAsync({ replace: !!q.data?.npub });
      else if (choice === 'nip07') {
        const hex = await (
          window as unknown as { nostr: { getPublicKey(): Promise<string> } }
        ).nostr.getPublicKey();
        await imp.mutateAsync({ npub: npubEncode(hex) });
      } else if (bunkerNpub) await imp.mutateAsync({ npub: bunkerNpub });
      haptic('confirm');
      setReplace(false);
    } catch {
      haptic('error');
    }
  };

  return (
    <StepFrame
      step="identity"
      title={t('setup.setup.whoOwnsTheseAgents')}
      lede="Your owner key signs every change you make. Agents get their own keys."
      cli="beamhop init"
      primary={
        have
          ? {
              label: t('setup.setup.continuePhone'),
              onPress: () => {
                update((p) => markDone(p, 'identity'));
                go('phone');
              },
            }
          : {
              label: choice === 'create' ? t('setup.setup.createOwnerKey') : t('setup.setup.useThisKey'),
              icon: <Key size={16} weight="bold" aria-hidden="true" />,
              pending: create.isPending || imp.isPending,
              disabled: choice === 'nip46' && !bunkerNpub,
              onPress: () => void submit(),
            }
      }
    >
      {q.isError ? (
        <ErrorState
          title={t('setup.setup.couldnTReadYour')}
          details={q.error}
          onRetry={() => void q.refetch()}
        >
          {q.error.message}
        </ErrorState>
      ) : !q.data ? (
        <Skeleton variant="detail" count={2} label={t('setup.setup.loadingIdentity')} />
      ) : have ? (
        <>
          <div
            className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
            data-owner="ready"
          >
            <div className="flex items-center gap-3">
              <span className="grid size-7 shrink-0 place-items-center rounded-sm bg-ink text-bg">
                <Check size={16} weight="bold" aria-hidden="true" />
              </span>
              <span className="flex-1 type-title-3 text-ink">{t('setup.setup.ownerKeyReady')}</span>
              <Badge tone={q.data.ownerKeyHeld ? 'neutral' : 'outline'}>
                {q.data.ownerKeyHeld ? t('setup.setup.inOsKeychain') : t('setup.setup.yourSigner')}
              </Badge>
            </div>
            <div className="flex items-center gap-1">
              <code title={q.data.npub} className="min-w-0 flex-1 truncate type-meta text-ink">
                {middleTruncate(q.data.npub!, 30)}
              </code>
              <CopyButton value={q.data.npub!} label={t('setup.setup.copyOwnerNpub')} compact />
            </div>
          </div>
          <WhatsThisKey />
          {q.data.ownerKeyHeld && (
            <div className="flex flex-col gap-2">
              <p className="type-label text-ink">{t('setup.setup.backItUp')}</p>
              {backup === 'done' && exp.data ? (
                <div className="flex items-center gap-1 rounded-md bg-sunken py-0.5 pr-0.5 pl-3">
                  <code className="min-w-0 flex-1 truncate py-2 type-code text-ink">{exp.data.nsec}</code>
                  <CopyButton value={exp.data.nsec} label={t('setup.setup.copySecretKey')} compact />
                </div>
              ) : backup === 'later' ? (
                <p className="type-body-sm text-ink-2">{t('setup.setup.okSettingsIdentityReminds')}</p>
              ) : (
                <>
                  <p className="type-body-sm text-ink-2">{t('setup.setup.ifThisComputerDies')}</p>
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      isPending={exp.isPending}
                      onPress={() => void exp.mutateAsync({}).then(() => setBackup('done'))}
                    >
                      {t('setup.setup.exportBackupNow')}
                    </Button>
                    <Button variant="quiet" size="sm" onPress={() => setBackup('later')}>
                      {t('setup.setup.later')}
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}
          <Button variant="quiet" size="sm" className="-ml-3 self-start" onPress={() => setReplace(true)}>
            {t('setup.setup.useADifferentKey')}
          </Button>
        </>
      ) : (
        <>
          <RadioGroup
            label={t('setup.setup.ownerKey')}
            hideLabel
            variant="cards"
            value={choice}
            onChange={(v) => setChoice(v as IdChoice)}
          >
            <Radio value="create" description={t('setup.setup.storedInYourOs')}>
              {t('setup.setup.createANewOwner')}
            </Radio>
            {hasExt && (
              <Radio value="nip07" description={t('setup.setup.yourBrowserExtensionKeeps')}>
                {t('setup.setup.useMyNostrExtension')}
              </Radio>
            )}
            <Radio value="nip46" description={t('setup.setup.aRemoteSignerNsec')}>
              {t('setup.setup.connectABunkerNip')}
            </Radio>
          </RadioGroup>
          {choice === 'nip46' && (
            <TextField
              label={t('setup.setup.bunkerUrl')}
              mono
              value={bunker}
              onChange={setBunker}
              placeholder="bunker://…?relay=wss://…"
              description={t('setup.setup.pasteItFromYour')}
              isInvalid={bunker.length > 0 && !bunkerNpub}
              errorMessage={t('setup.setup.aBunkerUrlStarts')}
            />
          )}
          {err && <p className="type-body-sm text-stop-text">{err.message}</p>}
          {q.data.npub && (
            <Button variant="quiet" size="sm" className="-ml-3 self-start" onPress={() => setReplace(false)}>
              {t('setup.setup.keepMyCurrentKey')}
            </Button>
          )}
          <WhatsThisKey />
        </>
      )}
    </StepFrame>
  );
};

// ─────────── 04 Phone ───────────
export const StepPhone = () => {
  const [, update] = useSetupProgress();
  const go = useGoStep();
  const [paired, setPaired] = useState(false);
  return (
    <StepFrame
      step="phone"
      title={t('setup.setup.pairYourPhone')}
      lede="Approve requests and stop agents from your pocket. The phone gets its own key; your owner key stays here."
      cli="beamhop device pair"
      primary={{
        label: t('setup.setup.continueAgent'),
        disabled: !paired,
        onPress: () => {
          update((p) => markDone(p, 'phone'));
          go('agent');
        },
      }}
      skip={
        paired
          ? undefined
          : {
              label: t('setup.checks.skipForNow'),
              onPress: () => {
                update((p) => markSkipped(p, 'phone'));
                go('agent');
              },
            }
      }
    >
      <PairingPanel onPaired={() => setPaired(true)} />
      {!paired && <p className="type-body-sm text-ink-2">{t('setup.setup.noPhoneHandySkip')}</p>}
    </StepFrame>
  );
};

// ─────────── 05 Agent ───────────
const PRESET_NAME: Record<string, string> = {
  'personal-assistant': 'assistant',
  'code-reviewer': 'reviewer',
  'team-dev-bot': 'devbot',
  'public-qa': 'helpdesk',
};

export const freeName = (base: string, taken: string[]) => {
  if (!taken.includes(base)) return base;
  let i = 2;
  while (taken.includes(`${base}-${i}`)) i++;
  return `${base}-${i}`;
};

export const StepAgent = () => {
  const presets = useApi('agent.presets');
  const harnesses = useApi('harness.list');
  const agents = useApi('agent.list');
  const status = useApi('system.status');
  const create = useMutationApi('agent.create');
  const [progress, update] = useSetupProgress();
  const go = useGoStep();
  const taken = useMemo(() => (agents.data?.agents ?? []).map((a) => a.config.name), [agents.data]);
  const ready = (harnesses.data?.harnesses ?? []).filter((h) => h.status === 'ready');
  const [preset, setPreset] = useState('code-reviewer');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [harness, setHarness] = useState('');
  const [folder, setFolder] = useState('~/code/app');
  const [mode, setMode] = useState<'ro' | 'rw'>('ro');
  const existing = progress.agent
    ? agents.data?.agents.find((a) => a.config.name === progress.agent)
    : undefined;

  useEffect(() => {
    if (!nameTouched && agents.data) setName(freeName(PRESET_NAME[preset] ?? 'agent', taken));
  }, [preset, taken, nameTouched, agents.data]);
  useEffect(() => {
    if (!harness && ready[0]) setHarness(ready[0].id);
  }, [ready, harness]);

  const p = presets.data?.presets.find((x) => x.id === preset);
  const profile = ((p?.config.sandbox as { profile?: string } | undefined)?.profile ?? 'workspace') as string;
  const nameOk = AGENT_NAME_RE.test(name) && !taken.includes(name);

  const submit = async () => {
    try {
      const a = await create.mutateAsync({
        preset,
        config: { name, harness, mounts: folder ? [{ path: folder, mode }] : [] },
      });
      haptic('confirm');
      update((x) => markDone(x, 'agent', { agent: a.config.name }));
    } catch {
      haptic('error');
    }
  };

  if (existing)
    return (
      <StepFrame
        step="agent"
        title={t('setup.setup.isReady', { name: existing.config.name })}
        lede={t('setup.setup.ownKey')}
        primary={{ label: t('setup.setup.continueHello'), onPress: () => go('hello') }}
      >
        <div
          className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
          data-agent="created"
        >
          <div className="flex items-center gap-3">
            <LetterTile code={existing.config.harness.slice(0, 2).toUpperCase()} />
            <span className="flex-1 type-title-3 text-ink">{existing.config.name}</span>
            <Badge tone="go">created</Badge>
          </div>
          <MetaLine
            items={[
              existing.config.harness,
              existing.config.sandbox.profile,
              ...existing.config.mounts.map((m) => `${m.path} ${m.mode}`),
            ]}
          />
          {existing.config.identity.npub && (
            <div className="flex items-center gap-1">
              <code
                className="min-w-0 flex-1 truncate type-meta text-ink"
                title={existing.config.identity.npub}
              >
                {middleTruncate(existing.config.identity.npub, 30)}
              </code>
              <CopyButton
                value={existing.config.identity.npub}
                label={t('setup.setup.copyAgentNpub')}
                compact
              />
            </div>
          )}
          <div className="rounded-md bg-sunken p-3">
            <p className="type-micro text-ink-3">{t('setup.setup.nostrProfilePreview')}</p>
            <p className="mt-1 type-body text-ink">{existing.config.name}</p>
            <p className="type-body-sm text-ink-2">
              {t('setup.setup.operatedBy', {
                owner: status.data?.owner.npub
                  ? middleTruncate(status.data.owner.npub, 18)
                  : t('setup.setup.you'),
              })}
            </p>
          </div>
        </div>
      </StepFrame>
    );

  const reads = folder ? [folder] : [];
  return (
    <StepFrame
      step="agent"
      title={t('setup.setup.createYourFirstAgent')}
      lede="Pick what it's for; everything else is prefilled. You can change any of it later."
      cli={`beamhop agent add ${name || '<name>'} --preset ${preset} --harness ${harness || '<harness>'}${folder ? ` --mount ${folder}:${mode}` : ''}`}
      primary={{
        label: `Create ${name || 'agent'}`,
        icon: <Plus size={16} weight="bold" aria-hidden="true" />,
        disabled: !nameOk || !harness,
        pending: create.isPending,
        onPress: () => void submit(),
      }}
      skip={{
        label: 'Skip',
        onPress: () => {
          update((x) => markSkipped(x, 'agent'));
          go('next');
        },
      }}
    >
      {!presets.data || !harnesses.data ? (
        <Skeleton variant="detail" count={3} label={t('setup.setup.loadingPresets')} />
      ) : (
        <>
          <RadioGroup label={t('setup.setup.whatSItFor')} variant="cards" value={preset} onChange={setPreset}>
            {presets.data.presets.map((x) => (
              <Radio key={x.id} value={x.id} description={x.description}>
                {x.title}
              </Radio>
            ))}
          </RadioGroup>
          <TextField
            label={t('setup.setup.name')}
            mono
            value={name}
            onChange={(v) => {
              setNameTouched(true);
              setName(v.toLowerCase());
            }}
            description={t('setup.setup.alsoItsNostrProfile')}
            isInvalid={!!name && !nameOk}
            errorMessage={
              taken.includes(name) ? `${name} already exists.` : t('setup.setup.useLowercaseLettersDigits')
            }
          />
          {ready.length ? (
            <RadioGroup
              label={t('setup.setup.harness')}
              value={harness}
              onChange={setHarness}
              description={t('setup.setup.onlyHarnessesThatAre')}
            >
              {ready.map((h) => (
                <Radio
                  key={h.id}
                  value={h.id}
                  description={<span className="font-mono text-[12px]">{h.version}</span>}
                >
                  {h.displayName}
                </Radio>
              ))}
            </RadioGroup>
          ) : (
            <ErrorState title={t('setup.setup.noHarnessIsReady')}>
              {t('setup.setup.goBackOneStep')}
            </ErrorState>
          )}
          <div className="flex flex-col gap-2">
            <PathPicker label={t('setup.setup.folderItCanSee')} value={folder} onChange={setFolder} />
            <SegmentedControl
              label={t('setup.setup.folderAccess')}
              value={mode}
              onChange={setMode}
              options={[
                { id: 'ro', label: 'Read-only' },
                { id: 'rw', label: 'Read-write' },
              ]}
            />
            {mode === 'rw' && (
              <p className="type-body-sm text-ink-2">
                {t('setup.setup.gitBranch')}{' '}
                <span className="font-mono text-ink">beamhop/&lt;thread&gt;</span>.
              </p>
            )}
          </div>
          <section
            aria-labelledby="exposure"
            className="rounded-lg border border-line bg-sunken p-4"
            aria-live="polite"
          >
            <h2 id="exposure" className="type-micro text-ink-2">
              {t('setup.setup.whatCanReach', { name: name || t('setup.setup.it') })}
            </h2>
            <ul className="mt-2 flex flex-col gap-1.5 type-body-sm text-ink">
              <li>
                {reads.length ? (
                  <>
                    {mode === 'rw' ? t('setup.setup.canReadWrite') : t('setup.setup.canRead')}{' '}
                    <span className="font-mono">{folder}</span>
                  </>
                ) : (
                  t('setup.setup.seesNoFolders')
                )}
              </li>
              <li>
                {t('setup.setup.canReachApi', {
                  harness: ready.find((h) => h.id === harness)?.displayName ?? t('setup.setup.theHarness'),
                })}
              </li>
              <li>
                {t('setup.setup.sandboxProfile')} <span className="font-mono">{profile}</span>
              </li>
              <li className="text-ink-2">
                {t('setup.setup.never')} <span className="font-mono">~/.ssh</span>,{' '}
                <span className="font-mono">~/.aws</span>, {t('setup.setup.keychains')}
              </li>
            </ul>
          </section>
          {create.isError && (
            <ErrorState title={t('setup.setup.couldntCreate', { name })} details={create.error}>
              {create.error.message}
            </ErrorState>
          )}
        </>
      )}
    </StepFrame>
  );
};
