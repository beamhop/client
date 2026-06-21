import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Event as NostrEvent, Filter } from "nostr-tools";
import { useStore } from "./store.tsx";
import { Kind, type Note } from "@beamhop/nostr";
import { compileMutes } from "@beamhop/lib";
import {
  decodeEmbeddedRepostNote,
  decodeNote,
  decodeRepostPointer,
  deletedEventIdsByAuthor,
} from "@beamhop/nostr";

const sortNotes = (notes: Iterable<Note>): Note[] =>
  [...notes].sort((a, b) => b.createdAt - a.createdAt);

export type TimelineItem =
  | {
      id: string;
      type: "note";
      createdAt: number;
      note: Note;
    }
  | {
      id: string;
      type: "repost";
      createdAt: number;
      note: Note;
      repostedBy: string;
      repostEventId: string;
      repostEvent?: NostrEvent;
    };

const sortTimelineItems = (items: Iterable<TimelineItem>): TimelineItem[] =>
  [...items].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));

const feedLimit = (filter: Filter): number =>
  typeof filter.limit === "number" && filter.limit > 0 ? filter.limit : 80;

const oldestCreatedAt = (notes: Iterable<Note>): number | undefined => {
  let oldest: number | undefined;
  for (const note of notes) {
    if (oldest === undefined || note.createdAt < oldest) oldest = note.createdAt;
  }
  return oldest;
};

const oldestTimelineCreatedAt = (items: Iterable<TimelineItem>): number | undefined => {
  let oldest: number | undefined;
  for (const item of items) {
    if (oldest === undefined || item.createdAt < oldest) oldest = item.createdAt;
  }
  return oldest;
};

