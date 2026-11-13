/**
 * ⌘K command palette + `?` keyboard-shortcut sheet (DESIGN §9.4, SCREENS §0.3). Lazy chunk, mounted
 * once by the shell; opened through `overlays.ts` from the keyboard, the sidebar search button, More
 * and the Inbox. The palette is instant (no motion: it is a frequent action, DESIGN §8.1.4).
 *
 * Commands mirror CLI verbs (typing `agent stop reviewer` or `channel add` finds them) and cover:
 * actions (stop everything, new agent, add channel, review / allow the next approval…), every screen
 * and settings section, and live objects (agents, sessions, channels) from the daemon.
 */
import type { ApprovalView } from '@beamhop/core';
import {
  ArrowRight,
  ChatsTeardrop,
  Check,
  CloudArrowUp,
  Cpu,
  DeviceMobile,
  type Icon,
  Keyboard,
  MagnifyingGlass,
  Moon,
  Plugs,
  Plus,
  SlidersHorizontal,
  Stop,
  Sun,
  Toolbox,
  Tray,
} from '@phosphor-icons/react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { type ReactNode, useMemo } from 'react';
import {
  Autocomplete,
  Dialog,
  Header,
  Input,
  Menu,
  MenuItem,
  MenuSection,
  Modal,
  ModalOverlay,
  SearchField,
  useFilter,
} from 'react-aria-components';
import { approvalTarget, providerMonogram, useApi, useCall, useConnection } from '../api/index.ts';
import { type MessageKey, t } from '../i18n/index.ts';
import { useAppearance } from '../lib/appearance.ts';
import { cx } from '../lib/cx.ts';
import { haptic } from '../lib/haptics.ts';
import { Kbd, LetterTile } from '../ui/Meta.tsx';
import { Sheet } from '../ui/Sheet.tsx';
import { useToast } from '../ui/Toast.tsx';
import { NAV } from './nav.ts';
import { closeOverlay, modKey, openOverlay, useOverlay } from './overlays.ts';
import { usePanicSheet } from './panic.tsx';
import { sectionsFor } from './shortcut-list.ts';

interface Command {
  id: string;
  label: string;
  /** Extra words the filter matches (CLI verbs, ids). */
  keywords?: string;
  /** Mono hint on the right (chord, kind, id). */
  hint?: string;
  icon?: ReactNode;
  tone?: 'stop';
  run: () => void;
}

interface Section {
  id: string;
  title: string;
  items: Command[];
}

const SETTINGS: Array<{ id: string; title: MessageKey }> = [
  { id: 'devices', title: 'settings.section.devices' },
  { id: 'identity', title: 'settings.section.identity' },
  { id: 'owners', title: 'settings.section.owners' },
  { id: 'secrets', title: 'settings.section.secrets' },
  { id: 'retention', title: 'settings.section.retention' },
  { id: 'notifications', title: 'settings.section.notifications' },
  { id: 'updates', title: 'settings.section.updates' },
  { id: 'appearance', title: 'settings.section.appearance' },
  { id: 'stop', title: 'settings.section.stop' },
];

const icon = (I: Icon) => <I size={18} aria-hidden="true" />;

/** Oldest pending approval first: the one closest to auto-deny. */
const nextApproval = (xs: ApprovalView[] | undefined) =>
  xs?.filter((a) => a.status === 'pending').sort((a, b) => a.expiresAt.localeCompare(b.expiresAt))[0];

