/**
 * Expanded sidebar (DESIGN §9.4): 240px, wordmark, nav groups with micro headers, connection + Stop
 * everything at the bottom. Collapses to a 64px icon rail (⌘\ / Ctrl+\), remembered per browser.
 */
import { MagnifyingGlass, SidebarSimple, Stop } from '@phosphor-icons/react';
import { Link, useRouterState } from '@tanstack/react-router';
import { Button as RACButton } from 'react-aria-components';
import { useApi } from '../api/index.ts';
import { t } from '../i18n/index.ts';
import { cx } from '../lib/cx.ts';
import { Button, IconButton } from '../ui/Button.tsx';
import { CountBadge, Kbd } from '../ui/Meta.tsx';
import { ConnectionPill } from './Connection.tsx';
import { isActive, SIDEBAR_GROUPS } from './nav.ts';
import { modKey, openOverlay } from './overlays.ts';
import { usePanicSheet, usePanicState } from './panic.tsx';
import { Wordmark } from './Wordmark.tsx';

export const Sidebar = ({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) => {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const status = useApi('system.status', undefined, { refetchInterval: 30_000 });
  const findings = useApi('policy.suggestions');
  const pending = status.data?.pendingApprovals ?? 0;
  const { open } = usePanicSheet();
  const { panic } = usePanicState();

  return (
    <aside
      className={cx(
        'fixed inset-y-0 left-0 z-30 flex flex-col border-r border-line bg-bg',
        collapsed ? 'w-16' : 'w-60',
      )}
      aria-label="Sidebar"
      data-sidebar={collapsed ? 'rail' : 'full'}
    >
      <div
        className={cx('flex h-16 items-center', collapsed ? 'justify-center' : 'justify-between pr-2 pl-5')}
      >
        {!collapsed && (
          <Link to="/" aria-label="beamhop home" className="rounded-sm outline-none">
            <Wordmark />
          </Link>
        )}
        <IconButton
          label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          shortcut="⌘\"
          icon={<SidebarSimple size={20} />}
          onPress={onToggle}
        />
      </div>
      <div className={cx('pb-1', collapsed ? 'flex justify-center' : 'px-3')}>
        {collapsed ? (
          <IconButton
            label={t('palette.open')}
            shortcut={`${modKey()}K`}
            icon={<MagnifyingGlass size={20} />}
            onPress={() => openOverlay('palette')}
          />
        ) : (
          <RACButton
            onPress={() => openOverlay('palette')}
            className="flex h-10 w-full items-center gap-2.5 rounded-md border border-line bg-surface px-2.5 text-left text-ink-2 outline-none data-[hovered]:border-line-strong data-[hovered]:text-ink data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus"
          >
            <MagnifyingGlass size={18} aria-hidden="true" />
            <span className="flex-1 type-label">{t('palette.open')}</span>
            <Kbd>{`${modKey()}K`}</Kbd>
          </RACButton>
        )}
      </div>
      <nav aria-label={t('nav.main')} className="pane-scroll flex-1 px-3 pb-4">
        {SIDEBAR_GROUPS.map((g) => (
          <div key={g.label} className="mt-3 first:mt-1">
            {!collapsed && <h2 className="px-2 pt-2 pb-1 type-micro text-ink-3">{g.label}</h2>}
            {collapsed && <div aria-hidden="true" className="mx-3 my-2 h-px bg-line" />}
            <ul className="flex flex-col gap-0.5">
              {g.items.map((item) => {
                const active = isActive(item, pathname);
                const Icon = item.icon;
                const badge = item.to === '/inbox' ? pending : 0;
                const dot = item.to === '/policy' && (findings.data?.suggestions.length ?? 0) > 0;
                return (
                  <li key={item.to}>
                    <Link
                      to={item.to}
                      aria-current={active ? 'page' : undefined}
                      aria-label={collapsed ? item.label : undefined}
                      title={collapsed ? item.label : undefined}
                      className={cx(
                        'relative flex h-10 items-center gap-3 rounded-md outline-none',
                        collapsed ? 'justify-center' : 'px-2',
                        active ? 'bg-sunken text-ink' : 'text-ink-2 hover:bg-sunken hover:text-ink',
                      )}
                    >
                      {active && (
                        <span aria-hidden="true" className="absolute top-2 bottom-2 -left-3 w-0.5 bg-flare" />
                      )}
                      <Icon size={20} weight={active ? 'bold' : 'regular'} aria-hidden="true" />
                      {!collapsed && <span className="flex-1 type-label">{item.label}</span>}
                      {!collapsed && badge > 0 && (
                        <CountBadge
                          count={badge}
                          label={badge === 1 ? 'approval waiting' : 'approvals waiting'}
                        />
                      )}
                      {collapsed && badge > 0 && (
                        <span
                          aria-hidden="true"
                          className="absolute top-1.5 right-2 size-2 rounded-full bg-flare"
                        />
                      )}
                      {dot && (
                        <span
                          className={cx(
                            'size-1.5 rounded-full bg-caution-text',
                            collapsed && 'absolute top-2 right-2.5',
                          )}
                          aria-label="has findings"
                          role="img"
                        />
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
      <div className={cx('flex flex-col gap-2 border-t border-line p-3', collapsed && 'items-center')}>
        <ConnectionPill wide={!collapsed} className={collapsed ? '' : 'self-start'} />
        {!panic &&
          (collapsed ? (
            <IconButton
              label="Stop everything"
              shortcut="⌘⇧."
              icon={<Stop size={20} weight="fill" />}
              variant="destructive-ghost"
              onPress={open}
            />
          ) : (
            <Button
              variant="destructive-outline"
              size="sm"
              icon={<Stop size={16} weight="fill" aria-hidden="true" />}
              onPress={open}
              fullWidth
            >
              {t('panic.button')}
            </Button>
          ))}
      </div>
    </aside>
  );
};
