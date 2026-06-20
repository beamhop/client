import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { Filter } from "nostr-tools";
import { useStore, routeToHash } from "../state/store.tsx";
import { useTimelineFeed, useEngagement, type Engagement, type TimelineItem } from "../state/hooks.ts";
import { Kind, ARTICLE_MARKER, type Note, type LongForm } from "../nostr/types.ts";
import { buildNote, buildReaction, buildRepost, decodeLongForm } from "../nostr/events.ts";
import { nowSeconds } from "../nostr/client.ts";
import { Avatar, Spinner, EmptyState } from "../ui/primitives.tsx";
import { PostCard } from "../ui/PostCard.tsx";
import { EventJsonButton } from "../ui/EventJsonModal.tsx";
import { HomeIcon } from "../ui/icons.tsx";
import { displayName, avatarStyle, initials, timeAgo } from "../lib/format.ts";
import { compileMutes, arrangeFeed, evaluateNote, evaluateRepost, evaluateArticle, type FeedRow } from "../lib/mute.ts";
import { Compose } from "../ui/Compose.tsx";

const AGENTS_KEY = "verity.agents.v1";

/** Pubkeys of locally-defined AI agents, used to flag agent-authored posts. */
const loadAgentPubkeys = (): Set<string> => {
  if (typeof localStorage === "undefined") return new Set();
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(AGENTS_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return new Set();
    const keys = parsed.flatMap((a) =>
      typeof a === "object" && a !== null && typeof (a as { pubkeyHex?: unknown }).pubkeyHex === "string"
        ? [(a as { pubkeyHex: string }).pubkeyHex]
        : [],
    );
    return new Set(keys);
  } catch {
    return new Set();
  }
};

/** Accent globe glyph for the relay/scope pill. */
const GlobeGlyph = (): ReactNode => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
    <circle cx="12" cy="12" r="9" />
    <path d="M2 12h20M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z" />
  </svg>
);

/** Edit/pencil glyph for the "Write article" button. */
const PencilGlyph = (): ReactNode => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
  </svg>
);

const BookGlyph = (): ReactNode => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
  </svg>
);

/** Inline composer card — design lines 220-238. */
const Composer = ({
  pubkey,
  meName,
  picture,
}: {
  pubkey: string;
  meName: string;
  picture: string | undefined;
}): ReactNode => {
  const { publish, toast, writeRelayUrls, navigate } = useStore();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [articleHover, setArticleHover] = useState(false);
  const canPost = text.trim().length > 0 && !busy;

  const post = async (): Promise<void> => {
    const content = text.trim();
    if (!content || busy) return;
    setBusy(true);
    try {
      await publish(buildNote(content));
      toast(`Published to ${writeRelayUrls.length} relays`, "check");
      setText("");
    } catch {
      toast("Could not publish — check your relays", "warn");
    } finally {
      setBusy(false);
    }
  };

  const postBtnStyle: CSSProperties = {
    padding: "9px 18px",
    borderRadius: 10,
    border: "1px solid rgba(255,255,255,.25)",
    background: canPost ? "var(--accent)" : "var(--glass-2)",
    color: canPost ? "var(--on-accent)" : "var(--text-3)",
    fontWeight: 700,
    fontSize: 13.5,
    fontFamily: "inherit",
    cursor: canPost ? "pointer" : "default",
    transition: "filter .2s, transform .12s",
  };

  return (
    <div
      data-testid="composer"
      style={{
        background: "var(--glass)",
        border: "1px solid var(--glass-border)",
        borderRadius: 13,
        padding: 16,
        boxShadow: "var(--glass-shadow)",
        marginBottom: 18,
      }}
    >
      <div style={{ display: "flex", gap: 13 }}>
        <Avatar pubkey={pubkey} size={44} name={meName} picture={picture} />
        <textarea
          data-testid="composer-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void post();
            }
          }}
          placeholder="Share something with your workspace…"
          style={{
            flex: 1,
            border: "none",
            background: "transparent",
            resize: "none",
            outline: "none",
            fontSize: 17,
            lineHeight: 1.5,
            color: "var(--text)",
            fontFamily: "inherit",
            minHeight: 52,
            paddingTop: 8,
          }}
        />
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginTop: 10,
          paddingTop: 12,
          borderTop: "1px solid var(--hairline)",
        }}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "5px 10px",
            borderRadius: 10,
            background: "var(--accent-soft)",
            color: "var(--accent)",
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          <GlobeGlyph />
          Workspace · {writeRelayUrls.length} relays
        </span>
        <button
          type="button"
          data-testid="open-article-editor"
          onClick={() => navigate("articleEditor")}
          onMouseEnter={() => setArticleHover(true)}
          onMouseLeave={() => setArticleHover(false)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "5px 11px",
            border: `1px solid ${articleHover ? "var(--accent)" : "var(--glass-border)"}`,
            borderRadius: 10,
            background: articleHover ? "var(--accent-soft)" : "transparent",
            color: articleHover ? "var(--accent)" : "var(--text-2)",
            fontSize: 12.5,
            fontWeight: 700,
            fontFamily: "inherit",
            cursor: "pointer",
            transition: "all .15s",
          }}
        >
          <PencilGlyph />
          Write article
        </button>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 12.5, color: "var(--text-3)", fontVariantNumeric: "tabular-nums" }}>
          {text.length}
        </span>
        <button
          type="button"
          data-testid="post-submit"
          onClick={() => void post()}
          disabled={!canPost}
          style={postBtnStyle}
        >
          {busy ? "Posting…" : "Post"}
        </button>
      </div>
    </div>
  );
};

