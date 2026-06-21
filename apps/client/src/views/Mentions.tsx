import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Filter } from "nostr-tools";
import { useStore, useFeed, useEngagement, useCompiledMutes, routeToHash, type Engagement } from "@beamhop/state";
import { Kind, mentionsPubkey, buildReaction, buildRepost, nowSeconds, type Note } from "@beamhop/nostr";
import { evaluateNote } from "@beamhop/lib";
import { haptic } from "@beamhop/lib";
import { PostCard } from "../ui/PostCard.tsx";
import { Compose } from "../ui/Compose.tsx";
import { EmptyState, Spinner } from "../ui/primitives.tsx";
import { AtIcon } from "../ui/icons.tsx";

// Cap the contacts `authors` filter so a huge follow list can't blow past relay
// limits; the tagged-mention feed (#p) still covers mentions from anyone.
const CONTACTS_SCAN_CAP = 500;

const smallButtonStyle = {
  padding: "10px 16px",
  border: "1px solid var(--glass-border)",
  borderRadius: 10,
  background: "var(--glass)",
  color: "var(--text)",
  fontWeight: 700,
  fontSize: 13.5,
  fontFamily: "inherit",
  cursor: "pointer",
} as const;

/**
 * Posts that mention you, newest first. Two sources are merged:
 *
 *  1. `#p`-tagged mentions from anyone (the NIP-27/-10 happy path — what our own
 *     composer now emits), and
 *  2. content-only mentions from people you follow, recovered by scanning their
 *     notes for an inline `@npub` of you. This catches notes whose author forgot
 *     the `p` tag — relays can't match free-text, so we can only recover these
 *     among notes we already pull, i.e. your network.
 *
 * Both are re-checked client-side with the same `referencesMe` predicate, so the
 * list is correct regardless of how strictly a relay honored the filters.
 */
