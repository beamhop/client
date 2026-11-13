/**
 * Harness install / update / login jobs (docs/desktop-ux.md §4–5). The daemon runs the job; the UI starts
 * it, polls `harness.job.get` every ~500 ms until it finishes, and keeps the raw output lines. One shared
 * store per harness id, so a row, its details panel and the Install sheet show the same job, and a job
 * found in `harness.job.list` after a reload resumes.
 */
import {
  type HarnessJob,
  type HarnessJobStep,
  type HarnessView,
  isJobFinished,
  type MethodName,
  type Params,
  type Result,
} from '@beamhop/core';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useApi, useCall } from '../../api/index.ts';
import { t } from '../../i18n/index.ts';
import { announce } from '../../lib/live.ts';

export type JobKind = HarnessJob['kind'];

/** Plain step text shown on the row (no commands, no jargon). */
export const jobStepLabel = (step: HarnessJobStep): string =>
  ({
    resolving: t('harnesses.job.resolving'),
    downloading: t('harnesses.job.downloading'),
    verifying: t('harnesses.job.verifying'),
    installing: t('harnesses.job.installing'),
    checking: t('harnesses.job.checking'),
    'waiting-browser': t('harnesses.job.waitingBrowser'),
    done: t('harnesses.job.done'),
    failed: t('harnesses.job.failed'),
    cancelled: t('harnesses.job.cancelled'),
  })[step];

/** Rough progress (0–4 of 4) for the hop meter. */
export const jobProgress = (step: HarnessJobStep): number =>
  ({
    resolving: 1,
    downloading: 1,
    verifying: 2,
    installing: 3,
    checking: 3,
    'waiting-browser': 2,
    done: 4,
    failed: 0,
    cancelled: 0,
  })[step];

/** What the row offers for this harness, if anything. */
export type HarnessActionKind = 'install' | 'update' | 'login' | 'manual';
export const harnessAction = (
  h: Pick<HarnessView, 'status' | 'installPlan' | 'loginFlow'>,
  opts: { updateAvailable?: boolean; managedLogin?: boolean } = {},
): HarnessActionKind | undefined => {
  if (h.status === 'not-installed')
    return h.installPlan && h.installPlan.method !== 'none' ? 'install' : 'manual';
  if (h.status === 'unsupported-version' || (h.status === 'ready' && opts.updateAvailable)) return 'update';
  if (h.status === 'needs-login' && h.loginFlow && !opts.managedLogin) return 'login';
  return undefined;
};

// ─────────── store ───────────

export interface JobEntry {
  job?: HarnessJob;
  lines: string[];
  /** Starting the job failed (refused, offline): the plain error message. */
  error?: string;
  /** What was started last, for Try again. */
  kind?: JobKind;
  starting?: boolean;
}

type Call = <M extends MethodName>(method: M, params?: Params<M>) => Promise<Result<M>>;

const EMPTY: JobEntry = { lines: [] };
const store = new Map<string, JobEntry>();
const subs = new Set<() => void>();
const polling = new Set<string>();

const get = (hid: string): JobEntry => store.get(hid) ?? EMPTY;
const set = (hid: string, patch: Partial<JobEntry>) => {
  store.set(hid, { ...get(hid), ...patch });
  for (const s of subs) s();
};
const subscribe = (fn: () => void) => {
  subs.add(fn);
  return () => subs.delete(fn);
};

/** For tests. */
export const resetJobStore = () => {
  store.clear();
  polling.clear();
  for (const s of subs) s();
};

export const POLL_MS = 500;

const refresh = (qc: QueryClient) =>
  Promise.all(
    (['harness.list', 'harness.scan', 'harness.updates', 'harness.job.list'] as const).map((m) =>
      qc.invalidateQueries({ queryKey: ['bh', m] }),
    ),
  );