/** Lightweight article strip — NIP-23 kind 30023 (verity-article). */
const ArticlesStrip = ({ authors }: { authors?: string[] }): ReactNode => {
  const { client, readRelayUrls, navigate, state } = useStore();
  const [articles, setArticles] = useState<LongForm[]>([]);
  const [seeAllHover, setSeeAllHover] = useState(false);
  const muted = useMemo(() => compileMutes(state.muteSettings.rules), [state.muteSettings.rules]);

  useEffect(() => {
    if (readRelayUrls.length === 0 || authors?.length === 0) {
      setArticles([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const filter: Filter = {
        kinds: [Kind.LongForm],
        "#t": [ARTICLE_MARKER],
        limit: 12,
      };
      if (authors) filter.authors = authors;
      const events = await client.list(readRelayUrls, filter);
      if (cancelled) return;
      const byKey = new Map<string, LongForm>();
      for (const ev of events) {
        const a = decodeLongForm(ev);
        const key = `${a.pubkey}:${a.identifier}`;
        const prev = byKey.get(key);
        if (!prev || a.updatedAt > prev.updatedAt) byKey.set(key, a);
      }
      setArticles([...byKey.values()].sort((a, b) => b.publishedAt - a.publishedAt).slice(0, 3));
    })();
    return () => {
      cancelled = true;
    };
  }, [authors, client, readRelayUrls]);

  // Articles always hard-hide muted content, regardless of feed display mode.
  const visibleArticles = useMemo(
    () => articles.filter((a) => !evaluateArticle(muted, a)),
    [articles, muted],
  );

  if (visibleArticles.length === 0) return null;

  return (
    <div data-testid="feed-articles" style={{ marginBottom: 14 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 10,
          padding: "0 2px",
        }}
      >
        <h3
          style={{
            margin: 0,
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontFamily: "'Space Grotesk',sans-serif",
            fontSize: 14,
            fontWeight: 700,
            color: "var(--text)",
          }}
        >
          <span style={{ color: "var(--accent)", display: "flex" }}>
            <BookGlyph />
          </span>
          Articles in your network
        </h3>
        <button
          type="button"
          onClick={() => navigate("docs")}
          onMouseEnter={() => setSeeAllHover(true)}
          onMouseLeave={() => setSeeAllHover(false)}
          style={{
            border: "none",
            background: "transparent",
            color: seeAllHover ? "var(--accent)" : "var(--text-3)",
            fontWeight: 600,
            fontSize: 12.5,
            fontFamily: "inherit",
            cursor: "pointer",
          }}
        >
          See all
        </button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {visibleArticles.map((a) => (
          <ArticleCard key={`${a.pubkey}:${a.identifier}`} article={a} mine={a.pubkey === state.identity?.pubkey} />
        ))}
      </div>
    </div>
  );
};

const ArticleCard = ({ article, mine }: { article: LongForm; mine: boolean }): ReactNode => {
  const { navigate } = useStore();
  const [hover, setHover] = useState(false);
  const open = (): void => navigate("articleReader", { id: article.identifier, pubkey: article.pubkey });
  // Reading time at ~220 wpm; cheap word count is sufficient for a strip badge.
  const minutes = Math.max(1, Math.round(article.body.trim().split(/\s+/).filter(Boolean).length / 220));

  return (
    <div
      data-testid="article-card"
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") open();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        gap: 16,
        alignItems: "stretch",
        width: "100%",
        padding: 15,
        border: `1px solid ${hover ? "var(--text-3)" : "var(--glass-border)"}`,
        borderRadius: 14,
        background: hover ? "var(--glass-2)" : "var(--glass)",
        cursor: "pointer",
        transition: "border-color .15s, background .15s",
      }}
    >
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 8 }}>
          <span style={avatarStyle(article.pubkey, 32, article.image)}>
            {!article.image && initials(article.pubkey.slice(0, 4))}
          </span>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-2)" }}>
            {`${article.pubkey.slice(0, 8)}…`}
          </span>
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
        {article.summary && (
          <p style={{ margin: "5px 0 0", fontSize: 14, lineHeight: 1.5, color: "var(--text-2)" }}>
            {article.summary}
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
            {minutes} min read
          </span>
          <div style={{ flex: 1 }} />
          <EventJsonButton event={article.event} label="Original article event" />
          {mine && <span style={{ color: "var(--text-3)" }}>Yours</span>}
        </div>
      </div>
      {article.image && (
        <span
          style={{
            width: 104,
            minWidth: 104,
            alignSelf: "stretch",
            minHeight: 98,
            borderRadius: 11,
            border: "1px solid var(--glass-border)",
            background: `center/cover no-repeat url("${article.image}")`,
          }}
        />
      )}
    </div>
  );
};