export const MentionsView = (): ReactNode => {
  const { state, publish, toast, toggleBookmark, setRefreshHandler } = useStore();
  const me = state.identity?.pubkey ?? "";

  const [replyTarget, setReplyTarget] = useState<Note | null>(null);
  const [optimistic, setOptimistic] = useState<Record<string, Partial<Engagement>>>({});

  const contacts = useMemo(
    () => state.contacts.filter((p) => p && p !== me).slice(0, CONTACTS_SCAN_CAP),
    [state.contacts, me],
  );

  const taggedFilter = useMemo<Filter>(() => ({ kinds: [Kind.Note], "#p": [me], limit: 100 }), [me]);
  const contactsFilter = useMemo<Filter>(() => ({ kinds: [Kind.Note], authors: contacts, limit: 200 }), [contacts]);

  const tagged = useFeed(taggedFilter, [taggedFilter], me !== "");
  const fromContacts = useFeed(contactsFilter, [contactsFilter], contacts.length > 0);

  // A note mentions me if it carries my `p` tag or names me inline — independent
  // of which feed surfaced it.
  const referencesMe = useCallback(
    (note: Note): boolean =>
      note.pubkey !== me &&
      (note.tags.some((t) => t[0] === "p" && t[1] === me) || mentionsPubkey(note.content, me)),
    [me],
  );

  const muted = useCompiledMutes();
  const mentions = useMemo(() => {
    const byId = new Map<string, Note>();
    for (const note of [...tagged.notes, ...fromContacts.notes]) {
      if (!referencesMe(note)) continue;
      if (evaluateNote(muted, note)) continue; // hard-hide muted authors/content
      byId.set(note.id, note);
    }
    return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
  }, [tagged.notes, fromContacts.notes, referencesMe, muted]);

  const noteIds = useMemo(() => mentions.map((n) => n.id), [mentions]);
  const engagement = useEngagement(noteIds, optimistic);

  // Wire both feeds into the shell's pull-to-refresh.
  const refresh = useCallback(async (): Promise<void> => {
    await Promise.all([tagged.refresh(), fromContacts.refresh()]);
  }, [tagged.refresh, fromContacts.refresh]);
  useEffect(() => {
    setRefreshHandler(refresh);
    return () => setRefreshHandler(null);
  }, [refresh, setRefreshHandler]);

  const loading = tagged.loading || fromContacts.loading;
  const hasMore = tagged.hasMore || fromContacts.hasMore;
  const loadingMore = tagged.loadingMore || fromContacts.loadingMore;
  const loadMore = useCallback((): void => {
    void tagged.loadMore();
    void fromContacts.loadMore();
  }, [tagged.loadMore, fromContacts.loadMore]);

  const like = useCallback(
    (note: Note): void => {
      haptic("light");
      const cur = engagement.get(note.id);
      if (cur?.liked) {
        const eventId = cur.likedEventId;
        if (!eventId) return;
        setOptimistic((o) => ({
          ...o,
          [note.id]: { ...o[note.id], liked: false, likes: Math.max(0, (cur.likes ?? 1) - 1), likedEventId: undefined },
        }));
        void publish({ kind: 5, created_at: nowSeconds(), tags: [["e", eventId]], content: "" }).then(() => toast("Unliked", "info"));
        return;
      }
      setOptimistic((o) => ({ ...o, [note.id]: { ...o[note.id], liked: true, likes: (cur?.likes ?? 0) + 1 } }));
      void publish(buildReaction(note, "+")).then((eventId) => {
        toast("Liked", "check");
        setOptimistic((o) => ({ ...o, [note.id]: { ...o[note.id], likedEventId: eventId } }));
      });
    },
    [engagement, publish, toast],
  );

  const repost = useCallback(
    (note: Note): void => {
      const cur = engagement.get(note.id);
      if (cur?.reposted) {
        const ids = cur.repostedEventIds ?? [];
        if (ids.length === 0) return;
        setOptimistic((o) => ({
          ...o,
          [note.id]: { ...o[note.id], reposted: false, reposts: Math.max(0, (cur.reposts ?? ids.length) - ids.length), repostedEventIds: [] },
        }));
        void publish({ kind: 5, created_at: nowSeconds(), tags: ids.map((id) => ["e", id]), content: "" });
        return;
      }
      setOptimistic((o) => ({ ...o, [note.id]: { ...o[note.id], reposted: true, reposts: (cur?.reposts ?? 0) + 1 } }));
      haptic("medium");
      void publish(buildRepost(note)).then(
        (eventId) => {
          toast("Reposted to your followers", "repost");
          setOptimistic((o) => ({ ...o, [note.id]: { ...o[note.id], repostedEventIds: [eventId] } }));
        },
        () => {
          toast("Could not repost", "warn");
          setOptimistic((o) => ({
            ...o,
            [note.id]: { ...o[note.id], reposted: false, reposts: Math.max(0, (cur?.reposts ?? 1) - 1), repostedEventIds: [] },
          }));
        },
      );
    },
    [engagement, publish, toast],
  );

  const share = useCallback(
    (note: Note): void => {
      const link = `${location.origin}${location.pathname}${location.search}${routeToHash({ view: "postDetail", params: { id: note.id } })}`;
      void navigator.clipboard?.writeText(link).then(() => toast("Link copied to clipboard", "copy"));
    },
    [toast],
  );

  return (
    <div data-testid="view-mentions" style={{ maxWidth: 640, margin: "0 auto", padding: "16px 18px calc(120px + var(--sab))" }}>
      {loading && mentions.length === 0 ? (
        <div style={{ display: "flex", justifyContent: "center", padding: "56px 0" }}>
          <Spinner size={26} />
        </div>
      ) : mentions.length === 0 ? (
        <EmptyState
          icon={<AtIcon size={32} />}
          title="No mentions yet"
          hint="When someone tags you in a post — or someone you follow @-mentions you — it shows up here."
        />
      ) : (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
            {mentions.map((note) => (
              <PostCard
                key={note.id}
                note={note}
                engagement={engagement.get(note.id)}
                bookmarked={state.bookmarks.includes(note.id)}
                onReply={() => setReplyTarget(note)}
                onRepost={() => repost(note)}
                onLike={() => like(note)}
                onBookmark={() => toggleBookmark(note.id)}
                onShare={() => share(note)}
              />
            ))}
          </div>
          {loadingMore ? (
            <div style={{ display: "flex", justifyContent: "center", padding: "20px 0 4px" }}>
              <Spinner size={20} />
            </div>
          ) : hasMore ? (
            <div style={{ display: "flex", justifyContent: "center", padding: "16px 0 4px" }}>
              <button type="button" data-testid="mentions-load-more" onClick={loadMore} style={smallButtonStyle}>
                Load older mentions
              </button>
            </div>
          ) : null}
        </>
      )}

      {replyTarget && <Compose replyTo={replyTarget} onClose={() => setReplyTarget(null)} />}
    </div>
  );
};