const poll = (hid: string, jobId: string, call: Call, qc: QueryClient) => {
  if (polling.has(jobId)) return;
  polling.add(jobId);
  let failures = 0;
  const tick = async () => {
    if (!polling.has(jobId) || get(hid).job?.id !== jobId) {
      polling.delete(jobId);
      return;
    }
    try {
      const r = await call('harness.job.get', { jobId, since: get(hid).lines.length });
      failures = 0;
      const before = get(hid).job;
      set(hid, { job: r.job, lines: [...get(hid).lines, ...r.lines] });
      if (before?.step !== r.job.step)
        announce(
          r.job.step === 'failed' && r.job.message ? r.job.message : jobStepLabel(r.job.step),
          'polite',
        );
      if (isJobFinished(r.job)) {
        polling.delete(jobId);
        await refresh(qc);
        return;
      }
    } catch (e) {
      // A dropped request or a daemon restart: keep trying for a while, then give up visibly.
      failures += 1;
      if (failures >= 10) {
        polling.delete(jobId);
        set(hid, { error: (e as Error).message });
        return;
      }
    }
    window.setTimeout(() => void tick(), POLL_MS);
  };
  window.setTimeout(() => void tick(), POLL_MS);
};

export interface HarnessJobApi extends JobEntry {
  running: boolean;
  /** `method`: a subscription sign-in (login method of kind `home`). */
  start: (kind: JobKind, opts?: { method?: string }) => Promise<void>;
  cancel: () => Promise<void>;
  /** Forget a finished job (hide its result). */
  dismiss: () => void;
}

/**
 * Start, follow and cancel the job for one harness. Resumes a running job the daemon still has (after a
 * reload or from another window).
 */
export const useHarnessJob = (harnessId: string): HarnessJobApi => {
  const call = useCall() as Call;
  const qc = useQueryClient();
  const entry = useSyncExternalStore(
    subscribe,
    () => get(harnessId),
    () => EMPTY,
  );
  const list = useApi('harness.job.list', undefined, { retry: false, staleTime: 10_000 });

  useEffect(() => {
    const running = list.data?.jobs.find((j) => j.harness === harnessId && !isJobFinished(j));
    if (!running || get(harnessId).job) return;
    set(harnessId, { job: running, lines: [], kind: running.kind });
    poll(harnessId, running.id, call, qc);
  }, [list.data, harnessId, call, qc]);

  const start = async (kind: JobKind, opts: { method?: string } = {}) => {
    set(harnessId, { starting: true, error: undefined, kind, job: undefined, lines: [] });
    announce(jobStepLabel('resolving'));
    try {
      const job =
        kind === 'install'
          ? await call('harness.install', { id: harnessId })
          : kind === 'update'
            ? await call('harness.update', { id: harnessId })
            : await call('harness.loginFlow', {
                id: harnessId,
                openBrowser: true,
                ...(opts.method ? { method: opts.method } : {}),
              });
      set(harnessId, { job, starting: false });
      if (isJobFinished(job)) await refresh(qc);
      else poll(harnessId, job.id, call, qc);
    } catch (e) {
      const message = (e as Error).message;
      set(harnessId, { starting: false, error: message });
      announce(message);
    }
  };

  const cancel = async () => {
    const job = get(harnessId).job;
    if (!job || isJobFinished(job)) return;
    try {
      const r = await call('harness.job.cancel', { jobId: job.id });
      polling.delete(job.id);
      set(harnessId, { job: r });
      announce(jobStepLabel(r.step));
      await refresh(qc);
    } catch (e) {
      set(harnessId, { error: (e as Error).message });
    }
  };

  const dismiss = useCallback(
    () => set(harnessId, { job: undefined, lines: [], error: undefined }),
    [harnessId],
  );

  return {
    ...entry,
    running: !!entry.starting || (!!entry.job && !isJobFinished(entry.job)),
    start,
    cancel,
    dismiss,
  };
};

/** Install / log in from this caller? Only the computer itself (`system.whoami` via `local`). */
export const useCanRunPrograms = (): boolean => {
  const me = useApi('system.whoami', undefined, { staleTime: 60_000 });
  return me.data?.via === 'local';
};

/** `harness.updates` as a map by id (fetched when the Harnesses screen opens; cached by the daemon). */
export const useHarnessUpdates = (enabled = true) => {
  const q = useApi('harness.updates', { refresh: false }, { enabled, retry: false, staleTime: 60_000 });
  return new Map((q.data?.updates ?? []).map((u) => [u.id, u]));
};
