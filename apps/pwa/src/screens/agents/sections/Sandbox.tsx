/**
 * Sandbox: the reach summary first (JOURNEYS §5 — "can it read ~/.ssh? which hosts?" in <10 s),
 * then the profile as radio cards with a two-line reach preview each, learning mode (confirmed, since it
 * loosens enforcement), pending learning suggestions, and a hand-off to the full Policy editor.
 */
import { type AgentView, SandboxPolicy, type SandboxProfileName } from '@beamhop/core';
import {
  ArrowRight,
  CheckCircle,
  MinusCircle,
  PlugsConnected,
  ShieldCheck,
  XCircle,
} from '@phosphor-icons/react';
import { useState } from 'react';
import { useApi, useMutationApi } from '../../../api/index.ts';
import { t } from '../../../i18n/index.ts';
import { Button, LinkButton } from '../../../ui/Button.tsx';
import { Radio, RadioGroup, Switch } from '../../../ui/Choice.tsx';
import { TextField } from '../../../ui/Field.tsx';
import { Badge } from '../../../ui/Meta.tsx';
import { ConfirmDialog } from '../../../ui/Sheet.tsx';
import { ErrorState, Skeleton, useDelayedLoading } from '../../../ui/States.tsx';
import { useToast } from '../../../ui/Toast.tsx';
import { HARNESS_HOSTS, reachOf, WORKSPACE_HOSTS } from '../model.ts';
import { Block, ReachSummary, SaveBar, useAgentDraft } from '../parts.tsx';

const PROFILES: SandboxProfileName[] = ['strict', 'workspace', 'custom'];

export const profilePreview = (p: SandboxProfileName, harness: string): string => {
  const api = HARNESS_HOSTS[harness] ?? 'the model API';
  if (p === 'strict') return t('agents.sandbox.strictPreview', { api });
  if (p === 'workspace') return t('agents.sandbox.workspacePreview', { api, count: WORKSPACE_HOSTS.length });
  return t('agents.sandbox.customPreview');
};

type NetworkProps = {
  name: string;
  profile: SandboxProfileName;
  /** The agent's own policy overrides (what gets saved), not the compiled reach. */
  raw: ReturnType<typeof SandboxPolicy.parse>;
  mode: 'restricted' | 'all';
  userAllow: string[];
  required: { host: string; source: string }[];
  blocked: { id: string; value: string }[];
};

