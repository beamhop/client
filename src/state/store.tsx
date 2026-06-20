import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { EventTemplate } from "nostr-tools";
import { NostrClient } from "../nostr/client.ts";
import { Kind, type Profile, type RelayInfo } from "../nostr/types.ts";
import { decodeProfile, buildContacts } from "../nostr/events.ts";
import {
  type Identity,
  loadPersisted,
  persist,
  clearPersisted,
} from "../nostr/keys.ts";
import { loadRelays, saveRelays, readRelays, writeRelays } from "../nostr/relays.ts";
import {
  type ThemeMode,
  type PaletteId,
  loadTheme,
  saveTheme,
  loadPalette,
  savePalette,
  applyPalette,
} from "../lib/theme.ts";

export type ViewId =
  | "home"
  | "explore"
  | "docs"
  | "docReader"
  | "docEditor"
  | "messages"
  | "agents"
  | "agentDetail"
  | "profile"
  | "security"
  | "articleReader"
  | "articleEditor";

export type Toast = { id: number; text: string; tone: "check" | "info" | "warn" | "copy" | "repost" };

export type Nav = { view: ViewId; params: Record<string, string | undefined> };

type State = {
  identity: Identity | null;
  me: Profile | null;
  relays: RelayInfo[];
  contacts: string[]; // followed pubkeys
  theme: ThemeMode;
  palette: PaletteId;
  nav: Nav;
  toasts: Toast[];
  bookmarks: string[]; // local-only note ids
  ready: boolean;
};

type Action =
  | { type: "init"; identity: Identity | null; relays: RelayInfo[]; theme: ThemeMode; palette: PaletteId; bookmarks: string[] }
  | { type: "setIdentity"; identity: Identity | null }
  | { type: "setMe"; me: Profile | null }
  | { type: "setRelays"; relays: RelayInfo[] }
  | { type: "setContacts"; contacts: string[] }
  | { type: "setTheme"; theme: ThemeMode }
  | { type: "setPalette"; palette: PaletteId }
  | { type: "navigate"; nav: Nav }
  | { type: "pushToast"; toast: Toast }
  | { type: "dropToast"; id: number }
  | { type: "setBookmarks"; bookmarks: string[] }
  | { type: "ready" };

const reducer = (state: State, action: Action): State => {
  switch (action.type) {
    case "init":
      return {
        ...state,
        identity: action.identity,
        relays: action.relays,
        theme: action.theme,
        palette: action.palette,
        bookmarks: action.bookmarks,
        ready: true,
      };
    case "setIdentity":
      return { ...state, identity: action.identity };
    case "setMe":
      return { ...state, me: action.me };
    case "setRelays":
      return { ...state, relays: action.relays };
    case "setContacts":
      return { ...state, contacts: action.contacts };
    case "setTheme":
      return { ...state, theme: action.theme };
    case "setPalette":
      return { ...state, palette: action.palette };
    case "navigate":
      return { ...state, nav: action.nav };
    case "pushToast":
      return { ...state, toasts: [...state.toasts, action.toast] };
    case "dropToast":
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) };
    case "setBookmarks":
      return { ...state, bookmarks: action.bookmarks };
    case "ready":
      return { ...state, ready: true };
  }
};

const BOOKMARKS_KEY = "verity.bookmarks.v1";

export type Store = {
  state: State;
  client: NostrClient;
  readRelayUrls: string[];
  writeRelayUrls: string[];
  navigate: (view: ViewId, params?: Record<string, string | undefined>) => void;
  toast: (text: string, tone?: Toast["tone"]) => void;
  setIdentity: (identity: Identity | null) => void;
  setMe: (me: Profile | null) => void;
  setRelays: (relays: RelayInfo[]) => void;
  toggleTheme: () => void;
  setPalette: (id: PaletteId) => void;
  toggleFollow: (pubkey: string) => Promise<void>;
  toggleBookmark: (noteId: string) => void;
  publish: (template: EventTemplate) => Promise<string>;
  fetchProfile: (pubkey: string) => Promise<Profile | null>;
  signOut: () => void;
  rootRef: React.RefObject<HTMLDivElement | null>;
};

const StoreContext = createContext<Store | null>(null);

let toastSeq = 1;

