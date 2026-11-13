/**
 * Sandbox: the reach summary first (JOURNEYS §5 — "can it read ~/.ssh? which hosts?" in <10 s),
 * then the profile as radio cards with a two-line reach preview each, learning mode (confirmed, since it
 * loosens enforcement), pending learning suggestions, and a hand-off to the full Policy editor.
 */
import type { AgentView, SandboxProfileName } from '@beamhop/core';
import { ArrowRight, ShieldCheck } from '@phosphor-icons/react';
import { useState } from 'react';
import { useApi, useMutationApi } from '../../../api/index.ts';
import { t } from '../../../i18n/index.ts';
import { LinkButton } from '../../../ui/Button.tsx';
import { Radio, RadioGroup, Switch } from '../../../ui/Choice.tsx';
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
  const pending = suggestions.data?.suggestions.length ?? 0;

  const setLearning = (on: boolean) => {
    if (!eff || !policy.data) return;
    set
      .mutateAsync({ name, profile: policy.data.profile, policy: { ...eff, learning: on } })
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