const usePaletteSections = (enabled: boolean): Section[] => {
  const navigate = useNavigate();
  const go = (to: string) => () => void navigate({ to });
  const conn = useConnection();
  const live = enabled && conn.kind !== 'none';
  const agents = useApi('agent.list', undefined, { enabled: live });
  const sessions = useApi('session.list', undefined, { enabled: live });
  const channels = useApi('channel.list', undefined, { enabled: live });
  const approvals = useApi('approval.list', undefined, { enabled: live });
  const { open: openPanic } = usePanicSheet();
  const [, resolved, setAppearance] = useAppearance();
  const call = useCall();
  const toast = useToast();

  // Cheap, and only computed while the palette is open.
  return (() => {
    const next = nextApproval(approvals.data?.approvals);
    const allowNext = (a: ApprovalView) => () => {
      call('approval.decide', { id: a.id, allow: true, always: false })
        .then(() => {
          haptic('confirm');
          toast.show({
            message: t('palette.allowed', { what: approvalTarget(a) }),
            tone: 'success',
            onUndo: () => call('approval.undo', { id: a.id }).then(() => undefined),
          });
        })
        .catch((e: Error) => toast.show({ message: e.message, tone: 'error' }));
    };
    const actions: Command[] = [
      ...(next
        ? [
            next.risk === 'low'
              ? {
                  id: 'allow-next',
                  label: t('palette.allowNext', { agent: next.agent, what: approvalTarget(next) }),
                  keywords: 'approve next approval allow once',
                  hint: t('ui.overlays.lowRisk'),
                  icon: icon(Check),
                  run: allowNext(next),
                }
              : {
                  id: 'review-next',
                  label: t('palette.reviewNext', { agent: next.agent, what: approvalTarget(next) }),
                  keywords: 'approve next approval',
                  hint: `${next.risk} risk`,
                  icon: icon(Tray),
                  run: go(`/inbox/${next.id}`),
                },
          ]
        : []),
      {
        id: 'panic',
        label: t('panic.button'),
        keywords: 'panic stop all kill switch',
        hint: `${modKey()}⇧.`,
        icon: icon(Stop),
        tone: 'stop',
        run: openPanic,
      },
      {
        id: 'new-agent',
        label: t('palette.newAgent'),
        keywords: 'agent create add',
        icon: icon(Plus),
        run: go('/agents/new'),
      },
      {
        id: 'add-channel',
        label: t('palette.addChannel'),
        keywords: 'channel add telegram slack discord nostr',
        icon: icon(Plugs),
        run: go('/channels/add'),
      },
      {
        id: 'pair-device',
        label: t('palette.pairDevice'),
        keywords: 'device pair phone',
        icon: icon(DeviceMobile),
        run: go('/settings/devices'),
      },
      {
        id: 'deploy',
        label: t('palette.deploy'),
        keywords: 'deploy cloud new',
        icon: icon(CloudArrowUp),
        run: go('/deploy/new'),
      },
      {
        id: 'scan',
        label: t('palette.scan'),
        keywords: 'harness scan doctor',
        icon: icon(Toolbox),
        run: go('/harnesses'),
      },
      {
        id: 'theme',
        label: resolved.theme === 'dark' ? t('palette.themeLight') : t('palette.themeDark'),
        keywords: 'theme appearance dark light night paper',
        icon: icon(resolved.theme === 'dark' ? Sun : Moon),
        run: () => setAppearance({ theme: resolved.theme === 'dark' ? 'light' : 'dark' }),
      },
      {
        id: 'shortcuts',
        label: t('keys.title'),
        keywords: 'help keyboard shortcuts',
        hint: '?',
        icon: icon(Keyboard),
        run: () => queueMicrotask(() => openOverlay('shortcuts')),
      },
    ];

    const screens: Command[] = Object.entries(NAV)
      .filter(([k]) => k !== 'more')
      .map(([k, n]) => ({
        id: `go-${k}`,
        label: n.label,
        keywords: `go ${n.to}`,
        hint: n.chord ? `g ${n.chord}` : undefined,
        icon: <n.icon size={18} aria-hidden="true" />,
        run: go(n.to),
      }));
    const settings: Command[] = SETTINGS.map((s) => ({
      id: `set-${s.id}`,
      label: t(s.title),
      keywords: `settings ${s.id}`,
      hint: 'settings',
      icon: icon(SlidersHorizontal),
      run: go(`/settings/${s.id}`),
    }));

    const agentItems: Command[] = (agents.data?.agents ?? []).flatMap((a) => {
      const name = a.config.name;
      const items: Command[] = [
        {
          id: `agent-${name}`,
          label: name,
          keywords: `agent ${a.config.harness}`,
          hint: a.config.harness,
          icon: icon(Cpu),
          run: go(`/agents/${name}`),
        },
      ];
      if (a.status === 'busy' || a.status === 'idle' || a.status === 'starting')
        items.push({
          id: `agent-stop-${name}`,
          label: t('palette.stopAgent', { name }),
          keywords: `agent stop ${name}`,
          hint: t('ui.overlays.agentStop'),
          icon: icon(Stop),
          run: () => {
            call('agent.stop', { name })
              .then(() => toast.show({ message: t('palette.stopped', { name }), tone: 'success' }))
              .catch((e: Error) => toast.show({ message: e.message, tone: 'error' }));
          },
        });
      return items;
    });
    const sessionItems: Command[] = (sessions.data?.sessions ?? [])
      .slice()
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
      .slice(0, 12)
      .map((s) => ({
        id: `session-${s.id}`,
        label: s.title,
        keywords: `session ${s.agent} ${s.threadId}`,
        hint: s.agent,
        icon: icon(ChatsTeardrop),
        run: go(`/sessions/${s.id}`),
      }));
    const channelItems: Command[] = (channels.data?.channels ?? []).map((c) => ({
      id: `channel-${c.config.name}`,
      label: c.self?.handle ?? c.self?.displayName ?? c.config.name,
      keywords: `channel ${c.config.provider} ${c.config.name}`,
      hint: c.config.provider,
      icon: <LetterTile code={providerMonogram(c.config.provider)} size={22} />,
      run: go(`/channels/${c.config.name}`),
    }));

    return [
      { id: 'actions', title: t('palette.actions'), items: actions },
      { id: 'agents', title: t('nav.agents'), items: agentItems },
      { id: 'sessions', title: t('nav.sessions'), items: sessionItems },
      { id: 'channels', title: t('nav.channels'), items: channelItems },
      { id: 'screens', title: t('palette.screens'), items: screens },
      { id: 'settings', title: t('nav.settings'), items: settings },
    ].filter((s) => s.items.length > 0);
  })();
};

