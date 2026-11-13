/**
 * TODO(sessions builder): Sessions list — SCREENS §3 "Sessions list", JOURNEYS §3.
 * Owns: src/screens/sessions/**. Route: /sessions (layout) → /sessions/$sessionId (SessionScreen.tsx).
 * Build: rows grouped by agent (sticky micro headers), filters Live · Needs you · Today · All,
 * partial swipe-left → Stop (no full swipe) + row ⋯ menu. Data: useApi('session.list').
 */
import { Outlet } from '@tanstack/react-router';
import { sessionLamp, useApi } from '../../api/index.ts';
import { since, usd } from '../../lib/format.ts';
import { Screen, SplitView } from '../../shell/Screen.tsx';
import { ScreenStub, useHasDetail } from '../../shell/ScreenStub.tsx';
import { StubList } from '../../shell/StubList.tsx';

export const SessionsScreen = () => {
  const hasDetail = useHasDetail('/sessions');
  const q = useApi('session.list');
  return (
    <SplitView
      hasDetail={hasDetail}
      list={
        <Screen title="Sessions" pane="list">
          <StubList
            label="Sessions"
            loading={q.isPending}
            items={(q.data?.sessions ?? []).map((s) => ({
              href: `/sessions/${s.id}`,
              title: s.title,
              slug: [
                s.agent,
                `${s.channel}:${s.conversationId}`,
                `thread ${s.threadId}`,
                since(s.lastActivityAt),
                usd(s.usage.usd),
              ],
              lamp: sessionLamp(s),
            }))}
          />
          <div className="mt-6">
            <ScreenStub
              spec="SCREENS §3 Sessions list"
              owner="src/screens/sessions/"
              outline={[
                'Rows grouped by agent with sticky micro headers',
                'Filters: Live · Needs you · Today · All',
                'Partial swipe-left reveals Stop; row ⋯ menu has the same',
              ]}
            />
          </div>
        </Screen>
      }
    >
      <Outlet />
    </SplitView>
  );
};
