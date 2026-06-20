import type { ReactNode } from "react";
import { useStore, type ViewId } from "../state/store.tsx";
import { displayName, initials, avatarStyle } from "../lib/format.ts";
import { shortNpub } from "../nostr/keys.ts";
import { PALETTE_ORDER, paletteBanner, type PaletteId } from "../lib/theme.ts";
import { navStyle, tabStyle } from "./styles.ts";
import {
  Logo,
  HomeIcon,
  SearchIcon,
  DocsIcon,
  MessagesIcon,
  AgentsIcon,
  ProfileIcon,
  ShieldIcon,
  PlusIcon,
  SunIcon,
  MoonIcon,
  ChevronDownIcon,
  VerifiedSeal,
} from "./icons.tsx";

type NavItem = { id: ViewId; testid: string; label: string; icon: ReactNode; active: (v: ViewId) => boolean };

const NAV: NavItem[] = [
  { id: "home", testid: "nav-home", label: "Home", icon: <HomeIcon />, active: (v) => v === "home" },
  { id: "explore", testid: "nav-explore", label: "Explore", icon: <SearchIcon />, active: (v) => v === "explore" },
  { id: "docs", testid: "nav-docs", label: "Docs", icon: <DocsIcon />, active: (v) => v.startsWith("doc") },
  { id: "messages", testid: "nav-messages", label: "Messages", icon: <MessagesIcon />, active: (v) => v === "messages" },
  { id: "agents", testid: "nav-agents", label: "Agents", icon: <AgentsIcon />, active: (v) => v === "agents" || v === "agentDetail" },
  { id: "profile", testid: "nav-profile", label: "Profile", icon: <ProfileIcon />, active: (v) => v === "profile" },
  { id: "security", testid: "nav-security", label: "Keys & Security", icon: <ShieldIcon />, active: (v) => v === "security" },
];

export const Sidebar = ({ onCompose }: { onCompose: () => void }): ReactNode => {
  const { state, navigate, toggleTheme, setPalette, toast } = useStore();
  const view = state.nav.view;
  const pubkey = state.identity?.pubkey ?? "";
  const name = state.me ? displayName({ name: state.me.name, displayName: state.me.displayName, pubkey }) : "You";
  const relayCount = state.relays.filter((r) => r.read || r.write).length;

  return (
    <aside
      data-testid="sidebar"
      style={{ width: 236, flexShrink: 0, display: "flex", flexDirection: "column", padding: "16px 12px", gap: 6, height: "100vh", position: "sticky", top: 0, overflowY: "auto" }}
    >
      <div data-testid="sidebar-logo" style={{ display: "flex", alignItems: "center", gap: 11, padding: "8px 10px 16px" }}>
        <Logo size={32} />
        <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 20, letterSpacing: "-.02em" }}>Verity</span>
      </div>

      <button
        data-testid="workspace-switcher"
        onClick={() => toast("Workspace switching is a demo stub", "info")}
        style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 11px", margin: "0 2px 8px", border: "1px solid var(--glass-border)", borderRadius: 10, background: "var(--glass)", boxShadow: "var(--glass-shadow)", cursor: "pointer", transition: "transform .18s", width: "calc(100% - 4px)" }}
      >
        <span style={{ width: 27, height: 27, borderRadius: 8, background: "var(--grad)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--on-accent)", fontWeight: 700, fontSize: 13, fontFamily: "'Space Grotesk',sans-serif" }}>A</span>
        <span style={{ textAlign: "left", flex: 1, minWidth: 0 }}>
          <span style={{ display: "block", fontWeight: 700, fontSize: 13.5, color: "var(--text)" }}>Aperture</span>
          <span style={{ display: "block", fontSize: 11, color: "var(--text-3)" }}>Workspace · {relayCount} relays</span>
        </span>
        <ChevronDownIcon size={15} />
      </button>

      <nav data-testid="sidebar-nav" style={{ display: "flex", flexDirection: "column", gap: 4, padding: "0 2px" }}>
        {NAV.map((item) => {
          const active = item.active(view);
          return (
            <button key={item.id} data-testid={item.testid} onClick={() => navigate(item.id)} style={navStyle(active)}>
              {item.icon}
              <span style={item.id === "messages" ? { flex: 1, textAlign: "left" } : undefined}>{item.label}</span>
            </button>
          );
        })}
      </nav>

      <button
        data-testid="compose-button-sidebar"
        onClick={onCompose}
        style={{ position: "relative", overflow: "hidden", margin: "16px 2px 0", display: "flex", alignItems: "center", justifyContent: "center", gap: 9, padding: 13, border: "1px solid rgba(255,255,255,.3)", borderRadius: 10, background: "var(--accent)", color: "var(--on-accent)", fontWeight: 700, fontSize: 15, fontFamily: "inherit", cursor: "pointer", transition: "all .2s" }}
      >
        <PlusIcon size={19} /> New post
      </button>

      <div style={{ flex: 1 }} />

      <div data-testid="accent-picker" style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", margin: "0 2px" }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-3)" }}>Accent</span>
        <div style={{ display: "flex", alignItems: "center", gap: 9, flex: 1, justifyContent: "flex-end" }}>
          {PALETTE_ORDER.map((id: PaletteId) => (
            <button
              key={id}
              data-testid={`accent-swatch-${id}`}
              onClick={() => setPalette(id)}
              title={id}
              aria-label={id}
              style={{ width: 18, height: 18, borderRadius: "50%", cursor: "pointer", background: paletteBanner(id), border: state.palette === id ? "2px solid var(--text)" : "2px solid transparent", boxShadow: "0 0 0 1px var(--glass-border)", transition: "transform .15s" }}
            />
          ))}
        </div>
      </div>

      <button
        data-testid="theme-toggle"
        onClick={toggleTheme}
        style={{ display: "flex", alignItems: "center", gap: 11, padding: "11px 14px", margin: "0 2px", border: "none", borderRadius: 9, background: "transparent", color: "var(--text-2)", fontWeight: 600, fontSize: 14, fontFamily: "inherit", cursor: "pointer", transition: "all .15s" }}
      >
        {state.theme === "dark" ? <SunIcon size={19} /> : <MoonIcon size={19} />}
        <span>{state.theme === "dark" ? "Light mode" : "Dark mode"}</span>
      </button>

      <button
        data-testid="sidebar-profile-card"
        onClick={() => navigate("profile")}
        style={{ position: "sticky", bottom: 0, display: "flex", alignItems: "center", gap: 11, padding: "9px 11px", margin: "4px 2px 0", border: "1px solid var(--glass-border)", borderRadius: 10, background: "var(--glass-strong)", boxShadow: "var(--glass-shadow)", cursor: "pointer", transition: "transform .18s", width: "calc(100% - 4px)" }}
      >
        <span style={avatarStyle(pubkey, 36, state.me?.picture)}>{!state.me?.picture && initials(name)}</span>
        <span style={{ textAlign: "left", flex: 1, minWidth: 0 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 4, fontWeight: 700, fontSize: 13.5, color: "var(--text)" }}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
            {state.me?.nip05 && <VerifiedSeal size={13} />}
          </span>
          <span style={{ display: "block", fontSize: 11.5, color: "var(--text-3)", fontFamily: "'JetBrains Mono',monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {state.me?.nip05 ?? (pubkey && shortNpub(pubkey))}
          </span>
        </span>
      </button>
    </aside>
  );
};

