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
import type { Event as NostrEvent, EventTemplate, Filter } from "nostr-tools";
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
  | "notifications"
  | "messages"
  | "agents"
  | "agentDetail"
  | "profile"
  | "security"
  | "postDetail"
  | "articleReader"
  | "articleEditor";

export type ToastAction = { type: "profile"; pubkey: string };

export type Toast = {
  id: number;
  text: string;
  tone: "check" | "info" | "warn" | "copy" | "repost";
  action?: ToastAction;
};

export type Nav = { view: ViewId; params: Record<string, string | undefined> };

export type NotificationType = "reply" | "mention" | "reaction" | "zap" | "dm";

export type NotificationItem = {
  id: string;
  type: NotificationType;
  eventId: string;
  pubkey: string;
  createdAt: number;
  content: string;
  targetId?: string;
  read: boolean;
};

type State = {
  identity: Identity | null;
  me: Profile | null;
  relays: RelayInfo[];
  contacts: string[]; // followed pubkeys
  theme: ThemeMode;
  palette: PaletteId;
  nav: Nav;
  toasts: Toast[];
  notifications: NotificationItem[];
  notificationReadIds: string[];
  bookmarks: string[]; // local-only note ids
  ready: boolean;
};

type Action =
  | { type: "init"; identity: Identity | null; relays: RelayInfo[]; theme: ThemeMode; palette: PaletteId; bookmarks: string[]; notificationReadIds: string[] }
  | { type: "setIdentity"; identity: Identity | null }
  | { type: "setMe"; me: Profile | null }
  | { type: "setRelays"; relays: RelayInfo[] }
  | { type: "setContacts"; contacts: string[] }
  | { type: "setTheme"; theme: ThemeMode }
  | { type: "setPalette"; palette: PaletteId }
  | { type: "navigate"; nav: Nav }
  | { type: "setNotifications"; notifications: NotificationItem[] }
  | { type: "addNotification"; notification: NotificationItem }
  | { type: "setNotificationReadIds"; ids: string[] }
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
        notificationReadIds: action.notificationReadIds,
        notifications: applyNotificationReadState(state.notifications, action.notificationReadIds),
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
    case "setNotifications":
      return {
        ...state,
        notifications: sortNotifications(
          dedupeNotifications(action.notifications).map((n) => ({
            ...n,
            read: state.notificationReadIds.includes(n.eventId),
          })),
        ),
      };
    case "addNotification": {
      const notification = {
        ...action.notification,
        read: state.notificationReadIds.includes(action.notification.eventId),
      };
      return {
        ...state,
        notifications: sortNotifications(dedupeNotifications([notification, ...state.notifications])),
      };
    }
    case "setNotificationReadIds":
      return {
        ...state,
        notificationReadIds: action.ids,
        notifications: applyNotificationReadState(state.notifications, action.ids),
      };
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
const NOTIFICATION_READ_KEY = "verity.notifications.read.v1";

const notificationReadKey = (pubkey: string): string => `${NOTIFICATION_READ_KEY}:${pubkey}`;

const loadNotificationReadIds = (pubkey: string | undefined): string[] => {
  if (!pubkey) return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(notificationReadKey(pubkey)) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
};

const saveNotificationReadIds = (pubkey: string | undefined, ids: string[]): void => {
  if (!pubkey) return;
  localStorage.setItem(notificationReadKey(pubkey), JSON.stringify([...new Set(ids)]));
};

const sortNotifications = (items: NotificationItem[]): NotificationItem[] =>
  [...items].sort((a, b) => b.createdAt - a.createdAt);

const dedupeNotifications = (items: NotificationItem[]): NotificationItem[] => {
  const seen = new Set<string>();
  const out: NotificationItem[] = [];
  for (const item of items) {
    if (seen.has(item.eventId)) continue;
    seen.add(item.eventId);
    out.push(item);
  }
  return out;
};

const applyNotificationReadState = (
  items: NotificationItem[] | undefined,
  readIds: string[],
): NotificationItem[] => {
  const read = new Set(readIds);
  return (items ?? []).map((item) => ({ ...item, read: read.has(item.eventId) }));
};

const tagValue = (event: NostrEvent, key: string): string | undefined =>
  event.tags.find((tag) => tag[0] === key)?.[1];

const hasTagValue = (event: NostrEvent, key: string, value: string): boolean =>
  event.tags.some((tag) => tag[0] === key && tag[1] === value);

