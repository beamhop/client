import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { Filter } from "nostr-tools";
import { useStore, useProfile } from "../state/store.tsx";
import { useFeed, useEngagement, type Engagement } from "../state/hooks.ts";
import { Kind, type Note } from "../nostr/types.ts";
import { buildNote, buildReaction, buildRepost } from "../nostr/events.ts";
import { Avatar, AuthorChip, Spinner, EmptyState, PrimaryButton, glass } from "../ui/primitives.tsx";
import { HeartIcon, ReplyIcon, RepostIcon, BookmarkIcon, HomeIcon } from "../ui/icons.tsx";
import { timeAgo, fmtCount, displayName } from "../lib/format.ts";
import { Compose } from "../ui/Compose.tsx";

const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif)$/i;
const VIDEO_RE = /\.(mp4|webm|mov)$/i;
const URL_RE = /(https?:\/\/[^\s]+)/g;

/** Split content into plain text, links, and media embeds. */
const renderContent = (content: string): { body: ReactNode; embeds: string[] } => {
  const embeds: string[] = [];
  const parts: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of content.matchAll(URL_RE)) {
    const url = match[0];
    const start = match.index;
    if (start > last) parts.push(content.slice(last, start));
    last = start + url.length;
    if (IMAGE_RE.test(url) || VIDEO_RE.test(url)) {
      embeds.push(url);
      continue; // strip media URLs from the text body
    }
    parts.push(
      <a
        key={`l${key++}`}
        href={url}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
        style={{ color: "var(--accent)", textDecoration: "none", wordBreak: "break-word" }}
      >
        {url}
      </a>,
    );
  }
  if (last < content.length) parts.push(content.slice(last));
  return { body: parts, embeds };
};

const Embed = ({ url }: { url: string }): ReactNode => {
  const common: CSSProperties = {
    width: "100%",
    maxHeight: 420,
    borderRadius: 12,
    border: "1px solid var(--glass-border)",
    objectFit: "cover",
    display: "block",
  };
  if (VIDEO_RE.test(url)) return <video src={url} controls style={common} />;
  return <img src={url} alt="" loading="lazy" style={common} />;
};

const actionBtn = (active: boolean, hue: string): CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 9px",
  border: "none",
  borderRadius: 9,
  background: "transparent",
  color: active ? hue : "var(--text-3)",
  fontSize: 13,
  fontWeight: 600,
  fontFamily: "inherit",
  fontVariantNumeric: "tabular-nums",
  cursor: "pointer",
  transition: "background .15s, color .15s",
});

const PostCard = ({
  note,
  engagement,
  onLike,
  onRepost,
  onReply,
}: {
  note: Note;
  engagement: Engagement;
  onLike: () => void;
  onRepost: () => void;
  onReply: () => void;
}): ReactNode => {
  const { state, toggleBookmark, navigate } = useStore();
  const profile = useProfile(note.pubkey);
  const [popKey, setPopKey] = useState(0);
  const { body, embeds } = useMemo(() => renderContent(note.content), [note.content]);
  const bookmarked = state.bookmarks.includes(note.id);

  const handle =
    profile?.nip05 ??
    displayName({ name: profile?.name, displayName: profile?.displayName, pubkey: note.pubkey });

  const openAuthor = (): void => navigate("profile", { pubkey: note.pubkey });

  return (
    <article
      style={{ ...glass, borderRadius: 16, padding: 16, transition: "background .15s, border-color .15s" }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
        <AuthorChip pubkey={note.pubkey} size={42} subtitle={handle} onClick={openAuthor} />
        <span style={{ fontSize: 13, color: "var(--text-3)", whiteSpace: "nowrap", flexShrink: 0 }}>
          {timeAgo(note.createdAt)}
        </span>
      </div>

      {body && (
        <p
          style={{
            margin: "11px 0 0",
            fontSize: 15.5,
            lineHeight: 1.55,
            color: "var(--text)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {body}
        </p>
      )}

      {embeds.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 11 }}>
          {embeds.map((url) => (
            <Embed key={url} url={url} />
          ))}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 12, marginLeft: -6 }}>
        <button type="button" onClick={onReply} style={actionBtn(false, "var(--accent)")}>
          <ReplyIcon size={17} />
          <span>{engagement.replies > 0 ? fmtCount(engagement.replies) : ""}</span>
        </button>
        <button type="button" onClick={onRepost} style={actionBtn(engagement.reposted, "var(--success)")}>
          <RepostIcon size={17} />
          <span>{engagement.reposts > 0 ? fmtCount(engagement.reposts) : ""}</span>
        </button>
        <button
          type="button"
          onClick={() => {
            setPopKey((k) => k + 1);
            onLike();
          }}
          style={actionBtn(engagement.liked, "var(--danger)")}
        >
          <span key={popKey} className="verity-pop" style={{ display: "flex" }}>
            <HeartIcon size={17} filled={engagement.liked} />
          </span>
          <span>{engagement.likes > 0 ? fmtCount(engagement.likes) : ""}</span>
        </button>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => toggleBookmark(note.id)}
          style={actionBtn(bookmarked, "var(--accent)")}
          aria-label="Bookmark"
        >
          <BookmarkIcon size={17} filled={bookmarked} />
        </button>
      </div>
    </article>
  );
};

