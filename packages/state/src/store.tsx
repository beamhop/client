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
import { flushSync } from "react-dom";
import type { Event as NostrEvent, EventTemplate, Filter } from "nostr-tools";
import { NostrClient, nowSeconds } from "@beamhop/nostr";
import { haptic } from "@beamhop/lib";
import { Kind, type Profile, type RelayInfo } from "@beamhop/nostr";
import { decodeProfile, buildContacts, tagValue } from "@beamhop/nostr";
import {
  type Identity,
  loadPersisted,
  persist,
  clearPersisted,
} from "@beamhop/nostr";
import { loadRelays, saveRelays, readRelays, writeRelays } from "@beamhop/nostr";
import {
  type ThemeMode,
  type PaletteId,
  loadTheme,
  saveTheme,
  loadPalette,
  savePalette,
  applyPalette,
} from "@beamhop/lib";
import {
  type MuteSettings,
  type MuteRuleInput,
  type MuteRulePatch,
  type MuteDisplay,
  EMPTY_MUTE_SETTINGS,
  compileMutes,
  evaluateNotification,
  parseMuteSettings,
  serializeMuteSettings,
  addRule,
  removeRule,
  updateRule,
  mergeSettings,
} from "@beamhop/lib";
import {
  type FollowSet,
  type BookmarkSet,
  createFollowSet,
  addPubkeyToFollowSet,
  removePubkeyFromFollowSet,
  createBookmarkSet,
  addEventIdToBookmarkSet,
  removeEventIdFromBookmarkSet,
} from "@beamhop/lib";
import {
  buildMuteList,
  parseMuteList,
  buildFollowSet,
  parseFollowSet,
  buildBookmarkSet,
  parseBookmarkSet,
} from "@beamhop/nostr";

export type ViewId =
  | "home"
  | "explore"
  | "docs"
  | "docReader"
  | "docEditor"
  | "notifications"
  | "mentions"
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

/** Direction of the last navigation, used to pick the push vs pop transition. */
export type NavDir = "forward" | "back" | "none";

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
  event?: NostrEvent;
};

type State = {
  identity: Identity | null;
  me: Profile | null;
  relays: RelayInfo[];
  contacts: string[]; // followed pubkeys
  theme: ThemeMode;
  palette: PaletteId;
  nav: Nav;
  navDir: NavDir;
  toasts: Toast[];
  notifications: NotificationItem[];
  notificationReadIds: string[];
  bookmarks: string[]; // local-only note ids
  muteSettings: MuteSettings; // local-only soft-mute rules + display mode
  followSets: FollowSet[];
  bookmarkSets: BookmarkSet[];
  developerMode: boolean;
  ready: boolean;
};

type Action =
  | { type: "init"; identity: Identity | null; relays: RelayInfo[]; theme: ThemeMode; palette: PaletteId; bookmarks: string[]; notificationReadIds: string[]; muteSettings: MuteSettings; developerMode: boolean }
  | { type: "setIdentity"; identity: Identity | null }
  | { type: "setMe"; me: Profile | null }
  | { type: "setRelays"; relays: RelayInfo[] }
  | { type: "setContacts"; contacts: string[] }
  | { type: "setTheme"; theme: ThemeMode }
  | { type: "setPalette"; palette: PaletteId }
  | { type: "navigate"; nav: Nav; dir: NavDir }
  | { type: "setNotifications"; notifications: NotificationItem[] }
  | { type: "addNotification"; notification: NotificationItem }
  | { type: "setNotificationReadIds"; ids: string[] }
  | { type: "pushToast"; toast: Toast }
  | { type: "dropToast"; id: number }
  | { type: "setBookmarks"; bookmarks: string[] }
  | { type: "setMuteSettings"; muteSettings: MuteSettings }
  | { type: "setFollowSets"; followSets: FollowSet[] }
  | { type: "setBookmarkSets"; bookmarkSets: BookmarkSet[] }
  | { type: "setDeveloperMode"; developerMode: boolean }
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
        muteSettings: action.muteSettings,
        developerMode: action.developerMode,
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
      return { ...state, nav: action.nav, navDir: action.dir };
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
      const notification = cloneNotificationWithRead(
        action.notification,
        state.notificationReadIds.includes(action.notification.eventId),
      );
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
    case "setMuteSettings":
      return { ...state, muteSettings: action.muteSettings };
    case "setFollowSets":
      return { ...state, followSets: action.followSets };
    case "setBookmarkSets":
      return { ...state, bookmarkSets: action.bookmarkSets };
    case "setDeveloperMode":
      return { ...state, developerMode: action.developerMode };
    case "ready":
      return { ...state, ready: true };
  }
};

