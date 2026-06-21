import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useIsMobile } from "@beamhop/lib";
import { useEdgeSwipeBack, usePullToRefresh, useSwipeTabs, type PointerHandlers } from "@beamhop/lib";
import { haptic } from "@beamhop/lib";
import { useStore, type ViewId } from "@beamhop/state";
import { Onboarding } from "./ui/Onboarding.tsx";
import { Sidebar, MobileNav } from "./ui/Sidebar.tsx";
import { Compose } from "./ui/Compose.tsx";
import { Toasts } from "./ui/Toasts.tsx";
import { RightRail } from "./ui/RightRail.tsx";
import { CommandPalette } from "./ui/CommandPalette.tsx";
import { Spinner } from "./ui/primitives.tsx";
import { Logo, SunIcon, MoonIcon } from "./ui/icons.tsx";
import { PALETTE_ORDER, paletteBanner, type PaletteId } from "@beamhop/lib";
import { HomeView } from "./views/Home.tsx";
import { ExploreView } from "./views/Explore.tsx";
import { NotificationsView } from "./views/Notifications.tsx";
import { DocsView } from "./views/Docs.tsx";
import { MessagesView } from "./views/Messages.tsx";
import { AgentsView } from "./views/Agents.tsx";
import { ProfileView } from "./views/Profile.tsx";
import { SecurityView } from "./views/Security.tsx";
import { ArticleView } from "./views/Article.tsx";
import { PostDetailView } from "./views/PostDetail.tsx";

const HEADERS: Partial<Record<ViewId, { title: string; subtitle: string }>> = {
  home: { title: "Home", subtitle: "Your network, freshest first" },
  explore: { title: "Explore", subtitle: "Find people, posts, and topics" },
  notifications: { title: "Notifications", subtitle: "Replies, mentions, reactions, zaps, and messages" },
  docs: { title: "Documentations", subtitle: "Long-form knowledge, signed and versioned" },
  messages: { title: "Messages", subtitle: "End-to-end encrypted · NIP-04" },
  agents: { title: "Agents", subtitle: "Autonomous identities you own" },
  security: { title: "Keys & Security", subtitle: "Your identity, signers, and relays" },
};

// Per-view header-inner width so the title aligns with the view body below it.
const HEADER_WIDTH: Partial<Record<ViewId, number | null>> = {
  home: 640,
  explore: 680,
  notifications: 720,
  docs: 760,
  messages: null,
  agents: 820,
  security: 760,
};

const NO_HEADER: ViewId[] = ["docReader", "docEditor", "agentDetail", "profile", "postDetail", "articleReader", "articleEditor"];
const RIGHT_RAIL_VIEWS: ViewId[] = ["home", "explore"];

// When the browser can drive a directional View Transition (iOS 18.2+, modern
// Chrome), the store owns the animation; skip the keyed cross-fade to avoid
// double-animating. Older browsers keep the fade as a graceful fallback.
const SUPPORTS_VIEW_TRANSITION = typeof document !== "undefined" && "startViewTransition" in document;

// Top-level destinations that horizontal tab-swiping moves between (browser-tab
// mode only — in standalone the left-edge swipe is reserved for back).
const SWIPE_TABS: ViewId[] = ["home", "explore", "notifications", "messages", "profile"];