type FeedTab = "forYou" | "following";

const FEED_TABS: { id: FeedTab; label: string }[] = [
  { id: "forYou", label: "For you" },
  { id: "following", label: "Following" },
];

const feedTabStyle = (active: boolean): CSSProperties => ({
  flex: 1,
  minHeight: 42,
  padding: "0 14px",
  border: "none",
  borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
  background: "transparent",
  color: active ? "var(--text)" : "var(--text-3)",
  fontWeight: active ? 800 : 700,
  fontSize: 14,
  fontFamily: "inherit",
  cursor: "pointer",
  transition: "color .15s, border-color .15s, background .15s",
});

const FeedTabs = ({
  active,
  onChange,
}: {
  active: FeedTab;
  onChange: (tab: FeedTab) => void;
}): ReactNode => (
  <div
    role="tablist"
    aria-label="Home feed"
    data-testid="home-feed-tabs"
    style={{
      display: "flex",
      alignItems: "stretch",
      margin: "0 0 16px",
      borderBottom: "1px solid var(--hairline)",
      position: "sticky",
      top: 0,
      zIndex: 9,
      background: "color-mix(in srgb, var(--bg-base) 88%, transparent)",
      backdropFilter: "blur(8px)",
      WebkitBackdropFilter: "blur(8px)",
    }}
  >
    {FEED_TABS.map((tab) => {
      const selected = tab.id === active;
      return (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={selected}
          data-testid={`home-tab-${tab.id === "forYou" ? "for-you" : "following"}`}
          onClick={() => onChange(tab.id)}
          style={feedTabStyle(selected)}
        >
          {tab.label}
        </button>
      );
    })}
  </div>
);

const repostIdentityKey = (pubkey: string, noteId: string): string => `${pubkey}:${noteId}`;

const mergeTimelineItems = (items: TimelineItem[], optimisticReposts: TimelineItem[]): TimelineItem[] => {
  const byId = new Map<string, TimelineItem>();
  const repostByActorAndNote = new Map<string, string>();

  for (const item of [...items, ...optimisticReposts]) {
    if (item.type !== "repost") {
      if (!byId.has(item.id)) byId.set(item.id, item);
      continue;
    }

    const key = repostIdentityKey(item.repostedBy, item.note.id);
    const prevId = repostByActorAndNote.get(key);
    const prev = prevId ? byId.get(prevId) : undefined;
    if (prev && prev.createdAt >= item.createdAt) continue;
    if (prevId) byId.delete(prevId);
    byId.set(item.id, item);
    repostByActorAndNote.set(key, item.id);
  }

  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
};

/**
 * Collapsed group of consecutive muted feed items ("summary" display mode).
 * Each group toggles independently via local state; keys stay stable across
 * collapse/expand because the wrapping render keys the row by its first item.
 */
