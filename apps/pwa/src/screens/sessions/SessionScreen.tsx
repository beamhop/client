/**
 * TODO(sessions builder): Live session view — SCREENS §3, JOURNEYS §3.
 * Route: /sessions/$sessionId (tab bar hidden on compact via staticData.hideTabBar).
 * Build: sticky 2-row header (lamp, RouteLine, slug), transcript on a tick rail (role="log"), tool rows
 * (expand → CodeBlock / DiffView), inline mini-slips, progress strip, pill composer (Stop while live,
 * Steer), prev/next session buttons + `[` `]`, Inspector pane ≥1024 (⌘I).
 * Data: useApi('session.events', { id }), useServerEvent for 'session.event' (cache already patched;
 * same seq = replaced text while streaming), useMutationApi('session.send' | 'session.stop').
 */
import { useParams } from '@tanstack/react-router';
import { useApi } from '../../api/index.ts';
import { usd } from '../../lib/format.ts';
import { Screen } from '../../shell/Screen.tsx';
import { ScreenStub } from '../../shell/ScreenStub.tsx';
import { MetaLine } from '../../ui/Meta.tsx';
import { RouteLine } from '../../ui/Status.tsx';

export const SessionScreen = () => {
  const { sessionId } = useParams({ strict: false }) as { sessionId: string };
  const list = useApi('session.list');
  const s = list.data?.sessions.find((x) => x.id === sessionId);
  const events = useApi('session.events', { id: sessionId, afterSeq: 0 });
  return (
    <Screen
      title={s?.agent ?? 'Session'}
      back={{ href: '/sessions', label: 'Sessions' }}
      pane="detail"
      crumbs={[
        { label: 'Sessions', href: '/sessions' },
        { label: s?.agent ?? sessionId },
        { label: s ? `thread ${s.threadId}` : '' },
      ]}
      slug={
        s && (
          <div className="flex flex-col gap-1">
            <RouteLine
              nodes={[
                { label: `${s.channel}:${s.conversationId}`, kind: 'channel' },
                { label: s.agent, kind: 'agent' },
              ]}
              live={s.status === 'running'}
            />
            <MetaLine
              items={[
                `thread ${s.threadId}`,
                s.worktree ? `worktree ${s.worktree.branch}` : null,
                usd(s.usage.usd),
              ]}
            />
          </div>
        )
      }
    >
      <ScreenStub
        spec="SCREENS §3 · JOURNEYS §3"
        owner="src/screens/sessions/"
        outline={[
          `Transcript on a tick rail · ${events.data?.events.length ?? '…'} events so far (streams live)`,
          'Tool rows: one line, expand for input/output/diff; agent prose never folded',
          'Inline approval mini-slip mirrors Inbox state',
          'Progress strip + pill composer (Stop while live, Steer)',
        ]}
        calls={[{ method: 'session.events', params: { id: sessionId, afterSeq: 0 } }]}
      />
    </Screen>
  );
};
