/**
 * Per-agent sandbox editor (SCREENS §7, JOURNEYS §5). Everything edits a local draft; nothing reaches the
 * daemon until the review sheet (plain-language diff + YAML diff) is confirmed. Widening is deliberate
 * (primary reads "Widen access"), tightening is one "Save". Desktop (container ≥ 60rem): editor left,
 * sticky REACH + FINDINGS right; compact: REACH first, then findings, then the editor sections.
 *
 * Research used (beyond JOURNEYS §5): NN/g on permission requests — say why, plain language, narrowest
 * scope (https://www.nngroup.com/articles/permission-requests/); Android runtime-permission comprehension
 * studies — users misread scopes, so every rule is restated as a sentence
 * (https://usenix.org/system/files/sec21-shen-bingyu.pdf); Little Snitch rule anatomy, deny-wins
 * (https://help.obdev.at/littlesnitch5/ref-rule-properties); 1Password Watchtower — specific findings with
 * per-item fixes, not a score (https://support.1password.com/watchtower/).
 */
import type { AgentView, PolicySuggestion, SandboxPolicy } from '@beamhop/core';
import { FolderSimple, GitBranch, Info, LockSimple, Plus, Trash, WarningCircle } from '@phosphor-icons/react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { useApi, useCall, useMutationApi } from '../../api/index.ts';
import { t } from '../../i18n/index.ts';
import { middleTruncate, when } from '../../lib/format.ts';
import { useNow } from '../../lib/useNow.ts';
import { Screen } from '../../shell/Screen.tsx';
import { Button, IconButton, TextLink } from '../../ui/Button.tsx';
import { Card } from '../../ui/Card.tsx';
import { ChipGroup, ChipInput } from '../../ui/Chip.tsx';
import { Checkbox, Radio, RadioGroup, SegmentedControl, Select, Switch, Tabs } from '../../ui/Choice.tsx';
import { CliStrip } from '../../ui/CliStrip.tsx';
import { DiffView } from '../../ui/CodeBlock.tsx';
import { NumberField } from '../../ui/Field.tsx';
import { MetaLine } from '../../ui/Meta.tsx';
import { demoListDir, PathPicker } from '../../ui/PathPicker.tsx';
import { Sheet } from '../../ui/Sheet.tsx';
import { Banner, ErrorState, Skeleton, useDelayedLoading } from '../../ui/States.tsx';
import { useToast } from '../../ui/Toast.tsx';
import { type Decision, LearningTriage } from './LearningTriage.tsx';
import {
  acceptSuggestion,
  applyProfile,
  type Change,
  clone,
  describeChanges,
  type Finding,
  findingsFor,
  foldersOf,
  isWidening,
  METADATA_IP,
  type Mode,
  PRIVATE_RANGES,
  PROFILES,
  type Profile,
  parseAllowHost,
  parseEnvName,
  parseFolder,
  samePolicy,
  toYaml,
  unifiedDiff,
  userDenies,
  withFolders,
} from './model.ts';
import { ChangeList, FindingList, LockedStrip, Mono, ReachSummary, Section } from './parts.tsx';

interface Snapshot {
  profile: Profile;
  policy: SandboxPolicy;
}

const sameSnap = (a: Snapshot, b: Snapshot) => a.profile === b.profile && samePolicy(a.policy, b.policy);
const scrollTo = (id: string) =>
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

export const AgentPolicyScreen = ({ name }: { name: string }) => {
  const agent = useApi('agent.get', { name });
  const pol = useApi('policy.get', { name });
  const showSkeleton = useDelayedLoading(pol.isPending || agent.isPending);
  const frame = (body: React.ReactNode, footer?: React.ReactNode) => (
    <Screen
      title={name}
      back={{ href: '/policy', label: t('nav.policy') }}
      pane="detail"
      maxWidth="none"
      crumbs={[{ label: t('nav.policy'), href: '/policy' }, { label: name }]}
      slug={
        agent.data && (
          <MetaLine
            items={[
              t('policy.slug.sandbox'),
              pol.data?.profile ?? '',
              agent.data.location.kind === 'cloud' ? (agent.data.location.provider ?? 'cloud') : 'local',
            ]}
          />
        )
      }
      footer={footer}
    >
      {body}
    </Screen>
  );
  if (pol.error || agent.error)
    return frame(
      <ErrorState
        title={t('policy.error.title', { agent: name })}
        details={pol.error ?? agent.error}
        onRetry={() => {
          void pol.refetch();
          void agent.refetch();
        }}
      >
        {(pol.error ?? agent.error)?.message}
      </ErrorState>,
    );
  if (!pol.data || !agent.data)
    return frame(showSkeleton ? <Skeleton variant="detail" label={t('policy.loading')} /> : null);
  return (
    <Editor
      key={name}
      name={name}
      agent={agent.data}
      server={{ profile: pol.data.profile as Profile, policy: pol.data.effective }}
      frame={frame}
    />
  );
};

