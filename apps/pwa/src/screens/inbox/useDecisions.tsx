/**
 * Decisions: allow / deny / grant / undo with the 5 s commit window (JOURNEYS §2.5–6).
 * One hook so the Inbox stack, list rows, detail pane, keyboard and Home preview all behave
 * identically: haptic, toast with shrinking beam line + Undo, "Add reason" after a deny, polite
 * announcement, offline queue ("Queued · sends when online"), and group decisions (×N).
 */
import type { Params, PolicySuggestion } from '@beamhop/core';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect } from 'react';
import { approvalTarget, useCall, useConnection } from '../../api/index.ts';
import { t } from '../../i18n/index.ts';
import { haptic } from '../../lib/haptics.ts';
import { announce } from '../../lib/live.ts';
import { useToast } from '../../ui/Toast.tsx';
import type { SlipGroup } from './model.ts';
import {
  holdSuggestion,
  markMine,
  openSheet,
  queueStore,
  releaseHold,
  returningStore,
  setHidden,
  setQueue,
  UNDO_MS,
  undoStore,
  useStore,
} from './store.ts';

type DecideOpts = Omit<Params<'approval.decide'>, 'id' | 'allow'>;

const verbFor = (allow: boolean, o: DecideOpts): string =>
  !allow
    ? t('inbox.toast.denied')
    : o.always
      ? t('inbox.toast.always')
      : o.session
        ? t('inbox.toast.session')
        : o.grantRole
          ? t('inbox.toast.granted', { role: o.grantRole })
          : t('inbox.toast.allowed');

/** Module-level: several components use this hook; only one flush may run. */
const flushing = { current: false };

const Mono = ({ children }: { children: string }) => (
  <span className="font-mono text-[0.9em] break-all">{children}</span>
);

