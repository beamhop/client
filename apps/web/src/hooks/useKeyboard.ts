import { useEffect, useRef } from 'react';
import { useApp, type View } from '../store/AppContext.js';

function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

const GOTO: Record<string, View | 'profile-self'> = {
  h: 'home',
  e: 'explore',
  m: 'messages',
  p: 'profile-self',
  s: 'security',
};

/**
 * Global keyboard shortcuts for a keyboard-first experience:
 *  - ⌘K / Ctrl+K  → command palette (works even while typing)
 *  - /            → command palette
 *  - n            → new post
 *  - g then h/e/m/p/s → go to Home / Explore / Messages / Profile / Security
 *  - t            → toggle theme
 *  - ?            → command palette (shortcut reference lives there)
 *  - Esc          → close palette / modals
 */
export function useGlobalKeyboard(): void {
  const app = useApp();
  const pendingG = useRef<number>(0);
  // Keep the latest app in a ref so the listener stays stable.
  const ref = useRef(app);
  ref.current = app;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const a = ref.current;
      const mod = e.metaKey || e.ctrlKey;

      // Command palette toggle works everywhere.
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (a.showPalette) a.closePalette();
        else a.openPalette();
        return;
      }

      if (e.key === 'Escape') {
        if (a.showPalette) {
          a.closePalette();
          return;
        }
        if (a.showCompose) a.closeCompose();
        if (a.showEdit) a.closeEdit();
        if (a.showRotate) a.closeRotate();
        if (a.showRelays) a.closeRelays();
        return;
      }

      // Don't hijack typing or fire while a modal/palette is open.
      if (isEditable(e.target) || mod || e.altKey) return;
      if (a.showPalette || a.showCompose || a.showEdit || a.showRotate || a.showRelays) return;

      const now = Date.now();
      const key = e.key.toLowerCase();

      // g-then-x navigation sequence.
      if (pendingG.current && now - pendingG.current < 900) {
        pendingG.current = 0;
        const dest = GOTO[key];
        if (dest) {
          e.preventDefault();
          if (dest === 'profile-self') a.viewProfile(null);
          else a.setView(dest);
          return;
        }
      }

      if (key === 'g') {
        pendingG.current = now;
        return;
      }
      pendingG.current = 0;

      switch (key) {
        case '/':
        case '?':
          e.preventDefault();
          a.openPalette();
          break;
        case 'n':
          e.preventDefault();
          a.openCompose();
          break;
        case 't':
          e.preventDefault();
          a.toggleTheme();
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
}