export const CommandPalette = () => {
  const open = useOverlay() === 'palette';
  const sections = usePaletteSections(open);
  const { contains } = useFilter({ sensitivity: 'base' });
  const byId = useMemo(() => new Map(sections.flatMap((s) => s.items.map((c) => [c.id, c]))), [sections]);
  if (!open) return null;
  return (
    <ModalOverlay
      isOpen
      isDismissable
      onOpenChange={(o) => !o && closeOverlay()}
      className="fixed inset-0 z-[80] flex items-start justify-center bg-scrim px-4 pt-[max(12px,var(--bh-safe-top))] medium:pt-[12dvh]"
    >
      <Modal className="flex max-h-[min(80dvh,560px)] w-full max-w-[640px] flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-pop outline-none">
        <Dialog aria-label={t('palette.title')} className="flex min-h-0 flex-1 flex-col outline-none">
          <Autocomplete filter={(text, input) => contains(text, input)}>
            <SearchField aria-label={t('palette.search')} autoFocus className="shrink-0 border-b border-line">
              <div className="flex h-14 items-center gap-3 px-4">
                <MagnifyingGlass size={20} aria-hidden="true" className="text-ink-2" />
                <Input
                  placeholder={t('palette.placeholder')}
                  className="h-full min-w-0 flex-1 bg-transparent type-body text-ink outline-none placeholder:text-ink-3 [&::-webkit-search-cancel-button]:hidden"
                />
                <Kbd>Esc</Kbd>
              </div>
            </SearchField>
            {/* The list scrolls in its own region: focus stays in the search field (virtual focus), so the
                region itself takes a tab stop for keyboard scrolling (axe scrollable-region-focusable). */}
            <div
              role="region"
              aria-label={t('palette.results')}
              // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users must be able to scroll it
              tabIndex={0}
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
            >
              <Menu
                aria-label={t('palette.results')}
                onAction={(key) => {
                  const c = byId.get(String(key));
                  closeOverlay();
                  c?.run();
                }}
                renderEmptyState={() => (
                  <p className="px-4 py-6 type-body-sm text-ink-2">{t('palette.empty')}</p>
                )}
                className="p-1.5 outline-none"
              >
                {sections.map((s) => (
                  <MenuSection key={s.id} id={s.id} className="pb-1">
                    <Header className="px-2.5 pt-2 pb-1 type-micro text-ink-3">{s.title}</Header>
                    {s.items.map((c) => (
                      <MenuItem
                        key={c.id}
                        id={c.id}
                        textValue={`${c.label} ${c.keywords ?? ''}`}
                        className={cx(
                          'flex min-h-11 cursor-default items-center gap-3 rounded-md px-2.5 outline-none',
                          'data-[focused]:bg-sunken data-[pressed]:bg-sunken',
                          c.tone === 'stop' ? 'text-stop-text' : 'text-ink',
                        )}
                      >
                        <span className="grid w-7 shrink-0 place-items-center text-current">{c.icon}</span>
                        <span className="min-w-0 flex-1 truncate type-body">{c.label}</span>
                        {c.hint && <span className="shrink-0 type-meta text-ink-3">{c.hint}</span>}
                        <ArrowRight size={14} aria-hidden="true" className="shrink-0 text-ink-3" />
                      </MenuItem>
                    ))}
                  </MenuSection>
                ))}
              </Menu>
            </div>
          </Autocomplete>
          <p className="hidden shrink-0 items-center gap-3 border-t border-line px-4 py-2 type-meta text-ink-2 expanded:flex">
            <span>
              <Kbd>↑</Kbd> <Kbd>↓</Kbd> {t('palette.hintMove')}
            </span>
            <span>
              <Kbd>↵</Kbd> {t('palette.hintRun')}
            </span>
            <span className="ml-auto">
              <Kbd>?</Kbd> {t('keys.title')}
            </span>
          </p>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
};

const KeyCaps = ({ keys, chord }: { keys: string[]; chord?: boolean }) => (
  <span className="flex items-center gap-1">
    {keys.map((k, i) => (
      <span key={k} className="flex items-center gap-1">
        {i > 0 && <span className="type-meta text-ink-3">{chord ? t('keys.then') : '/'}</span>}
        <Kbd>{k.replace('mod+', modKey()).replace(/\+/g, '')}</Kbd>
      </span>
    ))}
  </span>
);

export const ShortcutsSheet = () => {
  const open = useOverlay() === 'shortcuts';
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <Sheet
      isOpen={open}
      onOpenChange={(o) => !o && closeOverlay()}
      title={t('keys.title')}
      subtitle={t('keys.subtitle')}
      readOnly
    >
      <div className="flex flex-col gap-6">
        {sectionsFor(pathname).map((s) => (
          <section key={s.id} aria-labelledby={`keys-${s.id}`}>
            <h3 id={`keys-${s.id}`} className="mt-1 mb-2 type-micro text-ink-2">
              {t(s.title)}
            </h3>
            <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] items-center gap-x-4 gap-y-2">
              {s.keys.map((k) => (
                <div key={k.keys.join()} className="contents">
                  <dt>
                    <KeyCaps keys={k.keys} chord={k.chord} />
                  </dt>
                  <dd className="type-body-sm text-ink">{t(k.label)}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Sheet>
  );
};

/** Everything lazy the shell mounts once. */
const Overlays = () => (
  <>
    <CommandPalette />
    <ShortcutsSheet />
  </>
);
export default Overlays;
