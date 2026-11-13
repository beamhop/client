/**
 * Global keyboard shortcuts (SCREENS §0.3): `g h` Home, `g i` Inbox, `g s` Sessions, `g a` Agents,
 * `g c` Channels, `g p` Policy, `g d` Deploy, `g u` Audit; `⌘⇧.` / `Ctrl+Shift+.` panic; `⌘\` sidebar.
 * Ignored while typing in a field. Screens add their own keys locally (J/K/A/D in Inbox).
 */
import { useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { NAV } from './nav.ts';

const typing = (e: KeyboardEvent) => {
  const el = e.target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
};

export const useGlobalShortcuts = ({ onPanic, onToggleSidebar }: { onPanic: () => void; onToggleSidebar: () => void }) => {
  const navigate = useNavigate();
  useEffect(() => {
    let gAt = 0;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.shiftKey && (e.key === '.' || e.key === '>')) {
        e.preventDefault();
        onPanic();
        return;
      }
      if (mod && e.key === '\\') {
        e.preventDefault();
        onToggleSidebar();
        return;
      }
      if (mod || e.altKey || typing(e)) return;
      if (e.key === 'g') {
        gAt = Date.now();
        return;
      }
      if (Date.now() - gAt < 1200) {
        const item = Object.values(NAV).find((n) => n.chord === e.key);
        gAt = 0;
        if (item) {
          e.preventDefault();
          void navigate({ to: item.to });
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, onPanic, onToggleSidebar]);
};
