/**
 * Resumable onboarding progress (JOURNEYS §1: "Each step is a URL so reload/back work; state is
 * resumable"). Kept per browser in localStorage; the daemon state (doctor, harnesses, identity, devices,
 * agents) is always re-read, so this only remembers what the user chose to skip and which agent the
 * hello step talks to.
 */
import { useSyncExternalStore } from 'react';

export const SETUP_STEPS = ['doctor', 'harnesses', 'identity', 'phone', 'agent', 'hello'] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];
export const STEP_LABEL: Record<SetupStep, string> = {
  doctor: 'Doctor',
  harnesses: 'Harnesses',
  identity: 'Identity',
  phone: 'Phone',
  agent: 'Agent',
  hello: 'Hello',
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

export const isStep = (s: string): s is SetupStep => (SETUP_STEPS as readonly string[]).includes(s);

export const markDone = (p: SetupProgress, s: SetupStep, extra: Partial<SetupProgress> = {}): SetupProgress => ({
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

export const nextStep = (s: SetupStep): SetupStep | 'next' => {
  const i = SETUP_STEPS.indexOf(s);
  return SETUP_STEPS[i + 1] ?? 'next';
};

/** Where to resume: the first step neither done nor skipped (or the summary). */
export const resumeAt = (p: SetupProgress): SetupStep | 'next' =>
  SETUP_STEPS.find((s) => !p.done.includes(s) && !p.skipped.includes(s)) ?? 'next';

export const completedCount = (p: SetupProgress) => SETUP_STEPS.filter((s) => p.done.includes(s)).length;

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