export const useDecisions = () => {
  const call = useCall();
  const qc = useQueryClient();
  const toast = useToast();
  const conn = useConnection();
  const offline = !conn.online || conn.status === 'closed';
  const queue = useStore(queueStore);

  const refresh = useCallback(() => qc.invalidateQueries({ queryKey: ['bh', 'approval.list'] }), [qc]);

  const undoIds = useCallback(
    async (ids: string[], dir: 'left' | 'right') => {
      returningStore.set((r) => ({ ...r, ...Object.fromEntries(ids.map((id) => [id, dir])) }));
      try {
        await Promise.all(ids.map((id) => call('approval.undo', { id })));
        markMine(ids, false);
        haptic('tick');
      } catch (e) {
        toast.show({ message: (e as Error).message, tone: 'error' });
      } finally {
        undoStore.set(null);
        void refresh();
      }
    },
    [call, toast, refresh],
  );

  /** Core: decide every item of a group. Resolves true when at least one decision landed. */
  const decide = useCallback(
    async (group: SlipGroup, allow: boolean, opts: DecideOpts = {}): Promise<boolean> => {
      const ids = group.items.map((a) => a.id);
      const target = approvalTarget(group.lead);
      const times = ids.length > 1 ? ` ×${ids.length}` : '';
      haptic(allow ? 'confirm' : 'reject');
      if (offline) {
        setQueue((q) => [
          ...q.filter((d) => !d.ids.some((id) => ids.includes(id))),
          { ids, params: { allow, ...opts }, target, at: Date.now() },
        ]);
        toast.show({
          message: t('inbox.toast.queued', { verb: verbFor(allow, opts), target }),
          spoken: t('inbox.toast.queued', { verb: verbFor(allow, opts), target }),
        });
        return true;
      }
      markMine(ids);
      setHidden(ids, true);
      const results = await Promise.allSettled(
        ids.map((id) => call('approval.decide', { id, allow, ...opts })),
      );
      // Make sure the cache reflects the outcome before un-hiding (no flash of the old slip).
      await refresh();
      setHidden(ids, false);
      const done = ids.filter((_, i) => results[i]?.status === 'fulfilled');
      const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (done.length === 0) {
        markMine(ids, false);
        haptic('error');
        toast.show({ message: (failed?.reason as Error)?.message ?? t('inbox.toast.failed'), tone: 'error' });
        void refresh();
        return false;
      }
      const first = results[0];
      const stillPending =
        first?.status === 'fulfilled' && (first.value as { status: string }).status === 'pending';
      const verb = stillPending ? t('inbox.toast.voted') : verbFor(allow, opts);
      const dir = allow ? 'right' : 'left';
      const run = () => undoIds(done, dir);
      undoStore.set({
        label: `${verb} · ${target}`,
        until: Date.now() + UNDO_MS,
        run,
        reasonFor: !allow && !opts.reason ? { ids: done, target } : undefined,
      });
      toast.show({
        message: (
          <>
            {verb} · <Mono>{`${target}${times}`}</Mono>
          </>
        ),
        spoken: `${verb}: ${target}${times}`,
        onUndo: run,
        action:
          !allow && !opts.reason
            ? {
                label: t('inbox.reason.add'),
                onPress: () => openSheet({ type: 'reason', ids: done, target }),
              }
            : undefined,
      });
      if (failed) toast.show({ message: (failed.reason as Error).message, tone: 'error' });
      return true;
    },
    [call, offline, toast, undoIds, refresh],
  );

  /** Deny again with a reason: undo inside the window, then re-deny carrying the reason. */
  const denyWithReason = useCallback(
    async (ids: string[], target: string, reason: string) => {
      try {
        await Promise.all(ids.map((id) => call('approval.undo', { id })));
      } catch {
        toast.show({ message: t('inbox.reason.tooLate'), tone: 'error' });
        return;
      }
      await Promise.all(ids.map((id) => call('approval.decide', { id, allow: false, reason })));
      const run = () => undoIds(ids, 'left');
      undoStore.set({ label: `${t('inbox.toast.denied')} · ${target}`, until: Date.now() + UNDO_MS, run });
      toast.show({
        message: (
          <>
            {t('inbox.reason.sent')} · <Mono>{target}</Mono>
          </>
        ),
        spoken: `${t('inbox.reason.sent')}: ${target}`,
        onUndo: run,
      });
      void refresh();
    },
    [call, toast, undoIds, refresh],
  );

  const undoLast = useCallback(async () => {
    const u = undoStore.get();
    if (!u || u.until < Date.now()) {
      announce(t('inbox.undo.nothing'));
      return;
    }
    toast.dismiss();
    await u.run();
    announce(t('inbox.undo.done'));
  }, [toast]);

  // Flush the offline queue when the connection comes back. Expired requests are dropped and said so.
  useEffect(() => {
    if (offline || queue.length === 0 || flushing.current) return;
    flushing.current = true;
    void (async () => {
      let sent = 0;
      const dropped: string[] = [];
      for (const d of queue) {
        markMine(d.ids);
        const rs = await Promise.allSettled(d.ids.map((id) => call('approval.decide', { id, ...d.params })));
        if (rs.some((r) => r.status === 'fulfilled')) sent++;
        else dropped.push(d.target);
      }
      setQueue(() => []);
      flushing.current = false;
      void refresh();
      if (dropped.length > 0)
        toast.show({
          message: t('inbox.queue.dropped', { count: dropped.length, target: dropped[0] ?? '' }),
          tone: 'error',
        });
      else if (sent > 0) toast.show({ message: t('inbox.queue.sent', { count: sent }) });
    })();
  }, [offline, queue, call, refresh, toast]);

  // ─────────── Learning-mode suggestions (held 5 s client-side) ───────────
  const decideSuggestion = useCallback(
    (s: PolicySuggestion, accept: boolean, value?: string) => {
      haptic(accept ? 'confirm' : 'reject');
      holdSuggestion(
        s,
        accept,
        value,
        () =>
          call('policy.applySuggestion', { id: s.id, accept, value }).then(() =>
            qc.invalidateQueries({ queryKey: ['bh', 'policy.suggestions'] }),
          ),
        (e) => toast.show({ message: e.message, tone: 'error' }),
      );
      const shown = accept ? (value ?? s.value) : s.value;
      const verb = accept ? t('inbox.toast.allowedRule') : t('inbox.toast.keptBlocked');
      const run = async () => {
        releaseHold(s.id);
        undoStore.set(null);
      };
      undoStore.set({ label: `${verb} · ${shown}`, until: Date.now() + UNDO_MS, run });
      toast.show({
        message: (
          <>
            {verb} · <Mono>{shown}</Mono>
          </>
        ),
        spoken: `${verb}: ${shown}`,
        onUndo: run,
      });
    },
    [call, qc, toast],
  );

  return { decide, denyWithReason, undoLast, decideSuggestion, offline, queue };
};
