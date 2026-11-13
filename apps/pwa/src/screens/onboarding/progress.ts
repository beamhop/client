/**
 * Resumable onboarding progress (JOURNEYS §1: "Each step is a URL so reload/back work; state is
 * resumable"). Kept per browser in localStorage; the daemon state (doctor, harnesses, identity, devices,
 * agents) is always re-read, so this only remembers what the user chose to skip and which agent the
 * hello step talks to.
 */
import { useSyncExternalStore } from 'react';
import { t } from '../../i18n/index.ts';

/**
 * Outcome first (desktop UX audit): the numbered steps are only "your agent" and "say hello". The machine
 * check, AI accounts, owner key and phone pairing are pages setup sends you to when they need you (a check
 * that needs a fix, an AI account to sign in, a phone to pair after the first reply), not steps to click through.
 */
export const SETUP_STEPS = ['agent', 'hello'] as const;
export const EXTRA_STEPS = ['doctor', 'harnesses', 'identity', 'phone'] as const;
export type SetupStep = (typeof SETUP_STEPS)[number] | (typeof EXTRA_STEPS)[number];
export const isNumbered = (s: string): s is (typeof SETUP_STEPS)[number] =>
  (SETUP_STEPS as readonly string[]).includes(s);
export const STEP_LABEL: Record<SetupStep, string> = {
  doctor: t('setup.step.doctor'),
  harnesses: t('setup.step.harnesses'),
  identity: t('setup.step.identity'),
  phone: t('setup.step.phone'),
  agent: t('setup.step.agent'),
  hello: t('setup.step.hello'),
};

export interface SetupProgress {
  done: SetupStep[];
  skipped: SetupStep[];
  agent?: string;
  /** Round trip finished (ms). */
  helloMs?: number;
}

export const EMPTY: SetupProgress = { done: [], skipped: [] };
const KEY = 'bh.setup';

export const isStep = (s: string): s is SetupStep =>
  isNumbered(s) || (EXTRA_STEPS as readonly string[]).includes(s);

export const markDone = (
  p: SetupProgress,
  s: SetupStep,
  extra: Partial<SetupProgress> = {},
): SetupProgress => ({
  ...p,
  ...extra,
  done: p.done.includes(s) ? p.done : [...p.done, s],
  skipped: p.skipped.filter((x) => x !== s),
});

export const markSkipped = (p: SetupProgress, s: SetupStep): SetupProgress => ({
  ...p,
  skipped: p.skipped.includes(s) ? p.skipped : [...p.skipped, s],
  done: p.done.filter((x) => x !== s),
});

/** After a numbered step, the next one; after a page setup sent you to, back to your agent. */
export const nextStep = (s: SetupStep): SetupStep | 'next' => {
  if (!isNumbered(s)) return 'agent';
  const i = SETUP_STEPS.indexOf(s);
  return SETUP_STEPS[i + 1] ?? 'next';
};

/** Where to resume: the first step neither done nor skipped (or the summary). */
export const resumeAt = (p: SetupProgress): SetupStep | 'next' =>
  SETUP_STEPS.find((s) => !(p.done as string[]).includes(s) && !(p.skipped as string[]).includes(s)) ??
  'next';

export const completedCount = (p: SetupProgress) =>
  SETUP_STEPS.filter((s) => (p.done as string[]).includes(s)).length;

// ─────────── store ───────────
const listeners = new Set<() => void>();
let cached: { raw: string | null; value: SetupProgress } = { raw: null, value: EMPTY };

const readRaw = () => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};

const snapshot = (): SetupProgress => {
  const raw = readRaw();
  if (raw === cached.raw) return cached.value;
  let value = EMPTY;
  try {
    const j = raw ? (JSON.parse(raw) as Partial<SetupProgress>) : {};
    value = {
      done: (j.done ?? []).filter(isStep),
      skipped: (j.skipped ?? []).filter(isStep),
      ...(typeof j.agent === 'string' ? { agent: j.agent } : {}),
      ...(typeof j.helloMs === 'number' ? { helloMs: j.helloMs } : {}),
    };
  } catch {
    value = EMPTY;
  }
  cached = { raw, value };
  return value;
};

export const saveProgress = (p: SetupProgress) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    cached = { raw: JSON.stringify(p), value: p };
  }
  for (const l of listeners) l();
};

export const useSetupProgress = (): [SetupProgress, (fn: (p: SetupProgress) => SetupProgress) => void] => {
  const value = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    snapshot,
    () => EMPTY,
  );
  return [value, (fn) => saveProgress(fn(snapshot()))];
};
