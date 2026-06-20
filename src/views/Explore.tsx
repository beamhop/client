import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { Event as NostrEvent, Filter } from "nostr-tools";
import { nip19 } from "nostr-tools";
import { useStore, useProfile, routeToHash } from "../state/store.tsx";
import { useFeed, useEngagement } from "../state/hooks.ts";
import type { Engagement } from "../state/hooks.ts";
import { Kind, ARTICLE_MARKER, type LongForm, type Note } from "../nostr/types.ts";
import { decodeLongForm, decodeNote, buildReaction, buildRepost } from "../nostr/events.ts";
import { nowSeconds } from "../nostr/client.ts";
import { EmptyState, Spinner } from "../ui/primitives.tsx";
import { PostCard } from "../ui/PostCard.tsx";
import { EventJsonButton } from "../ui/EventJsonModal.tsx";
import { SearchIcon, VerifiedSeal } from "../ui/icons.tsx";
import { followStyle, statusDot, avatarWrap } from "../ui/styles.ts";
import {
  timeAgo,
  fmtCount,
  initials,
  avatarStyle,
  displayName,
} from "../lib/format.ts";
import { countWords, readingMinutes } from "../lib/markdown.ts";

/** The five glass topic pills, verbatim from the design. */
const TOPICS = ["engineering", "security", "design", "product", "announcements"] as const;
const SEARCH_LIMIT = 50;
const RECENT_SEARCH_LIMIT = 200;
const PROFILE_SEARCH_LIMIT = 20;

// ---------------------------------------------------------------------------
// data hooks
// ---------------------------------------------------------------------------

