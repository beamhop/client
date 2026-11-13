import {
  Broadcast,
  ChatsTeardrop,
  CloudArrowUp,
  Cpu,
  DotsNine,
  type Icon,
  Plugs,
  Pulse,
  ShieldCheck,
  SlidersHorizontal,
  Toolbox,
  Tray,
} from '@phosphor-icons/react';

export interface NavItem {
  to: string;
  label: string;
  icon: Icon;
  /** Keyboard chord after `g` (desktop). */
  chord?: string;
  /** Paths (prefixes) that make this item active. */
  match: string[];
}

export const NAV: Record<string, NavItem> = {
  home: { to: '/', label: 'Home', icon: Broadcast, chord: 'h', match: ['/'] },
  inbox: { to: '/inbox', label: 'Inbox', icon: Tray, chord: 'i', match: ['/inbox'] },
  sessions: { to: '/sessions', label: 'Sessions', icon: ChatsTeardrop, chord: 's', match: ['/sessions'] },
  agents: { to: '/agents', label: 'Agents', icon: Cpu, chord: 'a', match: ['/agents'] },
  channels: { to: '/channels', label: 'Channels', icon: Plugs, chord: 'c', match: ['/channels'] },
  harnesses: { to: '/harnesses', label: 'Harnesses', icon: Toolbox, match: ['/harnesses'] },
  policy: { to: '/policy', label: 'Policy', icon: ShieldCheck, chord: 'p', match: ['/policy'] },
  deploy: { to: '/deploy', label: 'Deploy', icon: CloudArrowUp, chord: 'd', match: ['/deploy'] },
  audit: { to: '/audit', label: 'Audit', icon: Pulse, chord: 'u', match: ['/audit'] },
  settings: { to: '/settings', label: 'Settings', icon: SlidersHorizontal, match: ['/settings'] },
  more: {
    to: '/more',
    label: 'More',
    icon: DotsNine,
    match: ['/more', '/channels', '/harnesses', '/policy', '/deploy', '/audit', '/settings', '/panic', '/_kitchen'],
  },
};

/** Compact bottom tab bar (DESIGN §9.4): exactly five. */
export const TABS = [NAV.home!, NAV.inbox!, NAV.sessions!, NAV.agents!, NAV.more!];

/** Expanded sidebar groups. */
export const SIDEBAR_GROUPS: Array<{ label: string; items: NavItem[] }> = [
  { label: 'Operate', items: [NAV.home!, NAV.inbox!, NAV.sessions!] },
  { label: 'Configure', items: [NAV.agents!, NAV.channels!, NAV.harnesses!, NAV.policy!] },
  { label: 'Run', items: [NAV.deploy!, NAV.audit!, NAV.settings!] },
];

/** "More" list on compact. */
export const MORE_ITEMS = [NAV.channels!, NAV.harnesses!, NAV.policy!, NAV.deploy!, NAV.audit!, NAV.settings!];

export const isActive = (item: NavItem, pathname: string): boolean =>
  item.match.some((m) => (m === '/' ? pathname === '/' : pathname === m || pathname.startsWith(`${m}/`)));
