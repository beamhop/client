import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { Filter } from "nostr-tools";
import { useStore, routeToHash } from "../state/store.tsx";
import { useEngagement, type Engagement } from "../state/hooks.ts";
import { Kind, type Note } from "../nostr/types.ts";
import { buildReaction, buildRepost, decodeNote } from "../nostr/events.ts";
import { nowSeconds } from "../nostr/client.ts";
import { Spinner, EmptyState } from "../ui/primitives.tsx";
import { PostCard } from "../ui/PostCard.tsx";
import { Compose } from "../ui/Compose.tsx";

const topBarStyle: CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 9,
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "13px 22px",
  background: "color-mix(in srgb, var(--bg-base) 88%, transparent)",
  backdropFilter: "blur(8px)",
  WebkitBackdropFilter: "blur(8px)",
  borderBottom: "1px solid var(--hairline)",
};

const buttonStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 7,
  padding: "8px 12px",
  border: "none",
  borderRadius: 9,
  background: "transparent",
  color: "var(--text-2)",
  fontWeight: 700,
  fontSize: 13.5,
  fontFamily: "inherit",
  cursor: "pointer",
};

const focusedHighlightStyle: CSSProperties = {
  borderRadius: 12,
  outline: "2px solid var(--accent)",
  outlineOffset: 2,
  background: "var(--accent-soft)",
};

const ChevronLeft = (): ReactNode => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="m15 18-6-6 6-6" />
  </svg>
);

const ShareGlyph = (): ReactNode => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" />
    <path d="M16 6l-4-4-4 4M12 2v13" />
  </svg>
);

const postLink = (id: string): string =>
  `${location.origin}${location.pathname}${location.search}${routeToHash({ view: "postDetail", params: { id } })}`;

// Depth-first tree builder used for both thread mode (from thread root) and
// standalone reply mode (from the viewed post). skipId excludes a note from
// the child list — used to omit the thread root that is rendered separately.
const buildThreadTree = (
  startId: string,
  notes: Note[],
  skipId: string | null,
): Array<{ note: Note; depth: number }> => {
  const knownIds = new Set([startId, ...notes.map((n) => n.id)]);
  const byParent = new Map<string, Note[]>();
  for (const n of notes) {
    if (skipId !== null && n.id === skipId) continue;
    const parentId = n.replyTo && knownIds.has(n.replyTo) ? n.replyTo : startId;
    const bucket = byParent.get(parentId);
    if (bucket) bucket.push(n);
    else byParent.set(parentId, [n]);
  }
  const result: Array<{ note: Note; depth: number }> = [];
  const visited = new Set<string>();
  const walk = (parentId: string, depth: number): void => {
    if (visited.has(parentId)) return;
    visited.add(parentId);
    for (const child of (byParent.get(parentId) ?? []).sort((a, b) => a.createdAt - b.createdAt)) {
      result.push({ note: child, depth });
      walk(child.id, depth + 1);
    }
  };
  walk(startId, 0);
  return result;
};

