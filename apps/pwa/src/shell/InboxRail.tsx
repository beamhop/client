/**
 * The Needs-you panel: pending approvals in a panel that slides over any screen (the status strip's
 * "need you" count, or `n`). It replaced a rail docked beside every screen, which repeated Home's list and
 * squeezed conversations and setup flows (desktop UX audit). Compact rows only; deciding happens in the Inbox.
 */
import { Link } from 'react-aria-components';
import { approvalTarget, RISK_LABEL, useApi } from '../api/index.ts';
import { t } from '../i18n/index.ts';
import { countdown } from '../lib/format.ts';
import { useMe } from '../screens/inbox/me.ts';
import { decisionsOf } from '../screens/inbox/needs.ts';
import { hiddenStore, queuedIds, queueStore, useStore } from '../screens/inbox/store.ts';
import { LinkButton } from '../ui/Button.tsx';
import { Badge, RiskTag } from '../ui/Meta.tsx';
import { Sheet } from '../ui/Sheet.tsx';
import { StatusDot } from '../ui/Status.tsx';
import { closeOverlay, useOverlay } from './overlays.ts';

export const InboxPanel = () => {
  const open = useOverlay() === 'inbox';
  return (
    <Sheet
      isOpen={open}
      onOpenChange={(o) => !o && closeOverlay()}
      title={t('inbox.panel.title')}
      subtitle={t('inbox.panel.subtitle')}
      desktop="pane"
      footer={
        <LinkButton href="/inbox" variant="secondary" fullWidth onPress={closeOverlay}>
          {t('inbox.panel.all')}
        </LinkButton>
      }
    >
      {open && <NeedsYouList onPick={closeOverlay} />}
    </Sheet>
  );
};

const NeedsYouList = ({ onPick }: { onPick: () => void }) => {
  const approvals = useApi('approval.list', { status: 'pending' });
  const me = useMe();
  const hidden = useStore(hiddenStore);
  const queue = useStore(queueStore);
  // Same slips as the Inbox: identical requests collapse (×3), so the count matches the tab badge.
  const groups = decisionsOf(approvals.data?.approvals ?? [], me, hidden, queuedIds(queue));
  return (
    <div aria-label={t('ui.inboxRail.pendingApprovals')} className="flex flex-col gap-2">
      {groups.length === 0 && (
        <p className="type-body-sm text-ink-2">{t('ui.inboxRail.inboxClearNothingIs')}</p>
      )}
      <ul className="flex flex-col gap-2">
        {groups.map(({ lead: a, items }) => (
          <li key={a.id}>
            <Link
              href={`/inbox/${a.id}`}
              onPress={onPick}
              className="flex flex-col gap-1 rounded-lg border border-line bg-surface p-3 outline-none bh-focus-inset data-[hovered]:border-line-strong"
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
    </div>
  );
};
