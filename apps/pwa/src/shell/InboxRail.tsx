/**
 * Wide (≥1440) right rail: pending approvals docked beside every screen except Inbox (SCREENS §0.3).
 * Compact rows only; deciding happens in the Inbox (owned by the inbox screen builder).
 */
import { CaretDoubleRight } from '@phosphor-icons/react';
import { Link } from 'react-aria-components';
import { approvalTarget, RISK_LABEL, useApi } from '../api/index.ts';
import { t } from '../i18n/index.ts';
import { countdown } from '../lib/format.ts';
import { useMe } from '../screens/inbox/me.ts';
import { decisionsOf } from '../screens/inbox/needs.ts';
import { hiddenStore, queuedIds, queueStore, useStore } from '../screens/inbox/store.ts';
import { IconButton } from '../ui/Button.tsx';
import { Badge, Eyebrow, RiskTag } from '../ui/Meta.tsx';
import { StatusDot } from '../ui/Status.tsx';

export const InboxRail = ({ onCollapse }: { onCollapse: () => void }) => {
  const approvals = useApi('approval.list', { status: 'pending' });
  const me = useMe();
  const hidden = useStore(hiddenStore);
  const queue = useStore(queueStore);
  // Same slips as the Inbox: identical requests collapse (×3), so the count matches the tab badge.
  const groups = decisionsOf(approvals.data?.approvals ?? [], me, hidden, queuedIds(queue));
  return (
    <aside
      aria-label={t('ui.inboxRail.pendingApprovals')}
      className="pane-scroll h-full w-[360px] shrink-0 border-l border-line bg-bg px-5 py-3"
    >
      <div className="flex items-center justify-between">
        <Eyebrow count={groups.length} href="/inbox">
          {t('ui.inboxRail.needsYou')}
        </Eyebrow>
        <IconButton
          label={t('ui.inboxRail.hideApprovalsRail')}
          icon={<CaretDoubleRight size={18} />}
          onPress={onCollapse}
        />
      </div>
      {groups.length === 0 && (
        <p className="type-body-sm text-ink-2">{t('ui.inboxRail.inboxClearNothingIs')}</p>
      )}
      <ul className="flex flex-col gap-2">
        {groups.map(({ lead: a, items }) => (
          <li key={a.id}>
            <Link
              href={`/inbox/${a.id}`}
              className="flex flex-col gap-1 rounded-lg border border-line bg-surface p-3 outline-none data-[hovered]:border-line-strong"
            >
              <span className="flex items-center gap-2">
                <StatusDot state="needs-you" hideLabel />
                <span className="type-label text-ink">{a.agent}</span>
                {items.length > 1 && <Badge tone="outline">×{items.length}</Badge>}
                <span className="ml-auto">
                  <RiskTag risk={RISK_LABEL[a.risk]} />
                </span>
              </span>
              <span className="truncate font-mono text-[13px] text-ink">{approvalTarget(a)}</span>
              <span className="type-meta text-ink-2">
                Auto-denies in {countdown(new Date(a.expiresAt).getTime() - Date.now())}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </aside>
  );
};