export const HomeView = (): ReactNode => {
  const { state, publish, toast, writeRelayUrls } = useStore();
  const pubkey = state.identity?.pubkey ?? "";

  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [replyTarget, setReplyTarget] = useState<Note | null>(null);
  const [optimistic, setOptimistic] = useState<Record<string, Partial<Engagement>>>({});

  const filter = useMemo<Filter>(() => {
    const authors = [...new Set([...state.contacts, pubkey].filter(Boolean))];
    if (authors.length <= 1) return { kinds: [Kind.Note], limit: 60 };
    return { kinds: [Kind.Note], authors, limit: 80 };
  }, [state.contacts, pubkey]);

  const { notes, loading } = useFeed(filter, [filter]);

  // Home feed = top-level notes only (no replies).
  const topLevel = useMemo(() => notes.filter((n) => n.replyTo === undefined), [notes]);
  const visibleNoteIds = useMemo(() => topLevel.map((n) => n.id), [topLevel]);
  const engagement = useEngagement(visibleNoteIds, optimistic);

  const post = async (): Promise<void> => {
    const content = text.trim();
    if (!content) return;
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

  const like = (note: Note): void => {
    const cur = engagement.get(note.id);
    if (cur?.liked) return;
    setOptimistic((o) => ({
      ...o,
      [note.id]: { ...o[note.id], liked: true, likes: (cur?.likes ?? 0) + 1 },
    }));
    void publish(buildReaction(note, "+")).then(() => toast("Liked", "check"));
  };

  const repost = (note: Note): void => {
    const cur = engagement.get(note.id);
    if (cur?.reposted) return;
    setOptimistic((o) => ({
      ...o,
      [note.id]: { ...o[note.id], reposted: true, reposts: (cur?.reposts ?? 0) + 1 },
    }));
    void publish(buildRepost(note)).then(() => toast("Reposted to your followers", "repost"));
  };

  const meName = state.me
    ? displayName({ name: state.me.name, displayName: state.me.displayName, pubkey })
    : "You";

  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: "6px 18px 120px" }}>
      {/* composer */}
      <div style={{ ...glass, borderRadius: 14, padding: 16, marginBottom: 18 }}>
        <div style={{ display: "flex", gap: 13 }}>
          <Avatar pubkey={pubkey} size={44} name={meName} picture={state.me?.picture} />
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="What's happening on the network?"
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
          <div style={{ flex: 1 }} />
          <span
            style={{
              fontSize: 12.5,
              color: text.length > 280 ? "var(--warn)" : "var(--text-3)",
              fontFamily: "'JetBrains Mono',monospace",
            }}
          >
            {text.length}
          </span>
          <PrimaryButton onClick={() => void post()} disabled={!text.trim() || busy}>
            {busy ? "Posting…" : "Post"}
          </PrimaryButton>
        </div>
      </div>

      {/* feed */}
      {loading && topLevel.length === 0 ? (
        <div style={{ display: "flex", justifyContent: "center", padding: "56px 0" }}>
          <Spinner size={26} />
        </div>
      ) : topLevel.length === 0 ? (
        <EmptyState
          icon={<HomeIcon size={32} />}
          title="Your feed is quiet"
          hint="Follow a few people on Explore, or share the first post — it'll show up right here."
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {topLevel.map((note) => (
            <PostCard
              key={note.id}
              note={note}
              engagement={engagement.get(note.id) ?? {
                likes: 0,
                reposts: 0,
                replies: 0,
                liked: false,
                reposted: false,
              }}
              onLike={() => like(note)}
              onRepost={() => repost(note)}
              onReply={() => setReplyTarget(note)}
            />
          ))}
        </div>
      )}

      {replyTarget && <Compose replyTo={replyTarget} onClose={() => setReplyTarget(null)} />}
    </div>
  );
};