const notificationTarget = (event: NostrEvent): string | undefined =>
  [...event.tags].reverse().find((tag) => (tag[0] === "e" || tag[0] === "a") && tag[1])?.[1];

const buildNotification = (event: NostrEvent, me: string): NotificationItem | null => {
  if (event.pubkey === me) return null;
  if (!hasTagValue(event, "p", me)) return null;

  if (event.kind === Kind.Note || event.kind === Kind.Mention) {
    const targetId = notificationTarget(event);
    return {
      id: event.id,
      eventId: event.id,
      type: targetId ? "reply" : "mention",
      pubkey: event.pubkey,
      createdAt: event.created_at,
      content: event.content,
      targetId,
      read: false,
    };
  }

  if (event.kind === Kind.Reaction) {
    return {
      id: event.id,
      eventId: event.id,
      type: "reaction",
      pubkey: event.pubkey,
      createdAt: event.created_at,
      content: event.content || "+",
      targetId: notificationTarget(event),
      read: false,
    };
  }

  if (event.kind === Kind.ZapReceipt) {
    return {
      id: event.id,
      eventId: event.id,
      type: "zap",
      pubkey: event.pubkey,
      createdAt: event.created_at,
      content: tagValue(event, "amount") ?? event.content,
      targetId: notificationTarget(event),
      read: false,
    };
  }

  if (event.kind === Kind.EncryptedDM || event.kind === Kind.PrivateDirectMessage) {
    return {
      id: event.id,
      eventId: event.id,
      type: "dm",
      pubkey: event.pubkey,
      createdAt: event.created_at,
      content: "",
      read: false,
    };
  }

  return null;
};

const notificationToastText = (notification: NotificationItem): string => {
  switch (notification.type) {
    case "reply":
      return "New reply";
    case "mention":
      return "New mention";
    case "reaction":
      return notification.content === "+" ? "New like" : "New reaction";
    case "zap":
      return "New zap";
    case "dm":
      return "New direct message";
  }
};

let notificationAudio: AudioContext | null = null;
const playNotificationPing = (): void => {
  try {
    const AudioCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtor) return;
    notificationAudio ??= new AudioCtor();
    const ctx = notificationAudio;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(880, ctx.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.08);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.16);
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start();
    oscillator.stop(ctx.currentTime + 0.17);
  } catch {
    // Browsers can block audio until user interaction; notifications still work.
  }
};

const decodePart = (part: string | undefined): string | undefined => {
  if (part === undefined || part === "") return undefined;
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
};

const encodePart = (part: string): string => encodeURIComponent(part);

const isDetailTab = (tab: string | undefined): boolean =>
  tab === "activity" || tab === "capabilities" || tab === "connections";

const isProfileTab = (tab: string | undefined): boolean =>
  tab === "posts" ||
  tab === "articles" ||
  tab === "replies" ||
  tab === "media" ||
  tab === "following" ||
  tab === "followers";

const compactParams = (
  params: Record<string, string | undefined>,
): Record<string, string | undefined> => {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") out[key] = value;
  }
  return out;
};

const normalizeNav = (nav: Nav): Nav => {
  const params = compactParams(nav.params);
  if ((nav.view === "articleReader" || nav.view === "articleEditor") && !params.id && params.identifier) {
    params.id = params.identifier;
    delete params.identifier;
  }
  if ((nav.view === "docReader" || nav.view === "docEditor") && !params.id && params.identifier) {
    params.id = params.identifier;
    delete params.identifier;
  }
  if (nav.view === "agentDetail" && !isDetailTab(params.agentTab)) delete params.agentTab;
  if (nav.view === "profile" && !isProfileTab(params.tab)) delete params.tab;
  return { view: nav.view, params };
};

