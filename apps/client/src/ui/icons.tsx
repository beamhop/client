import type { ReactNode } from "react";

type IconProps = { size?: number; stroke?: number; fill?: string };

const Svg = ({
  size = 21,
  stroke = 2,
  fill = "none",
  children,
}: IconProps & { children: ReactNode }): ReactNode => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill={fill}
    stroke="currentColor"
    strokeWidth={stroke}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {children}
  </svg>
);

export const HomeIcon = (p: IconProps): ReactNode => (
  <Svg {...p}>
    <path d="M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" />
  </Svg>
);
export const SearchIcon = (p: IconProps): ReactNode => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />
  </Svg>
);
export const BellIcon = (p: IconProps): ReactNode => (
  <Svg {...p}>
    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
    <path d="M10 21a2 2 0 0 0 4 0" />
  </Svg>
);
export const AtIcon = (p: IconProps): ReactNode => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94" />
  </Svg>
);
export const DocsIcon = (p: IconProps): ReactNode => (
  <Svg {...p}>
    <path d="M4 4a2 2 0 0 1 2-2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
    <path d="M14 2v6h6M9 13h6M9 17h6" />
  </Svg>
);
export const MessagesIcon = (p: IconProps): ReactNode => (
  <Svg {...p}>
    <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </Svg>
);
export const AgentsIcon = (p: IconProps): ReactNode => (
  <Svg {...p}>
    <rect x="4" y="7" width="16" height="12" rx="3" />
    <path d="M12 7V4M9 13h.01M15 13h.01M2 12h2M20 12h2" />
  </Svg>
);
export const ProfileIcon = (p: IconProps): ReactNode => (
  <Svg {...p}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21a8 8 0 0 1 16 0" />
  </Svg>
);
export const ShieldIcon = (p: IconProps): ReactNode => (
  <Svg {...p}>
    <path d="M12 22s8-3.5 8-9.5V5l-8-3-8 3v7.5C4 18.5 12 22 12 22z" />
    <path d="m9 12 2 2 4-4" />
  </Svg>
);
export const PlusIcon = (p: IconProps): ReactNode => (
  <Svg {...p} stroke={p.stroke ?? 2.4}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);
export const HeartIcon = ({ filled, ...p }: IconProps & { filled?: boolean }): ReactNode => (
  <Svg {...p} fill={filled ? "currentColor" : "none"}>
    <path d="M20.8 6.6a5 5 0 0 0-8.8-1.6A5 5 0 0 0 3.2 6.6c-1.2 2.6.3 5.2 2.3 7.1L12 19.5l6.5-5.8c2-1.9 3.5-4.5 2.3-7.1z" />
  </Svg>
);
export const ReplyIcon = (p: IconProps): ReactNode => (
  <Svg {...p}>
    <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </Svg>
);
export const RepostIcon = (p: IconProps): ReactNode => (
  <Svg {...p}>
    <path d="M17 2l4 4-4 4" />
    <path d="M3 11V9a4 4 0 0 1 4-4h14M7 22l-4-4 4-4" />
    <path d="M21 13v2a4 4 0 0 1-4 4H3" />
  </Svg>
);
export const BookmarkIcon = ({ filled, ...p }: IconProps & { filled?: boolean }): ReactNode => (
  <Svg {...p} fill={filled ? "currentColor" : "none"}>
    <path d="M5 3h14a1 1 0 0 1 1 1v17l-8-5-8 5V4a1 1 0 0 1 1-1z" />
  </Svg>
);
export const MoreIcon = (p: IconProps): ReactNode => (
  <Svg {...p}>
    <circle cx="5" cy="12" r="1.4" />
    <circle cx="12" cy="12" r="1.4" />
    <circle cx="19" cy="12" r="1.4" />
  </Svg>
);
export const CheckIcon = (p: IconProps): ReactNode => (
  <Svg {...p} stroke={p.stroke ?? 2.4}>
    <path d="M5 12l5 5L20 6" />
  </Svg>
);
export const CopyIcon = (p: IconProps): ReactNode => (
  <Svg {...p}>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </Svg>
);
export const CloseIcon = (p: IconProps): ReactNode => (
  <Svg {...p} stroke={p.stroke ?? 2.2}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);
