import type { CSSProperties } from "react";

/**
 * Exact port of the Beamhop design's style-helper functions (beamhop-glass.html
 * ~lines 1997-2207). Views use these so feed/profile/agent surfaces are
 * pixel-identical to the design. Keep values verbatim.
 */

export const navStyle = (active: boolean): CSSProperties => ({
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
  fontFamily: "inherit",
  width: "100%",
  textAlign: "left",
  transition: "background .15s, color .15s",
});

export const tabStyle = (active: boolean): CSSProperties => ({
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "8px 14px",
  border: "none",
  background: "transparent",
  color: active ? "var(--accent)" : "var(--text-3)",
  cursor: "pointer",
  transition: "color .15s",
});

export const actionStyle = (active: boolean, color: string): CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: 7,
  padding: "6px 10px",
  borderRadius: 10,
  border: "none",
  background: "transparent",
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: 13,
  fontWeight: 600,
  color: active ? color : "var(--text-3)",
  transition: "color .18s, background .18s",
});

export const followStyle = (following: boolean): CSSProperties => {
  const base: CSSProperties = {
    padding: "7px 16px",
    borderRadius: 8,
    fontWeight: 700,
    fontSize: 12.5,
    cursor: "pointer",
    fontFamily: "inherit",
    transition: "background .15s, color .15s, border-color .15s, transform .12s",
    whiteSpace: "nowrap",
  };
  return following
    ? { ...base, background: "transparent", color: "var(--text-2)", border: "1px solid var(--glass-border)" }
    : { ...base, background: "var(--accent)", color: "var(--on-accent)", border: "1px solid var(--accent)" };
};

export const statusDot = (online: boolean, big?: boolean): CSSProperties => ({
  position: "absolute",
  right: big ? 2 : -1,
  bottom: big ? 2 : -1,
  width: big ? 15 : 12,
  height: big ? 15 : 12,
  borderRadius: "50%",
  background: online ? "var(--success)" : "var(--text-3)",
  border: `${big ? 3 : 2.5}px solid var(--bg-base)`,
  boxSizing: "border-box",
  zIndex: 3,
});

export const avatarWrap = (size: number, clickable?: boolean): CSSProperties => ({
  position: "relative",
  flexShrink: 0,
  width: size,
  height: size,
  display: "inline-block",
  cursor: clickable ? "pointer" : "default",
});

export const segStyle = (active: boolean): CSSProperties => ({
  padding: "6px 14px",
  borderRadius: 8,
  border: "none",
  background: active ? "var(--glass)" : "transparent",
  color: active ? "var(--text)" : "var(--text-3)",
  fontWeight: active ? 700 : 600,
  fontSize: 12.5,
  fontFamily: "inherit",
  cursor: "pointer",
  boxShadow: active ? "0 1px 3px rgba(0,0,0,.12)" : "none",
  transition: "all .15s",
});

export const chipSelectStyle = (active: boolean): CSSProperties => ({
  padding: "8px 14px",
  borderRadius: 9,
  border: active ? "1px solid var(--accent)" : "1px solid var(--glass-border)",
  background: active ? "var(--accent-soft)" : "var(--glass)",
  color: active ? "var(--accent)" : "var(--text-2)",
  fontWeight: active ? 700 : 600,
  fontSize: 13,
  fontFamily: "inherit",
  cursor: "pointer",
  transition: "all .15s",
});

export const rowSelectStyle = (active: boolean): CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: 12,
  width: "100%",
  textAlign: "left",
  padding: "13px 14px",
  borderRadius: 11,
  border: active ? "1px solid var(--accent)" : "1px solid var(--glass-border)",
  background: active ? "var(--accent-soft)" : "var(--glass)",
  cursor: "pointer",
  fontFamily: "inherit",
  transition: "all .15s",
});

export const checkBoxStyle = (active: boolean): CSSProperties => ({
  width: 20,
  height: 20,
  minWidth: 20,
  borderRadius: 6,
  border: active ? "none" : "1.5px solid var(--glass-border)",
  background: active ? "var(--accent)" : "transparent",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  transition: "all .15s",
});

export const profileTabStyle = (active: boolean): CSSProperties => ({
  padding: "0 0 11px",
  marginBottom: -1,
  border: "none",
  borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
  background: "transparent",
  color: active ? "var(--text)" : "var(--text-3)",
  fontWeight: active ? 700 : 600,
  fontSize: 14,
  fontFamily: "inherit",
  cursor: "pointer",
  transition: "color .15s, border-color .15s",
});

export const agentTabStyle = (active: boolean): CSSProperties => ({
  position: "relative",
  padding: "10px 2px",
  border: "none",
  background: "transparent",
  color: active ? "var(--text)" : "var(--text-3)",
  fontWeight: active ? 700 : 600,
  fontSize: 14,
  fontFamily: "inherit",
  cursor: "pointer",
  borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
  marginBottom: -1,
  transition: "color .15s",
});

export type AgentStatusMeta = { label: string; color: string; soft: string; dot: string };
export const agentStatusMeta = (status: string): AgentStatusMeta =>
  status === "active"
    ? { label: "Active", color: "var(--success)", soft: "var(--success-soft)", dot: "var(--success)" }
    : { label: "Paused", color: "var(--warn)", soft: "rgba(224,145,31,.13)", dot: "var(--warn)" };

/** The card shell used by every feed post / article (article element). */
export const postCardStyle: CSSProperties = {
  display: "block",
  padding: 16,
  border: "1px solid var(--glass-border)",
  borderRadius: 14,
  background: "var(--glass)",
  marginBottom: 12,
  transition: "background .15s, border-color .15s",
};