const BOOKMARKS_KEY = "beamhop.bookmarks.v1";
const NOTIFICATION_READ_KEY = "beamhop.notifications.read.v1";
const MUTES_KEY = "beamhop.mutes.v1";
const MUTES_RELAY_AT_KEY = "beamhop.mutes.relayAt.v1";
const DEVELOPER_MODE_KEY = "beamhop.developerMode.v1";

// Browser/status-bar tint per theme; kept in sync with --bg-base in tokens.css.
const BG_BY_MODE: Record<ThemeMode, string> = { light: "#fafafa", dark: "#0a0a0a" };

const notificationReadKey = (pubkey: string): string => `${NOTIFICATION_READ_KEY}:${pubkey}`;

const mutesKey = (pubkey: string): string => `${MUTES_KEY}:${pubkey}`;
const mutesRelayAtKey = (pubkey: string): string => `${MUTES_RELAY_AT_KEY}:${pubkey}`;

const loadDeveloperMode = (): boolean => {
  try {
    return localStorage.getItem(DEVELOPER_MODE_KEY) === "true";
  } catch {
    return false;
  }
};

const saveDeveloperMode = (enabled: boolean): void => {
  localStorage.setItem(DEVELOPER_MODE_KEY, enabled ? "true" : "false");
};

// Mute rules are identity-scoped. relayAt tracks the created_at of the last
// relay event we merged, so we don't blindly overwrite local changes with an
// older remote snapshot on re-login.
const loadMuteSettings = (pubkey: string | undefined): MuteSettings => {
  if (!pubkey) return { ...EMPTY_MUTE_SETTINGS };
  try {
    return parseMuteSettings(JSON.parse(localStorage.getItem(mutesKey(pubkey)) ?? "null"));
  } catch {
    return { ...EMPTY_MUTE_SETTINGS };
  }
};

const saveMuteSettings = (pubkey: string | undefined, settings: MuteSettings): void => {
  if (!pubkey) return;
  localStorage.setItem(mutesKey(pubkey), serializeMuteSettings(settings));
};

const loadMuteRelayAt = (pubkey: string): number => {
  try {
    return Number(localStorage.getItem(mutesRelayAtKey(pubkey)) ?? "0");
  } catch {
    return 0;
  }
};

const saveMuteRelayAt = (pubkey: string, createdAt: number): void => {
  localStorage.setItem(mutesRelayAtKey(pubkey), String(createdAt));
};

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
  return (items ?? []).map((item) => cloneNotificationWithRead(item, read.has(item.eventId)));
};

const cloneNotificationWithRead = (item: NotificationItem, read: boolean): NotificationItem => {
  const clone = { ...item, read };
  return item.event ? withNotificationEvent(clone, item.event) : clone;
};

const hasTagValue = (event: NostrEvent, key: string, value: string): boolean =>
  event.tags.some((tag) => tag[0] === key && tag[1] === value);

const notificationTarget = (event: NostrEvent): string | undefined =>
  [...event.tags].reverse().find((tag) => (tag[0] === "e" || tag[0] === "a") && tag[1])?.[1];