export const routeToHash = (nav: Nav): string => {
  const { view, params } = normalizeNav(nav);
  const id = params.id;
  const pubkey = params.pubkey;

  switch (view) {
    case "home":
      return "#/";
    case "explore":
      return "#/explore";
    case "notifications":
      return "#/notifications";
    case "docs":
      return "#/docs";
    case "docReader":
      if (pubkey && id) return `#/docs/${encodePart(pubkey)}/${encodePart(id)}`;
      return id ? `#/docs/${encodePart(id)}` : "#/docs";
    case "docEditor":
      if (pubkey && id) return `#/docs/${encodePart(pubkey)}/${encodePart(id)}/edit`;
      return id ? `#/docs/${encodePart(id)}/edit` : "#/docs/new";
    case "messages":
      return pubkey ? `#/messages/${encodePart(pubkey)}` : "#/messages";
    case "agents":
      return "#/agents";
    case "agentDetail": {
      const tab = params.agentTab ? `?tab=${encodePart(params.agentTab)}` : "";
      return id ? `#/agents/${encodePart(id)}${tab}` : "#/agents";
    }
    case "profile": {
      const tab = params.tab ? `?tab=${encodePart(params.tab)}` : "";
      return pubkey ? `#/profile/${encodePart(pubkey)}${tab}` : `#/profile${tab}`;
    }
    case "security":
      return "#/settings";
    case "postDetail":
      return id ? `#/posts/${encodePart(id)}` : "#/";
    case "articleReader":
      if (pubkey && id) return `#/articles/${encodePart(pubkey)}/${encodePart(id)}`;
      return id ? `#/articles/${encodePart(id)}` : "#/";
    case "articleEditor":
      if (pubkey && id) return `#/articles/${encodePart(pubkey)}/${encodePart(id)}/edit`;
      return id ? `#/articles/${encodePart(id)}/edit` : "#/articles/new";
  }
};

