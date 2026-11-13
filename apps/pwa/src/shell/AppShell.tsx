/**
 * App shell (SCREENS §0): compact = screen + bottom tab bar; expanded (≥64rem) = sidebar + status
 * strip + main (+ Inbox rail ≥90rem). Routes opt out of chrome with `staticData: { chrome: 'bare' }`
 * (onboarding, pairing) or hide the tab bar with `staticData: { hideTabBar: true }` (session view).
 */
import { CaretDoubleLeft } from '@phosphor-icons/react';
import { Outlet, useMatches, useRouterState } from '@tanstack/react-router';
import { lazy, Suspense, useCallback, useState } from 'react';
import { t } from '../i18n/index.ts';
import { cx } from '../lib/cx.ts';
import { useExpanded, useWide } from '../lib/media.ts';
import { IconButton } from '../ui/Button.tsx';
import { InboxRail } from './InboxRail.tsx';
import { usePanicSheet } from './panic.tsx';
import { ShellBanners } from './ShellBanners.tsx';
import { Sidebar } from './Sidebar.tsx';
import { StatusStrip } from './StatusStrip.tsx';
import { useGlobalShortcuts } from './shortcuts.ts';
import { TabBar } from './TabBar.tsx';
import { UpdatePrompt } from './UpdatePrompt.tsx';

declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    /** `bare`: no sidebar / tab bar (onboarding, pairing). */
    chrome?: 'app' | 'bare';
    /** Hide the compact tab bar (session view: back returns to the previous tab). */
    hideTabBar?: boolean;
    /** Hide the wide Inbox rail (the Inbox itself). */
    hideInboxRail?: boolean;
  }
}

const readBool = (k: string) => {
  try {
    return localStorage.getItem(k) === '1';
  } catch {
    return false;
  }
};
const writeBool = (k: string, v: boolean) => {
  try {
    localStorage.setItem(k, v ? '1' : '0');
  } catch {
    /* ignore */
  }
};

// Palette, shortcut sheet: their own chunk, fetched after first paint (never on the boot path).
const Overlays = lazy(() => import('./Overlays.tsx'));
// Finishes a push subscription granted during a fresh hosted pairing (screens/pair/push.tsx).
const PushResume = lazy(() => import('../screens/pair/push.tsx').then((m) => ({ default: m.PushResume })));
const pushPending = () => {
  try {
    return !!localStorage.getItem('bh.push.pending');
  } catch {
    return false;
  }
};

/** Lazy shell extras, mounted once on every layout. */
const ShellExtras = () => {
  const [pending] = useState(pushPending);
  return (
    <Suspense fallback={null}>
      <Overlays />
      {pending && <PushResume />}
    </Suspense>
  );
};

export const LiveRegions = () => (
  <>
    <div id="bh-live-polite" aria-live="polite" aria-atomic="true" className="sr-only" />
    <div id="bh-live-assertive" aria-live="assertive" aria-atomic="true" className="sr-only" />
  </>
);

export const SkipLink = () => (
  <a
    href="#bh-main-content"
    className="sr-only z-[90] rounded-md bg-ink px-4 py-3 type-label text-bg focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
  >
    {t('nav.skip')}
  </a>
);

export const AppShell = () => {
  const expanded = useExpanded();
  const wide = useWide();
  const matches = useMatches();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const flags: { chrome?: string; hideTabBar?: boolean; hideInboxRail?: boolean } = {};
  for (const m of matches) Object.assign(flags, m.staticData ?? {});
  const [collapsed, setCollapsed] = useState(() => readBool('bh.sidebar.collapsed'));
  const [railHidden, setRailHidden] = useState(() => readBool('bh.inboxRail.hidden'));
  const { open: openPanic } = usePanicSheet();
  const toggleSidebar = useCallback(() => {
    setCollapsed((c) => {
      writeBool('bh.sidebar.collapsed', !c);
      return !c;
    });
  }, []);
  useGlobalShortcuts({ onPanic: openPanic, onToggleSidebar: toggleSidebar });

  if (flags.chrome === 'bare') {
    return (
      <>
        <SkipLink />
        <main className="min-h-dvh">
          <Outlet />
        </main>
        <UpdatePrompt />
        <ShellExtras />
      </>
    );
  }

  if (!expanded) {
    return (
      <>
        <SkipLink />
        <main className="min-h-dvh" data-shell="compact">
          <Outlet />
        </main>
        {!flags.hideTabBar && <TabBar />}
        <UpdatePrompt />
        <ShellExtras />
      </>
    );
  }

  const showRail = wide && !flags.hideInboxRail && !pathname.startsWith('/inbox');
  return (
    <>
      <SkipLink />
      <div className="flex h-dvh overflow-hidden" data-shell="expanded">
        <Sidebar collapsed={collapsed} onToggle={toggleSidebar} />
        <div className={cx('flex h-dvh min-w-0 flex-1 flex-col', collapsed ? 'ml-16' : 'ml-60')}>
          <StatusStrip />
          <ShellBanners />
          <div className="flex min-h-0 flex-1">
            <main className="h-full min-h-0 min-w-0 flex-1">
              <Outlet />
            </main>
            {showRail && !railHidden && (
              <InboxRail
                onCollapse={() => {
                  setRailHidden(true);
                  writeBool('bh.inboxRail.hidden', true);
                }}
              />
            )}
            {showRail && railHidden && (
              <div className="border-l border-line px-2 py-3">
                <IconButton
                  label={t('ui.appShell.showApprovalsRail')}
                  icon={<CaretDoubleLeft size={18} />}
                  onPress={() => {
                    setRailHidden(false);
                    writeBool('bh.inboxRail.hidden', false);
                  }}
                />
              </div>
            )}
          </div>
        </div>
      </div>
      <UpdatePrompt />
      <ShellExtras />
    </>
  );
};
