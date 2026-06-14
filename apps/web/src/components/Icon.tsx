import type { ReactNode } from 'react';

export type IconName =
  | 'home'
  | 'search'
  | 'messages'
  | 'user'
  | 'shield'
  | 'plus'
  | 'sun'
  | 'moon'
  | 'reply'
  | 'repost'
  | 'heart'
  | 'bookmark'
  | 'share'
  | 'pin'
  | 'send'
  | 'lock'
  | 'chevron-down'
  | 'chevron-right'
  | 'chevron-left'
  | 'edit'
  | 'copy'
  | 'link'
  | 'check'
  | 'x'
  | 'globe'
  | 'key'
  | 'rotate'
  | 'logout'
  | 'download'
  | 'device'
  | 'play'
  | 'image'
  | 'film'
  | 'music'
  | 'eye'
  | 'alert'
  | 'maximize'
  | 'trash';

const STROKE: Partial<Record<IconName, ReactNode>> = {
  home: <path d="M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" />,
  search: (
    <>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </>
  ),
  messages: <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  shield: (
    <>
      <path d="M12 22s8-3.5 8-9.5V5l-8-3-8 3v7.5C4 18.5 12 22 12 22z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  moon: <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />,
  reply: <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
  repost: (
    <>
      <path d="m17 2 4 4-4 4" />
      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <path d="m7 22-4-4 4-4" />
      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
    </>
  ),
  heart: <path d="M20.8 5.6a5.3 5.3 0 0 0-7.5 0L12 6.9l-1.3-1.3a5.3 5.3 0 1 0-7.5 7.5L12 22l8.8-8.9a5.3 5.3 0 0 0 0-7.5z" />,
  bookmark: <path d="m19 21-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />,
  share: (
    <>
      <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" />
      <path d="M16 6l-4-4-4 4M12 2v13" />
    </>
  ),
  send: (
    <>
      <path d="m22 2-7 20-4-9-9-4z" />
      <path d="M22 2 11 13" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </>
  ),
  'chevron-down': <path d="m6 9 6 6 6-6" />,
  'chevron-right': <path d="m9 6 6 6-6 6" />,
  'chevron-left': <path d="m15 18-6-6 6-6" />,
  edit: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </>
  ),
  link: (
    <>
      <circle cx="9" cy="9" r="3" />
      <path d="M12 9h9M17 6l3 3-3 3" />
    </>
  ),
  check: <path d="M5 13l4 4L19 7" />,
  x: <path d="M18 6 6 18M6 6l12 12" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M2 12h20M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z" />
    </>
  ),
  key: <path d="M12 22s8-3.5 8-9.5V5l-8-3-8 3v7.5C4 18.5 12 22 12 22z" />,
  rotate: (
    <>
      <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
      <path d="M21 3v5h-5" />
    </>
  ),
  logout: (
    <>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5M21 12H9" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 21h14" />
    </>
  ),
  device: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </>
  ),
  play: <path d="M7 4v16l13-8z" />,
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.6" />
      <path d="m21 15-5-5L5 21" />
    </>
  ),
  film: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4" />
    </>
  ),
  music: (
    <>
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  alert: (
    <>
      <path d="M12 2 2 21h20L12 2z" />
      <path d="M12 9v5M12 17h.01" />
    </>
  ),
  maximize: <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M3 16v3a2 2 0 0 1 2 2h3" />,
  trash: <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6M10 11v6M14 11v6" />,
};

/** The verified badge (filled, with an inner check). */
function VerifiedBadge({ size }: { size: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="var(--accent)" aria-hidden>
      <path d="M12 2l2.4 1.8 3-.2 1 2.8 2.5 1.6-.8 2.9.8 2.9-2.5 1.6-1 2.8-3-.2L12 22l-2.4-1.8-3 .2-1-2.8L3.1 16l.8-2.9L3.1 10l2.5-1.6 1-2.8 3 .2L12 2z" />
      <path d="m8.5 12 2.2 2.2 4.8-4.8" stroke="#fff" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export interface IconProps {
  name: IconName;
  size?: number;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
}

export function Icon({ name, size = 20, fill = 'none', stroke = 'currentColor', strokeWidth = 2 }: IconProps): ReactNode {
  const inner = STROKE[name];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke={stroke}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {inner}
    </svg>
  );
}

export function Verified({ size = 15 }: { size?: number }): ReactNode {
  return <VerifiedBadge size={size} />;
}

/** The Verity wordmark logo glyph. */
export function Logo({ size = 32 }: { size?: number }): ReactNode {
  const gid = `lg-${size}`;
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <rect width="32" height="32" rx="9" fill={`url(#${gid})`} />
      <path d="M16 7.5l6.4 8.5-6.4 8.5L9.6 16 16 7.5z" fill="#fff" fillOpacity=".96" />
      <circle cx="16" cy="16" r="2.5" fill={`url(#${gid})`} />
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="32" y2="32">
          <stop stopColor="#6366f1" />
          <stop offset="1" stopColor="#a855f7" />
        </linearGradient>
      </defs>
    </svg>
  );
}
