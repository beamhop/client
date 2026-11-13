/**
 * Wide (≥1440) right rail: pending approvals docked beside every screen except Inbox (SCREENS §0.3).
 * Compact rows only; deciding happens in the Inbox (owned by the inbox screen builder).
 */
import { CaretDoubleRight } from '@phosphor-icons/react';
import { Link } from 'react-aria-components';
import { approvalTarget, RISK_LABEL, useApi } from '../api/index.ts';
import { countdown } from '../lib/format.ts';
import { IconButton } from '../ui/Button.tsx';
import { Eyebrow, RiskTag } from '../ui/Meta.tsx';
import { StatusDot } from '../ui/Status.tsx';

export const InboxRail = ({ onCollapse }: { onCollapse: () => void }) => {
  const approvals = useApi('approval.list', { status: 'pending' });
  const list = approvals.data?.approvals ?? [];
  return (
    <aside aria-label="Pending approvals" className="pane-scroll h-full w-[360px] shrink-0 border-l border-line bg-bg px-5 py-3">
      <div className="flex items-center justify-between">
        <Eyebrow count={list.length} href="/inbox">
          Needs you
        </Eyebrow>
        <IconButton label="Hide approvals rail" icon={<CaretDoubleRight size={18} />} onPress={onCollapse} />
      </div>
      {list.length === 0 && <p className="type-body-sm text-ink-2">Inbox clear. Nothing is waiting on you.</p>}
      <ul className="flex flex-col gap-2">
        {list.map((a) => (
          <li key={a.id}>
            <Link
              href={`/inbox/${a.id}`}
              className="flex flex-col gap-1 rounded-lg border border-line bg-surface p-3 outline-none data-[hovered]:border-line-strong"
            >
              <span className="flex items-center gap-2">
                <StatusDot state="needs-you" hideLabel />
                <span className="type-label text-ink">{a.agent}</span>
                <span className="ml-auto">
                  <RiskTag risk={RISK_LABEL[a.risk]} />
                </span>
              </span>
              <span className="truncate font-mono text-[13px] text-ink">{approvalTarget(a)}</span>
              <span className="type-meta text-ink-2">Auto-denies in {countdown(new Date(a.expiresAt).getTime() - Date.now())}</span>
            </Link>
          </li>
        ))}
      </ul>
    </aside>
  );
};
