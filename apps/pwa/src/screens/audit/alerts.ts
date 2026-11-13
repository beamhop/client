/**
 * Alert rules (JOURNEYS §6 Alerts). The contract has no alerts RPC yet, so rules are kept on this device
 * (and drive the in-app thresholds: budget meter warnings, security spike marks). The CLI strip in the
 * sheet shows the daemon-side equivalent.
 */
import { useCallback, useSyncExternalStore } from 'react';

export interface AlertRules {
  budgetWarn: number;
  budgetAlert: number;
  spikeEvents: number;
  spikeMinutes: number;
  heartbeatMinutes: number;
  crash: boolean;
  push: boolean;
  nostrDm: boolean;
  quietHours: boolean;
}

export const DEFAULT_RULES: AlertRules = {
  budgetWarn: 80,
  budgetAlert: 100,
  spikeEvents: 10,
  spikeMinutes: 10,
  heartbeatMinutes: 3,
  crash: true,
  push: true,
  nostrDm: false,
  quietHours: false,
};

const KEY = 'bh.alerts';
const listeners = new Set<() => void>();
let cache: AlertRules | undefined;

const read = (): AlertRules => {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    cache = raw ? { ...DEFAULT_RULES, ...(JSON.parse(raw) as Partial<AlertRules>) } : DEFAULT_RULES;
  } catch {
    cache = DEFAULT_RULES;
  }
  return cache;
};

export const saveRules = (r: AlertRules) => {
  cache = r;
  try {
    localStorage.setItem(KEY, JSON.stringify(r));
  } catch {
    /* storage blocked: keep in memory */
  }
  for (const l of listeners) l();
};

export const useAlertRules = (): [AlertRules, (r: AlertRules) => void] => {
  const rules = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    read,
    () => DEFAULT_RULES,
  );
  return [rules, useCallback(saveRules, [])];
};

export const rulesCli = (r: AlertRules) =>
  `beamhop alerts set --budget ${r.budgetWarn},${r.budgetAlert} --spike ${r.spikeEvents}/${r.spikeMinutes}m --heartbeat ${r.heartbeatMinutes}m${r.nostrDm ? ' --nostr-dm' : ''}`;
