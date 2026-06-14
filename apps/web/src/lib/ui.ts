import type { CSSProperties } from 'react';

/** Stable string hash (mirrors the design prototype). */
export function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

/** Two-letter initials from a name. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? '?';
  const second = parts[1]?.[0] ?? '';
  return (first + second).toUpperCase();
}

const GRADIENTS: ReadonlyArray<readonly [string, string]> = [
  ['#6366f1', '#a855f7'],
  ['#0ea5e9', '#6366f1'],
  ['#f43f5e', '#fb7185'],
  ['#10b981', '#22d3ee'],
  ['#f59e0b', '#f97316'],
  ['#8b5cf6', '#ec4899'],
  ['#14b8a6', '#0ea5e9'],
  ['#ef4444', '#f59e0b'],
];

/** Deterministic gradient avatar style for a seed string (mirrors design). */
export function avatarStyle(seed: string, size: number): CSSProperties {
  const g = GRADIENTS[hashString(seed) % GRADIENTS.length] ?? GRADIENTS[0]!;
  return {
    width: `${size}px`,
    height: `${size}px`,
    minWidth: `${size}px`,
    borderRadius: '50%',
    background: `linear-gradient(135deg,${g[0]},${g[1]})`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#fff',
    fontWeight: 700,
    fontSize: `${Math.round(size * 0.36)}px`,
    fontFamily: "'Space Grotesk',sans-serif",
    letterSpacing: '.3px',
    overflow: 'hidden',
    flexShrink: 0,
  };
}

/** Compact number formatting (1.2k, 12k). */
export function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return `${n}`;
}

/** Relative "time ago" label from a unix-seconds timestamp. */
export function timeAgo(unixSeconds: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (seconds < 45) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w`;
  return new Date(unixSeconds * 1000).toLocaleDateString();
}

/** Short clock time (HH:MM) for message bubbles. */
export function clockTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Truncate a long key string for display (npub1abc…wxyz). */
export function truncateMiddle(value: string, head = 24, tail = 6): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}
