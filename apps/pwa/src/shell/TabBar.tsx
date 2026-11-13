/**
 * Compact bottom tab bar (DESIGN §9.4): Home, Inbox, Sessions, Agents, More. 56px + safe area.
 * Navigation landmark with links (`aria-current="page"`), not a tablist. Active = Bold icon + ink + 2px
 * flare bar above the icon. The only blur in the system: 92% bg + 12px blur.
 */
import { Link, useRouterState } from '@tanstack/react-router';
import { t } from '../i18n/index.ts';
import { cx } from '../lib/cx.ts';
import { useNeedsYouCount } from '../screens/inbox/needs.ts';
import { CountBadge } from '../ui/Meta.tsx';
import { isActive, TABS } from './nav.ts';

export const TabBar = () => {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const pending = useNeedsYouCount();
  return (
    <nav
      aria-label={t('nav.main')}
      className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-[color-mix(in_oklch,var(--bh-bg)_92%,transparent)] pb-safe backdrop-blur-[12px] hc:bg-bg"
      data-tabbar=""
    >
      <ul className="mx-auto flex h-14 max-w-xl items-stretch px-[max(4px,env(safe-area-inset-left))]">
        {TABS.map((item) => {
          const active = isActive(item, pathname);
          const Icon = item.icon;
          const isInbox = item.to === '/inbox';
          return (
            <li key={item.to} className="flex-1">
              <Link
                to={item.to}
                aria-current={active ? 'page' : undefined}
                className={cx(
                  'relative flex h-full flex-col items-center justify-center gap-0.5 rounded-md outline-none bh-focus-inset',
                  active ? 'text-ink' : 'text-ink-2',
                )}
              >
                <span
                  aria-hidden="true"
                  className={cx(
                    'absolute top-0 h-0.5 w-5 rounded-b-[1px]',
                    active ? 'bg-flare' : 'bg-transparent',
                  )}
                />
                <span className="relative">
                  <Icon size={24} weight={active ? 'bold' : 'regular'} aria-hidden="true" />
                  {isInbox && (
                    <CountBadge
                      count={pending}
                      label={pending === 1 ? t('ui.tabBar.approvalWaiting') : t('ui.tabBar.approvalsWaiting')}
                      className="absolute -top-1.5 -right-3"
                    />
                  )}
                </span>
                <span
                  className="text-[11px] leading-[14px] font-medium"
                  style={{ fontVariationSettings: '"wdth" 90' }}
                >
                  {item.label}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
};