const isStandalone = (): boolean => {
  if (typeof window === "undefined") return false;
  const displayMode = window.matchMedia?.("(display-mode: standalone)").matches ?? false;
  const iosStandalone = (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
  return displayMode || iosStandalone;
};

// Fan one pointer event out to several gesture hooks sharing the scroll element.
const mergeHandlers = (...sets: PointerHandlers[]): PointerHandlers => ({
  onPointerDown: (e) => { for (const s of sets) s.onPointerDown?.(e); },
  onPointerMove: (e) => { for (const s of sets) s.onPointerMove?.(e); },
  onPointerUp: (e) => { for (const s of sets) s.onPointerUp?.(e); },
  onPointerCancel: (e) => { for (const s of sets) s.onPointerCancel?.(e); },
});

const renderView = (view: ViewId): ReactNode => {
  switch (view) {
    case "home":
      return <HomeView />;
    case "explore":
      return <ExploreView />;
    case "notifications":
      return <NotificationsView />;
    case "docs":
    case "docReader":
    case "docEditor":
      return <DocsView />;
    case "messages":
      return <MessagesView />;
    case "agents":
    case "agentDetail":
      return <AgentsView />;
    case "profile":
      return <ProfileView />;
    case "security":
      return <SecurityView />;
    case "postDetail":
      return <PostDetailView />;
    case "articleReader":
    case "articleEditor":
      return <ArticleView />;
  }
};

export const App = (): ReactNode => {
  const { state, rootRef, toggleTheme, setPalette, goBack, runRefresh, navigate } = useStore();
  const [compose, setCompose] = useState(false);
  const [palette, setPaletteOpen] = useState(false);
  const isMobile = useIsMobile();
  const view = state.nav.view;
  const standalone = useMemo(() => isStandalone(), []);

  // ---- touch gestures (hooks must run before the early returns below) ----
  // Edge-swipe-back: standalone only — in a browser tab iOS owns the edge gesture.
  const edgeBack = useEdgeSwipeBack(
    () => { haptic("light"); goBack(); },
    { enabled: isMobile && standalone },
  );
  // Pull-to-refresh on the active feed (online-only refetch via the store seam).
  const ptr = usePullToRefresh(
    async () => { haptic("medium"); await runRefresh(); },
    { enabled: isMobile },
  );
  // Swipe between top-level tabs — browser-tab mode only, to avoid colliding with
  // the standalone left-edge back gesture.
  const tabIndex = SWIPE_TABS.indexOf(view);
  const swipeTabs = useSwipeTabs({
    onPrev: () => { const prev = SWIPE_TABS[tabIndex - 1]; if (prev) { haptic("selection"); navigate(prev); } },
    onNext: () => { const next = SWIPE_TABS[tabIndex + 1]; if (next) { haptic("selection"); navigate(next); } },
    enabled: isMobile && !standalone && tabIndex >= 0,
  });
  const scrollHandlers = mergeHandlers(ptr.handlers, edgeBack.handlers, swipeTabs.handlers);

  // Global ⌘K / Ctrl+K toggles the command palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setPaletteOpen((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  if (!state.ready) {
    return (
      <div style={{ minHeight: "var(--app-h)", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg-base)" }}>
        <Spinner size={28} />
      </div>
    );
  }

  if (!state.identity) {
    return (
      <div ref={rootRef}>
        <Onboarding />
        <Toasts />
      </div>
    );
  }

  const header = HEADERS[view];
  const showHeader = !NO_HEADER.includes(view) && header !== undefined;
  const showRightRail = !isMobile && RIGHT_RAIL_VIEWS.includes(view);
  const headerWidth = HEADER_WIDTH[view];

  const shell: CSSProperties = {
    position: "relative",
    color: "var(--text)",
    minHeight: "var(--app-h)",
    height: "var(--app-h)",
    display: "flex",
    flexDirection: "column",
    fontFamily: "'Hanken Grotesk',sans-serif",
    overflow: "hidden",
    transition: "color .3s",
  };

  const headerInner: CSSProperties =
    headerWidth === null || headerWidth === undefined
      ? { display: "flex", alignItems: "center", gap: 14, width: "100%", padding: "0 24px" }
      : { display: "flex", alignItems: "center", gap: 14, width: "100%", maxWidth: headerWidth, margin: "0 auto", padding: "0 18px" };

  return (
    <div ref={rootRef} data-theme={state.theme} data-testid="app-root" style={shell}>
      <div aria-hidden style={{ position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none", background: "var(--bg-base)" }} />
      <div data-testid="app-shell" style={{ position: "relative", zIndex: 1, flex: 1, display: "flex", width: "100%", maxWidth: 1340, margin: "0 auto", minHeight: 0 }}>
        {!isMobile && <Sidebar onCompose={() => setCompose(true)} />}

        <main data-testid="main-column" style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", height: "var(--app-h)", overflow: "hidden" }}>
          <div data-testid="main-scroll" {...scrollHandlers} style={{ flex: 1, overflowY: "auto", minHeight: 0, scrollbarGutter: "stable", overscrollBehaviorY: "contain" }}>
            {(ptr.pullDistance > 0 || ptr.refreshing) && (
              <div
                aria-hidden
                style={{
                  display: "flex",
                  justifyContent: "center",
                  alignItems: "flex-end",
                  height: ptr.refreshing ? 44 : ptr.pullDistance,
                  overflow: "hidden",
                  color: "var(--text-3)",
                  transition: ptr.pullDistance === 0 && !ptr.refreshing ? "height .2s ease" : undefined,
                }}
              >
                <div style={{ padding: 8 }}>
                  <Spinner size={18} />
                </div>
              </div>
            )}
            {showHeader && (
              <header data-testid="main-header" style={{ display: "flex", padding: "calc(18px + var(--sat)) 0 0", minHeight: "var(--header-h)", boxSizing: "border-box", position: "sticky", top: 0, zIndex: 5, background: "var(--bg-base)" }}>
                <div style={headerInner}>
                  {isMobile && <Logo size={26} />}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <h1 data-testid="header-title" style={{ margin: 0, fontFamily: "'Space Grotesk',sans-serif", fontSize: 20, fontWeight: 700, letterSpacing: "-.02em", lineHeight: 1.1 }}>{header.title}</h1>
                    {header.subtitle && <p data-testid="header-subtitle" style={{ margin: "2px 0 0", fontSize: 12.5, color: "var(--text-3)" }}>{header.subtitle}</p>}
                  </div>
                  {isMobile && (
                    <>
                      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                        {PALETTE_ORDER.map((id: PaletteId) => (
                          <button key={id} data-testid={`accent-swatch-${id}`} onClick={() => setPalette(id)} aria-label={id} style={{ width: 18, height: 18, borderRadius: "50%", cursor: "pointer", background: paletteBanner(id), border: state.palette === id ? "2px solid var(--text)" : "2px solid transparent", boxShadow: "0 0 0 1px var(--glass-border)" }} />
                        ))}
                      </div>
                      <button data-testid="theme-toggle-mobile" onClick={toggleTheme} style={{ display: "flex", padding: 9, border: "1px solid var(--glass-border)", borderRadius: 9, background: "var(--glass)", color: "var(--text-2)", cursor: "pointer" }}>
                        {state.theme === "dark" ? <SunIcon size={18} /> : <MoonIcon size={18} />}
                      </button>
                    </>
                  )}
                </div>
              </header>
            )}
            <div className={SUPPORTS_VIEW_TRANSITION ? undefined : "beamhop-fadein"} key={view}>
              {renderView(view)}
            </div>
          </div>
        </main>

        {showRightRail && <RightRail onOpenPalette={() => setPaletteOpen(true)} />}
      </div>

      {isMobile && <MobileNav onCompose={() => setCompose(true)} onOpenPalette={() => setPaletteOpen(true)} />}
      {compose && <Compose onClose={() => setCompose(false)} />}
      {palette && <CommandPalette onClose={() => setPaletteOpen(false)} onCompose={() => setCompose(true)} />}
      <Toasts />
    </div>
  );
};
