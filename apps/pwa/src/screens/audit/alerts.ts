/**
 * Alert rules (JOURNEYS §6 Alerts): daemon config read with `alerts.get` and merged with `alerts.set`.
 * They drive the daemon's alerts and the in-app thresholds (budget meter warnings, security spike
 * marks). Until the first read lands the defaults are shown.
 */
import { type AlertRules, type AlertRulesPatch, DEFAULT_ALERT_RULES } from '@beamhop/core';
import { useApi, useMutationApi } from '../../api/index.ts';

export type { AlertRules };
export const DEFAULT_RULES: AlertRules = DEFAULT_ALERT_RULES;

export const useAlertRules = () => {
  const q = useApi('alerts.get');
  const set = useMutationApi('alerts.set');
  return {
    rules: q.data ?? DEFAULT_RULES,
    loaded: !!q.data,
    error: q.error,
    /** Merge a patch on the daemon; resolves with the effective rules. */
    save: (patch: AlertRulesPatch) => set.mutateAsync(patch),
    saving: set.isPending,
  };
};

export const rulesCli = (r: AlertRules) =>
  `beamhop alerts set --budget ${r.budgetWarn},${r.budgetAlert} --spike ${r.spikeEvents}/${r.spikeMinutes}m --heartbeat ${r.heartbeatMinutes}m${r.nostrDm ? ' --nostr-dm' : ''}`;
