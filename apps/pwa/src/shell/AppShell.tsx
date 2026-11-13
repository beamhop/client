import { Outlet, useMatches } from '@tanstack/react-router';
import { lazy, Suspense, useCallback, useState } from 'react';
import { useConnection } from '../api/index.ts';
import { t } from '../i18n/index.ts';
import { cx } from '../lib/cx.ts';
import { useExpanded } from '../lib/media.ts';
import { InboxPanel } from './InboxRail.tsx';
import { usePanicSheet } from './panic.tsx';
import { ShellBanners } from './ShellBanners.tsx';
import { Sidebar } from './Sidebar.tsx';
import { StatusStrip } from './StatusStrip.tsx';
import { useGlobalShortcuts } from './shortcuts.ts';
import { TabBar } from './TabBar.tsx';
import { Unpaired } from './Unpaired.tsx';
import { UpdatePrompt } from './UpdatePrompt.tsx';

declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    /** `bare`: no sidebar / tab bar (onboarding, pairing). */
    chrome?: 'app' | 'bare';
    /** The screen renders its own `<main>` (onboarding's StepFrame), so the bare shell must not nest one. */
    ownMain?: boolean;
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
  const conn = useConnection();
  const matches = useMatches();
  const flags: { chrome?: string; ownMain?: boolean; hideTabBar?: boolean; hideInboxRail?: boolean } = {};
  for (const m of matches) Object.assign(flags, m.staticData ?? {});
  const [collapsed, setCollapsed] = useState(() => readBool('bh.sidebar.collapsed'));
  const { open: openPanic } = usePanicSheet();
  const toggleSidebar = useCallback(() => {
    setCollapsed((c) => {
      writeBool('bh.sidebar.collapsed', !c);
      return !c;
    });
  }, []);
  useGlobalShortcuts({ onPanic: openPanic, onToggleSidebar: toggleSidebar });

  // Nothing to talk to yet (not paired, no token): a landing instead of a shell of endless skeletons.
  if (conn.kind === 'none' && flags.chrome !== 'bare') {
    return (
      <>
        <SkipLink />
        <Unpaired />
        <UpdatePrompt />
        <ShellExtras />
      </>
    );
  }

  if (flags.chrome === 'bare') {
    return (
      <>
        <SkipLink />
        {flags.ownMain ? (
          <div className="min-h-dvh">
            <Outlet />
          </div>
        ) : (
          <main className="min-h-dvh">
            <Outlet />
          </main>
        )}
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

  return (
    <>
      <SkipLink />
      <div className="flex h-dvh overflow-hidden pt-safe" data-shell="expanded">
        <Sidebar collapsed={collapsed} onToggle={toggleSidebar} />
        <div className={cx('flex h-full min-w-0 flex-1 flex-col', collapsed ? 'ml-16' : 'ml-60')}>
          <StatusStrip />
          <ShellBanners />
          <div className="flex min-h-0 flex-1">
            <main className="h-full min-h-0 min-w-0 flex-1">
              <Outlet />
            </main>
          </div>
        </div>
      </div>
      <InboxPanel />
      <UpdatePrompt />
      <ShellExtras />
    </>
  );
};