export const ChevronDownIcon = (p: IconProps): ReactNode => (
  <Svg {...p} stroke={p.stroke ?? 2.2}>
    <path d="m6 9 6 6 6-6" />
  </Svg>
);
export const ChevronLeftIcon = (p: IconProps): ReactNode => (
  <Svg {...p} stroke={p.stroke ?? 2.2}>
    <path d="m15 18-6-6 6-6" />
  </Svg>
);
export const SunIcon = (p: IconProps): ReactNode => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Svg>
);
export const MoonIcon = (p: IconProps): ReactNode => (
  <Svg {...p}>
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
  </Svg>
);
export const SendIcon = (p: IconProps): ReactNode => (
  <Svg {...p}>
    <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z" />
  </Svg>
);
export const ImageIcon = (p: IconProps): ReactNode => (
  <Svg {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="9" cy="9" r="2" />
    <path d="m21 15-5-5L5 21" />
  </Svg>
);
export const KeyIcon = (p: IconProps): ReactNode => (
  <Svg {...p}>
    <circle cx="8" cy="15" r="4" />
    <path d="M10.8 12.2 21 2M17 5l3 3M14 8l3 3" />
  </Svg>
);
export const EyeIcon = (p: IconProps): ReactNode => (
  <Svg {...p}>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
    <circle cx="12" cy="12" r="3" />
  </Svg>
);
export const EyeOffIcon = (p: IconProps): ReactNode => (
  <Svg {...p}>
    <path d="M9.9 4.2A10 10 0 0 1 12 4c6.5 0 10 7 10 7a17 17 0 0 1-3 3.8M6.1 6.1A17 17 0 0 0 2 11s3.5 7 10 7a10 10 0 0 0 4-.8M1 1l22 22" />
  </Svg>
);
export const CommandIcon = (p: IconProps): ReactNode => (
  <Svg {...p}>
    <path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3z" />
  </Svg>
);

export const ShareIcon = (p: IconProps): ReactNode => (
  <Svg {...p}>
    <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" />
    <path d="M16 6l-4-4-4 4M12 2v13" />
  </Svg>
);
export const TrashIcon = (p: IconProps): ReactNode => (
  <Svg {...p}>
    <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6" />
  </Svg>
);

/** The verified seal used throughout the design. */
export const VerifiedSeal = ({ size = 14 }: { size?: number }): ReactNode => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="var(--accent)" aria-label="Verified">
    <path d="M12 2l2.4 1.8 3-.2 1 2.8 2.5 1.6-.8 2.9.8 2.9-2.5 1.6-1 2.8-3-.2L12 22l-2.4-1.8-3 .2-1-2.8L3.1 16l.8-2.9L3.1 10l2.5-1.6 1-2.8 3 .2L12 2z" />
    <path
      d="m8.5 12 2.2 2.2 4.8-4.8"
      stroke="#fff"
      strokeWidth="2"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const Logo = ({ size = 32 }: { size?: number }): ReactNode => (
  <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
    <rect width="32" height="32" rx="9" fill="url(#beamhop-lg)" />
    <path d="M16 7.5l6.4 8.5-6.4 8.5L9.6 16 16 7.5z" fill="#fff" fillOpacity=".96" />
    <circle cx="16" cy="16" r="2.5" fill="url(#beamhop-lg)" />
    <defs>
      <linearGradient id="beamhop-lg" x1="0" y1="0" x2="32" y2="32">
        <stop stopColor="var(--accent)" />
        <stop offset="1" stopColor="var(--accent-2)" />
      </linearGradient>
    </defs>
  </svg>
);
