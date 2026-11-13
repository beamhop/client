/**
 * "Needs you" — the ONE number for pending decisions: tab-bar badge, sidebar, Inbox readout and
 * Home's eyebrow all show it. A decision is a slip: identical requests (×3) collapse into one, and
 * requests you already voted on (N-of-M), decided optimistically or queued offline don't count.
 */
import type { ApprovalView } from '@beamhop/core';
import { useMemo } from 'react';
import { useApi } from '../../api/index.ts';
import { useMe } from './me.ts';
import { groupApprovals, waitingOnOthers } from './model.ts';
import { hiddenStore, queuedIds, queueStore, useStore } from './store.ts';

export const decisionsOf = (
  pending: ApprovalView[],
  me: ReadonlySet<string>,
  hidden: ReadonlySet<string>,
  queued: ReadonlySet<string>,
) =>
  groupApprovals(
    pending.filter(
      (a) => a.status === 'pending' && !hidden.has(a.id) && !queued.has(a.id) && !waitingOnOthers(a, me),
    ),
  );

export const useNeedsYouCount = (): number => {
  const q = useApi('approval.list', { status: 'pending' });
  const me = useMe();
  const hidden = useStore(hiddenStore);
  const queue = useStore(queueStore);
  return useMemo(
    () => decisionsOf(q.data?.approvals ?? [], me, hidden, queuedIds(queue)).length,
    [q.data, me, hidden, queue],
  );
};
