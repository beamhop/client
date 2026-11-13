/**
 * Every keyboard shortcut in the app, for the `?` sheet (one place, so screens never drift).
 * Global keys live in shortcuts.ts; screen keys in their screens (Inbox, Session view) — when you add a
 * key there, add it here too. `when` = the path prefix where a section applies (shown first there).
 */
import type { MessageKey } from '../i18n/index.ts';

export interface ShortcutSection {
  id: string;
  title: MessageKey;
  when?: string;
  keys: Array<{ keys: string[]; label: MessageKey; chord?: boolean }>;
}

export const SHORTCUT_SECTIONS: ShortcutSection[] = [
  {
    id: 'global',
    title: 'keys.global',
    keys: [
      { keys: ['mod+K'], label: 'keys.palette' },
      { keys: ['?'], label: 'keys.help' },
      { keys: ['N'], label: 'keys.needsYou' },
      { keys: ['g', 'h'], label: 'keys.goHome', chord: true },
      { keys: ['g', 'i'], label: 'keys.goInbox', chord: true },
      { keys: ['g', 's'], label: 'keys.goSessions', chord: true },
      { keys: ['g', 'a'], label: 'keys.goAgents', chord: true },
      { keys: ['g', 'c'], label: 'keys.goChannels', chord: true },
      { keys: ['g', 'p'], label: 'keys.goPolicy', chord: true },
      { keys: ['g', 'd'], label: 'keys.goDeploy', chord: true },
      { keys: ['g', 'u'], label: 'keys.goAudit', chord: true },
      { keys: ['g', ','], label: 'keys.goSettings', chord: true },
      { keys: ['mod+⇧+.'], label: 'keys.panic' },
      { keys: ['mod+\\'], label: 'keys.sidebar' },
      { keys: ['F6'], label: 'keys.toast' },
    ],
  },
  {
    id: 'inbox',
    title: 'keys.inbox',
    when: '/inbox',
    keys: [
      { keys: ['J', 'K'], label: 'inbox.keys.move' },
      { keys: ['A'], label: 'inbox.keys.allow' },
      { keys: ['⇧A'], label: 'inbox.keys.scope' },
      { keys: ['D'], label: 'inbox.keys.deny' },
      { keys: ['↵'], label: 'inbox.keys.details' },
      { keys: ['U', 'Z'], label: 'inbox.keys.undo' },
      { keys: ['R'], label: 'inbox.keys.reason' },
      { keys: ['X'], label: 'inbox.keys.select' },
    ],
  },
  {
    id: 'session',
    title: 'keys.session',
    when: '/sessions/',
    keys: [
      { keys: ['['], label: 'keys.sessionPrev' },
      { keys: [']'], label: 'keys.sessionNext' },
      { keys: ['mod+I'], label: 'keys.inspector' },
      { keys: ['↵'], label: 'keys.send' },
      { keys: ['⇧↵'], label: 'keys.newline' },
      { keys: ['/'], label: 'keys.slash' },
    ],
  },
  {
    id: 'sheets',
    title: 'keys.sheets',
    keys: [
      { keys: ['Esc'], label: 'keys.close' },
      { keys: ['Tab'], label: 'keys.tab' },
    ],
  },
];

/** Sections ordered for `pathname`: the screen's own keys first, then the rest. */
export const sectionsFor = (pathname: string): ShortcutSection[] => {
  const here = SHORTCUT_SECTIONS.filter((s) => s.when && pathname.startsWith(s.when));
  return [...here, ...SHORTCUT_SECTIONS.filter((s) => !here.includes(s))];
};
