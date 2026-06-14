import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useApp, type View } from '../store/AppContext.js';
import { Icon, type IconName } from './Icon.js';
import { Avatar, personView, type PersonView } from './common.js';

interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: IconName;
  keywords: string;
  run: () => void;
}

interface PersonItem {
  kind: 'person';
  person: PersonView;
  run: () => void;
}
interface CommandItem {
  kind: 'command';
  command: Command;
}
type Item = CommandItem | PersonItem;

export function CommandPalette(): ReactNode {
  const app = useApp();
  const { state, engine, closePalette, setView, viewProfile, openCompose, toggleTheme, openRelays, onLogout, theme } = app;
  const [query, setQuery] = useState('');
  const [remote, setRemote] = useState<PersonView[]>([]);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => {
      // Restore focus to whatever opened the palette.
      previous?.focus?.();
    };
  }, []);

  const commands = useMemo<Command[]>(
    () => [
      { id: 'home', label: 'Go to Home', hint: 'g h', icon: 'home', keywords: 'home feed', run: () => setView('home') },
      { id: 'explore', label: 'Go to Explore', hint: 'g e', icon: 'search', keywords: 'explore search discover', run: () => setView('explore') },
      { id: 'messages', label: 'Go to Messages', hint: 'g m', icon: 'messages', keywords: 'messages dm chat encrypted', run: () => setView('messages') },
      { id: 'profile', label: 'Go to your Profile', hint: 'g p', icon: 'user', keywords: 'profile me account', run: () => viewProfile(null) },
      { id: 'security', label: 'Go to Keys & Security', hint: 'g s', icon: 'shield', keywords: 'keys security settings audit', run: () => setView('security') },
      { id: 'compose', label: 'New post', hint: 'n', icon: 'plus', keywords: 'post compose write note new', run: openCompose },
      { id: 'theme', label: theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode', hint: 't', icon: theme === 'dark' ? 'sun' : 'moon', keywords: 'theme dark light mode appearance', run: toggleTheme },
      { id: 'relays', label: 'Manage relays', icon: 'globe', keywords: 'relays connection network servers', run: openRelays },
      { id: 'logout', label: 'Sign out', icon: 'logout', keywords: 'logout sign out exit leave', run: onLogout },
    ],
    [setView, viewProfile, openCompose, toggleTheme, openRelays, onLogout, theme],
  );

  const q = query.trim().toLowerCase();

  const filteredCommands = useMemo(() => {
    if (!q) return commands;
    return commands.filter((c) => c.label.toLowerCase().includes(q) || c.keywords.includes(q));
  }, [commands, q]);

  // Instant local people matches.
  const localPeople = useMemo(() => {
    if (q.length < 2) return [];
    return Object.keys(state.profiles)
      .filter((pk) => pk !== state.pubkey)
      .map((pk) => personView(pk, state.profiles[pk]))
      .filter((p) => p.name.toLowerCase().includes(q) || p.handle.toLowerCase().includes(q))
      .slice(0, 5);
  }, [state.profiles, state.pubkey, q]);

  // Debounced remote people search.
  useEffect(() => {
    if (q.length < 2) {
      setRemote([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void engine.searchProfiles(query.trim()).then((profiles) => {
        if (!cancelled) setRemote(profiles.map((p) => personView(p.pubkey, p)));
      });
    }, 280);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q, query, engine]);

  const people = useMemo(() => {
    const byKey = new Map<string, PersonView>();
    for (const p of [...localPeople, ...remote]) {
      if (p.pubkey !== state.pubkey && !byKey.has(p.pubkey)) byKey.set(p.pubkey, p);
    }
    return [...byKey.values()].slice(0, 8);
  }, [localPeople, remote, state.pubkey]);

  const items = useMemo<Item[]>(() => {
    const cmds: Item[] = filteredCommands.map((command) => ({ kind: 'command', command }));
    const ppl: Item[] = people.map((person) => ({
      kind: 'person',
      person,
      run: () => viewProfile(person.pubkey),
    }));
    return [...cmds, ...ppl];
  }, [filteredCommands, people, viewProfile]);

  useEffect(() => {
    setSelected((s) => Math.min(s, Math.max(0, items.length - 1)));
  }, [items.length]);

  const activate = (item: Item | undefined) => {
    if (!item) return;
    if (item.kind === 'command') item.command.run();
    else item.run();
    closePalette();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Tab') {
      // Keep focus inside the palette (the input is the only focusable control).
      e.preventDefault();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((s) => (items.length ? (s + 1) % items.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((s) => (items.length ? (s - 1 + items.length) % items.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      activate(items[selected]);
    }
  };

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${selected}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  return (
    <div
      onClick={closePalette}
      data-testid="command-palette"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(10,10,25,.5)',
        backdropFilter: 'blur(4px)',
        zIndex: 70,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '12vh 18px 18px',
        animation: 'fadeIn .15s',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        style={{
          width: '100%',
          maxWidth: 560,
          background: 'var(--surface)',
          borderRadius: 18,
          boxShadow: 'var(--shadow-lg)',
          overflow: 'hidden',
          border: '1px solid var(--border)',
          animation: 'scaleIn .18s cubic-bezier(.2,.9,.3,1)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
          <Icon name="search" size={18} stroke="var(--text-3)" />
          <input
            ref={inputRef}
            data-testid="palette-input"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search commands and people…"
            style={{ flex: 1, border: 'none', background: 'transparent', outline: 'none', fontSize: 16, color: 'var(--text)' }}
          />
          <kbd style={kbdStyle}>esc</kbd>
        </div>

        <div ref={listRef} role="listbox" aria-label="Results" style={{ maxHeight: '52vh', overflowY: 'auto', padding: 8 }}>
          {items.length === 0 ? (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-3)', fontSize: 14 }}>No matches</div>
          ) : (
            items.map((item, i) => (
              <Row key={item.kind === 'command' ? item.command.id : `p-${item.person.pubkey}`} index={i} active={i === selected} onHover={() => setSelected(i)} onClick={() => activate(item)} item={item} />
            ))
          )}
        </div>

        <div style={{ display: 'flex', gap: 14, alignItems: 'center', padding: '10px 16px', borderTop: '1px solid var(--border)', fontSize: 11.5, color: 'var(--text-3)' }}>
          <span><kbd style={kbdStyle}>↑</kbd><kbd style={kbdStyle}>↓</kbd> navigate</span>
          <span><kbd style={kbdStyle}>↵</kbd> select</span>
          <span><kbd style={kbdStyle}>g</kbd> then <kbd style={kbdStyle}>h/e/m/p/s</kbd> jump</span>
          <span><kbd style={kbdStyle}>n</kbd> new post</span>
        </div>
      </div>
    </div>
  );
}

function Row({ item, index, active, onHover, onClick }: { item: Item; index: number; active: boolean; onHover: () => void; onClick: () => void }): ReactNode {
  return (
    <div
      data-index={index}
      data-testid="palette-item"
      role="option"
      aria-selected={active}
      onMouseEnter={onHover}
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 12px',
        borderRadius: 11,
        cursor: 'pointer',
        background: active ? 'var(--accent-soft)' : 'transparent',
        color: active ? 'var(--accent)' : 'var(--text)',
      }}
    >
      {item.kind === 'command' ? (
        <>
          <Icon name={item.command.icon} size={18} stroke="currentColor" />
          <span style={{ flex: 1, fontSize: 14.5, fontWeight: 600 }}>{item.command.label}</span>
          {item.command.hint ? <kbd style={kbdStyle}>{item.command.hint}</kbd> : null}
        </>
      ) : (
        <>
          <Avatar pubkey={item.person.pubkey} profile={item.person.profile} name={item.person.name} size={28} />
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 14, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.person.name}</span>
            <span style={{ display: 'block', fontSize: 12, color: 'var(--text-3)', fontFamily: "'JetBrains Mono',monospace", overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.person.handle}</span>
          </span>
          <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>Profile</span>
        </>
      )}
    </div>
  );
}

const kbdStyle = {
  fontFamily: "'JetBrains Mono',monospace",
  fontSize: 11,
  background: 'var(--surface-2)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  padding: '2px 6px',
  color: 'var(--text-3)',
} as const;