export const StoreProvider = ({ children }: { children: ReactNode }): ReactNode => {
  const [state, dispatch] = useReducer(reducer, {
    identity: null,
    me: null,
    relays: [],
    contacts: [],
    theme: "light",
    palette: "Cobalt",
    nav: { view: "home", params: {} },
    toasts: [],
    bookmarks: [],
    ready: false,
  });

  const clientRef = useRef(new NostrClient());
  const rootRef = useRef<HTMLDivElement | null>(null);
  const profileCache = useRef(new Map<string, Promise<Profile | null>>());

  // ---- boot ----
  useEffect(() => {
    let bookmarks: string[] = [];
    try {
      bookmarks = JSON.parse(localStorage.getItem(BOOKMARKS_KEY) ?? "[]") as string[];
    } catch {
      bookmarks = [];
    }
    dispatch({
      type: "init",
      identity: loadPersisted(),
      relays: loadRelays(),
      theme: loadTheme(),
      palette: loadPalette(),
      bookmarks,
    });
  }, []);

  // ---- apply theme/palette to root + document ----
  useEffect(() => {
    if (rootRef.current) applyPalette(rootRef.current, state.palette, state.theme);
    document.documentElement.style.background = "var(--bg-base)";
  }, [state.palette, state.theme, state.ready]);

  const readRelayUrls = useMemo(() => readRelays(state.relays), [state.relays]);
  const writeRelayUrls = useMemo(() => writeRelays(state.relays), [state.relays]);

  // ---- load own profile + contacts when identity changes ----
  useEffect(() => {
    const id = state.identity;
    if (!id || readRelayUrls.length === 0) return;
    const client = clientRef.current;
    let cancelled = false;
    void (async () => {
      const [profileEvent, contactsEvent] = await Promise.all([
        client.get(readRelayUrls, { kinds: [Kind.Metadata], authors: [id.pubkey] }),
        client.get(readRelayUrls, { kinds: [Kind.Contacts], authors: [id.pubkey] }),
      ]);
      if (cancelled) return;
      dispatch({
        type: "setMe",
        me: profileEvent ? decodeProfile(profileEvent) : { pubkey: id.pubkey },
      });
      if (contactsEvent) {
        const follows = contactsEvent.tags.flatMap((t) => (t[0] === "p" && t[1] ? [t[1]] : []));
        dispatch({ type: "setContacts", contacts: follows });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.identity, readRelayUrls]);

  const toast = useCallback((text: string, tone: Toast["tone"] = "info") => {
    const id = toastSeq++;
    dispatch({ type: "pushToast", toast: { id, text, tone } });
    setTimeout(() => dispatch({ type: "dropToast", id }), 3200);
  }, []);

  const navigate = useCallback((view: ViewId, params: Record<string, string | undefined> = {}) => {
    dispatch({ type: "navigate", nav: { view, params } });
  }, []);

  const setIdentity = useCallback((identity: Identity | null) => {
    if (identity) persist(identity);
    else clearPersisted();
    dispatch({ type: "setIdentity", identity });
    if (!identity) dispatch({ type: "setMe", me: null });
  }, []);

  const setMe = useCallback((me: Profile | null) => dispatch({ type: "setMe", me }), []);

  const setRelays = useCallback((relays: RelayInfo[]) => {
    saveRelays(relays);
    dispatch({ type: "setRelays", relays });
  }, []);

  const toggleTheme = useCallback(() => {
    dispatch({ type: "setTheme", theme: state.theme === "dark" ? "light" : "dark" });
    saveTheme(state.theme === "dark" ? "light" : "dark");
  }, [state.theme]);

  const setPalette = useCallback(
    (id: PaletteId) => {
      savePalette(id);
      dispatch({ type: "setPalette", palette: id });
      if (rootRef.current) applyPalette(rootRef.current, id, state.theme);
      toast(`${id} theme applied`, "check");
    },
    [state.theme, toast],
  );

  const publish = useCallback(
    async (template: EventTemplate): Promise<string> => {
      if (!state.identity) throw new Error("Sign in first");
      const event = await clientRef.current.publish(writeRelayUrls, state.identity, template);
      return event.id;
    },
    [state.identity, writeRelayUrls],
  );

  const toggleFollow = useCallback(
    async (pubkey: string) => {
      if (!state.identity) {
        toast("Sign in to follow people", "warn");
        return;
      }
      const has = state.contacts.includes(pubkey);
      const next = has ? state.contacts.filter((p) => p !== pubkey) : [...state.contacts, pubkey];
      dispatch({ type: "setContacts", contacts: next });
      try {
        await publish(buildContacts(next));
        toast(has ? "Unfollowed" : "Following", has ? "info" : "check");
      } catch {
        dispatch({ type: "setContacts", contacts: state.contacts });
        toast("Could not update follows", "warn");
      }
    },
    [state.identity, state.contacts, publish, toast],
  );

  const toggleBookmark = useCallback(
    (noteId: string) => {
      const has = state.bookmarks.includes(noteId);
      const next = has ? state.bookmarks.filter((b) => b !== noteId) : [...state.bookmarks, noteId];
      localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(next));
      dispatch({ type: "setBookmarks", bookmarks: next });
      toast(has ? "Removed from bookmarks" : "Saved to bookmarks", has ? "info" : "check");
    },
    [state.bookmarks, toast],
  );

  const fetchProfile = useCallback(
    (pubkey: string): Promise<Profile | null> => {
      const cache = profileCache.current;
      const existing = cache.get(pubkey);
      if (existing) return existing;
      const promise = clientRef.current
        .get(readRelayUrls, { kinds: [Kind.Metadata], authors: [pubkey] })
        .then((event) => (event ? decodeProfile(event) : null));
      cache.set(pubkey, promise);
      return promise;
    },
    [readRelayUrls],
  );

  const signOut = useCallback(() => {
    clearPersisted();
    dispatch({ type: "setIdentity", identity: null });
    dispatch({ type: "setMe", me: null });
    dispatch({ type: "setContacts", contacts: [] });
    toast("Signed out", "info");
  }, [toast]);

  const store: Store = {
    state,
    client: clientRef.current,
    readRelayUrls,
    writeRelayUrls,
    navigate,
    toast,
    setIdentity,
    setMe,
    setRelays,
    toggleTheme,
    setPalette,
    toggleFollow,
    toggleBookmark,
    publish,
    fetchProfile,
    signOut,
    rootRef,
  };

  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
};

export const useStore = (): Store => {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used within StoreProvider");
  return ctx;
};

/** Resolve and subscribe to a profile from the shared cache. */
export const useProfile = (pubkey: string | undefined): Profile | null => {
  const { fetchProfile } = useStore();
  const [profile, setProfile] = useState<Profile | null>(null);
  useEffect(() => {
    if (!pubkey) return;
    let active = true;
    void fetchProfile(pubkey).then((p) => {
      if (active) setProfile(p);
    });
    return () => {
      active = false;
    };
  }, [pubkey, fetchProfile]);
  return profile;
};