const HOST = /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** Network: allow-all switch, the agent's own allowlist, what the harness needs, blocked hosts, and a test. */
const NetworkSection = ({ name, profile, raw, mode, userAllow, required, blocked }: NetworkProps) => {
  const save = useMutationApi('policy.set');
  const apply = useMutationApi('policy.applySuggestion', {
    invalidate: ['policy.suggestions', 'policy.get'],
  });
  const test = useMutationApi('sandbox.test');
  const toast = useToast();
  const [confirmAll, setConfirmAll] = useState(false);
  const [host, setHost] = useState('');
  const [hostError, setHostError] = useState<string | undefined>();
  const [results, setResults] = useState<
    { host: string; source: string; status: string; detail?: string }[] | null
  >(null);

  const saveNet = (net: Partial<ReturnType<typeof SandboxPolicy.parse>['net']>) =>
    save
      .mutateAsync({ name, profile, policy: { ...raw, net: { ...raw.net, ...net } } })
      .catch((e: Error) => toast.show({ tone: 'error', message: e.message }));

  const addHost = () => {
    const h = host.trim().toLowerCase();
    if (!HOST.test(h)) return setHostError(t('agents.sandbox.hostInvalid'));
    if (userAllow.includes(h)) return setHostError(t('agents.sandbox.hostDuplicate'));
    setHostError(undefined);
    setHost('');
    void saveNet({ allow: [...userAllow, h] });
  };

  const runTest = () =>
    test
      .mutateAsync({ name })
      .then((r) => setResults(r.results))
      .catch((e: Error) => toast.show({ tone: 'error', message: e.message }));

  const decide = (id: string, accept: boolean) =>
    apply.mutateAsync({ id, accept }).catch((e: Error) => toast.show({ tone: 'error', message: e.message }));

  return (
    <>
      <Block
        id="sb-network"
        title={t('agents.sandbox.network')}
        description={t('agents.sandbox.networkHint', { name })}
      >
        <Switch
          isSelected={mode === 'all'}
          isDisabled={save.isPending}
          onChange={(v) => (v ? setConfirmAll(true) : void saveNet({ mode: 'restricted' }))}
          description={t('agents.sandbox.allowAllHint')}
        >
          {t('agents.sandbox.allowAll')}
        </Switch>
        {mode === 'all' && (
          <p className="type-body-sm text-caution-text">{t('agents.sandbox.allowAllActive', { name })}</p>
        )}
      </Block>

      <Block
        id="sb-allowlist"
        title={t('agents.sandbox.userAllow')}
        description={
          profile === 'strict' ? t('agents.sandbox.userAllowStrict') : t('agents.sandbox.userAllowHint')
        }
      >
        {userAllow.length === 0 ? (
          <p className="type-body-sm text-ink-2">{t('agents.sandbox.userAllowNone')}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {userAllow.map((h) => (
              <li key={h} className="flex items-center justify-between gap-3 type-body-sm text-ink">
                <code className="min-w-0 break-all">{h}</code>
                <Button
                  size="sm"
                  variant="quiet"
                  aria-label={t('agents.sandbox.removeHost', { host: h })}
                  isDisabled={save.isPending}
                  onPress={() => void saveNet({ allow: userAllow.filter((x) => x !== h) })}
                >
                  {t('agents.sandbox.remove')}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            addHost();
          }}
        >
          <div className="min-w-0 flex-1">
            <TextField
              label={t('agents.sandbox.addHost')}
              hideLabel
              placeholder={t('agents.sandbox.hostPlaceholder')}
              value={host}
              onChange={(v) => {
                setHost(v);
                setHostError(undefined);
              }}
              errorMessage={hostError}
              mono
            />
          </div>
          <Button
            type="submit"
            variant="secondary"
            isDisabled={!host.trim() || save.isPending || profile === 'strict'}
          >
            {t('agents.sandbox.addHost')}
          </Button>
        </form>
      </Block>

      <Block
        id="sb-blocked"
        title={t('agents.sandbox.blocked')}
        description={t('agents.sandbox.blockedHint')}
      >
        {blocked.length === 0 ? (
          <p className="type-body-sm text-ink-2">{t('agents.sandbox.blockedNone')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {blocked.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center justify-between gap-2">
                <code className="min-w-0 break-all type-body-sm">{b.value}</code>
                <span className="flex gap-2">
                  <Button
                    size="sm"
                    variant="allow"
                    isDisabled={apply.isPending || profile === 'strict'}
                    onPress={() => void decide(b.id, true)}
                  >
                    {t('agents.sandbox.allow')}
                  </Button>
                  <Button
                    size="sm"
                    variant="quiet"
                    isDisabled={apply.isPending}
                    onPress={() => void decide(b.id, false)}
                  >
                    {t('agents.sandbox.reject')}
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Block>

      <Block
        id="sb-required"
        title={t('agents.sandbox.required')}
        description={t('agents.sandbox.requiredHint')}
      >
        {required.length === 0 ? (
          <p className="type-body-sm text-ink-2">{t('agents.sandbox.requiredNone')}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {required.map((r) => (
              <li
                key={`${r.source}|${r.host}`}
                className="flex flex-wrap justify-between gap-2 type-body-sm text-ink"
              >
                <code className="min-w-0 break-all">{r.host}</code>
                <span className="text-ink-2">{r.source}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="secondary"
            icon={<PlugsConnected size={18} aria-hidden="true" />}
            isDisabled={test.isPending}
            onPress={() => void runTest()}
          >
            {t('agents.sandbox.test')}
          </Button>
          <span className="type-body-sm text-ink-2">{t('agents.sandbox.testHint')}</span>
        </div>
        {results && (
          <ul className="flex flex-col gap-1">
            {results.map((r) => (
              <li
                key={`${r.source}|${r.host}`}
                className="flex flex-wrap items-center gap-2 type-body-sm text-ink"
              >
                {r.status === 'ok' ? (
                  <CheckCircle size={16} aria-hidden="true" className="text-go-text" />
                ) : r.status === 'skipped' ? (
                  <MinusCircle size={16} aria-hidden="true" className="text-ink-2" />
                ) : (
                  <XCircle size={16} aria-hidden="true" className="text-stop-text" />
                )}
                <code className="min-w-0 break-all">{r.host}</code>
                <span className="text-ink-2">
                  {r.status === 'ok'
                    ? t('agents.sandbox.testOk')
                    : r.status === 'blocked'
                      ? t('agents.sandbox.testBlocked')
                      : r.status === 'skipped'
                        ? t('agents.sandbox.testSkipped')
                        : t('agents.sandbox.testUnreachable', { detail: r.detail ?? '' })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Block>

      <ConfirmDialog
        isOpen={confirmAll}
        onOpenChange={setConfirmAll}
        title={t('agents.sandbox.allowAllTitle', { name })}
        confirmLabel={t('agents.sandbox.allowAllConfirm')}
        variant="primary"
        isPending={save.isPending}
        onConfirm={() => void saveNet({ mode: 'all' }).then(() => setConfirmAll(false))}
      >
        {t('agents.sandbox.allowAllBody', { name })}
      </ConfirmDialog>
    </>
  );
};

export const SandboxSection = ({ agent }: { agent: AgentView }) => {
  const d = useAgentDraft(agent);
  const c = d.draft;
  const name = c.name;
  const policy = useApi('policy.get', { name });
  const suggestions = useApi('policy.suggestions', { name });
  const set = useMutationApi('policy.set');
  const toast = useToast();
  const [confirmLearn, setConfirmLearn] = useState(false);
  const showSkel = useDelayedLoading(policy.isPending);
  const eff = policy.data?.effective;
  // While the profile is being changed, preview the new reach instead of the compiled one.
  const reach = reachOf(c, c.sandbox.profile === agent.config.sandbox.profile ? eff : undefined);
  const pending = (suggestions.data?.suggestions ?? []).filter((s) => s.kind !== 'net.allow').length;

  const setLearning = (on: boolean) => {
    if (!eff || !policy.data) return;
    // Save only the agent's own overrides (plus the flag), not the compiled reach, so profile defaults
    // are not frozen into the agent.
    const raw = SandboxPolicy.parse(agent.config.sandbox.policy ?? {});
    set
      .mutateAsync({ name, profile: policy.data.profile, policy: { ...raw, learning: on } })
      .then(() => {
        setConfirmLearn(false);
        toast.show({
          message: on ? t('agents.sandbox.learnOn', { name }) : t('agents.sandbox.learnOff', { name }),
        });
      })
      .catch((e: Error) => toast.show({ tone: 'error', message: e.message }));
  };

  return (
    <div className="flex flex-col gap-10">
      <Block
        id="sb-reach"
        title={t('agents.sandbox.reach')}
        description={t('agents.sandbox.reachHint', { name })}
      >
        {policy.isPending ? (
          showSkel && <Skeleton variant="detail" count={1} />
        ) : policy.isError ? (
          <ErrorState
            title={t('agents.sandbox.loadError')}
            onRetry={() => void policy.refetch()}
            details={policy.error}
          />
        ) : (
          <ReachSummary reach={reach} name={name} branchNote={c.mounts.some((m) => m.mode === 'rw')} />
        )}
      </Block>

      <Block
        id="sb-profile"
        title={t('agents.sandbox.profile')}
        cli={`beamhop policy set ${name} --profile ${c.sandbox.profile}`}
      >
        <RadioGroup
          label={t('agents.sandbox.profile')}
          hideLabel
          variant="cards"
          value={c.sandbox.profile}
          onChange={(v) =>
            d.set((x) => ({ ...x, sandbox: { ...x.sandbox, profile: v as SandboxProfileName } }))
          }
        >
          {PROFILES.map((p) => (
            <Radio key={p} value={p} description={profilePreview(p, c.harness)}>
              <span className="inline-flex items-center gap-2">
                {p}
                {p === agent.config.sandbox.profile && <Badge>{t('agents.sandbox.current')}</Badge>}
              </span>
            </Radio>
          ))}
        </RadioGroup>
      </Block>

      {policy.data && (
        <NetworkSection
          name={name}
          profile={policy.data.profile as SandboxProfileName}
          raw={SandboxPolicy.parse(agent.config.sandbox.policy ?? {})}
          mode={eff?.net.mode ?? 'restricted'}
          userAllow={policy.data.userAllow ?? []}
          required={policy.data.required ?? []}
          blocked={(suggestions.data?.suggestions ?? [])
            .filter((s) => s.kind === 'net.allow')
            .map((s) => ({ id: s.id, value: s.value }))}
        />
      )}

      <Block id="sb-learning" title={t('agents.sandbox.learning')}>
        <Switch
          isSelected={!!eff?.learning}
          isDisabled={!eff || set.isPending}
          onChange={(v) => (v ? setConfirmLearn(true) : setLearning(false))}
          description={t('agents.sandbox.learningHint')}
        >
          {t('agents.sandbox.learningLabel')}
        </Switch>
        {pending > 0 && (
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-dashed border-caution-text bg-caution-wash px-3 py-2">
            <p className="min-w-0 flex-1 type-body-sm text-ink">
              {t('agents.sandbox.suggestions', { count: pending, name })}
            </p>
            <LinkButton href="/policy" size="sm" variant="secondary">
              {t('agents.sandbox.review')}
            </LinkButton>
          </div>
        )}
      </Block>

      <Block id="sb-more" title={t('agents.sandbox.more')} description={t('agents.sandbox.moreHint')}>
        <LinkButton
          href={`/policy/${agent.config.sandbox.profile}`}
          variant="secondary"
          icon={<ShieldCheck size={18} aria-hidden="true" />}
          className="self-start"
        >
          {t('agents.sandbox.openPolicy')}
          <ArrowRight size={16} aria-hidden="true" />
        </LinkButton>
      </Block>

      <ConfirmDialog
        isOpen={confirmLearn}
        onOpenChange={setConfirmLearn}
        title={t('agents.sandbox.learnTitle', { name })}
        confirmLabel={t('agents.sandbox.learnConfirm')}
        variant="primary"
        isPending={set.isPending}
        onConfirm={() => setLearning(true)}
      >
        {t('agents.sandbox.learnBody', { name })}
      </ConfirmDialog>
      <SaveBar agent={agent} d={d} />
    </div>
  );
};