export const parseHashRoute = (hash: string): Nav => {
  const raw = hash.replace(/^#/, "");
  const normalized = raw.startsWith("/") ? raw : `/${raw}`;
  const [path = "/", queryString = ""] = normalized.split("?");
  const query = new URLSearchParams(queryString);
  const parts = path.split("/").filter(Boolean).map(decodePart);
  const [first, second, third, fourth] = parts;

  switch (first) {
    case undefined:
    case "":
    case "home":
      return { view: "home", params: {} };
    case "explore":
      return { view: "explore", params: {} };
    case "notifications":
      return { view: "notifications", params: {} };
    case "docs":
    case "d":
      if (second === "new") return { view: "docEditor", params: {} };
      if (second && third === "edit") return { view: "docEditor", params: { id: second } };
      if (second && third && fourth === "edit") return { view: "docEditor", params: { pubkey: second, id: third } };
      if (second && third) return { view: "docReader", params: { pubkey: second, id: third } };
      if (second) return { view: "docReader", params: { id: second } };
      return { view: "docs", params: {} };
    case "messages":
      return { view: "messages", params: second ? { pubkey: second } : {} };
    case "agents": {
      const agentTab = query.get("tab") ?? third;
      if (second) {
        return {
          view: "agentDetail",
          params: { id: second, agentTab: isDetailTab(agentTab) ? agentTab : undefined },
        };
      }
      return { view: "agents", params: {} };
    }
    case "me":
      return { view: "profile", params: {} };
    case "profile":
    case "people":
    case "p": {
      const tab = query.get("tab") ?? undefined;
      return {
        view: "profile",
        params: { pubkey: second, tab: isProfileTab(tab) ? tab : undefined },
      };
    }
    case "settings":
    case "security":
      return { view: "security", params: {} };
    case "posts":
    case "notes":
    case "n":
      return second ? { view: "postDetail", params: { id: second } } : { view: "home", params: {} };
    case "articles":
    case "a":
      if (second === "new") return { view: "articleEditor", params: {} };
      if (second && third === "edit") return { view: "articleEditor", params: { id: second } };
      if (second && third && fourth === "edit") return { view: "articleEditor", params: { pubkey: second, id: third } };
      if (second && third) return { view: "articleReader", params: { pubkey: second, id: third } };
      if (second) return { view: "articleReader", params: { id: second } };
      return { view: "home", params: {} };
    default:
      return { view: "home", params: {} };
  }
};

export type Store = {
  state: State;
  client: NostrClient;
  readRelayUrls: string[];
  writeRelayUrls: string[];
  navigate: (view: ViewId, params?: Record<string, string | undefined>) => void;
  toast: (text: string, tone?: Toast["tone"], action?: ToastAction) => void;
  markNotificationRead: (eventId: string) => void;
  markAllNotificationsRead: () => void;
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

export const StoreProvider = ({
  children,
  client,
}: {
  children: ReactNode;
  /** Inject a pre-built client (e.g. wired to a fake pool in tests). */
  client?: NostrClient;
}): ReactNode => {
  const [state, dispatch] = useReducer(reducer, {
    identity: null,
    me: null,
    relays: [],
    contacts: [],
    theme: "light",
    palette: "Cobalt",
    nav: typeof window === "undefined" ? { view: "home", params: {} } : parseHashRoute(window.location.hash),
    toasts: [],
    notifications: [],
    notificationReadIds: [],
    bookmarks: [],
    ready: false,
  });

  const clientRef = useRef(client ?? new NostrClient());
  const rootRef = useRef<HTMLDivElement | null>(null);
  const profileCache = useRef(new Map<string, Promise<Profile | null>>());

  // ---- hash routing ----
  useEffect(() => {
    const applyHash = (): void => {
      dispatch({ type: "navigate", nav: normalizeNav(parseHashRoute(window.location.hash)) });
    };
    if (!window.location.hash || window.location.hash === "#") {
      window.history.replaceState(null, "", routeToHash({ view: "home", params: {} }));
    } else {
      applyHash();
    }
    window.addEventListener("hashchange", applyHash);
    return () => window.removeEventListener("hashchange", applyHash);
  }, []);

  // ---- boot ----
  useEffect(() => {
    const identity = loadPersisted();
    let bookmarks: string[] = [];
    try {
      bookmarks = JSON.parse(localStorage.getItem(BOOKMARKS_KEY) ?? "[]") as string[];
    } catch {
      bookmarks = [];
    }
    dispatch({
      type: "init",
      identity,
      relays: loadRelays(),
      theme: loadTheme(),
      palette: loadPalette(),
      bookmarks,
      notificationReadIds: loadNotificationReadIds(identity?.pubkey),
    });
  }, []);

  // ---- load per-identity notification read state ----
  useEffect(() => {
    const pubkey = state.identity?.pubkey;
    dispatch({ type: "setNotifications", notifications: [] });
    dispatch({ type: "setNotificationReadIds", ids: loadNotificationReadIds(pubkey) });
  }, [state.identity?.pubkey]);

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

  const toast = useCallback((text: string, tone: Toast["tone"] = "info", action?: ToastAction) => {
    const id = toastSeq++;
    dispatch({ type: "pushToast", toast: { id, text, tone, action } });
    setTimeout(() => dispatch({ type: "dropToast", id }), 3200);
  }, []);

  // ---- notifications: backfill silently, toast + ping only after EOSE ----
  useEffect(() => {
    const me = state.identity?.pubkey;
    if (!me || readRelayUrls.length === 0) return;

    const filters: Filter[] = [
      { kinds: [Kind.Note, Kind.Mention], "#p": [me], limit: 80 },
      { kinds: [Kind.Reaction], "#p": [me], limit: 80 },
      { kinds: [Kind.ZapReceipt], "#p": [me], limit: 50 },
      { kinds: [Kind.EncryptedDM, Kind.PrivateDirectMessage], "#p": [me], limit: 80 },
    ];

    const unsubscribe = filters.map((filter) => {
      let live = false;
      return clientRef.current.subscribe(
        readRelayUrls,
        filter,
        (event) => {
          const notification = buildNotification(event, me);
          if (!notification) return;
          dispatch({ type: "addNotification", notification });
          if (live) {
            toast(notificationToastText(notification), "info");
            playNotificationPing();
          }
        },
        () => {
          live = true;
        },
      );
    });

    return () => {
      for (const unsub of unsubscribe) unsub();
    };
  }, [state.identity?.pubkey, readRelayUrls, toast]);

  const navigate = useCallback((view: ViewId, params: Record<string, string | undefined> = {}) => {
    const nav = normalizeNav({ view, params });
    const hash = routeToHash(nav);
    if (window.location.hash !== hash) window.location.hash = hash;
    dispatch({ type: "navigate", nav });
  }, []);

  const markNotificationRead = useCallback(
    (eventId: string) => {
      const pubkey = state.identity?.pubkey;
      const ids = state.notificationReadIds.includes(eventId)
        ? state.notificationReadIds
        : [...state.notificationReadIds, eventId];
      saveNotificationReadIds(pubkey, ids);
      dispatch({ type: "setNotificationReadIds", ids });
    },
    [state.identity?.pubkey, state.notificationReadIds],
  );

  const markAllNotificationsRead = useCallback(() => {
    const pubkey = state.identity?.pubkey;
    const ids = [...new Set([...state.notificationReadIds, ...state.notifications.map((n) => n.eventId)])];
    saveNotificationReadIds(pubkey, ids);
    dispatch({ type: "setNotificationReadIds", ids });
  }, [state.identity?.pubkey, state.notificationReadIds, state.notifications]);

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
        toast(has ? "Unfollowed" : "Followed", has ? "info" : "check", has ? undefined : { type: "profile", pubkey });
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
    markNotificationRead,
    markAllNotificationsRead,
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