export const PostDetailView = (): ReactNode => {
  const { state, client, readRelayUrls, publish, toast, toggleBookmark, navigate } = useStore();
  const id = state.nav.params.id;
  const [note, setNote] = useState<Note | null>(null);
  const [replies, setReplies] = useState<Note[]>([]);
  // Populated when the viewed post belongs to a thread (has a rootId).
  // Contains the thread root + all posts in the thread.
  const [threadNotes, setThreadNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [replyTarget, setReplyTarget] = useState<Note | null>(null);
  const [optimistic, setOptimistic] = useState<Record<string, Partial<Engagement>>>({});
  const [deleted, setDeleted] = useState<Set<string>>(new Set());

  const focusedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!id) {
      setLoading(false);
      return;
    }
    if (readRelayUrls.length === 0) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setNote(null);
    setReplies([]);
    setThreadNotes([]);
    void (async () => {
      const targetEvent = await client.get(readRelayUrls, { kinds: [Kind.Note, Kind.Mention], ids: [id] } satisfies Filter);
      if (cancelled) return;
      if (!targetEvent) {
        setLoading(false);
        return;
      }
      const decoded = decodeNote(targetEvent);
      setNote(decoded);

      const { rootId } = decoded;
      if (rootId) {
        // Fetch the thread root and every post that references the root.
        const [rootEvent, threadEvents] = await Promise.all([
          client.get(readRelayUrls, { kinds: [Kind.Note, Kind.Mention], ids: [rootId] } satisfies Filter),
          client.list(readRelayUrls, { kinds: [Kind.Note, Kind.Mention], "#e": [rootId], limit: 200 } satisfies Filter),
        ]);
        if (cancelled) return;
        const seen = new Set<string>();
        const all: Note[] = [];
        const add = (n: Note): void => {
          if (!seen.has(n.id)) { seen.add(n.id); all.push(n); }
        };
        if (rootEvent) add(decodeNote(rootEvent));
        threadEvents.forEach((e) => add(decodeNote(e)));
        add(decoded); // guarantee the focused post is always present
        setThreadNotes(all.sort((a, b) => a.createdAt - b.createdAt));
      } else {
        const replyEvents = await client.list(readRelayUrls, { kinds: [Kind.Note, Kind.Mention], "#e": [id], limit: 100 } satisfies Filter);
        if (cancelled) return;
        setReplies(
          replyEvents
            .map(decodeNote)
            .filter((reply) => reply.id !== id)
            .sort((a, b) => a.createdAt - b.createdAt),
        );
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [client, readRelayUrls, id]);

  // Scroll the focused post into view after the thread finishes loading.
  useEffect(() => {
    if (!loading && note?.rootId && focusedRef.current) {
      const timer = setTimeout(() => focusedRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 100);
      return () => clearTimeout(timer);
    }
  }, [loading, note?.id]);

  const isInThread = Boolean(note?.rootId) && threadNotes.length > 0;

  const visibleReplies = useMemo(() => replies.filter((reply) => !deleted.has(reply.id)), [replies, deleted]);

  const visibleThreadNotes = useMemo(() => threadNotes.filter((n) => !deleted.has(n.id)), [threadNotes, deleted]);

  const visibleIds = useMemo(
    () =>
      isInThread
        ? visibleThreadNotes.map((n) => n.id)
        : [note?.id, ...visibleReplies.map((r) => r.id)].filter((v): v is string => Boolean(v)),
    [isInThread, note?.id, visibleReplies, visibleThreadNotes],
  );

  const engagement = useEngagement(visibleIds, optimistic);

  // Thread mode: full tree from the thread root, excluding root itself (rendered at top).
  const threadedNotes = useMemo(
    (): Array<{ note: Note; depth: number }> =>
      isInThread && note?.rootId ? buildThreadTree(note.rootId, visibleThreadNotes, note.rootId) : [],
    [isInThread, note?.rootId, visibleThreadNotes],
  );

  // Standalone mode: replies threaded under the viewed post.
  const threadedReplies = useMemo(
    (): Array<{ note: Note; depth: number }> =>
      !isInThread && id ? buildThreadTree(id, visibleReplies, null) : [],
    [isInThread, id, visibleReplies],
  );

  const threadRootNote = useMemo(
    () => (isInThread && note?.rootId ? visibleThreadNotes.find((n) => n.id === note.rootId) ?? null : null),
    [isInThread, note?.rootId, visibleThreadNotes],
  );

  const like = useCallback(
    (target: Note): void => {
      const cur = engagement.get(target.id);
      if (cur?.liked) {
        const eventId = cur.likedEventId;
        if (!eventId) return;
        setOptimistic((o) => ({
          ...o,
          [target.id]: { ...o[target.id], liked: false, likes: Math.max(0, (cur.likes ?? 1) - 1), likedEventId: undefined },
        }));
        void publish({ kind: 5, created_at: nowSeconds(), tags: [["e", eventId]], content: "" }).then(() => toast("Unliked", "info"));
        return;
      }
      setOptimistic((o) => ({
        ...o,
        [target.id]: { ...o[target.id], liked: true, likes: (cur?.likes ?? 0) + 1 },
      }));
      void publish(buildReaction(target, "+")).then((eventId) => {
        toast("Liked", "check");
        setOptimistic((o) => ({ ...o, [target.id]: { ...o[target.id], likedEventId: eventId } }));
      });
    },
    [engagement, publish, toast],
  );

  const repost = useCallback(
    (target: Note): boolean => {
      const cur = engagement.get(target.id);
      if (cur?.reposted) {
        const eventIds = cur.repostedEventIds ?? [];
        if (eventIds.length === 0) return false;
        setOptimistic((o) => ({
          ...o,
          [target.id]: {
            ...o[target.id],
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
      setOptimistic((o) => ({
        ...o,
        [target.id]: { ...o[target.id], reposted: true, reposts: (cur?.reposts ?? 0) + 1 },
      }));
      void publish(buildRepost(target)).then((eventId) => {
        toast("Reposted to your followers", "repost");
        setOptimistic((o) => ({ ...o, [target.id]: { ...o[target.id], repostedEventIds: [eventId] } }));
      });
      return true;
    },
    [engagement, publish, toast],
  );

  const share = useCallback(
    (target: Note): void => {
      void navigator.clipboard?.writeText(postLink(target.id)).then(() => toast("Post link copied", "copy"));
    },
    [toast],
  );

  const remove = useCallback(
    (target: Note): void => {
      setDeleted((d) => new Set(d).add(target.id));
      void publish({
        kind: 5,
        created_at: nowSeconds(),
        tags: [["e", target.id]],
        content: "",
      }).then(
        () => toast("Post deleted", "info"),
        () => toast("Could not delete post", "warn"),
      );
    },
    [publish, toast],
  );

  const renderPost = (target: Note, pinnedLabel?: string): ReactNode => (
    <PostCard
      key={target.id}
      note={target}
      pinnedLabel={pinnedLabel}
      engagement={engagement.get(target.id)}
      bookmarked={state.bookmarks.includes(target.id)}
      onReply={() => setReplyTarget(target)}
      onRepost={() => repost(target)}
      onLike={() => like(target)}
      onBookmark={() => toggleBookmark(target.id)}
      onShare={() => share(target)}
      onDelete={() => remove(target)}
    />
  );

  const depthWrapStyle = (depth: number): CSSProperties | undefined =>
    depth > 0
      ? { marginLeft: Math.min(depth, 4) * 18, borderLeft: "2px solid var(--hairline)", paddingLeft: 14 }
      : undefined;

  return (
    <div data-testid="view-post-detail" style={{ minHeight: "100%" }}>
      <div style={topBarStyle}>
        <button type="button" data-testid="post-detail-back" onClick={() => navigate("home")} style={buttonStyle}>
          <ChevronLeft />
          Back
        </button>
        <div style={{ flex: 1 }} />
        {note && (
          <button type="button" data-testid="post-detail-share" onClick={() => share(note)} style={buttonStyle}>
            <ShareGlyph />
            Share
          </button>
        )}
      </div>

      <div style={{ maxWidth: 680, margin: "0 auto", padding: "22px 18px 120px" }}>
        {loading ? (
          <div style={{ display: "flex", justifyContent: "center", padding: "56px 0" }}>
            <Spinner size={26} />
          </div>
        ) : !note || deleted.has(note.id) ? (
          <EmptyState title="Post not found" hint="This post may not be available on your configured relays." />
        ) : isInThread ? (
          <>
            {threadRootNote && renderPost(threadRootNote, "Thread")}
            {threadedNotes.map(({ note: n, depth }) => {
              const isFocused = n.id === id;
              return (
                <div key={n.id} ref={isFocused ? focusedRef : undefined} style={depthWrapStyle(depth)}>
                  <div style={isFocused ? focusedHighlightStyle : undefined}>
                    {renderPost(n)}
                  </div>
                </div>
              );
            })}
          </>
        ) : (
          <>
            {renderPost(note, "Post")}
            <div style={{ margin: "22px 0 12px", fontFamily: "'Space Grotesk',sans-serif", fontSize: 15, fontWeight: 700, color: "var(--text)" }}>
              Replies
            </div>
            {threadedReplies.length === 0 ? (
              <EmptyState title="No replies yet" hint="Start the conversation from this post." />
            ) : (
              threadedReplies.map(({ note: reply, depth }) => (
                <div key={reply.id} style={depthWrapStyle(depth)}>
                  {renderPost(reply)}
                </div>
              ))
            )}
          </>
        )}
      </div>

      {replyTarget && (
        <Compose
          replyTo={replyTarget}
          onClose={() => setReplyTarget(null)}
          onPublished={(note) => {
            setReplies((prev) => [note, ...prev]);
            setReplyTarget(null);
          }}
        />
      )}
    </div>
  );
};
