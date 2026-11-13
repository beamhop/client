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
    <Heading level={3}>
      <RACButton
        slot="trigger"
        className="flex min-h-11 w-full items-center px-3 text-left type-label text-ink outline-none data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus"
      >
        What's this key for?
      </RACButton>
    </Heading>
    <DisclosurePanel>
      <ul className="flex list-disc flex-col gap-1 px-3 pb-3 pl-7 type-body-sm text-ink-2">
        <li>
          It signs role changes, device pairings and control messages, so only you can change who can do what.
        </li>
        <li>Each agent gets its own key. A leaked agent key never lets anyone act as you.</li>
        <li>It's a Nostr key: the same identity works in any Nostr app you like.</li>
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
      title="Who owns these agents?"
      lede="Your owner key signs every change you make. Agents get their own keys."
      cli="beamhop identity create"
      primary={
        have
          ? {
              label: 'Continue · Phone',
              onPress: () => {
                update((p) => markDone(p, 'identity'));
                go('phone');
              },
            }
          : {
              label: choice === 'create' ? 'Create owner key' : 'Use this key',
              icon: <Key size={16} weight="bold" aria-hidden="true" />,
              pending: create.isPending || imp.isPending,
              disabled: choice === 'nip46' && !bunkerNpub,
              onPress: () => void submit(),
            }
      }
    >
      {q.isError ? (
        <ErrorState title="Couldn't read your identity." details={q.error} onRetry={() => void q.refetch()}>
          {q.error.message}
        </ErrorState>
      ) : !q.data ? (
        <Skeleton variant="detail" count={2} label="Loading identity" />
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
              <span className="flex-1 type-title-3 text-ink">Owner key ready</span>
              <Badge tone={q.data.ownerKeyHeld ? 'neutral' : 'outline'}>
                {q.data.ownerKeyHeld ? 'in OS keychain' : 'your signer'}
              </Badge>
            </div>
            <div className="flex items-center gap-1">
              <code title={q.data.npub} className="min-w-0 flex-1 truncate type-meta text-ink">
                {middleTruncate(q.data.npub!, 30)}
              </code>
              <CopyButton value={q.data.npub!} label="Copy owner npub" compact />
            </div>
          </div>
          <WhatsThisKey />
          {q.data.ownerKeyHeld && (
            <div className="flex flex-col gap-2">
              <p className="type-label text-ink">Back it up?</p>
              {backup === 'done' && exp.data ? (
                <div className="flex items-center gap-1 rounded-md bg-sunken py-0.5 pr-0.5 pl-3">
                  <code className="min-w-0 flex-1 truncate py-2 type-code text-ink">{exp.data.nsec}</code>
                  <CopyButton value={exp.data.nsec} label="Copy secret key" compact />
                </div>
              ) : backup === 'later' ? (
                <p className="type-body-sm text-ink-2">
                  OK. Settings → Identity reminds you until it's done.
                </p>
              ) : (
                <>
                  <p className="type-body-sm text-ink-2">
                    If this computer dies, the backup is how you prove you own your agents. Put it in a
                    password manager.
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      isPending={exp.isPending}
                      onPress={() => void exp.mutateAsync({}).then(() => setBackup('done'))}
                    >
                      Export backup now
                    </Button>
                    <Button variant="quiet" size="sm" onPress={() => setBackup('later')}>
                      Later
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}
          <Button variant="quiet" size="sm" className="-ml-3 self-start" onPress={() => setReplace(true)}>
            Use a different key…
          </Button>
        </>
      ) : (
        <>
          <RadioGroup
            label="Owner key"
            hideLabel
            variant="cards"
            value={choice}
            onChange={(v) => setChoice(v as IdChoice)}
          >
            <Radio value="create" description="Stored in your OS keychain. You can export it later.">
              Create a new owner key
            </Radio>
            {hasExt && (
              <Radio value="nip07" description="Your browser extension keeps the key and signs for you.">
                Use my Nostr extension (NIP-07)
              </Radio>
            )}
            <Radio value="nip46" description="A remote signer (nsec.app, Amber…) keeps the key.">
              Connect a bunker (NIP-46)
            </Radio>
          </RadioGroup>
          {choice === 'nip46' && (
            <TextField
              label="Bunker URL"
              mono
              value={bunker}
              onChange={setBunker}
              placeholder="bunker://…?relay=wss://…"
              description="Paste it from your signer app."
              isInvalid={bunker.length > 0 && !bunkerNpub}
              errorMessage="A bunker URL starts with bunker:// followed by a 64-character key."
            />
          )}
          {err && <p className="type-body-sm text-stop-text">{err.message}</p>}
          {q.data.npub && (
            <Button variant="quiet" size="sm" className="-ml-3 self-start" onPress={() => setReplace(false)}>
              Keep my current key
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
      title="Pair your phone"
      lede="Approve requests and stop agents from your pocket. The phone gets its own key; your owner key stays here."
      cli="beamhop pair-device"
      primary={{
        label: 'Continue · Agent',
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
              label: 'Skip for now',
              onPress: () => {
                update((p) => markSkipped(p, 'phone'));
                go('agent');
              },
            }
      }
    >
      <PairingPanel onPaired={() => setPaired(true)} />
      {!paired && (
        <p className="type-body-sm text-ink-2">
          No phone handy? Skip. In step 06 you can reply from any Nostr app instead.
        </p>
      )}
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
        title={`${existing.config.name} is ready`}
        lede="It has its own Nostr key and a profile that says who operates it."
        primary={{ label: 'Continue · Hello', onPress: () => go('hello') }}
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
              <CopyButton value={existing.config.identity.npub} label="Copy agent npub" compact />
            </div>
          )}
          <div className="rounded-md bg-sunken p-3">
            <p className="type-micro text-ink-3">Nostr profile preview</p>
            <p className="mt-1 type-body text-ink">{existing.config.name}</p>
            <p className="type-body-sm text-ink-2">
              AI agent operated by{' '}
              {status.data?.owner.npub ? middleTruncate(status.data.owner.npub, 18) : 'you'}
            </p>
          </div>
        </div>
      </StepFrame>
    );

  const reads = folder ? [folder] : [];
  return (
    <StepFrame
      step="agent"
      title="Create your first agent"
      lede="Pick what it's for; everything else is prefilled. You can change any of it later."
      cli={`beamhop agent create ${name || '<name>'} --preset ${preset} --harness ${harness || '<harness>'}${folder ? ` --mount ${folder}:${mode}` : ''}`}
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
        <Skeleton variant="detail" count={3} label="Loading presets" />
      ) : (
        <>
          <RadioGroup label="What's it for?" variant="cards" value={preset} onChange={setPreset}>
            {presets.data.presets.map((x) => (
              <Radio key={x.id} value={x.id} description={x.description}>
                {x.title}
              </Radio>
            ))}
          </RadioGroup>
          <TextField
            label="Name"
            mono
            value={name}
            onChange={(v) => {
              setNameTouched(true);
              setName(v.toLowerCase());
            }}
            description="Also its Nostr profile name. Lowercase letters, digits, dashes."
            isInvalid={!!name && !nameOk}
            errorMessage={
              taken.includes(name) ? `${name} already exists.` : 'Use lowercase letters, digits and dashes.'
            }
          />
          {ready.length ? (
            <RadioGroup
              label="Harness"
              value={harness}
              onChange={setHarness}
              description="Only harnesses that are ready."
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
            <ErrorState title="No harness is ready.">
              Go back one step and log in to one, or install one.
            </ErrorState>
          )}
          <div className="flex flex-col gap-2">
            <PathPicker label="Folder it can see" value={folder} onChange={setFolder} />
            <SegmentedControl
              label="Folder access"
              value={mode}
              onChange={setMode}
              options={[
                { id: 'ro', label: 'Read-only' },
                { id: 'rw', label: 'Read-write' },
              ]}
            />
            {mode === 'rw' && (
              <p className="type-body-sm text-ink-2">
                If it's a git repo, each session gets its own branch{' '}
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
              What {name || 'it'} can reach
            </h2>
            <ul className="mt-2 flex flex-col gap-1.5 type-body-sm text-ink">
              <li>
                {reads.length ? (
                  <>
                    Can {mode === 'rw' ? 'read and write' : 'read'}{' '}
                    <span className="font-mono">{folder}</span>
                  </>
                ) : (
                  'Sees no folders'
                )}
              </li>
              <li>
                Can reach the {ready.find((h) => h.id === harness)?.displayName ?? 'harness'} API, nothing
                else until you allow it
              </li>
              <li>
                Sandbox profile: <span className="font-mono">{profile}</span>
              </li>
              <li className="text-ink-2">
                Never <span className="font-mono">~/.ssh</span>, <span className="font-mono">~/.aws</span>,
                keychains
              </li>
            </ul>
          </section>
          {create.isError && (
            <ErrorState title={`Couldn't create ${name}.`} details={create.error}>
              {create.error.message}
            </ErrorState>
          )}
        </>
      )}
    </StepFrame>
  );
};
