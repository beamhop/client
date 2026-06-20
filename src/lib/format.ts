import type { CSSProperties } from "react";

export const timeAgo = (seconds: number): string => {
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - seconds);
  if (diff < 45) return "now";
  if (diff < 3600) return `${Math.round(diff / 60)}m`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h`;
  if (diff < 604800) return `${Math.round(diff / 86400)}d`;
  return new Date(seconds * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

export const fmtCount = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n}`;

export const hashCode = (s: string): number => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
};

export const initials = (name: string): string => {
  const parts = name.trim().split(/\s+/);
  const a = parts[0]?.[0] ?? "?";
  const b = parts[1]?.[0] ?? "";
  return (a + b).toUpperCase();
};

const GRADIENTS: ReadonlyArray<readonly [string, string]> = [
  ["#5b54f0", "#9b6dff"],
  ["#0ea5e9", "#5b54f0"],
  ["#f43f5e", "#fb7185"],
  ["#0fae74", "#22d3ee"],
  ["#f59e0b", "#f97316"],
  ["#8b5cf6", "#ec4899"],
  ["#14b8a6", "#0ea5e9"],
  ["#ef4444", "#f59e0b"],
];

/** Deterministic gradient avatar style, matching the design's avatar treatment. */
export const avatarStyle = (seed: string, size: number, picture?: string): CSSProperties => {
  const [c1] = GRADIENTS[hashCode(seed) % GRADIENTS.length] ?? (["#5b54f0", "#9b6dff"] as const);
  const radius = Math.max(8, Math.round(size * 0.28));
  const base: CSSProperties = {
    width: size,
    height: size,
    minWidth: size,
    borderRadius: radius,
    background: c1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#fff",
    fontWeight: 700,
    fontSize: Math.round(size * 0.38),
    fontFamily: "'Space Grotesk',sans-serif",
    letterSpacing: ".2px",
    flexShrink: 0,
    overflow: "hidden",
  };
  if (picture) {
    return {
      ...base,
      backgroundImage: `url("${picture}")`,
      backgroundSize: "cover",
      backgroundPosition: "center",
      backgroundRepeat: "no-repeat",
      color: "transparent",
    };
  }
  return base;
};

export const displayName = (opts: { name?: string; displayName?: string; pubkey: string }): string =>
  opts.displayName?.trim() || opts.name?.trim() || `${opts.pubkey.slice(0, 8)}…`;
