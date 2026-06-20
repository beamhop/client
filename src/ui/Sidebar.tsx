import type { CSSProperties, ReactNode } from "react";
import { useStore, type ViewId } from "../state/store.tsx";
import { displayName } from "../lib/format.ts";
import { shortNpub } from "../nostr/keys.ts";
import { PALETTE_ORDER, paletteBanner, type PaletteId } from "../lib/theme.ts";
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
  VerifiedSeal,
} from "./icons.tsx";
import { Avatar } from "./primitives.tsx";

type NavItem = { id: ViewId; label: string; icon: ReactNode };

const NAV: NavItem[] = [
  { id: "home", label: "Home", icon: <HomeIcon /> },
  { id: "explore", label: "Explore", icon: <SearchIcon /> },
  { id: "docs", label: "Docs", icon: <DocsIcon /> },
  { id: "messages", label: "Messages", icon: <MessagesIcon /> },
  { id: "agents", label: "Agents", icon: <AgentsIcon /> },
  { id: "profile", label: "Profile", icon: <ProfileIcon /> },
  { id: "security", label: "Keys & Security", icon: <ShieldIcon /> },
];

const navStyle = (active: boolean): CSSProperties => ({
  position: "relative",
  display: "flex",
  alignItems: "center",
  gap: 11,
  padding: "9px 12px",
  borderRadius: 9,
  cursor: "pointer",
  border: "1px solid transparent",
  background: active ? "var(--accent-soft)" : "transparent",
  color: active ? "var(--accent)" : "var(--text-2)",
  fontWeight: active ? 700 : 600,
  fontSize: 14,
  width: "100%",
  textAlign: "left",
});

export const Sidebar = ({ onCompose }: { onCompose: () => void }): ReactNode => {
  const { state, navigate, toggleTheme, setPalette } = useStore();
  const view = state.nav.view;
  const pubkey = state.identity?.pubkey ?? "";
  const name = state.me ? displayName({ name: state.me.name, displayName: state.me.displayName, pubkey }) : "You";

  return (
    <aside
      style={{
        width: 236,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        padding: "16px 12px",
        gap: 6,
        height: "100vh",
        position: "sticky",
        top: 0,
        overflowY: "auto",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "8px 10px 16px" }}>
        <Logo size={32} />
        <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 20, letterSpacing: "-.02em" }}>
          Verity
        </span>
      </div>

      <nav style={{ display: "flex", flexDirection: "column", gap: 4, padding: "0 2px" }}>
        {NAV.map((item) => {
          const active = view === item.id || (item.id === "docs" && view.startsWith("doc"));
          return (
            <button key={item.id} onClick={() => navigate(item.id)} style={navStyle(active)}>
              {item.icon}
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      <button
        onClick={onCompose}
        style={{
          margin: "16px 2px 0",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 9,
          padding: 13,
          border: "1px solid rgba(255,255,255,.3)",
          borderRadius: 10,
          background: "var(--accent)",
          color: "var(--on-accent)",
          fontWeight: 700,
          fontSize: 15,
          cursor: "pointer",
        }}
      >
        <PlusIcon size={19} /> New post
      </button>

      <div style={{ flex: 1 }} />

      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", margin: "0 2px" }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-3)" }}>Accent</span>
        <div style={{ display: "flex", alignItems: "center", gap: 9, flex: 1, justifyContent: "flex-end" }}>
          {PALETTE_ORDER.map((id: PaletteId) => (
            <button
              key={id}
              onClick={() => setPalette(id)}
              title={id}
              aria-label={id}
              style={{
                width: 18,
                height: 18,
                borderRadius: "50%",
                cursor: "pointer",
                background: paletteBanner(id),
                border: state.palette === id ? "2px solid var(--text)" : "2px solid transparent",
                boxShadow: "0 0 0 1px var(--glass-border)",
                transition: "transform .15s",
              }}
            />
          ))}
        </div>
      </div>

      <button
        onClick={toggleTheme}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 11,
          padding: "11px 14px",
          margin: "0 2px",
          border: "none",
          borderRadius: 9,
          background: "transparent",
          color: "var(--text-2)",
          fontWeight: 600,
          fontSize: 14,
          cursor: "pointer",
        }}
      >
        {state.theme === "dark" ? <SunIcon size={19} /> : <MoonIcon size={19} />}
        <span>{state.theme === "dark" ? "Light mode" : "Dark mode"}</span>
      </button>

      <button
        onClick={() => navigate("profile")}
        style={{
          position: "sticky",
          bottom: 0,
          display: "flex",
          alignItems: "center",
          gap: 11,
          padding: "9px 11px",
          margin: "4px 2px 0",
          border: "1px solid var(--glass-border)",
          borderRadius: 10,
          background: "var(--glass-strong)",
          cursor: "pointer",
          width: "calc(100% - 4px)",
        }}
      >
        <Avatar pubkey={pubkey} size={36} name={name} picture={state.me?.picture} />
        <span style={{ textAlign: "left", flex: 1, minWidth: 0 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 4, fontWeight: 700, fontSize: 13.5, color: "var(--text)" }}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
            {state.me?.nip05 && <VerifiedSeal size={13} />}
          </span>
          <span
            style={{
              display: "block",
              fontSize: 11.5,
              color: "var(--text-3)",
              fontFamily: "'JetBrains Mono',monospace",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {state.me?.nip05 ?? (pubkey && shortNpub(pubkey))}
          </span>
        </span>
      </button>
    </aside>
  );
};

export const MobileNav = (): ReactNode => {
  const { state, navigate } = useStore();
  const view = state.nav.view;
  const items = NAV.filter((n) => ["home", "explore", "docs", "messages", "profile"].includes(n.id));
  return (
    <nav
      style={{
        position: "sticky",
        bottom: 0,
        display: "flex",
        justifyContent: "space-around",
        padding: "8px 4px",
        background: "var(--glass-strong)",
        borderTop: "1px solid var(--glass-border)",
        zIndex: 20,
      }}
    >
      {items.map((item) => {
        const active = view === item.id || (item.id === "docs" && view.startsWith("doc"));
        return (
          <button
            key={item.id}
            onClick={() => navigate(item.id)}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 3,
              background: "none",
              border: "none",
              cursor: "pointer",
              color: active ? "var(--accent)" : "var(--text-3)",
              fontSize: 10,
              fontWeight: 600,
              padding: "4px 10px",
            }}
          >
            {item.icon}
            {item.label}
          </button>
        );
      })}
    </nav>
  );
};
