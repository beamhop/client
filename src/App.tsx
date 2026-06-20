import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useStore, type ViewId } from "./state/store.tsx";
import { Onboarding } from "./ui/Onboarding.tsx";
import { Sidebar, MobileNav } from "./ui/Sidebar.tsx";
import { Compose } from "./ui/Compose.tsx";
import { Toasts } from "./ui/Toasts.tsx";
import { Spinner } from "./ui/primitives.tsx";
import { HomeView } from "./views/Home.tsx";
import { ExploreView } from "./views/Explore.tsx";
import { DocsView } from "./views/Docs.tsx";
import { MessagesView } from "./views/Messages.tsx";
import { AgentsView } from "./views/Agents.tsx";
import { ProfileView } from "./views/Profile.tsx";
import { SecurityView } from "./views/Security.tsx";

const HEADERS: Record<ViewId, { title: string; subtitle: string }> = {
  home: { title: "Home", subtitle: "Your network, freshest first" },
  explore: { title: "Explore", subtitle: "Find people, posts, and topics" },
  docs: { title: "Documentations", subtitle: "Long-form knowledge, signed and versioned" },
  docReader: { title: "Documentation", subtitle: "" },
  docEditor: { title: "Write documentation", subtitle: "NIP-23 long-form · markdown" },
  messages: { title: "Messages", subtitle: "End-to-end encrypted · NIP-04" },
  agents: { title: "Agents", subtitle: "Autonomous identities you own" },
  agentDetail: { title: "Agent", subtitle: "" },
  profile: { title: "Profile", subtitle: "" },
  security: { title: "Keys & Security", subtitle: "Your identity, signers, and relays" },
  articleReader: { title: "Article", subtitle: "" },
  articleEditor: { title: "Write article", subtitle: "NIP-23 long-form · markdown" },
};

const renderView = (view: ViewId): ReactNode => {
  switch (view) {
    case "home":
      return <HomeView />;
    case "explore":
      return <ExploreView />;
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
    case "articleReader":
    case "articleEditor":
      return <HomeView />;
  }
};

export const App = (): ReactNode => {
  const { state, rootRef } = useStore();
  const [compose, setCompose] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 900);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  if (!state.ready) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg-base)" }}>
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

  const header = HEADERS[state.nav.view];
  const showHeader = !["docReader", "agentDetail", "profile", "articleReader", "docEditor", "articleEditor"].includes(
    state.nav.view,
  );

  const shell: CSSProperties = {
    position: "relative",
    color: "var(--text)",
    minHeight: "100vh",
    height: "100vh",
    display: "flex",
    flexDirection: "column",
    fontFamily: "'Hanken Grotesk',sans-serif",
    overflow: "hidden",
  };

  return (
    <div ref={rootRef} data-theme={state.theme} data-testid="app-root" style={shell}>
      <div aria-hidden style={{ position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none", background: "var(--bg-base)" }} />
      <div
        data-testid="app-shell"
        style={{ position: "relative", zIndex: 1, flex: 1, display: "flex", width: "100%", maxWidth: 1340, margin: "0 auto", minHeight: 0 }}
      >
        {!isMobile && <Sidebar onCompose={() => setCompose(true)} />}

        <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden" }}>
          <div style={{ flex: 1, overflowY: "auto", minHeight: 0, scrollbarGutter: "stable" }}>
            {showHeader && (
              <header
                style={{
                  display: "flex",
                  padding: "18px 24px 0",
                  height: 74,
                  boxSizing: "border-box",
                  position: "sticky",
                  top: 0,
                  zIndex: 5,
                  background: "var(--bg-base)",
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h1 style={{ margin: 0, fontFamily: "'Space Grotesk',sans-serif", fontSize: 20, fontWeight: 700, letterSpacing: "-.02em", lineHeight: 1.1 }}>
                    {header.title}
                  </h1>
                  {header.subtitle && <p style={{ margin: "2px 0 0", fontSize: 12.5, color: "var(--text-3)" }}>{header.subtitle}</p>}
                </div>
              </header>
            )}
            <div style={{ padding: "8px 24px 80px", maxWidth: 720, margin: "0 auto" }} className="verity-fadein" key={state.nav.view}>
              {renderView(state.nav.view)}
            </div>
          </div>
          {isMobile && <MobileNav />}
        </main>
      </div>

      {compose && <Compose onClose={() => setCompose(false)} />}
      <Toasts />
    </div>
  );
};
