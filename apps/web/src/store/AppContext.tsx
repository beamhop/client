import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { NostrEvent } from '@beamhop/core';
import type { VerityEngine } from '../engine/VerityEngine.js';
import type { EngineState } from '../engine/types.js';
import { useHash, parseHash, navigateTo, type SearchType } from '../lib/router.js';

export type View = 'home' | 'explore' | 'messages' | 'profile' | 'note' | 'security';
export type ToastKind = 'check' | 'copy' | 'repost' | 'warn' | 'info';

export interface Toast {
  readonly id: number;
  readonly msg: string;
  readonly kind: ToastKind;
}

interface AppContextValue {
  engine: VerityEngine;
  state: EngineState;
  // routing + chrome (derived from the URL hash)
  view: View;
  setView: (v: View) => void;
  /** The pubkey whose profile is shown (null = the logged-in user). */
  profileTarget: string | null;
  viewProfile: (pubkey: string | null) => void;
  /** The hex event id of the note being viewed in the detail view, if any. */
  noteTarget: string | null;
  openNote: (eventId: string) => void;
  /** The committed Explore search query + scope (mirror `#/explore?q=&type=`). */
  exploreQuery: string;
  exploreType: SearchType;
  setExploreSearch: (q: string, type: SearchType) => void;
  theme: 'light' | 'dark';
  toggleTheme: () => void;
  isMobile: boolean;
  // compose
  showCompose: boolean;
  openCompose: () => void;
  closeCompose: () => void;
  composeText: string;
  setComposeText: (t: string) => void;
  replyTarget: NostrEvent | null;
  startReply: (note: NostrEvent) => void;
  // messages
  activeConvId: string | null;
  selectConversation: (peer: string) => void;
  mobileThreadOpen: boolean;
  setMobileThreadOpen: (open: boolean) => void;
  dmText: string;
  setDmText: (t: string) => void;
  startConversation: (peer: string) => void;
  // profile / keys modals
  showEdit: boolean;
  openEdit: () => void;
  closeEdit: () => void;
  showRotate: boolean;
  openRotate: () => void;
  closeRotate: () => void;
  // relays modal
  showRelays: boolean;
  openRelays: () => void;
  closeRelays: () => void;
  // command palette
  showPalette: boolean;
  openPalette: () => void;
  closePalette: () => void;
  // toasts
  toasts: readonly Toast[];
  toast: (msg: string, kind?: ToastKind) => void;
  // identity secrets (for Keys & Security view)
  nsec: string | null;
  // logout / rotate handled by parent
  onLogout: () => void;
  onRotate: () => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

export interface AppProviderProps {
  engine: VerityEngine;
  nsec: string | null;
  onLogout: () => void;
  onRotate: () => Promise<void>;
  children: ReactNode;
}

export function AppProvider({ engine, nsec, onLogout, onRotate, children }: AppProviderProps): ReactNode {
  const state = useSyncExternalStore(engine.subscribe, engine.getSnapshot, engine.getSnapshot);

  // The URL hash is the source of truth for navigation; everything below derives
  // from it so a refresh or shared link restores the same view.
  const hash = useHash();
  const route = useMemo(() => parseHash(hash), [hash]);
  const view: View = route.name;
  const profileTarget = route.name === 'profile' ? route.pubkey : null;
  const activeConvId = route.name === 'messages' ? route.peer : null;
  const noteTarget = route.name === 'note' ? route.id : null;
  const exploreQuery = route.name === 'explore' ? route.q : '';
  const exploreType: SearchType = route.name === 'explore' ? route.type : 'posts';

  const [showRelays, setShowRelays] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    return (localStorage.getItem('verity:theme') as 'light' | 'dark' | null) ?? 'light';
  });
  const [isMobile, setIsMobile] = useState<boolean>(() => window.innerWidth < 900);
  const [showCompose, setShowCompose] = useState(false);
  const [composeText, setComposeText] = useState('');
  const [replyTarget, setReplyTarget] = useState<NostrEvent | null>(null);
  const [mobileThreadOpen, setMobileThreadOpen] = useState(false);
  const [dmText, setDmText] = useState('');
  const [showEdit, setShowEdit] = useState(false);
  const [showRotate, setShowRotate] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastSeq = useRef(0);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 900);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    localStorage.setItem('verity:theme', theme);
  }, [theme]);

  const toast = useCallback((msg: string, kind: ToastKind = 'info') => {
    const id = (toastSeq.current += 1);
    setToasts((prev) => [...prev, { id, msg, kind }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 2800);
  }, []);

  const setView = useCallback((v: View) => {
    switch (v) {
      case 'home':
        navigateTo({ name: 'home' });
        break;
      case 'explore':
        navigateTo({ name: 'explore', q: '', type: 'posts' });
        break;
      case 'messages':
        navigateTo({ name: 'messages', peer: null });
        break;
      case 'profile':
        navigateTo({ name: 'profile', pubkey: null });
        break;
      case 'security':
        navigateTo({ name: 'security' });
        break;
      case 'note':
        // 'note' requires an id; use openNote() instead. No-op here.
        break;
    }
  }, []);

  const selectConversation = useCallback((peer: string) => {
    // Side effects (mark read / ensure profile) run from the route effect below
    // so a freshly loaded `#/messages/<peer>` URL behaves the same as a click.
    setMobileThreadOpen(true);
    navigateTo({ name: 'messages', peer });
  }, []);

  // startConversation and selectConversation are now identical: the messages
  // route already carries the peer.
  const startConversation = selectConversation;

  const viewProfile = useCallback((pubkey: string | null) => {
    setShowPalette(false);
    navigateTo({ name: 'profile', pubkey });
  }, []);

  const openNote = useCallback((eventId: string) => {
    setShowPalette(false);
    navigateTo({ name: 'note', id: eventId });
  }, []);

  const setExploreSearch = useCallback((q: string, type: SearchType) => {
    navigateTo({ name: 'explore', q, type });
  }, []);

  // Resolve profile metadata whenever a profile is viewed (click or shared URL).
  useEffect(() => {
    if (profileTarget) engine.ensureProfiles([profileTarget]);
  }, [profileTarget, engine]);

  // Open + mark-read whenever a conversation becomes active (click or shared URL).
  useEffect(() => {
    if (!activeConvId) return;
    setMobileThreadOpen(true);
    engine.markConversationRead(activeConvId);
    engine.ensureProfiles([activeConvId]);
  }, [activeConvId, engine]);

  const value = useMemo<AppContextValue>(
    () => ({
      engine,
      state,
      view,
      setView,
      profileTarget,
      viewProfile,
      noteTarget,
      openNote,
      exploreQuery,
      exploreType,
      setExploreSearch,
      theme,
      toggleTheme: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')),
      isMobile,
      showCompose,
      openCompose: () => setShowCompose(true),
      closeCompose: () => {
        setShowCompose(false);
        setReplyTarget(null);
      },
      composeText,
      setComposeText,
      replyTarget,
      startReply: (note: NostrEvent) => {
        setReplyTarget(note);
        setShowCompose(true);
      },
      activeConvId,
      selectConversation,
      mobileThreadOpen,
      setMobileThreadOpen,
      dmText,
      setDmText,
      startConversation,
      showEdit,
      openEdit: () => setShowEdit(true),
      closeEdit: () => setShowEdit(false),
      showRotate,
      openRotate: () => setShowRotate(true),
      closeRotate: () => setShowRotate(false),
      showRelays,
      openRelays: () => setShowRelays(true),
      closeRelays: () => setShowRelays(false),
      showPalette,
      openPalette: () => setShowPalette(true),
      closePalette: () => setShowPalette(false),
      toasts,
      toast,
      nsec,
      onLogout,
      onRotate,
    }),
    [
      engine,
      state,
      view,
      profileTarget,
      viewProfile,
      noteTarget,
      openNote,
      exploreQuery,
      exploreType,
      setExploreSearch,
      theme,
      isMobile,
      showCompose,
      composeText,
      replyTarget,
      activeConvId,
      selectConversation,
      mobileThreadOpen,
      dmText,
      startConversation,
      setView,
      showEdit,
      showRotate,
      showRelays,
      showPalette,
      toasts,
      toast,
      nsec,
      onLogout,
      onRotate,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