const MOBILE_TABS: { id: ViewId; testid: string; icon: ReactNode; active: (v: ViewId) => boolean }[] = [
  { id: "home", testid: "tab-home", icon: <HomeIcon size={24} />, active: (v) => v === "home" },
  { id: "explore", testid: "tab-explore", icon: <SearchIcon size={24} />, active: (v) => v === "explore" },
  { id: "docs", testid: "tab-docs", icon: <DocsIcon size={24} />, active: (v) => v.startsWith("doc") },
];
const MOBILE_TABS_RIGHT: { id: ViewId; testid: string; icon: ReactNode; active: (v: ViewId) => boolean }[] = [
  { id: "messages", testid: "tab-messages", icon: <MessagesIcon size={24} />, active: (v) => v === "messages" },
  { id: "agents", testid: "tab-agents", icon: <AgentsIcon size={24} />, active: (v) => v === "agents" || v === "agentDetail" },
  { id: "profile", testid: "tab-profile", icon: <ProfileIcon size={24} />, active: (v) => v === "profile" },
];

export const MobileNav = ({ onCompose }: { onCompose: () => void }): ReactNode => {
  const { state, navigate } = useStore();
  const view = state.nav.view;
  return (
    <nav
      data-testid="bottom-nav"
      style={{ position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 20, display: "flex", alignItems: "center", justifyContent: "space-around", padding: "8px 6px calc(8px + env(safe-area-inset-bottom))", margin: "0 10px 10px", borderRadius: 14, background: "var(--glass-strong)", border: "1px solid var(--glass-border)", boxShadow: "var(--glass-shadow-lg)" }}
    >
      {MOBILE_TABS.map((t) => (
        <button key={t.id} data-testid={t.testid} onClick={() => navigate(t.id)} style={tabStyle(t.active(view))}>
          {t.icon}
        </button>
      ))}
      <button
        data-testid="compose-button-mobile"
        onClick={onCompose}
        style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 52, height: 52, marginTop: -18, border: "1px solid rgba(255,255,255,.3)", borderRadius: 12, background: "var(--accent)", color: "var(--on-accent)", cursor: "pointer", transition: "transform .15s" }}
      >
        <PlusIcon size={24} stroke={2.4} />
      </button>
      {MOBILE_TABS_RIGHT.map((t) => (
        <button key={t.id} data-testid={t.testid} onClick={() => navigate(t.id)} style={tabStyle(t.active(view))}>
          {t.icon}
        </button>
      ))}
    </nav>
  );
};