const Editor = ({
  name,
  agent,
  server,
  frame,
}: {
  name: string;
  agent: AgentView;
  server: Snapshot;
  frame: (body: React.ReactNode, footer?: React.ReactNode) => React.ReactNode;
}) => {
  const toast = useToast();
  const call = useCall();
  const navigate = useNavigate();
  const now = useNow(30_000);
  const search = useSearch({ strict: false }) as { allowHost?: string };
  const sugg = useApi('policy.suggestions', { name });
  const secrets = useApi('secret.list');
  const sessions = useApi('session.list', { agent: name });
  const set = useMutationApi('policy.set', { invalidate: ['agent.list'] });

  const [base, setBase] = useState<Snapshot>(server);
  const [draft, setDraft] = useState<Snapshot>(server);
  const [conflict, setConflict] = useState<Snapshot | null>(null);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [prefill, setPrefill] = useState<string | null>(null);
  const [profileAsk, setProfileAsk] = useState<Profile | null>(null);
  const [review, setReview] = useState(false);
  const [gitPaths, setGitPaths] = useState<Set<string>>();

  const dirty = !sameSnap(base, draft) || Object.keys(decisions).length > 0;

  // Server changed while we were editing (another device, CLI, YAML on disk): don't clobber.
  // biome-ignore lint/correctness/useExhaustiveDependencies: react to server snapshots only
  useEffect(() => {
    if (sameSnap(server, base)) return;
    if (!dirty || sameSnap(server, draft)) {
      setBase(server);
      if (!dirty) setDraft(server);
      setConflict(null);
    } else setConflict(server);
  }, [server.profile, JSON.stringify(server.policy)]);

  // "Allow…" from Audit: stage the host in the draft, the person still reviews and saves.
  // biome-ignore lint/correctness/useExhaustiveDependencies: run once per incoming host
  useEffect(() => {
    const h = search.allowHost;
    if (!h) return;
    const r = parseAllowHost(h, draft.policy.net.denyPrivateIps);
    if ('value' in r && !draft.policy.net.allow.includes(r.value)) {
      setDraft((d) => {
        const p = clone(d.policy);
        p.net.allow.push(r.value);
        return { ...d, policy: p };
      });
      setPrefill(r.value);
    } else if ('error' in r) toast.show({ message: r.error, tone: 'error' });
    void navigate({ to: '/policy/$profile', params: { profile: name }, search: {}, replace: true });
  }, [search.allowHost]);

  const folders = foldersOf(draft.policy);
  const folderKey = folders.map((f) => f.path).join('|');
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the folder list
  useEffect(() => {
    let live = true;
    const parents = [...new Set(folders.map((f) => f.path.slice(0, f.path.lastIndexOf('/')) || '~'))];
    void Promise.all(parents.map((p) => demoListDir(p))).then((lists) => {
      if (live) setGitPaths(new Set(lists.flat().filter((e) => e.git).map((e) => e.path)));
    });
    return () => {
      live = false;
    };
  }, [folderKey]);

  const allSugg = sugg.data?.suggestions ?? [];
  const pending = allSugg.filter((s) => !decisions[s.id]);
  const decided = allSugg.filter((s) => decisions[s.id]).map((s) => ({ s, d: decisions[s.id]! }));
  const findings = useMemo(
    () => findingsFor(draft.policy, { gitPaths, pendingSuggestions: pending.length }),
    [draft.policy, gitPaths, pending.length],
  );
  const changes: Change[] = useMemo(() => {
    const cs = describeChanges(name, base, draft);
    for (const { d } of decided)
      if (!d.accept)
        cs.push({
          kind: 'neutral',
          text: d.broker
            ? t('policy.change.broker', { value: d.value })
            : t('policy.change.keepBlocked', { value: d.value }),
          value: d.value,
        });
    return cs;
  }, [name, base, draft, decided]);
  const widen = isWidening(changes);
  const running = (sessions.data?.sessions ?? []).filter((s) => s.status === 'running');

  const update = (fn: (p: SandboxPolicy) => SandboxPolicy) => setDraft((d) => ({ ...d, policy: fn(clone(d.policy)) }));
  const fix = (f: Finding) => {
    if (!f.fix) return;
    update(f.fix.apply);
    toast.show({ message: t('policy.findings.staged', { fix: f.fix.label }) });
  };
  const decide = (s: PolicySuggestion, d: Decision) => {
    setDecisions((x) => ({ ...x, [s.id]: d }));
    if (d.accept) update((p) => acceptSuggestion(p, s, d.value));
  };
  const undoDecision = (s: PolicySuggestion) => {
    const d = decisions[s.id];
    setDecisions(({ [s.id]: _, ...rest }) => rest);
    if (d?.accept)
      update((p) =>
        s.kind === 'net.allow'
          ? { ...p, net: { ...p.net, allow: p.net.allow.filter((h) => h !== d.value) } }
          : withFolders(
              p,
              foldersOf(p).filter((f) => f.path !== d.value),
            ),
      );
  };
  const discard = () => {
    setDraft(base);
    setDecisions({});
    setPrefill(null);
  };

  const save = async (restart: boolean) => {
    try {
      for (const [id, d] of Object.entries(decisions)) await call('policy.applySuggestion', { id, accept: d.accept });
      await set.mutateAsync({ name, profile: draft.profile, policy: draft.policy });
      if (restart) for (const s of running) await call('session.stop', { id: s.id });
      setBase(draft);
      setDecisions({});
      setPrefill(null);
      setConflict(null);
      setReview(false);
      toast.show({
        message: widen ? t('policy.saved.widened', { agent: name }) : t('policy.saved.ok', { agent: name }),
        tone: 'success',
      });
    } catch (e) {
      toast.show({ message: (e as Error).message, tone: 'error' });
    }
  };

  const reachAside = (
    <aside
      aria-label={t('policy.aside')}
      className="flex flex-col gap-8 @min-[60rem]:sticky @min-[60rem]:top-4 @min-[60rem]:col-start-2 @min-[60rem]:row-start-1 @min-[60rem]:self-start"
    >
      <Section id="reach" title={t('policy.reach.title')}>
        <ReachSummary agent={name} policy={draft.policy} />
        {dirty && <p className="mt-2 type-meta text-caution-text">{t('policy.reach.draftNote')}</p>}
      </Section>
      <Section id="findings" title={t('policy.findings.title', { count: findings.length })}>
        <FindingList findings={findings} onFix={fix} />
      </Section>
    </aside>
  );

  const body = (
    <div className="relative @container">
      {conflict && (
        <Banner
          tone="caution"
          className="mb-4 -mx-gutter expanded:mx-0 expanded:rounded-md expanded:border"
          action={
            <div className="flex gap-1">
              <Button
                variant="quiet"
                size="sm"
                onPress={() => {
                  setBase(conflict);
                  setConflict(null);
                }}
              >
                {t('policy.conflict.keep')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onPress={() => {
                  setBase(conflict);
                  setDraft(conflict);
                  setDecisions({});
                  setConflict(null);
                }}
              >
                {t('policy.conflict.theirs')}
              </Button>
            </div>
          }
        >
          {t('policy.conflict.body', { agent: name, time: when(new Date()) })}
        </Banner>
      )}
      {prefill && (
        <Banner tone="info" className="mb-4 -mx-gutter expanded:mx-0 expanded:rounded-md expanded:border">
          {t('policy.prefill', { host: prefill })}
        </Banner>
      )}
      <div className="grid grid-cols-1 gap-8 @min-[60rem]:grid-cols-[minmax(0,1fr)_22rem] @min-[60rem]:gap-10">
        {reachAside}
        <div className="flex min-w-0 flex-col gap-8 @min-[60rem]:col-start-1 @min-[60rem]:row-start-1">
          <RulesIndex
            items={[
              ['learning', t('policy.learn.title'), draft.policy.learning ? t('policy.index.on') : t('policy.index.off')],
              ['profile', t('policy.profile.title'), draft.profile],
              ['files', t('policy.files.title'), String(folders.length)],
              ['network', t('policy.net.title'), t('policy.list.hosts', { count: draft.policy.net.allow.length })],
              ['secrets', t('policy.index.keys'), String(draft.policy.secrets.length)],
              ['env', t('policy.env.title'), String(draft.policy.env.passthrough.length)],
              ['limits', t('policy.limits.title'), `${draft.policy.proc.maxSessionMinutes} min`],
              ['people', t('policy.index.people'), String(agent.config.memberships.length + Object.keys(agent.config.grants).length)],
            ]}
          />
          <LearningSection
            name={name}
            policy={draft.policy}
            onToggle={(v) => update((p) => ({ ...p, learning: v }))}
            pending={pending}
            decided={decided}
            onDecide={decide}
            onUndo={undoDecision}
            now={now}
          />
          <ProfileSection
            name={name}
            value={draft.profile}
            onAsk={(p) => (p === draft.profile ? undefined : setProfileAsk(p))}
          />
          <FoldersSection
            name={name}
            policy={draft.policy}
            gitPaths={gitPaths}
            onChange={(fs) => update((p) => withFolders(p, fs))}
            onDeny={(deny) => update((p) => ({ ...p, fs: { ...p.fs, deny } }))}
          />
          <NetworkSection
            policy={draft.policy}
            pending={pending.filter((s) => s.kind === 'net.allow')}
            onChange={(net) => update((p) => ({ ...p, net }))}
          />
          <SecretsSection
            name={name}
            policy={draft.policy}
            available={(secrets.data?.secrets ?? []).map((s) => s.name).filter((n) => !n.startsWith('channel/'))}
            backend={secrets.data?.backend}
            onChange={(s) => update((p) => ({ ...p, secrets: s }))}
          />
          <Section id="env" title={t('policy.env.title')} description={t('policy.env.desc')}>
            <ChipInput
              label={t('policy.env.label')}
              hideLabel
              inputLabel={t('policy.env.add')}
              placeholder={t('policy.env.placeholder')}
              items={draft.policy.env.passthrough.map((e) => ({ id: e, label: e }))}
              parse={parseEnvName}
              onAdd={(v) => update((p) => ({ ...p, env: { passthrough: [...p.env.passthrough, v] } }))}
              onRemove={(id) =>
                update((p) => ({ ...p, env: { passthrough: p.env.passthrough.filter((x) => x !== id) } }))
              }
            />
          </Section>
          <Section id="limits" title={t('policy.limits.title')}>
            <NumberField
              label={t('policy.limits.session')}
              description={t('policy.limits.sessionDesc')}
              unit="min"
              minValue={5}
              maxValue={1440}
              step={5}
              value={draft.policy.proc.maxSessionMinutes}
              onChange={(v) =>
                Number.isFinite(v) && update((p) => ({ ...p, proc: { maxSessionMinutes: Math.round(v) } }))
              }
              className="max-w-xs"
            />
          </Section>
          <PeopleSection agent={agent} />
          <CliStrip command={`beamhop policy edit ${name}   # ~/.beamhop/agents/${name}.yaml`} />
        </div>
      </div>
      <ProfileSheet
        name={name}
        agent={agent}
        current={draft}
        target={profileAsk}
        onClose={() => setProfileAsk(null)}
        onApply={(next) => {
          setDraft(next);
          setProfileAsk(null);
        }}
      />
      <ReviewSheet
        isOpen={review}
        onOpenChange={setReview}
        name={name}
        changes={changes}
        widen={widen}
        yaml={unifiedDiff(
          `~/.beamhop/agents/${name}.yaml`,
          toYaml(base.profile, base.policy),
          toYaml(draft.profile, draft.policy),
        )}
        running={running.map((s) => ({ id: s.id, title: s.title }))}
        pending={set.isPending}
        onSave={save}
      />
    </div>
  );

  const footer = dirty ? (
    <div className="flex items-center gap-2 px-gutter py-2.5 expanded:px-8">
      <p className="min-w-0 flex-1 type-body-sm text-ink" aria-live="polite">
        <span className="font-semibold">{t('policy.save.count', { count: changes.length })}</span>
        {widen && (
          <span className="ml-2 inline-flex items-center gap-1 type-meta text-caution-text">
            <WarningCircle size={14} weight="bold" aria-hidden="true" /> {t('policy.save.widens')}
          </span>
        )}
      </p>
      <Button variant="quiet" size="sm" onPress={discard}>
        {t('policy.save.discard')}
      </Button>
      <Button variant="primary" onPress={() => setReview(true)}>
        {t('policy.save.review')}
      </Button>
    </div>
  ) : undefined;

  return <>{frame(body, footer)}</>;
};

// ─────────── Index ───────────
/** Jump list of the editor sections with their current value (SCREENS §7 "FILES › NETWORK › …"). */
const RulesIndex = ({ items }: { items: Array<[string, string, string]> }) => (
  <nav aria-label={t('policy.index.label')}>
    <ul className="grid grid-cols-2 gap-x-4 border-y border-line @min-[36rem]:grid-cols-4">
      {items.map(([id, label, value]) => (
        <li key={id} className="border-b border-line">
          <button
            type="button"
            onClick={() => {
              scrollTo(id);
              document.getElementById(`${id}-h`)?.focus({ preventScroll: true });
            }}
            className="flex min-h-12 w-full flex-col justify-center py-1.5 text-left outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-focus"
          >
            <span className="type-micro text-ink-2">{label}</span>
            <span className="truncate type-meta text-ink">{value}</span>
          </button>
        </li>
      ))}
    </ul>
  </nav>
);

// ─────────── Learning ───────────
const LearningSection = ({
  name,
  policy,
  onToggle,
  pending,
  decided,
  onDecide,
  onUndo,
  now,
}: {
  name: string;
  policy: SandboxPolicy;
  onToggle: (v: boolean) => void;
  pending: PolicySuggestion[];
  decided: Array<{ s: PolicySuggestion; d: Decision }>;
  onDecide: (s: PolicySuggestion, d: Decision) => void;
  onUndo: (s: PolicySuggestion) => void;
  now: number;
}) => (
  <Section
    id="learning"
    title={t('policy.learn.title')}
    aside={
      pending.length > 0 ? (
        <span className="type-meta text-caution-text">{t('policy.learn.count', { count: pending.length })}</span>
      ) : undefined
    }
  >
    <Switch isSelected={policy.learning} onChange={onToggle} description={t('policy.learn.desc', { agent: name })}>
      {t('policy.learn.toggle')}
    </Switch>
    {(policy.learning || pending.length > 0 || decided.length > 0) && (
      <div className="mt-4">
        {pending.length > 0 && (
          <p className="mb-3 type-body-sm text-ink">
            <span className="font-semibold">{t('policy.learn.headline', { count: pending.length })}</span>{' '}
            {t('policy.learn.headlineMore', { agent: name })}
          </p>
        )}
        <LearningTriage
          agent={name}
          pending={pending}
          decided={decided}
          onDecide={onDecide}
          onUndo={onUndo}
          onBroker={() => scrollTo('secrets')}
          now={now}
        />
      </div>
    )}
  </Section>
);

// ─────────── Profile ───────────
const ProfileSection = ({
  name,
  value,
  onAsk,
}: {
  name: string;
  value: Profile;
  onAsk: (p: Profile) => void;
}) => (
  <Section id="profile" title={t('policy.profile.title')} aside={<TextLink href={`/policy/${value}`}>{t('policy.profile.more')}</TextLink>}>
    <RadioGroup
      label={t('policy.profile.label', { agent: name })}
      hideLabel
      variant="cards"
      value={value}
      onChange={(v) => onAsk(v as Profile)}
    >
      {PROFILES.map((p) => (
        <Radio key={p} value={p} description={t(`policy.profile.${p}.blurb`)}>
          <span className="font-mono text-[15px] font-medium">{p}</span>
        </Radio>
      ))}
    </RadioGroup>
  </Section>
);

const ProfileSheet = ({
  name,
  agent,
  current,
  target,
  onClose,
  onApply,
}: {
  name: string;
  agent: AgentView;
  current: Snapshot;
  target: Profile | null;
  onClose: () => void;
  onApply: (s: Snapshot) => void;
}) => {
  const next = target ? { profile: target, policy: applyProfile(target, current.policy, agent.config.mounts) } : null;
  const changes = next ? describeChanges(name, current, next).filter((c) => !c.text.startsWith('Profile')) : [];
  return (
    <Sheet
      isOpen={!!target}
      onOpenChange={(o) => !o && onClose()}
      title={target ? t('policy.profile.askTitle', { agent: name, profile: target }) : ''}
      subtitle={target ? t(`policy.profile.${target}.blurb`) : undefined}
      focusTitle
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onPress={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onPress={() => next && onApply(next)}>
            {target ? t('policy.profile.use', { profile: target }) : ''}
          </Button>
        </div>
      }
    >
      {changes.length ? (
        <>
          <p className="mb-2 type-body-sm text-ink-2">{t('policy.profile.consequences')}</p>
          <ChangeList changes={changes} />
        </>
      ) : (
        <p className="type-body-sm text-ink-2">{t('policy.profile.noChange', { agent: name })}</p>
      )}
      <p className="mt-4 type-meta text-ink-2">{t('policy.profile.notYet')}</p>
    </Sheet>
  );
};

// ─────────── Folders ───────────
const FoldersSection = ({
  name,
  policy,
  gitPaths,
  onChange,
  onDeny,
}: {
  name: string;
  policy: SandboxPolicy;
  gitPaths?: Set<string>;
  onChange: (fs: ReturnType<typeof foldersOf>) => void;
  onDeny: (deny: string[]) => void;
}) => {
  const folders = foldersOf(policy);
  const [path, setPath] = useState('');
  const [mode, setMode] = useState<Mode>('ro');
  const [error, setError] = useState<string>();
  const add = () => {
    const r = parseFolder(path);
    if ('error' in r) return setError(r.error);
    if (folders.some((f) => f.path === r.value)) return setError(t('policy.files.dup', { path: r.value }));
    onChange([...folders, { path: r.value, mode }]);
    setPath('');
    setError(undefined);
  };
  const denies = userDenies(policy);
  return (
    <>
      <Section id="files" title={t('policy.files.title')} description={t('policy.files.desc', { agent: name })}>
        {folders.length === 0 ? (
          <p className="mb-3 type-body-sm text-ink-2">{t('policy.files.none', { agent: name })}</p>
        ) : (
          <ul className="mb-4 flex flex-col rounded-lg border border-line bg-surface">
            {folders.map((f) => (
              <li
                key={f.path}
                className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-3 py-2.5 last:border-b-0"
              >
                <FolderSimple size={18} aria-hidden="true" className="shrink-0 text-ink-2" />
                <span className="min-w-0 flex-1 basis-32">
                  <span className="block type-meta text-ink [overflow-wrap:anywhere]">{f.path}</span>
                  <span className="flex items-center gap-1 type-meta text-ink-2">
                    {gitPaths?.has(f.path) ? (
                      <>
                        <GitBranch size={12} aria-hidden="true" /> {t('policy.files.git')}
                      </>
                    ) : f.mode === 'rw' ? (
                      t('policy.files.lockNote')
                    ) : (
                      t('policy.files.roNote')
                    )}
                  </span>
                </span>
                <div className="flex items-center gap-1">
                  <SegmentedControl<Mode>
                    label={t('policy.files.modeLabel', { path: f.path })}
                    size="sm"
                    className="[&>*]:flex-auto"
                    value={f.mode}
                    onChange={(m) => onChange(folders.map((x) => (x.path === f.path ? { ...x, mode: m } : x)))}
                    options={[
                      { id: 'ro', label: t('policy.files.ro') },
                      { id: 'rw', label: t('policy.files.rw') },
                    ]}
                  />
                  <IconButton
                    label={t('policy.files.remove', { path: f.path })}
                    icon={<Trash size={18} aria-hidden="true" />}
                    onPress={() => onChange(folders.filter((x) => x.path !== f.path))}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-col gap-2 rounded-lg border border-dashed border-line-strong p-3">
          <PathPicker
            label={t('policy.files.add')}
            value={path}
            onChange={(v) => {
              setPath(v);
              setError(undefined);
            }}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <SegmentedControl<Mode>
              label={t('policy.files.newMode')}
              size="sm"
              className="[&>*]:flex-auto"
              value={mode}
              onChange={setMode}
              options={[
                { id: 'ro', label: t('policy.files.ro') },
                { id: 'rw', label: t('policy.files.rw') },
              ]}
            />
            <Button variant="secondary" size="sm" icon={<Plus size={16} aria-hidden="true" />} onPress={add}>
              {t('policy.files.addButton')}
            </Button>
          </div>
          {error && (
            <p role="alert" className="type-body-sm text-stop-text">
              {error}
            </p>
          )}
        </div>
      </Section>
      <Section id="never" title={t('policy.never.title')} description={t('policy.never.desc')}>
        <LockedPaths />
        <div className="mt-4">
          <ChipInput
            label={t('policy.never.extra')}
            inputLabel={t('policy.never.add')}
            placeholder={t('policy.never.placeholder')}
            items={denies.map((d) => ({ id: d, label: d, variant: 'blocked' as const }))}
            emptyText={t('policy.never.extraNone')}
            parse={(raw) => {
              const s = raw.trim().replace(/\/+$/, '');
              if (!s.startsWith('~') && !s.startsWith('/')) return { error: t('policy.never.bad') };
              return { value: s };
            }}
            onAdd={(v) => onDeny([...policy.fs.deny, v])}
            onRemove={(id) => onDeny(policy.fs.deny.filter((x) => x !== id))}
          />
        </div>
      </Section>
    </>
  );
};

const LOCKED_ALL = [
  '~/.ssh', '~/.aws', '~/.gnupg', '~/.config/gh', '~/.config/gcloud', '~/.azure', '~/.kube',
  '~/.docker/config.json', '~/.netrc', '~/.npmrc', '~/.beamhop', '~/Library/Keychains',
];
const LockedPaths = () => {
  const [all, setAll] = useState(false);
  const shown = all
    ? [...LOCKED_ALL, t('policy.reach.browsers')]
    : ['~/.ssh', '~/.aws', '~/.config/gh', '~/.gnupg', '~/Library/Keychains', t('policy.reach.browsers')];
  return (
    <div className="flex flex-col gap-1">
      <LockedStrip label={t('policy.never.locked')} items={shown} />
      <Button variant="quiet" size="sm" className="-ml-3 self-start" onPress={() => setAll((x) => !x)} aria-expanded={all}>
        {all ? t('policy.never.fewer') : t('policy.never.all')}
      </Button>
    </div>
  );
};

// ─────────── Network ───────────
const NetworkSection = ({
  policy,
  pending,
  onChange,
}: {
  policy: SandboxPolicy;
  pending: PolicySuggestion[];
  onChange: (net: SandboxPolicy['net']) => void;
}) => {
  const net = policy.net;
  return (
    <Section id="network" title={t('policy.net.title')} description={t('policy.net.desc')}>
      <ChipInput
        label={t('policy.net.allowed', { count: net.allow.length })}
        inputLabel={t('policy.net.add')}
        placeholder={t('policy.net.placeholder')}
        items={net.allow.map((h) => ({ id: h, label: h, variant: 'allowed' as const }))}
        parse={(raw) => parseAllowHost(raw, net.denyPrivateIps)}
        description={t('policy.net.hint')}
        emptyText={t('policy.net.none')}
        onAdd={(v) => onChange({ ...net, allow: [...net.allow, v] })}
        onRemove={(id) => onChange({ ...net, allow: net.allow.filter((h) => h !== id) })}
      />
      {pending.length > 0 && (
        <ChipGroup
          className="mt-4"
          label={t('policy.net.suggested')}
          items={pending.map((s) => ({ id: s.id, label: s.value, note: `${s.count}×`, variant: 'suggested' as const }))}
          onAction={() => scrollTo('learning')}
        />
      )}
      <div className="mt-4">
        <LockedStrip
          label={t('policy.net.blocked')}
          items={[
            `${METADATA_IP} (${t('policy.net.metadata')})`,
            ...(net.denyPrivateIps ? PRIVATE_RANGES.map((r) => `${r.id} (${r.note})`) : []),
          ]}
        />
      </div>
      <Switch
        className="mt-3"
        isSelected={net.denyPrivateIps}
        onChange={(v) => onChange({ ...net, denyPrivateIps: v })}
        description={net.denyPrivateIps ? t('policy.net.privateOn') : t('policy.net.privateOff')}
      >
        {t('policy.net.private')}
      </Switch>
    </Section>
  );
};

// ─────────── Secrets ───────────
const SecretsSection = ({
  name,
  policy,
  available,
  backend,
  onChange,
}: {
  name: string;
  policy: SandboxPolicy;
  available: string[];
  backend?: string;
  onChange: (s: SandboxPolicy['secrets']) => void;
}) => {
  const [secret, setSecret] = useState<string | null>(null);
  const [host, setHost] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const hosts = policy.net.allow.filter((h) => !h.startsWith('*.'));
  const free = available.filter((n) => !policy.secrets.some((s) => s.name === n));
  return (
    <Section
      id="secrets"
      title={t('policy.secrets.title')}
      description={t('policy.secrets.desc', { agent: name })}
    >
      {policy.secrets.length === 0 ? (
        <p className="mb-3 type-body-sm text-ink-2">{t('policy.secrets.none')}</p>
      ) : (
        <ul className="mb-4 flex flex-col rounded-lg border border-line bg-surface">
          {policy.secrets.map((s) => (
            <li key={`${s.name}@${s.host}`} className="flex items-center gap-3 border-b border-line py-2 pr-1 pl-3 last:border-b-0">
              <LockSimple size={18} aria-hidden="true" className="shrink-0 text-ink-2" />
              <span className="min-w-0 flex-1">
                <span className="block type-meta text-ink [overflow-wrap:anywhere]">{s.name}</span>
                <span className="block type-meta text-ink-2 [overflow-wrap:anywhere]">
                  → {s.host} · {s.header}
                  {s.prefix ? ` ${s.prefix} …` : ''}
                </span>
              </span>
              <IconButton
                label={t('policy.secrets.remove', { name: s.name })}
                icon={<Trash size={18} aria-hidden="true" />}
                onPress={() => onChange(policy.secrets.filter((x) => x !== s))}
              />
            </li>
          ))}
        </ul>
      )}
      {!adding ? (
        <Button
          variant="secondary"
          size="sm"
          icon={<Plus size={16} aria-hidden="true" />}
          onPress={() => setAdding(true)}
          isDisabled={free.length === 0}
        >
          {t('policy.secrets.bindNew')}
        </Button>
      ) : (
      <div className="grid grid-cols-1 gap-3 @min-[28rem]:grid-cols-[1fr_1fr_auto] @min-[28rem]:items-end">
        <Select
          label={t('policy.secrets.key')}
          placeholder={t('policy.secrets.keyPh')}
          options={free.map((n) => ({ id: n, label: n }))}
          selectedKey={secret}
          onSelectionChange={(k) => setSecret(k ? String(k) : null)}
          isDisabled={free.length === 0}
        />
        <Select
          label={t('policy.secrets.host')}
          placeholder={t('policy.secrets.hostPh')}
          options={hosts.map((h) => ({ id: h, label: h }))}
          selectedKey={host}
          onSelectionChange={(k) => setHost(k ? String(k) : null)}
          isDisabled={hosts.length === 0}
        />
        <Button
          variant="secondary"
          icon={<Plus size={16} aria-hidden="true" />}
          isDisabled={!secret || !host}
          onPress={() => {
            if (!secret || !host) return;
            onChange([...policy.secrets, { name: secret, host, header: 'Authorization', prefix: 'Bearer' }]);
            setSecret(null);
            setHost(null);
            setAdding(false);
          }}
        >
          {t('policy.secrets.addButton')}
        </Button>
      </div>
      )}
      <p className="mt-2 flex items-start gap-1.5 type-meta text-ink-2">
        <Info size={14} aria-hidden="true" className="mt-px shrink-0" />
        {t('policy.secrets.foot', { backend: backend ?? 'keychain' })}
      </p>
    </Section>
  );
};

// ─────────── People & roles ───────────
const PeopleSection = ({ agent }: { agent: AgentView }) => {
  const grants = Object.entries(agent.config.grants);
  const memberships = agent.config.memberships.filter((m) => !m.revokedAt);
  return (
    <Section
      id="people"
      title={t('policy.people.title')}
      aside={<TextLink href="/policy/roles">{t('policy.people.roles')}</TextLink>}
      description={t('policy.people.desc', { agent: agent.config.name })}
    >
      <ul className="flex flex-col rounded-lg border border-line bg-surface">
        {memberships.map((m) => (
          <li key={m.target} className="flex min-h-12 items-center gap-3 border-b border-line px-3 py-2 last:border-b-0">
            <span className="min-w-0 flex-1 type-meta text-ink [overflow-wrap:anywhere]">
              {t('policy.people.everyone', { target: m.target })}
            </span>
            <Mono className="type-meta text-ink-2">{m.defaultRole}</Mono>
          </li>
        ))}
        {grants.map(([who, role]) => (
          <li key={who} className="flex min-h-12 items-center gap-3 border-b border-line px-3 py-2 last:border-b-0">
            <span className="min-w-0 flex-1 truncate type-meta text-ink" title={who}>
              {middleTruncate(who, 28)}
            </span>
            <Mono className="type-meta text-ink-2">{role}</Mono>
          </li>
        ))}
      </ul>
    </Section>
  );
};

// ─────────── Review ───────────
const ReviewSheet = ({
  isOpen,
  onOpenChange,
  name,
  changes,
  widen,
  yaml,
  running,
  pending,
  onSave,
}: {
  isOpen: boolean;
  onOpenChange: (o: boolean) => void;
  name: string;
  changes: Change[];
  widen: boolean;
  yaml: string;
  running: Array<{ id: string; title: string }>;
  pending: boolean;
  onSave: (restart: boolean) => void;
}) => {
  const [restart, setRestart] = useState(false);
  const widens = changes.filter((c) => c.kind === 'widen').length;
  return (
    <Sheet
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={t('policy.review.title', { agent: name })}
      subtitle={`~/.beamhop/agents/${name}.yaml`}
      full
      focusTitle
      footer={
        <div className="flex flex-col gap-2">
          {widen && (
            <p className="flex items-start gap-1.5 type-body-sm text-caution-text">
              <WarningCircle size={16} weight="bold" aria-hidden="true" className="mt-0.5 shrink-0" />
              {t('policy.review.widenNote', { count: widens, agent: name })}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onPress={() => onOpenChange(false)}>
              {t('policy.review.back')}
            </Button>
            <Button variant="primary" isPending={pending} onPress={() => onSave(restart)}>
              {widen ? t('policy.review.widen') : t('policy.review.save')}
            </Button>
          </div>
        </div>
      }
    >
      <Tabs
        label={t('policy.review.tabs')}
        tabs={[
          {
            id: 'plain',
            label: t('policy.review.plain'),
            content: <ChangeList changes={changes} className="mt-2" />,
          },
          {
            id: 'yaml',
            label: 'YAML',
            content: <DiffView diff={yaml} className="mt-3" />,
          },
        ]}
      />
      <Card tone="sunken" padding="sm" className="mt-5">
        <p className="type-body-sm text-ink">{t('policy.review.newSessions')}</p>
        {running.length > 0 && (
          <>
            <p className="mt-1 type-body-sm text-ink-2">
              {t('policy.review.running', { count: running.length })}{' '}
              {running.map((s, i) => (
                <span key={s.id}>
                  {i > 0 && ', '}
                  <Mono>{s.title}</Mono>
                </span>
              ))}
            </p>
            <Checkbox className="mt-1" isSelected={restart} onChange={setRestart}>
              {t('policy.review.restart')}
            </Checkbox>
          </>
        )}
      </Card>
    </Sheet>
  );
};

