/**
 * TODO(inbox builder): Approval detail — SCREENS §2 desktop detail / JOURNEYS §2.7 Details sheet.
 * Route: /inbox/$approvalId. Full command/diff, transcript excerpt, policy rule, decision bar pinned.
 */
import { useParams } from '@tanstack/react-router';
import { Screen } from '../../shell/Screen.tsx';
import { ScreenStub } from '../../shell/ScreenStub.tsx';

export const ApprovalDetail = () => {
  const { approvalId } = useParams({ strict: false }) as { approvalId: string };
  return (
    <Screen title={`Approval #${approvalId.replace(/^apr_/, '')}`} back={{ href: '/inbox', label: 'Inbox' }} pane="detail" crumbs={[{ label: 'Inbox', href: '/inbox' }, { label: approvalId }]}>
      <ScreenStub
        spec="SCREENS §2 · JOURNEYS §2.7"
        owner="src/screens/inbox/"
        outline={['What is asked (plain sentence + raw code)', 'Context: last 3 messages', 'Policy rule that caused “ask”', 'Deny · Details · Allow… decision bar (keys D / ↵ / ⇧A)']}
        calls={[{ method: 'approval.list', params: { status: 'all' } }]}
      />
    </Screen>
  );
};