const buildNotification = (event: NostrEvent, me: string): NotificationItem | null => {
  if (event.pubkey === me) return null;
  if (!hasTagValue(event, "p", me)) return null;

  if (event.kind === Kind.Note || event.kind === Kind.Mention) {
    const targetId = notificationTarget(event);
    return withNotificationEvent({
      id: event.id,
      eventId: event.id,
      type: targetId ? "reply" : "mention",
      pubkey: event.pubkey,
      createdAt: event.created_at,
      content: event.content,
      targetId,
      read: false,
    }, event);
  }

  if (event.kind === Kind.Reaction) {
    return withNotificationEvent({
      id: event.id,
      eventId: event.id,
      type: "reaction",
      pubkey: event.pubkey,
      createdAt: event.created_at,
      content: event.content || "+",
      targetId: notificationTarget(event),
      read: false,
    }, event);
  }

  if (event.kind === Kind.ZapReceipt) {
    return withNotificationEvent({
      id: event.id,
      eventId: event.id,
      type: "zap",
      pubkey: event.pubkey,
      createdAt: event.created_at,
      content: tagValue(event, "amount") ?? event.content,
      targetId: notificationTarget(event),
      read: false,
    }, event);
  }

  if (event.kind === Kind.EncryptedDM || event.kind === Kind.PrivateDirectMessage) {
    return withNotificationEvent({
      id: event.id,
      eventId: event.id,
      type: "dm",
      pubkey: event.pubkey,
      createdAt: event.created_at,
      content: "",
      read: false,
    }, event);
  }

  return null;
};