const MutedRow = ({
  items,
  render,
}: {
  items: TimelineItem[];
  render: (item: TimelineItem) => ReactNode;
}): ReactNode => {
  const [expanded, setExpanded] = useState(false);
  const count = items.length;

  const toggleStyle: CSSProperties = {
    width: "100%",
    padding: "11px 14px",
    border: "1px dashed var(--glass-border)",
    borderRadius: 12,
    background: "var(--glass)",
    color: "var(--text-3)",
    fontSize: 13,
    fontWeight: 600,
    fontFamily: "inherit",
    cursor: "pointer",
    textAlign: "left",
    transition: "color .15s, border-color .15s",
  };

  if (!expanded) {
    return (
      <button
        type="button"
        data-testid="muted-row-toggle"
        onClick={() => setExpanded(true)}
        style={{ ...toggleStyle, marginBottom: 14 }}
      >
        {"Show " + count + " muted"}
      </button>
    );
  }

  return (
    <div data-testid="muted-row-expanded" style={{ marginBottom: 14 }}>
      {items.map((item) => render(item))}
      <button
        type="button"
        data-testid="muted-row-toggle"
        onClick={() => setExpanded(false)}
        style={toggleStyle}
      >
        {"Hide " + count + " muted"}
      </button>
    </div>
  );
};