/** Live-subscribe to a feed of notes (kind 1) matching the given filter. */
export const useFeed = (
  filter: Filter,
  deps: unknown[],
  enabled = true,
): {
  notes: Note[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
  refreshing: boolean;
} => {
  const { client, readRelayUrls } = useStore();
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const byIdRef = useRef<Map<string, Note>>(new Map());
  const pagingRef = useRef(false);
  const feedVersionRef = useRef(0);

  // Stable filter identity across renders.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableFilter = useMemo(() => filter, deps);

  const flush = useCallback(() => {
    setNotes(sortNotes(byIdRef.current.values()));
  }, []);

  const addEvent = useCallback((event: NostrEvent): boolean => {
    if (event.kind !== Kind.Note) return false;
    if (byIdRef.current.has(event.id)) return false;
    byIdRef.current.set(event.id, decodeNote(event));
    return true;
  }, []);

  useEffect(() => {
    if (!enabled || readRelayUrls.length === 0) {
      feedVersionRef.current++;
      byIdRef.current = new Map();
      setNotes([]);
      setLoading(false);
      setLoadingMore(false);
      setHasMore(false);
      return;
    }
    setLoading(true);
    setLoadingMore(false);
    setHasMore(true);
    setNotes([]);
    feedVersionRef.current++;
    byIdRef.current = new Map();
    pagingRef.current = false;
    const unsub = client.subscribe(
      readRelayUrls,
      stableFilter,
      (event) => {
        if (addEvent(event)) flush();
      },
      () => {
        setLoading(false);
        if (byIdRef.current.size === 0) setHasMore(false);
      },
    );
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addEvent, client, flush, readRelayUrls, stableFilter, enabled]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (!enabled || readRelayUrls.length === 0 || loading || !hasMore || pagingRef.current) return;
    const oldest = oldestCreatedAt(byIdRef.current.values());
    if (oldest === undefined) {
      setHasMore(false);
      return;
    }

    pagingRef.current = true;
    const feedVersion = feedVersionRef.current;
    setLoadingMore(true);
    try {
      const events = await client.list(readRelayUrls, {
        ...stableFilter,
        until: oldest,
        limit: feedLimit(stableFilter),
      });
      if (feedVersion !== feedVersionRef.current) return;
      let added = 0;
      for (const event of events) {
        if (addEvent(event)) added++;
      }
      if (added > 0) flush();
      else setHasMore(false);
    } catch {
      if (feedVersion === feedVersionRef.current) setHasMore(false);
    } finally {
      if (feedVersion === feedVersionRef.current) {
        pagingRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [addEvent, client, enabled, flush, hasMore, loading, readRelayUrls, stableFilter]);

  const refresh = useCallback(async (): Promise<void> => {
    if (!enabled || readRelayUrls.length === 0 || refreshing) return;
    setRefreshing(true);
    const feedVersion = feedVersionRef.current;
    try {
      // Online-only pull-to-refresh: one-shot fetch of the newest events merged
      // into the live set (no teardown → no flash-to-empty); addEvent dedups by id.
      const events = await client.list(readRelayUrls, { ...stableFilter, limit: feedLimit(stableFilter) });
      if (feedVersion !== feedVersionRef.current) return;
      let added = 0;
      for (const event of events) if (addEvent(event)) added++;
      if (added > 0) flush();
    } catch {
      // Keep current notes on failure.
    } finally {
      if (feedVersion === feedVersionRef.current) setRefreshing(false);
    }
  }, [addEvent, client, enabled, flush, readRelayUrls, refreshing, stableFilter]);

  return { notes, loading, loadingMore, hasMore, loadMore, refresh, refreshing };
};

export type TimelineFeedOptions = {
  /**
   * When `true`, live events that arrive *after* the initial load completes are
   * held in a `pending` buffer instead of being prepended to `items`. The
   * consumer surfaces a "show new posts" affordance and calls `showPending()`
   * to release them at once (Twitter-style). Off by default, so other consumers
   * keep the auto-prepend behavior unchanged.
   *
   * As a safety valve, arrivals are never buffered while the visible feed is
   * still empty — there is nothing to protect against, and relays that send
   * EOSE before any stored events would otherwise leave the user staring at a
   * blank feed behind a pill.
   */
  buffer?: boolean;
};

/** Live-subscribe to notes and reposts, resolving kind-6 reposts to note rows. */
export const useTimelineFeed = (
  filter: Filter,
  deps: unknown[],
  enabled = true,
  options: TimelineFeedOptions = {},
): {
  items: TimelineItem[];
  pending: TimelineItem[];
  showPending: () => void;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
  refreshing: boolean;
} => {
  const { client, readRelayUrls } = useStore();
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [pending, setPending] = useState<TimelineItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const notesByIdRef = useRef<Map<string, Note>>(new Map());
  const itemsByIdRef = useRef<Map<string, TimelineItem>>(new Map());
  const repostsByIdRef = useRef<Map<string, NostrEvent>>(new Map());
  const pendingFetchesRef = useRef<Set<string>>(new Set());
  // Ids currently merged into `items`; everything else known is "pending".
  const shownIdsRef = useRef<Set<string>>(new Set());
  // Flips true at the first EOSE — i.e. once the stored backlog has loaded and
  // subsequent events are genuinely "new". Gates buffering.
  const liveRef = useRef(false);
  const pagingRef = useRef(false);
  const feedVersionRef = useRef(0);

  // Mirror the buffering flag into a ref so subscription callbacks read the
  // latest value without re-subscribing when it toggles (e.g. on tab switch).
  const bufferRef = useRef(options.buffer ?? false);
  bufferRef.current = options.buffer ?? false;

  // Stable filter identity across renders.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableFilter = useMemo(() => filter, deps);

  const flushShown = useCallback(() => {
    const shown: TimelineItem[] = [];
    for (const [id, item] of itemsByIdRef.current) if (shownIdsRef.current.has(id)) shown.push(item);
    setItems(sortTimelineItems(shown));
  }, []);

  const flushPending = useCallback(() => {
    const buffered: TimelineItem[] = [];
    for (const [id, item] of itemsByIdRef.current) if (!shownIdsRef.current.has(id)) buffered.push(item);
    setPending(sortTimelineItems(buffered));
  }, []);

  // Surface freshly-added items: hold them in the buffer when live + buffering +
  // a baseline feed already exists; otherwise reveal them immediately.
  const surface = useCallback(
    (addedIds: readonly string[]): void => {
      if (addedIds.length === 0) return;
      if (bufferRef.current && liveRef.current && shownIdsRef.current.size > 0) {
        flushPending();
      } else {
        for (const id of addedIds) shownIdsRef.current.add(id);
        flushShown();
      }
    },
    [flushPending, flushShown],
  );

  const addRepostItem = useCallback((event: NostrEvent, note: Note): string | undefined => {
    const id = `repost:${event.id}`;
    if (itemsByIdRef.current.has(id)) return undefined;
    itemsByIdRef.current.set(id, {
      id,
      type: "repost",
      createdAt: event.created_at,
      note,
      repostedBy: event.pubkey,
      repostEventId: event.id,
      repostEvent: event,
    });
    return id;
  }, []);

  const addResolvedRepostsForNote = useCallback(
    (note: Note): string[] => {
      const added: string[] = [];
      for (const event of repostsByIdRef.current.values()) {
        const pointer = decodeRepostPointer(event);
        if (pointer?.noteId !== note.id) continue;
        const id = addRepostItem(event, note);
        if (id) added.push(id);
      }
      return added;
    },
    [addRepostItem],
  );

  const addNoteEvent = useCallback(
    (event: NostrEvent): string[] => {
      if (event.kind !== Kind.Note) return [];
      const note = decodeNote(event);
      notesByIdRef.current.set(note.id, note);

      const added: string[] = [];
      const id = `note:${note.id}`;
      if (!itemsByIdRef.current.has(id)) {
        itemsByIdRef.current.set(id, { id, type: "note", createdAt: note.createdAt, note });
        added.push(id);
      }
      added.push(...addResolvedRepostsForNote(note));
      return added;
    },
    [addResolvedRepostsForNote],
  );

  const fetchMissingRepostNote = useCallback(
    (noteId: string, feedVersion: number): void => {
      if (pendingFetchesRef.current.has(noteId)) return;
      const pendingFetches = pendingFetchesRef.current;
      pendingFetches.add(noteId);
      void client
        .get(readRelayUrls, { kinds: [Kind.Note], ids: [noteId] })
        .then((event) => {
          if (feedVersion !== feedVersionRef.current || event?.kind !== Kind.Note) return;
          const note = decodeNote(event);
          notesByIdRef.current.set(note.id, note);
          surface(addResolvedRepostsForNote(note));
        })
        .finally(() => {
          pendingFetches.delete(noteId);
        });
    },
    [addResolvedRepostsForNote, client, readRelayUrls, surface],
  );

  const addRepostEvent = useCallback(
    (event: NostrEvent, feedVersion: number): string[] => {
      const pointer = decodeRepostPointer(event);
      if (!pointer) return [];
      repostsByIdRef.current.set(event.id, event);

      const note = notesByIdRef.current.get(pointer.noteId) ?? decodeEmbeddedRepostNote(event);
      if (note) {
        notesByIdRef.current.set(note.id, note);
        const id = addRepostItem(event, note);
        return id ? [id] : [];
      }

      fetchMissingRepostNote(pointer.noteId, feedVersion);
      return [];
    },
    [addRepostItem, fetchMissingRepostNote],
  );

  const addEvent = useCallback(
    (event: NostrEvent, feedVersion: number): string[] => {
      if (event.kind === Kind.Note) return addNoteEvent(event);
      if (event.kind === Kind.Repost) return addRepostEvent(event, feedVersion);
      return [];
    },
    [addNoteEvent, addRepostEvent],
  );

  useEffect(() => {
    if (!enabled || readRelayUrls.length === 0) {
      feedVersionRef.current++;
      notesByIdRef.current = new Map();
      itemsByIdRef.current = new Map();
      repostsByIdRef.current = new Map();
      pendingFetchesRef.current = new Set();
      shownIdsRef.current = new Set();
      liveRef.current = false;
      setItems([]);
      setPending([]);
      setLoading(false);
      setLoadingMore(false);
      setHasMore(false);
      return;
    }
    setLoading(true);
    setLoadingMore(false);
    setHasMore(true);
    setItems([]);
    setPending([]);
    feedVersionRef.current++;
    const feedVersion = feedVersionRef.current;
    notesByIdRef.current = new Map();
    itemsByIdRef.current = new Map();
    repostsByIdRef.current = new Map();
    pendingFetchesRef.current = new Set();
    shownIdsRef.current = new Set();
    liveRef.current = false;
    pagingRef.current = false;
    const unsub = client.subscribe(
      readRelayUrls,
      stableFilter,
      (event) => {
        if (feedVersion !== feedVersionRef.current) return;
        surface(addEvent(event, feedVersion));
      },
      () => {
        if (feedVersion !== feedVersionRef.current) return;
        liveRef.current = true;
        setLoading(false);
        if (itemsByIdRef.current.size === 0 && pendingFetchesRef.current.size === 0) setHasMore(false);
      },
    );
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addEvent, client, surface, readRelayUrls, stableFilter, enabled]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (!enabled || readRelayUrls.length === 0 || loading || !hasMore || pagingRef.current) return;
    const oldest = oldestTimelineCreatedAt(itemsByIdRef.current.values());
    if (oldest === undefined) {
      setHasMore(false);
      return;
    }

    pagingRef.current = true;
    const feedVersion = feedVersionRef.current;
    setLoadingMore(true);
    try {
      const events = await client.list(readRelayUrls, {
        ...stableFilter,
        until: oldest,
        limit: feedLimit(stableFilter),
      });
      if (feedVersion !== feedVersionRef.current) return;
      const added: string[] = [];
      for (const event of events) added.push(...addEvent(event, feedVersion));
      if (added.length > 0) {
        // Paged-in items are older than the visible feed, so reveal them
        // immediately — they never belong in the "new posts" buffer.
        for (const id of added) shownIdsRef.current.add(id);
        flushShown();
      } else if (pendingFetchesRef.current.size === 0) setHasMore(false);
    } catch {
      if (feedVersion === feedVersionRef.current) setHasMore(false);
    } finally {
      if (feedVersion === feedVersionRef.current) {
        pagingRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [addEvent, client, enabled, flushShown, hasMore, loading, readRelayUrls, stableFilter]);

  const refresh = useCallback(async (): Promise<void> => {
    if (!enabled || readRelayUrls.length === 0 || refreshing) return;
    setRefreshing(true);
    const feedVersion = feedVersionRef.current;
    try {
      // Online-only pull-to-refresh: one-shot fetch of the newest events merged
      // into the live set (no teardown → no flash-to-empty); addEvent dedups by id.
      const events = await client.list(readRelayUrls, { ...stableFilter, limit: feedLimit(stableFilter) });
      if (feedVersion !== feedVersionRef.current) return;
      for (const event of events) addEvent(event, feedVersion);
      // An explicit refresh reveals the latest at once, absorbing the buffer.
      for (const id of itemsByIdRef.current.keys()) shownIdsRef.current.add(id);
      flushShown();
      setPending([]);
    } catch {
      // Keep current items on failure.
    } finally {
      if (feedVersion === feedVersionRef.current) setRefreshing(false);
    }
  }, [addEvent, client, enabled, flushShown, readRelayUrls, refreshing, stableFilter]);

  // Release the buffered posts into the visible feed, newest-first.
  const showPending = useCallback((): void => {
    for (const id of itemsByIdRef.current.keys()) shownIdsRef.current.add(id);
    flushShown();
    setPending([]);
  }, [flushShown]);

  return { items, pending, showPending, loading, loadingMore, hasMore, loadMore, refresh, refreshing };
};

export type Engagement = {
  likes: number;
  reposts: number;
  replies: number;
  liked: boolean;
  reposted: boolean;
  likedEventId?: string;
  repostedEventIds?: string[];
};

const empty: Engagement = { likes: 0, reposts: 0, replies: 0, liked: false, reposted: false };

/** Fetch like/repost/reply counts for a batch of notes in a single query. */
export const useEngagement = (
  noteIds: string[],
  optimistic: Record<string, Partial<Engagement>> = {},
): Map<string, Engagement> => {
  const { client, readRelayUrls, state } = useStore();
  const [map, setMap] = useState<Map<string, Engagement>>(new Map());
  const key = noteIds.join(",");
  const me = state.identity?.pubkey;
  const lastKey = useRef("");
  const queryKey = `${me ?? ""}|${readRelayUrls.join(",")}|${key}`;

  useEffect(() => {
    if (noteIds.length === 0 || readRelayUrls.length === 0) return;
    if (lastKey.current === queryKey) return;
    lastKey.current = queryKey;
    let cancelled = false;
    void (async () => {
      const events = await client.list(readRelayUrls, {
        kinds: [Kind.Reaction, Kind.Repost, Kind.Note],
        "#e": noteIds,
      });
      if (cancelled) return;
      const eventAuthorById = new Map(events.map((event) => [event.id, event.pubkey]));
      const deletions =
        events.length > 0
          ? await client.list(readRelayUrls, {
              kinds: [Kind.Deletion],
              "#e": [...eventAuthorById.keys()],
            })
          : [];
      if (cancelled) return;
      const deletedIds = deletedEventIdsByAuthor(deletions, eventAuthorById);
      const next = new Map<string, Engagement>();
      for (const id of noteIds) next.set(id, { ...empty });
      for (const ev of events) {
        if (deletedIds.has(ev.id)) continue;
        const target = [...ev.tags].reverse().find((t) => t[0] === "e")?.[1];
        const cur = target ? next.get(target) : undefined;
        if (!cur) continue;
        if (ev.kind === Kind.Reaction && ev.content !== "-") {
          cur.likes++;
          if (ev.pubkey === me) {
            cur.liked = true;
            cur.likedEventId = ev.id;
          }
        } else if (ev.kind === Kind.Repost) {
          cur.reposts++;
          if (ev.pubkey === me) {
            cur.reposted = true;
            cur.repostedEventIds = [...(cur.repostedEventIds ?? []), ev.id];
          }
        } else if (ev.kind === Kind.Note) {
          cur.replies++;
        }
      }
      setMap(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [client, readRelayUrls, queryKey, noteIds]);

  // Merge optimistic overrides without refetching.
  return useMemo(() => {
    const merged = new Map<string, Engagement>();
    for (const id of noteIds) {
      const base = map.get(id) ?? empty;
      merged.set(id, { ...base, ...optimistic[id] });
    }
    return merged;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, key, JSON.stringify(optimistic)]);
};

/** Returns compiled mute rules, memoized on the rules array identity. */
export function useCompiledMutes(): ReturnType<typeof compileMutes> {
  const { state } = useStore();
  return useMemo(() => compileMutes(state.muteSettings.rules), [state.muteSettings.rules]);
}

/** Returns the count of unread, non-muted notifications. */
export function useUnreadNotificationCount(): number {
  const { state } = useStore();
  const mutes = useCompiledMutes();
  return useMemo(() => {
    const readSet = new Set(state.notificationReadIds);
    return state.notifications.filter((n) => !readSet.has(n.id) && !mutes.matchAccount(n.pubkey) && !mutes.matchText(n.content)).length;
  }, [state.notifications, state.notificationReadIds, mutes]);
}
