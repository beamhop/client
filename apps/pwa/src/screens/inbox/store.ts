/**
 * Inbox client state that must outlive a component: the last undoable decision (U / Z from
 * anywhere in the inbox), the open decision sheet (scope / access / reason / help — opened from a swipe, a
 * button, a key or a toast action), the offline decision queue, and learning-mode holds
 * (suggestions are applied after the same 5 s undo window, client-side).
 */
import type { ApprovalView, Params, PolicySuggestion } from '@beamhop/core';
import { useSyncExternalStore } from 'react';
import type { SlipGroup } from './model.ts';

const store = <T>(initial: T) => {
  let value = initial;
  const subs = new Set<() => void>();
  return {
    get: () => value,
    set: (next: T | ((v: T) => T)) => {
      value = typeof next === 'function' ? (next as (v: T) => T)(value) : next;
      for (const s of subs) s();
    },
    subscribe: (fn: () => void) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
};

type Store<T> = ReturnType<typeof store<T>>;
export const useStore = <T>(s: Store<T>): T => useSyncExternalStore(s.subscribe, s.get, s.get);

const read = <T>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};
const write = (key: string, v: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* private mode */
  }
};

// ─────────── Last undoable decision ───────────
export interface UndoEntry {
  label: string;
  until: number;
  run: () => Promise<void>;
  /** Set after a deny: `R` opens the reason sheet for it. */
  reasonFor?: { ids: string[]; target: string };
}
export const undoStore = store<UndoEntry | null>(null);

/** Slips coming back from undo enter from the edge they left (DESIGN §8.3 Undo). */
export const returningStore = store<Record<string, 'left' | 'right'>>({});

// ─────────── Decision sheets ───────────
export type SheetState =
  | { type: 'scope'; group: SlipGroup; onDone?: () => void }
  | { type: 'access'; approval: ApprovalView; onDone?: () => void }
  | { type: 'reason'; ids: string[]; target: string }
  | null;
export const sheetStore = store<SheetState>(null);
export const openSheet = (s: SheetState) => sheetStore.set(s);

// ─────────── Offline queue ───────────
export interface QueuedDecision {
  ids: string[];
  params: Omit<Params<'approval.decide'>, 'id'>;
  target: string;
  at: number;
}
const QUEUE_KEY = 'bh.inbox.queue';
export const queueStore = store<QueuedDecision[]>(read<QueuedDecision[]>(QUEUE_KEY, []));
export const setQueue = (fn: (q: QueuedDecision[]) => QueuedDecision[]) =>
  queueStore.set((q) => {
    const next = fn(q);
    write(QUEUE_KEY, next);
    return next;
  });
export const queuedIds = (q: QueuedDecision[]): Set<string> => new Set(q.flatMap((d) => d.ids));

// ─────────── Learning-mode holds ───────────
export interface Hold {
  suggestion: PolicySuggestion;
  accept: boolean;
  value?: string;
  timer: ReturnType<typeof setTimeout>;
}
export const holdStore = store<Record<string, Hold>>({});

export const UNDO_MS = 5000;

/** Hold a suggestion decision for the undo window, then apply it (even if the inbox unmounts). */
export const holdSuggestion = (
  s: PolicySuggestion,
  accept: boolean,
  value: string | undefined,
  apply: () => Promise<unknown>,
  onError: (e: Error) => void,
) => {
  const timer = setTimeout(() => {
    apply()
      .catch((e: Error) => onError(e))
      .finally(() =>
        holdStore.set((h) => {
          const { [s.id]: _done, ...rest } = h;
          return rest;
        }),
      );
  }, UNDO_MS);
  holdStore.set((h) => ({ ...h, [s.id]: { suggestion: s, accept, value, timer } }));
};

export const releaseHold = (id: string) =>
  holdStore.set((h) => {
    const x = h[id];
    if (x) clearTimeout(x.timer);
    const { [id]: _gone, ...rest } = h;
    return rest;
  });

// ─────────── Optimistic hide while a decision is in flight ───────────
/** Approval ids decided on this device whose server confirmation hasn't landed yet. */
export const hiddenStore = store<ReadonlySet<string>>(new Set());
export const setHidden = (ids: string[], on: boolean) =>
  hiddenStore.set((prev) => {
    const next = new Set(prev);
    for (const id of ids) {
      if (on) next.add(id);
      else next.delete(id);
    }
    return next;
  });

// ─────────── First visits (swipe hint shown on the first 3) ───────────
const VISITS_KEY = 'bh.inbox.visits';
export const bumpVisits = (): number => {
  const n = read<number>(VISITS_KEY, 0) + 1;
  write(VISITS_KEY, n);
  return n;
};