export const HomeView = (): ReactNode => {
  const { state, publish, toast, toggleBookmark, readRelayUrls } = useStore();
  const pubkey = state.identity?.pubkey ?? "";
  const [feedTab, setFeedTab] = useState<FeedTab>("forYou");

  const [replyTarget, setReplyTarget] = useState<Note | null>(null);
  const [optimistic, setOptimistic] = useState<Record<string, Partial<Engagement>>>({});
  const [optimisticReposts, setOptimisticReposts] = useState<TimelineItem[]>([]);
  const [suppressedRepostKeys, setSuppressedRepostKeys] = useState<Set<string>>(new Set());
  const [deleted, setDeleted] = useState<Set<string>>(new Set());
  const agentPubkeys = useMemo(() => loadAgentPubkeys(), []);

  const followedAuthors = useMemo(
    () => [...new Set([...state.contacts, pubkey].filter(Boolean))],
    [state.contacts, pubkey],
  );
  const isFollowingFeed = feedTab === "following";
  const followedAuthorSet = useMemo(() => new Set(followedAuthors), [followedAuthors]);

  const filter = useMemo<Filter>(() => {
    if (isFollowingFeed) return { kinds: [Kind.Note, Kind.Repost], authors: followedAuthors, limit: 80 };
    return { kinds: [Kind.Note, Kind.Repost], limit: 80 };
  }, [followedAuthors, isFollowingFeed]);

  const feedEnabled = !isFollowingFeed || followedAuthors.length > 0;
  const { items, loading, loadingMore, hasMore, loadMore } = useTimelineFeed(filter, [filter], feedEnabled);

  // Home feed = top-level posts plus repost rows, minus optimistically-deleted rows.
  const timelineItems = useMemo(
    () =>
      mergeTimelineItems(items, optimisticReposts).filter((item) => {
        const actor = item.type === "repost" ? item.repostedBy : item.note.pubkey;
        if (isFollowingFeed && !followedAuthorSet.has(actor)) return false;
        if (deleted.has(item.note.id)) return false;
        if (item.type === "repost" && suppressedRepostKeys.has(repostIdentityKey(item.repostedBy, item.note.id))) {
          return false;
        }
        return item.type === "repost" || item.note.replyTo === undefined;
      }),
    [items, optimisticReposts, isFollowingFeed, followedAuthorSet, deleted, suppressedRepostKeys],
  );
  // Client-only soft mute, applied after the existing follow/reply/delete filtering.
  const muted = useMemo(() => compileMutes(state.muteSettings.rules), [state.muteSettings.rules]);
  const rows = useMemo(
    () =>
      arrangeFeed(
        timelineItems,
        (it) =>
          it.type === "repost"
            ? evaluateRepost(muted, { repostedBy: it.repostedBy, note: it.note })
            : evaluateNote(muted, it.note),
        state.muteSettings.display,
      ),
    [timelineItems, muted, state.muteSettings.display],
  );
  const visibleNoteIds = useMemo(() => [...new Set(timelineItems.map((item) => item.note.id))], [timelineItems]);
  const engagement = useEngagement(visibleNoteIds, optimistic);
  const emptyFeed = useMemo(() => {
    if (feedTab === "following") {
      return state.contacts.length === 0
        ? {
            title: "Follow people to build this feed",
            hint: "Find people on Explore, then their posts will show up here.",
          }
        : {
            title: "No posts from people you follow yet",
            hint: "New posts from your follows will show up here.",
          };
    }
    return readRelayUrls.length === 0
      ? {
          title: "No read relays connected",
          hint: "Enable a read relay in Keys & Security to load the For you feed.",
        }
      : {
          title: "Your For you feed is quiet",
          hint: "New public posts from your connected relays will show up here.",
        };
  }, [feedTab, readRelayUrls.length, state.contacts.length]);

  useEffect(() => {
    if (!feedEnabled || typeof document === "undefined") return;
    const scrollRoot = document.querySelector<HTMLElement>('[data-testid="main-scroll"]');
    if (!scrollRoot) return;

    let frame = 0;
    const checkForMore = (): void => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (loading || loadingMore || !hasMore) return;
        const distanceFromBottom = scrollRoot.scrollHeight - scrollRoot.scrollTop - scrollRoot.clientHeight;
        if (distanceFromBottom < 640) void loadMore();
      });
    };

    scrollRoot.addEventListener("scroll", checkForMore, { passive: true });
    checkForMore();
    return () => {
      scrollRoot.removeEventListener("scroll", checkForMore);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [feedEnabled, hasMore, loadMore, loading, loadingMore, items.length, timelineItems.length, rows.length]);

  const like = useCallback(
    (note: Note): void => {
      const cur = engagement.get(note.id);
      if (cur?.liked) {
        const eventId = cur.likedEventId;
        if (!eventId) return;
        setOptimistic((o) => ({
          ...o,
          [note.id]: { ...o[note.id], liked: false, likes: Math.max(0, (cur.likes ?? 1) - 1), likedEventId: undefined },
        }));
        void publish({ kind: 5, created_at: nowSeconds(), tags: [["e", eventId]], content: "" }).then(
          () => toast("Unliked", "info"),
        );
        return;
      }
      setOptimistic((o) => ({
        ...o,
        [note.id]: { ...o[note.id], liked: true, likes: (cur?.likes ?? 0) + 1 },
      }));
      void publish(buildReaction(note, "+")).then((eventId) => {
        toast("Liked", "check");
        setOptimistic((o) => ({ ...o, [note.id]: { ...o[note.id], likedEventId: eventId } }));
      });
    },
    [engagement, publish, toast],
  );

  const repost = useCallback(
    (note: Note): boolean => {
      const cur = engagement.get(note.id);
      const ownRepostKey = pubkey ? repostIdentityKey(pubkey, note.id) : undefined;
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
        if (ownRepostKey) {
          setOptimisticReposts((rows) =>
            rows.filter((row) => row.type !== "repost" || repostIdentityKey(row.repostedBy, row.note.id) !== ownRepostKey),
          );
          setSuppressedRepostKeys((keys) => new Set(keys).add(ownRepostKey));
        }
        void publish({
          kind: 5,
          created_at: nowSeconds(),
          tags: eventIds.map((eventId) => ["e", eventId]),
          content: "",
        });
        return true;
      }
      const repostAt = nowSeconds();
      const optimisticRow: TimelineItem | null = pubkey
        ? {
            id: `repost:local:${note.id}:${repostAt}`,
            type: "repost",
            createdAt: repostAt,
            note,
            repostedBy: pubkey,
            repostEventId: "",
          }
        : null;
      if (optimisticRow && ownRepostKey) {
        setSuppressedRepostKeys((keys) => {
          const next = new Set(keys);
          next.delete(ownRepostKey);
          return next;
        });
        setOptimisticReposts((rows) => [
          optimisticRow,
          ...rows.filter((row) => row.type !== "repost" || repostIdentityKey(row.repostedBy, row.note.id) !== ownRepostKey),
        ]);
      }
      setOptimistic((o) => ({
        ...o,
        [note.id]: { ...o[note.id], reposted: true, reposts: (cur?.reposts ?? 0) + 1 },
      }));
      void publish(buildRepost(note)).then(
        (eventId) => {
          toast("Reposted to your followers", "repost");
          setOptimistic((o) => ({ ...o, [note.id]: { ...o[note.id], repostedEventIds: [eventId] } }));
          if (ownRepostKey) {
            setOptimisticReposts((rows) =>
              rows.map((row) =>
                row.type === "repost" && repostIdentityKey(row.repostedBy, row.note.id) === ownRepostKey
                  ? { ...row, id: `repost:${eventId}`, repostEventId: eventId }
                  : row,
              ),
            );
          }
        },
        () => {
          toast("Could not repost", "warn");
          setOptimistic((o) => ({
            ...o,
            [note.id]: { ...o[note.id], reposted: false, reposts: Math.max(0, (cur?.reposts ?? 1) - 1), repostedEventIds: [] },
          }));
          if (ownRepostKey) {
            setOptimisticReposts((rows) =>
              rows.filter((row) => row.type !== "repost" || repostIdentityKey(row.repostedBy, row.note.id) !== ownRepostKey),
            );
          }
        },
      );
      return true;
    },
    [engagement, pubkey, publish, toast],
  );

  const share = useCallback(
    (note: Note): void => {
      const link = `${location.origin}${location.pathname}${location.search}${routeToHash({ view: "postDetail", params: { id: note.id } })}`;
      void navigator.clipboard?.writeText(link).then(() => toast("Link copied to clipboard", "copy"));
    },
    [toast],
  );

  const remove = useCallback(
    (note: Note): void => {
      setDeleted((d) => new Set(d).add(note.id));
      void publish({
        kind: 5,
        created_at: nowSeconds(),
        tags: [["e", note.id]],
        content: "",
      })
        .then(() => toast("Post deleted", "info"))
        .catch(() => toast("Could not delete post", "warn"));
    },
    [publish, toast],
  );

  const meName = state.me
    ? displayName({ name: state.me.name, displayName: state.me.displayName, pubkey })
    : "You";

  // Shared per-item render — reused for plain rows and inside expanded muted groups.
  const renderItem = useCallback(
    (item: TimelineItem): ReactNode => {
      const note = item.note;
      return (
        <PostCard
          key={item.id}
          note={note}
          engagement={engagement.get(note.id)}
          bookmarked={state.bookmarks.includes(note.id)}
          repostedBy={item.type === "repost" ? item.repostedBy : undefined}
          repostedAt={item.type === "repost" ? item.createdAt : undefined}
          repostEvent={item.type === "repost" ? item.repostEvent : undefined}
          isAgent={agentPubkeys.has(note.pubkey)}
          onReply={() => setReplyTarget(note)}
          onRepost={() => repost(note)}
          onLike={() => like(note)}
          onBookmark={() => toggleBookmark(note.id)}
          onShare={() => share(note)}
          onDelete={() => remove(note)}
        />
      );
    },
    [engagement, state.bookmarks, agentPubkeys, repost, like, toggleBookmark, share, remove],
  );

  return (
    <div data-testid="view-home" style={{ maxWidth: 640, margin: "0 auto", padding: "6px 18px 120px" }}>
      <FeedTabs active={feedTab} onChange={setFeedTab} />

      <Composer pubkey={pubkey} meName={meName} picture={state.me?.picture} />

      <ArticlesStrip authors={isFollowingFeed ? followedAuthors : undefined} />

      {loading && timelineItems.length === 0 ? (
        <div style={{ display: "flex", justifyContent: "center", padding: "56px 0" }}>
          <Spinner size={26} />
        </div>
      ) : timelineItems.length === 0 ? (
        <>
          <EmptyState
            icon={<HomeIcon size={32} />}
            title={emptyFeed.title}
            hint={emptyFeed.hint}
          />
          {loadingMore && (
            <div style={{ display: "flex", justifyContent: "center", padding: "20px 0 4px" }}>
              <Spinner size={20} />
            </div>
          )}
        </>
      ) : rows.length === 0 ? (
        // Items exist but every one matches a mute rule (hidden display mode):
        // show a neutral notice rather than the misleading "feed is quiet" state.
        <>
          <EmptyState
            icon={<HomeIcon size={32} />}
            title="Everything here is muted"
            hint={`${timelineItems.length} ${timelineItems.length === 1 ? "post is" : "posts are"} hidden by your mute rules. Manage them in Keys & Security.`}
          />
          {loadingMore && (
            <div style={{ display: "flex", justifyContent: "center", padding: "20px 0 4px" }}>
              <Spinner size={20} />
            </div>
          )}
        </>
      ) : (
        <>
          {rows.map((row: FeedRow<TimelineItem>) =>
            row.kind === "item" ? (
              renderItem(row.item)
            ) : (
              <MutedRow key={`muted:${row.items[0]?.id ?? ""}`} items={row.items} render={renderItem} />
            ),
          )}
          {loadingMore && (
            <div style={{ display: "flex", justifyContent: "center", padding: "20px 0 4px" }}>
              <Spinner size={20} />
            </div>
          )}
        </>
      )}

      {replyTarget && <Compose replyTo={replyTarget} onClose={() => setReplyTarget(null)} />}
    </div>
  );
};