const withNotificationEvent = (notification: NotificationItem, event: NostrEvent): NotificationItem => {
  Object.defineProperty(notification, "event", {
    value: event,
    enumerable: false,
    configurable: true,
  });
  return notification;
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
    case "mentions":
      return "#/mentions";
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
    case "mentions":
      return { view: "mentions", params: {} };
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
  goBack: () => void;
  setRefreshHandler: (fn: (() => void | Promise<void>) | null) => void;
  runRefresh: () => Promise<void>;
  toast: (text: string, tone?: Toast["tone"], action?: ToastAction) => void;
  markNotificationRead: (eventId: string) => void;
  markAllNotificationsRead: () => void;
  setIdentity: (identity: Identity | null) => void;
  setMe: (me: Profile | null) => void;
  setRelays: (relays: RelayInfo[]) => void;
  toggleTheme: () => void;
  setPalette: (id: PaletteId) => void;
  setDeveloperMode: (enabled: boolean) => void;
  toggleFollow: (pubkey: string) => Promise<void>;
  toggleBookmark: (noteId: string) => void;
  addMuteRule: (input: MuteRuleInput) => void;
  removeMuteRule: (id: string) => void;
  updateMuteRule: (id: string, patch: MuteRulePatch) => void;
  toggleMuteAccount: (pubkey: string) => void;
  setMuteDisplay: (display: MuteDisplay) => void;
  exportMuteSettings: () => string;
  importMuteSettings: (json: string) => boolean;
  followSets: FollowSet[];
  bookmarkSets: BookmarkSet[];
  createFollowSet: (name: string, isPrivate: boolean) => Promise<void>;
  updateFollowSet: (id: string, patch: Partial<Pick<FollowSet, "name" | "isPrivate" | "pubkeys">>) => Promise<void>;
  deleteFollowSet: (id: string) => Promise<void>;
  addToFollowSet: (setId: string, pubkey: string) => Promise<void>;
  removeFromFollowSet: (setId: string, pubkey: string) => Promise<void>;
  createFollowSetAndAdd: (name: string, isPrivate: boolean, pubkey: string) => Promise<void>;
  createBookmarkSet: (name: string, isPrivate: boolean) => Promise<void>;
  updateBookmarkSet: (id: string, patch: Partial<Pick<BookmarkSet, "name" | "isPrivate" | "eventIds">>) => Promise<void>;
  deleteBookmarkSet: (id: string) => Promise<void>;
  addToBookmarkSet: (setId: string, eventId: string) => Promise<void>;
  removeFromBookmarkSet: (setId: string, eventId: string) => Promise<void>;
  publish: (template: EventTemplate, relays?: string[]) => Promise<string>;
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
    palette: "White",
    nav: typeof window === "undefined" ? { view: "home", params: {} } : parseHashRoute(window.location.hash),
    navDir: "none",
    toasts: [],
    notifications: [],
    notificationReadIds: [],
    bookmarks: [],
    muteSettings: { ...EMPTY_MUTE_SETTINGS },
    followSets: [],
    bookmarkSets: [],
    developerMode: false,
    ready: false,
  });

  const clientRef = useRef(client ?? new NostrClient());
  const rootRef = useRef<HTMLDivElement | null>(null);
  const profileCache = useRef(new Map<string, Promise<Profile | null>>());
  // Monotonic history index mirrored into history.state.vi so popstate can tell
  // back from forward and pick the matching transition direction.
  const histIndexRef = useRef(0);
  // The active view registers its pull-to-refresh handler here so the shell-level
  // gesture can trigger it without prop-drilling through every view.
  const refreshHandlerRef = useRef<(() => void | Promise<void>) | null>(null);
  const mutePublishTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True once the initial relay fetch for the current identity has been attempted
  // (success or failure). Blocks publishing until we've had a chance to merge the
  // relay copy — otherwise empty local state can overwrite the relay on first login.
  const muteRelayFetchDone = useRef<boolean>(false);

  // Compiled mute matcher, kept current via a ref so the long-lived notification
  // subscription can filter without re-subscribing on every rule change.
  const muteRef = useRef(compileMutes(state.muteSettings.rules));
  useEffect(() => {
    muteRef.current = compileMutes(state.muteSettings.rules);
  }, [state.muteSettings.rules]);

  // Wrap a nav-induced DOM update in a directional View Transition where supported
  // (iOS 18.2+, modern Chrome); otherwise apply synchronously (older iOS falls back
  // to the keyed fade). prefers-reduced-motion always takes the synchronous path.
  const runNavTransition = useCallback((apply: () => void, dir: NavDir): void => {
    const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
    const reduce =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (typeof doc.startViewTransition !== "function" || reduce) {
      apply();
      return;
    }
    document.documentElement.dataset.navDir = dir;
    doc.startViewTransition(() => flushSync(apply));
  }, []);

  // ---- history routing (push/pop with direction) ----
  useEffect(() => {
    const onPop = (): void => {
      const idx = (window.history.state as { vi?: number } | null)?.vi;
      const nextIndex = typeof idx === "number" ? idx : 0;
      const dir: NavDir =
        nextIndex < histIndexRef.current ? "back" : nextIndex > histIndexRef.current ? "forward" : "none";
      histIndexRef.current = nextIndex;
      runNavTransition(
        () => dispatch({ type: "navigate", nav: normalizeNav(parseHashRoute(window.location.hash)), dir }),
        dir,
      );
    };
    const initialHash =
      !window.location.hash || window.location.hash === "#"
        ? routeToHash({ view: "home", params: {} })
        : window.location.hash;
    window.history.replaceState({ vi: 0 }, "", initialHash);
    histIndexRef.current = 0;
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [runNavTransition]);

  // ---- boot ----
  useEffect(() => {
    const identity = loadPersisted();
    let bookmarks: string[] = [];
    try {
      const rawBookmarks: unknown = JSON.parse(localStorage.getItem(BOOKMARKS_KEY) ?? '[]')
      bookmarks = Array.isArray(rawBookmarks) ? rawBookmarks.filter((x): x is string => typeof x === 'string') : []
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
      muteSettings: loadMuteSettings(identity?.pubkey),
      developerMode: loadDeveloperMode(),
    });
  }, []);

  // ---- load per-identity notification read state + mute rules ----
  useEffect(() => {
    const pubkey = state.identity?.pubkey;
    muteRelayFetchDone.current = false; // block publish until relay sync completes for this identity
    dispatch({ type: "setNotifications", notifications: [] });
    dispatch({ type: "setNotificationReadIds", ids: loadNotificationReadIds(pubkey) });
    dispatch({ type: "setMuteSettings", muteSettings: loadMuteSettings(pubkey) });
  }, [state.identity?.pubkey]);

  // ---- apply theme/palette to root + document ----
  useEffect(() => {
    if (rootRef.current) applyPalette(rootRef.current, state.palette, state.theme);
    // Mirror the theme onto <html> so --bg-base resolves correctly for the body,
    // safe-area regions, and overscroll gutter — not just the inner app div.
    document.documentElement.dataset.theme = state.theme;
    document.documentElement.style.background = "var(--bg-base)";
    // Keep the browser/status-bar tint in step with the active theme.
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", BG_BY_MODE[state.theme]);
  }, [state.palette, state.theme, state.ready]);

  const readRelayUrls = useMemo(() => readRelays(state.relays), [state.relays]);
  const writeRelayUrls = useMemo(() => writeRelays(state.relays), [state.relays]);
  useEffect(() => { profileCache.current.clear() }, [readRelayUrls])

  const toast = useCallback((text: string, tone: Toast["tone"] = "info", action?: ToastAction) => {
    const id = toastSeq++;
    dispatch({ type: "pushToast", toast: { id, text, tone, action } });
    setTimeout(() => dispatch({ type: "dropToast", id }), 3200);
  }, []);

  // ---- debounced NIP-51 mute list publish ----
  useEffect(() => {
    if (!state.ready) return;
    const identity = state.identity;
    if (!identity || writeRelayUrls.length === 0) return;

    // Block until the initial relay fetch for this identity is done — otherwise
    // empty local state (e.g. after clearing browser storage) overwrites the relay.
    if (!muteRelayFetchDone.current) return;

    if (mutePublishTimer.current !== null) clearTimeout(mutePublishTimer.current);
    mutePublishTimer.current = setTimeout(() => {
      void (async () => {
        try {
          const template = await buildMuteList(state.muteSettings, identity);
          await clientRef.current.publish(writeRelayUrls, identity, template);
        } catch {
          toast("Mute list failed to sync — changes are saved locally", "warn");
        }
      })();
    }, 1500);

    return () => {
      if (mutePublishTimer.current !== null) clearTimeout(mutePublishTimer.current);
    };
  }, [state.muteSettings, state.identity, state.ready, writeRelayUrls, toast]);

  // ---- load own profile + contacts + NIP-51 lists when identity changes ----
  useEffect(() => {
    const id = state.identity;
    if (!id || readRelayUrls.length === 0) return;
    const client = clientRef.current;
    let cancelled = false;
    void (async () => {
      const localMuteSettings = loadMuteSettings(id.pubkey);
      const lastMergedRelayAt = loadMuteRelayAt(id.pubkey);

      // Fetch everything in one round-trip so the mute list arrives before the
      // publish debounce can fire with stale (empty) local state.
      const [profileEvent, contactsEvent, muteListEvent, followSetEvents, bookmarkSetEvents] =
        await Promise.all([
          client.get(readRelayUrls, { kinds: [Kind.Metadata], authors: [id.pubkey] }),
          client.get(readRelayUrls, { kinds: [Kind.Contacts], authors: [id.pubkey] }),
          client.get(readRelayUrls, { kinds: [10000], authors: [id.pubkey] }),
          client.list(readRelayUrls, { kinds: [30000], authors: [id.pubkey] }),
          client.list(readRelayUrls, { kinds: [30003], authors: [id.pubkey] }),
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

      if (muteListEvent && muteListEvent.created_at > lastMergedRelayAt) {
        try {
          const remoteSettings = await parseMuteList(muteListEvent, id);
          // Union merge: keep every rule from both sides so neither device loses
          // rules added offline. Explicit removals still propagate because the
          // next publish sends the full current state.
          const merged = mergeSettings(localMuteSettings, remoteSettings);
          saveMuteRelayAt(id.pubkey, muteListEvent.created_at);
          saveMuteSettings(id.pubkey, merged);
          dispatch({ type: "setMuteSettings", muteSettings: merged });
        } catch {
          // Decryption failure (key rotation, etc.) — keep local settings
        }
      }

      // Unblock publishing now that we've merged from the relay. Set before
      // dispatching follow/bookmark sets so any subsequent muteSettings change
      // (e.g. from an account switch mid-fetch) doesn't race.
      muteRelayFetchDone.current = true;

      const followSets: FollowSet[] = (
        await Promise.all(
          followSetEvents.map(async (event) => {
            try {
              return await parseFollowSet(event, id);
            } catch {
              return null;
            }
          }),
        )
      ).filter((s): s is FollowSet => s !== null);
      dispatch({ type: "setFollowSets", followSets });

      const bookmarkSets: BookmarkSet[] = (
        await Promise.all(
          bookmarkSetEvents.map(async (event) => {
            try {
              return await parseBookmarkSet(event, id);
            } catch {
              return null;
            }
          }),
        )
      ).filter((s): s is BookmarkSet => s !== null);
      dispatch({ type: "setBookmarkSets", bookmarkSets });
    })().catch(() => {
      // Fetch failed entirely (e.g. all relays offline) — unblock publishing so
      // user-initiated changes can still be sent when connectivity returns.
      muteRelayFetchDone.current = true;
    });
    return () => {
      cancelled = true;
    };
  }, [state.identity, readRelayUrls]);

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
          if (evaluateNotification(muteRef.current, notification)) return;
          dispatch({ type: "addNotification", notification });
          if (live) {
            toast(notificationToastText(notification), "info");
            playNotificationPing();
            haptic("nudge");
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

  const navigate = useCallback(
    (view: ViewId, params: Record<string, string | undefined> = {}) => {
      const nav = normalizeNav({ view, params });
      const hash = routeToHash(nav);
      if (hash !== window.location.hash) {
        const nextIndex = histIndexRef.current + 1;
        histIndexRef.current = nextIndex;
        try {
          window.history.pushState({ vi: nextIndex }, "", hash);
        } catch {
          window.location.hash = hash;
        }
      }
      runNavTransition(() => dispatch({ type: "navigate", nav, dir: "forward" }), "forward");
    },
    [runNavTransition],
  );

  // Pop browser history when we can (gives a real reverse transition + edge-swipe
  // parity); fall back to Home so a leaf view in PWA standalone is never a dead end.
  const goBack = useCallback(() => {
    if (histIndexRef.current > 0) window.history.back();
    else navigate("home");
  }, [navigate]);

  const setRefreshHandler = useCallback((fn: (() => void | Promise<void>) | null) => {
    refreshHandlerRef.current = fn;
  }, []);
  const runRefresh = useCallback(async (): Promise<void> => {
    await refreshHandlerRef.current?.();
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

  const setDeveloperMode = useCallback((enabled: boolean) => {
    saveDeveloperMode(enabled);
    dispatch({ type: "setDeveloperMode", developerMode: enabled });
    toast(enabled ? "Developer mode enabled" : "Developer mode disabled", enabled ? "check" : "info");
  }, [toast]);

  const publish = useCallback(
    async (template: EventTemplate, relays?: string[]): Promise<string> => {
      if (!state.identity) throw new Error("Sign in first");
      const event = await clientRef.current.publish(relays ?? writeRelayUrls, state.identity, template);
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

  const persistMutes = useCallback(
    (next: MuteSettings) => {
      saveMuteSettings(state.identity?.pubkey, next);
      dispatch({ type: "setMuteSettings", muteSettings: next });
    },
    [state.identity?.pubkey],
  );

  const addMuteRule = useCallback(
    (input: MuteRuleInput) => persistMutes(addRule(state.muteSettings, input)),
    [state.muteSettings, persistMutes],
  );

  const removeMuteRule = useCallback(
    (id: string) => persistMutes(removeRule(state.muteSettings, id)),
    [state.muteSettings, persistMutes],
  );

  const updateMuteRule = useCallback(
    (id: string, patch: MuteRulePatch) => persistMutes(updateRule(state.muteSettings, id, patch)),
    [state.muteSettings, persistMutes],
  );

  const setMuteDisplay = useCallback(
    (display: MuteDisplay) => persistMutes({ ...state.muteSettings, display }),
    [state.muteSettings, persistMutes],
  );

  const toggleMuteAccount = useCallback(
    (pubkey: string) => {
      if (pubkey === state.identity?.pubkey) {
        toast("You can't mute yourself", "warn");
        return;
      }
      const existing = state.muteSettings.rules.find(
        (r) => r.type === "account" && r.pubkey === pubkey,
      );
      if (existing) {
        persistMutes(removeRule(state.muteSettings, existing.id));
        toast("Account unmuted", "info");
      } else {
        persistMutes(addRule(state.muteSettings, { type: "account", pubkey }));
        toast("Account muted", "check");
      }
    },
    [state.muteSettings, state.identity?.pubkey, persistMutes, toast],
  );

  const exportMuteSettings = useCallback(
    (): string => serializeMuteSettings(state.muteSettings),
    [state.muteSettings],
  );

  const importMuteSettings = useCallback(
    (json: string): boolean => {
      try {
        const incoming = parseMuteSettings(JSON.parse(json));
        persistMutes(mergeSettings(state.muteSettings, incoming));
        return true;
      } catch {
        return false;
      }
    },
    [state.muteSettings, persistMutes],
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

  // ---- follow set helpers ----

  const publishFollowSet = useCallback(
    async (set: FollowSet): Promise<void> => {
      const identity = state.identity;
      if (!identity || writeRelayUrls.length === 0) return;
      try {
        const template = await buildFollowSet(set, identity);
        await clientRef.current.publish(writeRelayUrls, identity, template);
      } catch {
        toast("Could not save list", "warn");
      }
    },
    [state.identity, writeRelayUrls, toast],
  );

  const createFollowSetCallback = useCallback(
    async (name: string, isPrivate: boolean): Promise<void> => {
      const next = createFollowSet(name, isPrivate);
      const updated = [...state.followSets, next];
      dispatch({ type: "setFollowSets", followSets: updated });
      await publishFollowSet(next);
    },
    [state.followSets, publishFollowSet],
  );

  const createFollowSetAndAdd = useCallback(
    async (name: string, isPrivate: boolean, pubkey: string): Promise<void> => {
      const next = addPubkeyToFollowSet(createFollowSet(name, isPrivate), pubkey);
      dispatch({ type: "setFollowSets", followSets: [...state.followSets, next] });
      await publishFollowSet(next);
    },
    [state.followSets, publishFollowSet],
  );

  const updateFollowSet = useCallback(
    async (id: string, patch: Partial<Pick<FollowSet, "name" | "isPrivate" | "pubkeys">>): Promise<void> => {
      const set = state.followSets.find((s) => s.id === id);
      if (!set) return;
      const updated = { ...set, ...patch };
      const next = state.followSets.map((s) => (s.id === id ? updated : s));
      dispatch({ type: "setFollowSets", followSets: next });
      await publishFollowSet(updated);
    },
    [state.followSets, publishFollowSet],
  );

  const deleteFollowSet = useCallback(
    async (id: string): Promise<void> => {
      const set = state.followSets.find((s) => s.id === id);
      if (!set) return;
      const next = state.followSets.filter((s) => s.id !== id);
      dispatch({ type: "setFollowSets", followSets: next });
      const identity = state.identity;
      if (identity && set.eventId && writeRelayUrls.length > 0) {
        try {
          await clientRef.current.publish(writeRelayUrls, identity, {
            kind: 5,
            created_at: nowSeconds(),
            tags: [["e", set.eventId]],
            content: "",
          });
        } catch {
          toast("Could not save list", "warn");
        }
      }
    },
    [state.followSets, state.identity, writeRelayUrls, toast],
  );

  const addToFollowSet = useCallback(
    async (setId: string, pubkey: string): Promise<void> => {
      const set = state.followSets.find((s) => s.id === setId);
      if (!set) return;
      const updated = addPubkeyToFollowSet(set, pubkey);
      const next = state.followSets.map((s) => (s.id === setId ? updated : s));
      dispatch({ type: "setFollowSets", followSets: next });
      await publishFollowSet(updated);
    },
    [state.followSets, publishFollowSet],
  );

  const removeFromFollowSet = useCallback(
    async (setId: string, pubkey: string): Promise<void> => {
      const set = state.followSets.find((s) => s.id === setId);
      if (!set) return;
      const updated = removePubkeyFromFollowSet(set, pubkey);
      const next = state.followSets.map((s) => (s.id === setId ? updated : s));
      dispatch({ type: "setFollowSets", followSets: next });
      await publishFollowSet(updated);
    },
    [state.followSets, publishFollowSet],
  );

  // ---- bookmark set helpers ----

  const publishBookmarkSet = useCallback(
    async (set: BookmarkSet): Promise<void> => {
      const identity = state.identity;
      if (!identity || writeRelayUrls.length === 0) return;
      try {
        const template = await buildBookmarkSet(set, identity);
        await clientRef.current.publish(writeRelayUrls, identity, template);
      } catch {
        toast("Could not save list", "warn");
      }
    },
    [state.identity, writeRelayUrls, toast],
  );

  const createBookmarkSetCallback = useCallback(
    async (name: string, isPrivate: boolean): Promise<void> => {
      const next = createBookmarkSet(name, isPrivate);
      const updated = [...state.bookmarkSets, next];
      dispatch({ type: "setBookmarkSets", bookmarkSets: updated });
      await publishBookmarkSet(next);
    },
    [state.bookmarkSets, publishBookmarkSet],
  );

  const updateBookmarkSet = useCallback(
    async (id: string, patch: Partial<Pick<BookmarkSet, "name" | "isPrivate" | "eventIds">>): Promise<void> => {
      const set = state.bookmarkSets.find((s) => s.id === id);
      if (!set) return;
      const updated = { ...set, ...patch };
      const next = state.bookmarkSets.map((s) => (s.id === id ? updated : s));
      dispatch({ type: "setBookmarkSets", bookmarkSets: next });
      await publishBookmarkSet(updated);
    },
    [state.bookmarkSets, publishBookmarkSet],
  );

  const deleteBookmarkSet = useCallback(
    async (id: string): Promise<void> => {
      const set = state.bookmarkSets.find((s) => s.id === id);
      if (!set) return;
      const next = state.bookmarkSets.filter((s) => s.id !== id);
      dispatch({ type: "setBookmarkSets", bookmarkSets: next });
      const identity = state.identity;
      if (identity && set.eventId && writeRelayUrls.length > 0) {
        try {
          await clientRef.current.publish(writeRelayUrls, identity, {
            kind: 5,
            created_at: nowSeconds(),
            tags: [["e", set.eventId]],
            content: "",
          });
        } catch {
          toast("Could not save list", "warn");
        }
      }
    },
    [state.bookmarkSets, state.identity, writeRelayUrls, toast],
  );

  const addToBookmarkSet = useCallback(
    async (setId: string, eventId: string): Promise<void> => {
      const set = state.bookmarkSets.find((s) => s.id === setId);
      if (!set) return;
      const updated = addEventIdToBookmarkSet(set, eventId);
      const next = state.bookmarkSets.map((s) => (s.id === setId ? updated : s));
      dispatch({ type: "setBookmarkSets", bookmarkSets: next });
      await publishBookmarkSet(updated);
    },
    [state.bookmarkSets, publishBookmarkSet],
  );

  const removeFromBookmarkSet = useCallback(
    async (setId: string, eventId: string): Promise<void> => {
      const set = state.bookmarkSets.find((s) => s.id === setId);
      if (!set) return;
      const updated = removeEventIdFromBookmarkSet(set, eventId);
      const next = state.bookmarkSets.map((s) => (s.id === setId ? updated : s));
      dispatch({ type: "setBookmarkSets", bookmarkSets: next });
      await publishBookmarkSet(updated);
    },
    [state.bookmarkSets, publishBookmarkSet],
  );

  const signOut = useCallback(() => {
    clearPersisted();
    dispatch({ type: "setIdentity", identity: null });
    dispatch({ type: "setMe", me: null });
    dispatch({ type: "setContacts", contacts: [] });
    dispatch({ type: "setNotifications", notifications: [] });
    dispatch({ type: "setNotificationReadIds", ids: [] });
    dispatch({ type: "setBookmarks", bookmarks: [] });
    dispatch({ type: "setMuteSettings", muteSettings: EMPTY_MUTE_SETTINGS });
    dispatch({ type: "setFollowSets", followSets: [] });
    dispatch({ type: "setBookmarkSets", bookmarkSets: [] });
    toast("Signed out", "info");
  }, [toast]);

  const store: Store = {
    state,
    client: clientRef.current,
    readRelayUrls,
    writeRelayUrls,
    navigate,
    goBack,
    setRefreshHandler,
    runRefresh,
    toast,
    markNotificationRead,
    markAllNotificationsRead,
    setIdentity,
    setMe,
    setRelays,
    toggleTheme,
    setPalette,
    setDeveloperMode,
    toggleFollow,
    toggleBookmark,
    addMuteRule,
    removeMuteRule,
    updateMuteRule,
    toggleMuteAccount,
    setMuteDisplay,
    exportMuteSettings,
    importMuteSettings,
    followSets: state.followSets,
    bookmarkSets: state.bookmarkSets,
    createFollowSet: createFollowSetCallback,
    updateFollowSet,
    deleteFollowSet,
    addToFollowSet,
    removeFromFollowSet,
    createFollowSetAndAdd,
    createBookmarkSet: createBookmarkSetCallback,
    updateBookmarkSet,
    deleteBookmarkSet,
    addToBookmarkSet,
    removeFromBookmarkSet,
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
