/**
 * TODO(inbox builder): Inbox — SCREENS §2, JOURNEYS §2.
 * Owns: src/screens/inbox/**. Route: /inbox (layout) → /inbox/$approvalId (ApprovalDetail.tsx).
 * Build: slip stack (TicketCard + SwipeAction), filter chips, `03 PENDING` Doto readout, allow-scope
 * sheet, undo toast (useToast onUndo → approval.undo), decided-recently list, J/K/A/D/Z keys,
 * desktop list/detail. Data: useApi('approval.list'), useMutationApi('approval.decide' | 'approval.undo').
 */

import { Outlet } from '@tanstack/react-router';
import { approvalTarget, RISK_LABEL, useApi } from '../../api/index.ts';
import { pad2 } from '../../lib/format.ts';
import { Screen, SplitView } from '../../shell/Screen.tsx';
import { ScreenStub, useHasDetail } from '../../shell/ScreenStub.tsx';
import { StubList } from '../../shell/StubList.tsx';
import { Readout } from '../../ui/Meta.tsx';

export const InboxScreen = () => {
  const hasDetail = useHasDetail('/inbox');
  const q = useApi('approval.list', { status: 'pending' });
  const list = q.data?.approvals ?? [];
  return (
    <SplitView
      hasDetail={hasDetail}
      list={
        <Screen
          title="Inbox"
          pane="list"
          titleAside={
            <span className="flex items-baseline gap-2">
              <Readout size="md">{pad2(list.length)}</Readout>
              <span className="type-micro text-ink-2">pending</span>
            </span>
          }
        >
          <StubList
            label="Pending approvals"
            loading={q.isPending}
            items={list.map((a) => ({
              href: `/inbox/${a.id}`,
              title: `${a.agent} · ${approvalTarget(a)}`,
              slug: [RISK_LABEL[a.risk], a.title],
              lamp: 'needs-you' as const,
            }))}
          />
          <div className="mt-6">
            <ScreenStub
              spec="SCREENS §2 · JOURNEYS §2"
              owner="src/screens/inbox/"
              outline={[
                'Slip stack with swipe right = allow once (LOW), left = deny; buttons always visible',
                'Allow scope sheet: once / this session / always (with policy diff)',
                'Undo toast with a 5 s shrinking beam line',
                'Waiting on others · Decided recently (24 h)',
              ]}
              calls={[{ method: 'approval.list', params: { status: 'all' } }]}
            />
          </div>
        </Screen>
      }
    >
      <Outlet />
    </SplitView>
  );
};
