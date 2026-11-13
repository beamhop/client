/**
 * Minimal list for placeholder list panes: tile · title · slug · lamp, each row a link to the detail.
 * Builders replace it with the real rows from SCREENS.md (RAC GridList with row actions).
 */
import { Link, useRouterState } from '@tanstack/react-router';
import type { LampState } from '../api/derive.ts';
import { cx } from '../lib/cx.ts';
import { LetterTile, MetaLine } from '../ui/Meta.tsx';
import { Skeleton, useDelayedLoading } from '../ui/States.tsx';
import { StatusDot } from '../ui/Status.tsx';

export interface StubListItem {
  href: string;
  /** React key when several rows share an href. */
  id?: string;
  title: string;
  slug?: string[];
  lamp?: LampState;
  lampLabel?: string;
  tile?: string;
}

export const StubList = ({ items, loading, label }: { items: StubListItem[]; loading?: boolean; label: string }) => {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const showSkeleton = useDelayedLoading(!!loading);
  if (loading) return showSkeleton ? <Skeleton variant="list" count={4} /> : null;
  return (
    <ul aria-label={label} className="-mx-2 flex flex-col">
      {items.map((it) => {
        const active = it.href !== pathname.split('/').slice(0, 2).join('/') && (pathname === it.href || pathname.startsWith(`${it.href}/`));
        return (
          <li key={it.id ?? it.href}>
            <Link
              to={it.href}
              aria-current={active ? 'page' : undefined}
              className={cx('flex min-h-14 items-center gap-3 rounded-md px-2 py-2.5 outline-none', active ? 'bg-flare-wash' : 'hover:bg-sunken')}
            >
              {it.tile && <LetterTile code={it.tile} />}
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate type-title-3 text-ink">{it.title}</span>
                {it.slug && <MetaLine items={it.slug} />}
              </span>
              {it.lamp && <StatusDot state={it.lamp} label={it.lampLabel} />}
            </Link>
          </li>
        );
      })}
    </ul>
  );
};
