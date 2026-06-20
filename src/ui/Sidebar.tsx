import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useStore, type ViewId } from "../state/store.tsx";
import { displayName, initials, avatarStyle } from "../lib/format.ts";
import { compileMutes, evaluateNotification } from "../lib/mute.ts";
import { shortNpub } from "../nostr/keys.ts";
import { PALETTE_ORDER, paletteBanner, type PaletteId } from "../lib/theme.ts";
import { navStyle, tabStyle } from "./styles.ts";
import {
  Logo,
  HomeIcon,
  SearchIcon,
  BellIcon,
  DocsIcon,
  MessagesIcon,
  AgentsIcon,
  ProfileIcon,
  ShieldIcon,
  PlusIcon,
  MoreIcon,
  SunIcon,
  MoonIcon,
  ChevronDownIcon,
  VerifiedSeal,
  CommandIcon,
} from "./icons.tsx";

type NavItem = { id: ViewId; testid: string; label: string; icon: ReactNode; active: (v: ViewId) => boolean };

const NAV: NavItem[] = [
  { id: "home", testid: "nav-home", label: "Home", icon: <HomeIcon />, active: (v) => v === "home" || v === "postDetail" },
  { id: "explore", testid: "nav-explore", label: "Explore", icon: <SearchIcon />, active: (v) => v === "explore" },
  { id: "notifications", testid: "nav-notifications", label: "Notifications", icon: <BellIcon />, active: (v) => v === "notifications" },
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
  const relayCount = state.relays.filter((r) => r.enabled && (r.read || r.write)).length;
  const muted = useMemo(() => compileMutes(state.muteSettings.rules), [state.muteSettings.rules]);
  const unreadNotifications = useMemo(
    () =>
      state.notifications.filter(
        (n) => !n.read && !evaluateNotification(muted, { pubkey: n.pubkey, content: n.content }),
      ).length,
    [state.notifications, muted],
  );

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
              <span style={{ display: "flex", position: "relative" }}>
                {item.icon}
                {item.id === "notifications" && unreadNotifications > 0 && (
                  <span
                    style={{
                      position: "absolute",
                      right: -4,
                      top: -4,
                      width: 9,
                      height: 9,
                      borderRadius: "50%",
                      background: "var(--danger)",
                      border: "2px solid var(--bg-base)",
                    }}
                  />
                )}
              </span>
              <span style={{ flex: 1, textAlign: "left" }}>{item.label}</span>
              {item.id === "notifications" && unreadNotifications > 0 && (
                <span
                  style={{
                    minWidth: 18,
                    height: 18,
                    padding: "0 6px",
                    borderRadius: 999,
                    background: "var(--danger)",
                    color: "#fff",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 11,
                    fontWeight: 800,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {unreadNotifications > 99 ? "99+" : unreadNotifications}
                </span>
              )}
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

type MobileDest = {
  id: ViewId;
  testid: string;
  label: string;
  icon: (size: number) => ReactNode;
  active: (v: ViewId) => boolean;
};

/**
 * Every bottom-nav destination in priority order. The compose button always
 * sits dead-centre with an equal number of tabs on each side; the lowest
 * priority destinations that don't fit fold into the "More" sheet instead of
 * overflowing the bar. `security` effectively always lives in "More".
 */
const MOBILE_DESTS: MobileDest[] = [
  { id: "home", testid: "tab-home", label: "Home", icon: (s) => <HomeIcon size={s} />, active: (v) => v === "home" || v === "postDetail" },
  { id: "explore", testid: "tab-explore", label: "Explore", icon: (s) => <SearchIcon size={s} />, active: (v) => v === "explore" },
  { id: "notifications", testid: "tab-notifications", label: "Notifications", icon: (s) => <BellIcon size={s} />, active: (v) => v === "notifications" },
  { id: "messages", testid: "tab-messages", label: "Messages", icon: (s) => <MessagesIcon size={s} />, active: (v) => v === "messages" },
  { id: "profile", testid: "tab-profile", label: "Profile", icon: (s) => <ProfileIcon size={s} />, active: (v) => v === "profile" },
  { id: "agents", testid: "tab-agents", label: "Agents", icon: (s) => <AgentsIcon size={s} />, active: (v) => v === "agents" || v === "agentDetail" },
  { id: "docs", testid: "tab-docs", label: "Docs", icon: (s) => <DocsIcon size={s} />, active: (v) => v.startsWith("doc") },
  { id: "security", testid: "tab-security", label: "Keys & Security", icon: (s) => <ShieldIcon size={s} />, active: (v) => v === "security" },
];

/**
 * Largest symmetric per-side tab count (2–4) that fits `innerWidth` without the
 * bar overflowing. The compose button is the exact centre: `slots` buttons sit
 * on each side, the final right-side slot being the "More" overflow trigger.
 */
export const mobileNavSlots = (innerWidth: number): number => {
  const COMPOSE_FOOTPRINT = 56; // raised compose button + breathing room
  const TAB_FOOTPRINT = 54; // icon + horizontal padding per tab
  const available = innerWidth - 32; // nav side margins (20) + inner padding (12)
  const fit = Math.floor((available - COMPOSE_FOOTPRINT) / (2 * TAB_FOOTPRINT));
  return Math.max(2, Math.min(4, fit));
};

const sideGroupStyle: CSSProperties = { flex: 1, minWidth: 0, display: "flex", alignItems: "center", justifyContent: "space-around" };

const notifBadge = (count: number): ReactNode => (
  <span style={{ position: "absolute", right: -5, top: -5, minWidth: 15, height: 15, padding: "0 3px", borderRadius: 999, background: "var(--danger)", color: "#fff", fontSize: 9, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1 }}>
    {count > 9 ? "9+" : count}
  </span>
);

const MoreSheet = ({
  items,
  unread,
  view,
  onNavigate,
  onClose,
}: {
  items: MobileDest[];
  unread: number;
  view: ViewId;
  onNavigate: (id: ViewId) => void;
  onClose: () => void;
}): ReactNode => {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      data-testid="more-sheet"
      role="dialog"
      aria-modal="true"
      aria-label="More destinations"
      onClick={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 40, display: "flex", flexDirection: "column", justifyContent: "flex-end", background: "rgba(6,7,13,.5)", backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)", animation: "verity-fade .16s ease" }}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        style={{ margin: "0 10px calc(10px + env(safe-area-inset-bottom))", padding: "8px 8px 12px", borderRadius: 18, background: "var(--glass-strong)", border: "1px solid var(--glass-border)", boxShadow: "var(--glass-shadow-lg)", animation: "verity-slideup .22s ease" }}
      >
        <span aria-hidden style={{ display: "block", width: 38, height: 4, borderRadius: 999, background: "var(--glass-border)", margin: "4px auto 10px" }} />
        {items.map((d) => (
          <button key={d.id} data-testid={`more-${d.id}`} onClick={() => onNavigate(d.id)} style={navStyle(d.active(view))}>
            <span style={{ display: "flex", position: "relative" }}>
              {d.icon(21)}
              {d.id === "notifications" && unread > 0 && notifBadge(unread)}
            </span>
            <span style={{ flex: 1, textAlign: "left" }}>{d.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
};

export const MobileNav = ({ onCompose, onOpenPalette }: { onCompose: () => void; onOpenPalette: () => void }): ReactNode => {
  const { state, navigate } = useStore();
  const view = state.nav.view;
  const muted = useMemo(() => compileMutes(state.muteSettings.rules), [state.muteSettings.rules]);
  const unreadNotifications = useMemo(
    () =>
      state.notifications.filter(
        (n) => !n.read && !evaluateNotification(muted, { pubkey: n.pubkey, content: n.content }),
      ).length,
    [state.notifications, muted],
  );
  const [slots, setSlots] = useState<number>(() => (typeof window === "undefined" ? 3 : mobileNavSlots(window.innerWidth)));
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => {
    const onResize = (): void => setSlots(mobileNavSlots(window.innerWidth));
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Reserve one right slot for the command palette button in addition to "More"
  const visibleCount = 2 * slots - 2;
  const leftTabs = MOBILE_DESTS.slice(0, slots);
  const rightTabs = MOBILE_DESTS.slice(slots, visibleCount);
  const hidden = MOBILE_DESTS.slice(visibleCount);
  const moreActive = moreOpen || hidden.some((d) => d.active(view));

  const tab = (d: MobileDest): ReactNode => (
    <button key={d.id} data-testid={d.testid} onClick={() => navigate(d.id)} style={tabStyle(d.active(view))}>
      <span style={{ display: "flex", position: "relative" }}>
        {d.icon(24)}
        {d.id === "notifications" && unreadNotifications > 0 && notifBadge(unreadNotifications)}
      </span>
    </button>
  );

  return (
    <>
      <nav
        data-testid="bottom-nav"
        style={{ position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 20, display: "flex", alignItems: "center", padding: "8px 6px calc(8px + env(safe-area-inset-bottom))", margin: "0 10px 10px", borderRadius: 14, background: "var(--glass-strong)", border: "1px solid var(--glass-border)", boxShadow: "var(--glass-shadow-lg)" }}
      >
        <div data-testid="bottom-nav-left" style={sideGroupStyle}>{leftTabs.map(tab)}</div>
        <button
          data-testid="compose-button-mobile"
          onClick={onCompose}
          style={{ flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", width: 52, height: 52, marginTop: -18, border: "1px solid rgba(255,255,255,.3)", borderRadius: 12, background: "var(--accent)", color: "var(--on-accent)", cursor: "pointer", transition: "transform .15s" }}
        >
          <PlusIcon size={24} stroke={2.4} />
        </button>
        <div data-testid="bottom-nav-right" style={sideGroupStyle}>
          {rightTabs.map(tab)}
          <button
            data-testid="tab-palette"
            aria-label="Command palette"
            onClick={onOpenPalette}
            style={tabStyle(false)}
          >
            <CommandIcon size={24} />
          </button>
          <button
            data-testid="tab-more"
            aria-label="More"
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen(true)}
            style={tabStyle(moreActive)}
          >
            <MoreIcon size={24} />
          </button>
        </div>
      </nav>
      {moreOpen && (
        <MoreSheet
          items={hidden}
          unread={unreadNotifications}
          view={view}
          onNavigate={(id) => {
            navigate(id);
            setMoreOpen(false);
          }}
          onClose={() => setMoreOpen(false)}
        />
      )}
    </>
  );
};