/** List the latest NIP-23 articles (kind 30023 carrying ARTICLE_MARKER), newest first. */
const useArticles = (topic: string | null): { articles: LongForm[]; loading: boolean } => {
  const { client, readRelayUrls } = useStore();
  const [articles, setArticles] = useState<LongForm[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (readRelayUrls.length === 0) return;
    let cancelled = false;
    setLoading(true);
    const tags = topic ? [ARTICLE_MARKER, topic] : [ARTICLE_MARKER];
    const filter: Filter = { kinds: [Kind.LongForm], "#t": tags, limit: 30 };
    void (async () => {
      const events = await client.list(readRelayUrls, filter);
      if (cancelled) return;
      const decoded = events
        .map(decodeLongForm)
        .filter((a) => a.kind === "article")
        .filter((a) => !topic || a.hashtags.includes(topic))
        .sort((a, b) => b.publishedAt - a.publishedAt)
        .slice(0, 3);
      setArticles(decoded);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [client, readRelayUrls, topic]);

  return { articles, loading };
};

/**
 * Derive ~6 "people to follow" from recent feed authors, excluding self and
 * anyone already followed. The list is frozen after the first non-empty
 * snapshot so it doesn't shift as live notes stream in.
 */
const usePeopleToFollow = (notes: Note[]): string[] => {
  const { state } = useStore();
  const me = state.identity?.pubkey;
  const frozenRef = useRef<string[] | null>(null);
  return useMemo(() => {
    // If we already have a frozen snapshot, return it unchanged.
    if (frozenRef.current !== null) return frozenRef.current;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const note of notes) {
      const pk = note.pubkey;
      if (seen.has(pk)) continue;
      seen.add(pk);
      if (pk === me) continue;
      if (state.contacts.includes(pk)) continue;
      out.push(pk);
      if (out.length >= 6) break;
    }
    // Freeze the first non-empty snapshot.
    if (out.length > 0) frozenRef.current = out;
    return out;
  }, [notes, me, state.contacts]);
};

type RelaySearchResults = {
  notes: Note[];
  people: string[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  loadMore: () => Promise<void>;
};

const normalizeSearchInput = (value: string): string =>
  value.trim().replace(/^#/, "").trim();

const tagCandidate = (value: string): string | null => {
  const tag = normalizeSearchInput(value).toLowerCase();
  return /^[a-z0-9_][a-z0-9_-]{0,63}$/.test(tag) ? tag : null;
};

const dedupeEvents = (events: NostrEvent[]): NostrEvent[] => {
  const byId = new Map<string, NostrEvent>();
  for (const event of events) if (!byId.has(event.id)) byId.set(event.id, event);
  return [...byId.values()];
};

const oldestNoteCreatedAt = (notes: Iterable<Note>): number | undefined => {
  let oldest: number | undefined;
  for (const note of notes) {
    if (oldest === undefined || note.createdAt < oldest) oldest = note.createdAt;
  }
  return oldest;
};

const noteMatchesSearch = (event: NostrEvent, lowerQuery: string, tag: string | null): boolean => {
  if (event.kind !== Kind.Note) return false;
  if (event.content.toLowerCase().includes(lowerQuery)) return true;
  return Boolean(tag && event.tags.some((t) => t[0] === "t" && t[1]?.toLowerCase() === tag));
};

const profileMatchesSearch = (event: NostrEvent, lowerQuery: string): boolean =>
  event.kind === Kind.Metadata && event.content.toLowerCase().includes(lowerQuery);

const useRelaySearch = (query: string): RelaySearchResults => {
  const { client, readRelayUrls } = useStore();
  const [notes, setNotes] = useState<Note[]>([]);
  const [people, setPeople] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const byIdRef = useRef<Map<string, Note>>(new Map());
  const pagingRef = useRef(false);
  const searchVersionRef = useRef(0);

  const fetchPage = useCallback(
    async (term: string, until?: number, includeProfiles = false): Promise<{ notes: Note[]; people: string[] }> => {
      const lowerTerm = term.toLowerCase();
      const tag = tagCandidate(term);
      const withCursor = (filter: Filter): Filter => (until === undefined ? filter : { ...filter, until });
      const list = async (filter: Filter): Promise<NostrEvent[]> => {
        try {
          return await client.list(readRelayUrls, filter);
        } catch {
          return [];
        }
      };

      const [searchEvents, recentEvents, tagEvents, profileEvents] = await Promise.all([
        list(withCursor({ kinds: [Kind.Note], search: term, limit: SEARCH_LIMIT })),
        list(withCursor({ kinds: [Kind.Note], limit: RECENT_SEARCH_LIMIT })),
        tag ? list(withCursor({ kinds: [Kind.Note], "#t": [tag], limit: SEARCH_LIMIT })) : Promise.resolve([]),
        includeProfiles ? list({ kinds: [Kind.Metadata], search: term, limit: PROFILE_SEARCH_LIMIT }) : Promise.resolve([]),
      ]);

      const nextNotes = dedupeEvents([...searchEvents, ...tagEvents, ...recentEvents])
        .filter((event) => noteMatchesSearch(event, lowerTerm, tag))
        .map(decodeNote)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, SEARCH_LIMIT);

      const seenPeople = new Set<string>();
      const nextPeople: string[] = [];
      for (const event of dedupeEvents(profileEvents).filter((candidate) => profileMatchesSearch(candidate, lowerTerm))) {
        if (seenPeople.has(event.pubkey)) continue;
        seenPeople.add(event.pubkey);
        nextPeople.push(event.pubkey);
        if (nextPeople.length >= 6) break;
      }

      return { notes: nextNotes, people: nextPeople };
    },
    [client, readRelayUrls],
  );

  const flush = useCallback(() => {
    setNotes([...byIdRef.current.values()].sort((a, b) => b.createdAt - a.createdAt));
  }, []);

  useEffect(() => {
    const term = normalizeSearchInput(query);
    if (!term || readRelayUrls.length === 0) {
      searchVersionRef.current++;
      byIdRef.current = new Map();
      setNotes([]);
      setPeople([]);
      setLoading(false);
      setLoadingMore(false);
      setHasMore(false);
      return;
    }

    let cancelled = false;
    const searchVersion = searchVersionRef.current + 1;
    searchVersionRef.current = searchVersion;
    byIdRef.current = new Map();
    pagingRef.current = false;

    setLoading(true);
    setLoadingMore(false);
    setHasMore(true);
    setNotes([]);
    void (async () => {
      const page = await fetchPage(term, undefined, true);
      if (cancelled || searchVersion !== searchVersionRef.current) return;

      for (const note of page.notes) {
        if (!byIdRef.current.has(note.id)) byIdRef.current.set(note.id, note);
      }
      flush();
      setPeople(page.people);
      setHasMore(page.notes.length > 0);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [fetchPage, flush, query, readRelayUrls]);

  const loadMore = useCallback(async (): Promise<void> => {
    const term = normalizeSearchInput(query);
    if (!term || readRelayUrls.length === 0 || loading || loadingMore || !hasMore || pagingRef.current) return;
    const oldest = oldestNoteCreatedAt(byIdRef.current.values());
    if (oldest === undefined) {
      setHasMore(false);
      return;
    }

    pagingRef.current = true;
    const searchVersion = searchVersionRef.current;
    setLoadingMore(true);
    try {
      const page = await fetchPage(term, oldest, false);
      if (searchVersion !== searchVersionRef.current) return;
      let added = 0;
      for (const note of page.notes) {
        if (byIdRef.current.has(note.id)) continue;
        byIdRef.current.set(note.id, note);
        added++;
      }
      if (added > 0) flush();
      else setHasMore(false);
    } catch {
      if (searchVersion === searchVersionRef.current) setHasMore(false);
    } finally {
      if (searchVersion === searchVersionRef.current) {
        pagingRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [fetchPage, flush, hasMore, loading, loadingMore, query, readRelayUrls]);

  return { notes, people, loading, loadingMore, hasMore, loadMore };
};

// ---------------------------------------------------------------------------
// excerpt: strip markdown → trim to 150 chars on a word boundary
// ---------------------------------------------------------------------------

const articleExcerpt = (body: string): string => {
  const flat = body
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length <= 150) return flat;
  const cut = flat.slice(0, 150);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim()}…`;
};

// ---------------------------------------------------------------------------
// inline SVG glyphs (design paths — kept local for pixel fidelity)
// ---------------------------------------------------------------------------

const BookGlyph = (): ReactNode => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 5a2 2 0 0 1 2-2h12v16H6a2 2 0 0 0-2 2z" />
    <path d="M18 3v18" />
  </svg>
);
const HeartGlyph = ({ fill }: { fill: string }): ReactNode => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill={fill} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20.8 5.6a5.3 5.3 0 0 0-7.5 0L12 6.9l-1.3-1.3a5.3 5.3 0 1 0-7.5 7.5L12 22l8.8-8.9a5.3 5.3 0 0 0 0-7.5z" />
  </svg>
);
const TrashGlyph = (): ReactNode => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6" />
  </svg>
);

// ---------------------------------------------------------------------------
// shared style helpers (design lines 110/137/180 — radii distinct per element)
// ---------------------------------------------------------------------------

const h3Style: CSSProperties = {
  margin: "0 0 12px",
  fontFamily: "'Space Grotesk',sans-serif",
  fontSize: 15,
  fontWeight: 700,
  color: "var(--text)",
};

const cardActionStyle = (color: string): CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  cursor: "pointer",
  color,
  transition: "color .15s",
  border: "none",
  background: "transparent",
  fontFamily: "inherit",
  fontSize: 12.5,
  padding: 0,
});

// ---------------------------------------------------------------------------
// topic pill
// ---------------------------------------------------------------------------

const TopicPill = ({ topic, onClick }: { topic: string; onClick: () => void }): ReactNode => {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        padding: "9px 15px",
        border: `1px solid ${hover ? "var(--accent)" : "var(--glass-border)"}`,
        borderRadius: 999,
        background: "var(--glass)",
        backdropFilter: "var(--blur)",
        WebkitBackdropFilter: "var(--blur)",
        boxShadow: "var(--glass-shadow)",
        color: hover ? "var(--accent)" : "var(--text)",
        fontWeight: 600,
        fontSize: 13.5,
        fontFamily: "inherit",
        cursor: "pointer",
        transform: hover ? "translateY(-1px)" : "none",
        transition: "all .18s",
      }}
    >
      # {topic}
    </button>
  );
};

// ---------------------------------------------------------------------------
// article card
// ---------------------------------------------------------------------------

const ArticleCard = ({ article }: { article: LongForm }): ReactNode => {
  const { state, navigate, publish, toast } = useStore();
  const profile = useProfile(article.pubkey);
  const [hover, setHover] = useState(false);
  const [likeHover, setLikeHover] = useState(false);
  const [delHover, setDelHover] = useState(false);
  const [liked, setLiked] = useState(false);
  const [likes, setLikes] = useState(0);

  const name = displayName({
    name: profile?.name,
    displayName: profile?.displayName,
    pubkey: article.pubkey,
  });
  const excerpt = article.summary.trim() || articleExcerpt(article.body);
  const readLabel = `${readingMinutes(countWords(article.body))} min read`;
  const hasCover = Boolean(article.image);
  const isMine = article.pubkey === state.identity?.pubkey;

  const onOpen = (): void => navigate("articleReader", { id: article.identifier, pubkey: article.pubkey });

  // The article event is a kind-30023 addressable note; reactions tag it by `e`.
  const onLike = (e: React.MouseEvent): void => {
    e.stopPropagation();
    if (liked) return;
    setLiked(true);
    setLikes((n) => n + 1);
    const target: Note = {
      id: article.id,
      pubkey: article.pubkey,
      content: "",
      createdAt: article.publishedAt,
      tags: [],
    };
    void publish(buildReaction(target, "+")).then(() => toast("Liked", "check"));
  };

  const onCardDelete = (e: React.MouseEvent): void => {
    e.stopPropagation();
    toast("Article deleted", "info");
  };

  return (
    <div
      data-testid="article-card"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        gap: 16,
        alignItems: "stretch",
        textAlign: "left",
        width: "100%",
        padding: 15,
        border: `1px solid ${hover ? "var(--text-3)" : "var(--glass-border)"}`,
        borderRadius: 14,
        background: hover ? "var(--glass-2)" : "var(--glass)",
        cursor: "pointer",
        transition: "border-color .15s, background .15s",
        fontFamily: "inherit",
      }}
    >
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 8 }}>
          <span style={avatarStyle(article.pubkey, 32, profile?.picture)}>
            {!profile?.picture && initials(name)}
          </span>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-2)" }}>{name}</span>
          <span style={{ fontSize: 12.5, color: "var(--text-3)" }}>· {timeAgo(article.publishedAt)}</span>
        </div>

        <h3
          style={{
            margin: 0,
            fontFamily: "'Space Grotesk',sans-serif",
            fontSize: 18,
            lineHeight: 1.28,
            fontWeight: 700,
            letterSpacing: "-.012em",
            color: "var(--text)",
            textWrap: "pretty",
          }}
        >
          {article.title}
        </h3>

        {excerpt && (
          <p style={{ margin: "5px 0 0", fontSize: 14, lineHeight: 1.5, color: "var(--text-2)", textWrap: "pretty" }}>
            {excerpt}
          </p>
        )}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            marginTop: 11,
            fontSize: 12.5,
            color: "var(--text-3)",
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <BookGlyph />
            {readLabel}
          </span>

          <button
            type="button"
            onClick={onLike}
            onMouseEnter={() => setLikeHover(true)}
            onMouseLeave={() => setLikeHover(false)}
            title="Like"
            style={cardActionStyle(liked || likeHover ? "var(--danger)" : "var(--text-3)")}
          >
            <HeartGlyph fill={liked ? "var(--danger)" : "none"} />
            {fmtCount(likes)}
          </button>

          <span style={{ flex: 1 }} />
          <EventJsonButton event={article.event} label="Original article event" />

          {isMine && (
            <button
              type="button"
              onClick={onCardDelete}
              onMouseEnter={() => setDelHover(true)}
              onMouseLeave={() => setDelHover(false)}
              title="Delete article"
              style={cardActionStyle(delHover ? "var(--danger)" : "var(--text-3)")}
            >
              <TrashGlyph />
              Delete
            </button>
          )}
        </div>
      </div>

      {hasCover && (
        <span
          style={{
            width: 104,
            minWidth: 104,
            alignSelf: "stretch",
            minHeight: 98,
            borderRadius: 11,
            border: "1px solid var(--glass-border)",
            background: `url("${article.image ?? ""}")`,
            backgroundSize: "cover",
            backgroundPosition: "center",
          }}
        />
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// person row
// ---------------------------------------------------------------------------

const PersonRow = ({ pubkey }: { pubkey: string }): ReactNode => {
  const { state, navigate, toggleFollow } = useStore();
  const profile = useProfile(pubkey);
  const [hover, setHover] = useState(false);
  const [avatarHover, setAvatarHover] = useState(false);
  const [nameHover, setNameHover] = useState(false);
  const [pressed, setPressed] = useState(false);

  const name = displayName({ name: profile?.name, displayName: profile?.displayName, pubkey });
  const verified = Boolean(profile?.nip05);
  const handle = profile?.nip05 ?? `${nip19.npubEncode(pubkey).slice(0, 16)}…`;
  const role = profile?.about?.split("\n")[0]?.trim() ?? "";
  const following = state.contacts.includes(pubkey);
  const followLabel = following ? "Following" : "Follow";

  const onOpen = (): void => navigate("profile", { pubkey });

  return (
    <div
      data-testid="explore-person"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "15px 16px",
        background: hover ? "var(--glass-2)" : "var(--glass)",
        backdropFilter: "var(--blur)",
        WebkitBackdropFilter: "var(--blur)",
        border: `1px solid ${hover ? "var(--text-3)" : "var(--glass-border)"}`,
        borderRadius: 12,
        boxShadow: "var(--glass-shadow)",
        transition: "all .2s",
      }}
    >
      <span
        onClick={onOpen}
        onMouseEnter={() => setAvatarHover(true)}
        onMouseLeave={() => setAvatarHover(false)}
        style={{ ...avatarWrap(44, true), filter: avatarHover ? "brightness(.94)" : "none" }}
      >
        <span style={avatarStyle(pubkey, 44, profile?.picture)}>
          {!profile?.picture && initials(name)}
        </span>
        <span style={statusDot(false, false)} />
      </span>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span
            onClick={onOpen}
            onMouseEnter={() => setNameHover(true)}
            onMouseLeave={() => setNameHover(false)}
            style={{
              fontWeight: 700,
              fontSize: 15,
              color: "var(--text)",
              cursor: "pointer",
              textDecoration: nameHover ? "underline" : "none",
            }}
          >
            {name}
          </span>
          {verified && <VerifiedSeal size={15} />}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
          <span style={{ fontSize: 13, color: "var(--text-3)", fontFamily: "'JetBrains Mono',monospace" }}>
            {handle}
          </span>
        </div>
        <span style={{ display: "block", fontSize: 13, color: "var(--text-2)", marginTop: 3 }}>
          {role}
        </span>
      </div>

      <button
        data-testid="follow-button"
        type="button"
        onClick={() => void toggleFollow(pubkey)}
        onMouseDown={() => setPressed(true)}
        onMouseUp={() => setPressed(false)}
        onMouseLeave={() => setPressed(false)}
        style={{ ...followStyle(following), transform: pressed ? "scale(.95)" : "none" }}
      >
        {followLabel}
      </button>
    </div>
  );
};

// ---------------------------------------------------------------------------
// NIP-05 resolution
// ---------------------------------------------------------------------------

/** Resolve a NIP-05 `name@domain` to a hex pubkey via the well-known endpoint. */
const resolveNip05 = async (input: string): Promise<string | null> => {
  const [name, domain] = input.split("@");
  if (!name || !domain) return null;
  try {
    const res = await fetch(
      `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`,
    );
    if (!res.ok) return null;
    const json: unknown = await res.json();
    if (typeof json !== "object" || json === null || !("names" in json)) return null;
    const names = (json as { names: unknown }).names;
    if (typeof names !== "object" || names === null) return null;
    const pubkey = (names as Record<string, unknown>)[name];
    return typeof pubkey === "string" ? pubkey : null;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// view
// ---------------------------------------------------------------------------

export const ExploreView = (): ReactNode => {
  const { state, navigate, toast, publish, toggleBookmark } = useStore();
  const [topic, setTopic] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [optimistic, setOptimistic] = useState<Record<string, Partial<Engagement>>>({});

  const filter = useMemo<Filter>(
    () =>
      topic
        ? { kinds: [Kind.Note], "#t": [topic], limit: 50 }
        : { kinds: [Kind.Note], limit: 50 },
    [topic],
  );
  const { notes, loading, loadingMore, hasMore, loadMore } = useFeed(filter, [topic]);
  const search = useRelaySearch(searchTerm);
  const searchActive = searchTerm.length > 0;
  const visibleNotes = searchActive ? search.notes : notes;
  const { articles } = useArticles(topic);
  const people = usePeopleToFollow(notes);

  const noteIds = useMemo(() => visibleNotes.map((n) => n.id), [visibleNotes]);
  const engagement = useEngagement(noteIds, optimistic);

  const like = (note: Note): void => {
    const cur = engagement.get(note.id);
    if (cur?.liked) return;
    setOptimistic((o) => ({ ...o, [note.id]: { ...o[note.id], liked: true, likes: (cur?.likes ?? 0) + 1 } }));
    void publish(buildReaction(note, "+")).then(() => toast("Liked", "check"));
  };

  const repost = (note: Note): boolean => {
    const cur = engagement.get(note.id);
    if (cur?.reposted) {
      const eventIds = cur.repostedEventIds ?? [];
      if (eventIds.length === 0) return false;
      setOptimistic((o) => ({
        ...o,
        [note.id]: {
          ...o[note.id],
          reposted: false,
          reposts: Math.max(0, (cur.reposts ?? eventIds.length) - eventIds.length),
          repostedEventIds: [],
        },
      }));
      void publish({
        kind: 5,
        created_at: nowSeconds(),
        tags: eventIds.map((eventId) => ["e", eventId]),
        content: "",
      });
      return true;
    }
    setOptimistic((o) => ({ ...o, [note.id]: { ...o[note.id], reposted: true, reposts: (cur?.reposts ?? 0) + 1 } }));
    void publish(buildRepost(note)).then((eventId) => {
      toast("Reposted to your followers", "repost");
      setOptimistic((o) => ({ ...o, [note.id]: { ...o[note.id], repostedEventIds: [eventId] } }));
    });
    return true;
  };

  const share = (note: Note): void => {
    const link = `${location.origin}${location.pathname}${location.search}${routeToHash({ view: "postDetail", params: { id: note.id } })}`;
    void navigator.clipboard?.writeText(link).then(() => toast("Post link copied", "copy"));
  };

  useEffect(() => {
    if (typeof document === "undefined") return;
    const scrollRoot = document.querySelector<HTMLElement>('[data-testid="main-scroll"]');
    if (!scrollRoot) return;

    let frame = 0;
    const checkForMore = (): void => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        const distanceFromBottom = scrollRoot.scrollHeight - scrollRoot.scrollTop - scrollRoot.clientHeight;
        if (distanceFromBottom >= 640) return;

        if (searchActive) {
          if (!search.loading && !search.loadingMore && search.hasMore) void search.loadMore();
          return;
        }

        if (topic && !loading && !loadingMore && hasMore) void loadMore();
      });
    };

    scrollRoot.addEventListener("scroll", checkForMore, { passive: true });
    checkForMore();
    return () => {
      scrollRoot.removeEventListener("scroll", checkForMore);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [
    hasMore,
    loadMore,
    loading,
    loadingMore,
    notes.length,
    search.hasMore,
    search.loadMore,
    search.loading,
    search.loadingMore,
    search.notes.length,
    searchActive,
    topic,
  ]);

  const submit = async (): Promise<void> => {
    const value = query.trim();
    if (!value) return;

    if (/^npub1/.test(value)) {
      try {
        const decoded = nip19.decode(value);
        if (decoded.type === "npub") {
          navigate("profile", { pubkey: decoded.data });
          return;
        }
      } catch {
        // fall through to a toast below
      }
      toast(`Could not resolve ${value}`, "warn");
      return;
    }

    if (value.includes("@")) {
      toast(`Looking up ${value}…`, "info");
      const pubkey = await resolveNip05(value);
      if (pubkey) navigate("profile", { pubkey });
      else toast(`Could not resolve ${value}`, "warn");
      return;
    }

    setSearchTerm(normalizeSearchInput(value));
    setTopic(null);
  };

  const openPalette = (): void => toast("Command palette coming soon", "info");

  return (
    <div style={{ maxWidth: 680, margin: "0 auto", padding: "18px 18px 120px" }}>
      {/* [1] search bar */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 11,
          padding: "13px 16px",
          background: "var(--glass)",
          backdropFilter: "var(--blur)",
          WebkitBackdropFilter: "var(--blur)",
          border: "1px solid var(--glass-border)",
          borderRadius: 10,
          boxShadow: "var(--glass-shadow)",
          marginBottom: 18,
        }}
      >
        <span style={{ display: "flex", color: "var(--text-3)" }}>
          <SearchIcon size={19} />
        </span>
        <input
          data-testid="search-input"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            if (!e.target.value.trim()) setSearchTerm("");
          }}
          placeholder="Search people, handles, or NIP-05 domains…"
          style={{
            flex: 1,
            border: "none",
            background: "transparent",
            outline: "none",
            fontSize: 15,
            color: "var(--text)",
            fontFamily: "inherit",
          }}
        />
        <span
          onClick={openPalette}
          style={{
            fontSize: 12,
            color: "var(--text-3)",
            background: "var(--glass-2)",
            padding: "4px 8px",
            borderRadius: 8,
            fontFamily: "'JetBrains Mono',monospace",
            cursor: "pointer",
          }}
        >
          ⌘K
        </span>
      </form>

      {/* [2] curate by topic */}
      <div style={{ marginBottom: 24 }}>
        <h3 style={h3Style}>Curate by topic</h3>
        <div data-testid="topic-list" style={{ display: "flex", flexWrap: "wrap", gap: 9 }}>
          {TOPICS.map((t) => (
            <TopicPill
              key={t}
              topic={t}
              onClick={() => {
                setTopic(t);
                setSearchTerm("");
                setQuery(`#${t}`);
              }}
            />
          ))}
        </div>
      </div>

      {/* [3] latest articles */}
      {articles.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <h3 style={h3Style}>Latest articles</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {articles.map((a) => (
              <ArticleCard key={a.id} article={a} />
            ))}
          </div>
        </div>
      )}

      {searchActive && (
        <div style={{ marginBottom: 24 }}>
          <h3 style={h3Style}>Search results for "{searchTerm}"</h3>
          {search.loading ? (
            <div style={{ display: "flex", justifyContent: "center", padding: "48px 0" }}>
              <Spinner />
            </div>
          ) : search.people.length === 0 && search.notes.length === 0 ? (
            <EmptyState
              icon={<SearchIcon size={28} />}
              title="No results"
              hint="Try a different word, phrase, hashtag, npub, or NIP-05 address."
            />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {search.people.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
                  {search.people.map((pk) => (
                    <PersonRow key={pk} pubkey={pk} />
                  ))}
                </div>
              )}

              {search.notes.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {search.notes.map((note) => (
                    <PostCard
                      key={note.id}
                      note={note}
                      engagement={engagement.get(note.id)}
                      bookmarked={state.bookmarks.includes(note.id)}
                      onLike={() => like(note)}
                      onRepost={() => repost(note)}
                      onReply={() => navigate("postDetail", { id: note.id })}
                      onBookmark={() => toggleBookmark(note.id)}
                      onShare={() => share(note)}
                    />
                  ))}
                  {search.loadingMore && (
                    <div style={{ display: "flex", justifyContent: "center", padding: "20px 0 4px" }}>
                      <Spinner size={20} />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* topic-filtered note feed (real Nostr content for the active topic) */}
      {!searchActive && topic && (
        <div style={{ marginBottom: 24 }}>
          <h3 style={h3Style}>#{topic}</h3>
          {loading && notes.length === 0 ? (
            <div style={{ display: "flex", justifyContent: "center", padding: "48px 0" }}>
              <Spinner />
            </div>
          ) : notes.length === 0 ? (
            <EmptyState
              icon={<SearchIcon size={28} />}
              title="Nothing here yet"
              hint={`No recent posts tagged #${topic}.`}
            />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {notes.map((note) => (
                <PostCard
                  key={note.id}
                  note={note}
                  engagement={engagement.get(note.id)}
                  bookmarked={state.bookmarks.includes(note.id)}
                  onLike={() => like(note)}
                  onRepost={() => repost(note)}
                  onReply={() => navigate("postDetail", { id: note.id })}
                  onBookmark={() => toggleBookmark(note.id)}
                  onShare={() => share(note)}
                />
              ))}
              {loadingMore && (
                <div style={{ display: "flex", justifyContent: "center", padding: "20px 0 4px" }}>
                  <Spinner size={20} />
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* [4] people header */}
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontFamily: "'Space Grotesk',sans-serif", fontSize: 15, fontWeight: 700, color: "var(--text)" }}>
          People in your network
        </h3>
        <span style={{ fontSize: 13, color: "var(--text-3)" }}>Following {state.contacts.length}</span>
      </div>

      {/* [5] people list */}
      {people.length === 0 ? (
        <EmptyState
          icon={<SearchIcon size={28} />}
          title="No suggestions yet"
          hint="As your feed fills in, new people to follow will surface here."
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
          {people.map((pk) => (
            <PersonRow key={pk} pubkey={pk} />
          ))}
        </div>
      )}
    </div>
  );
};
