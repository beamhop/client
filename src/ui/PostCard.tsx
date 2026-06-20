import { useState, type ReactNode } from "react";
import type { Note } from "../nostr/types.ts";
import { useProfile, useStore } from "../state/store.tsx";
import { displayName, initials, avatarStyle, timeAgo, fmtCount } from "../lib/format.ts";
import { parseMedia } from "../lib/media.ts";
import { actionStyle, avatarWrap, statusDot, postCardStyle } from "./styles.ts";
import { VerifiedSeal } from "./icons.tsx";
import type { Engagement } from "../state/hooks.ts";

type PostCardProps = {
  note: Note;
  engagement?: Engagement;
  bookmarked?: boolean;
  pinnedLabel?: string;
  isAgent?: boolean;
  agentOwner?: string;
  online?: boolean;
  onReply?: () => void;
  onRepost?: () => void;
  onLike?: () => void;
  onBookmark?: () => void;
  onShare?: () => void;
  onDelete?: () => void;
};

const ReplyGlyph = (): ReactNode => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
);
const RepostGlyph = (): ReactNode => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="m17 2 4 4-4 4" /><path d="M3 11V9a4 4 0 0 1 4-4h14" /><path d="m7 22-4-4 4-4" /><path d="M21 13v2a4 4 0 0 1-4 4H3" />
  </svg>
);
const HeartGlyph = ({ fill }: { fill: string }): ReactNode => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill={fill} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20.8 5.6a5.3 5.3 0 0 0-7.5 0L12 6.9l-1.3-1.3a5.3 5.3 0 1 0-7.5 7.5L12 22l8.8-8.9a5.3 5.3 0 0 0 0-7.5z" />
  </svg>
);
const BookmarkGlyph = ({ fill }: { fill: string }): ReactNode => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill={fill} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="m19 21-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
  </svg>
);
const ShareGlyph = (): ReactNode => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" /><path d="M16 6l-4-4-4 4M12 2v13" />
  </svg>
);
const TrashGlyph = (): ReactNode => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6" />
  </svg>
);
const PinGlyph = (): ReactNode => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
    <path d="M16 3l5 5-4 1-3 3 .5 5-2 2-3.5-3.5L4 24l5-5.5L5.5 15l2-2 5 .5 3-3 1-4z" />
  </svg>
);
const AgentSpark = (): ReactNode => (
  <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2l1.6 6.4L20 10l-6.4 1.6L12 18l-1.6-6.4L4 10l6.4-1.6z" />
  </svg>
);

/** The canonical feed post, faithful to the design (verity-glass.html ~271-323). */
export const PostCard = ({
  note,
  engagement,
  bookmarked,
  pinnedLabel,
  isAgent,
  agentOwner,
  online,
  onReply,
  onRepost,
  onLike,
  onBookmark,
  onShare,
  onDelete,
}: PostCardProps): ReactNode => {
  const { navigate, state } = useStore();
  const profile = useProfile(note.pubkey);
  const [hover, setHover] = useState(false);
  const [likePop, setLikePop] = useState(false);
  const [repostPop, setRepostPop] = useState(false);

  const handleLike = (): void => {
    if (!e?.liked) {
      setLikePop(true);
      setTimeout(() => setLikePop(false), 450);
    }
    onLike?.();
  };
  const handleRepost = (): void => {
    if (!e?.reposted) {
      setRepostPop(true);
      setTimeout(() => setRepostPop(false), 520);
    }
    onRepost?.();
  };
  const name = displayName({ name: profile?.name, displayName: profile?.displayName, pubkey: note.pubkey });
  const handle = profile?.nip05 ?? `${note.pubkey.slice(0, 8)}…${note.pubkey.slice(-4)}`;
  const verified = Boolean(profile?.nip05);
  const isMine = note.pubkey === state.identity?.pubkey;
  const { text, embeds } = parseMedia(note.content);
  const e = engagement;
  const openAuthor = () => navigate("profile", { pubkey: note.pubkey });

  return (
    <article
      data-testid="feed-post"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        ...postCardStyle,
        background: hover ? "var(--glass-2)" : "var(--glass)",
        borderColor: hover ? "var(--text-3)" : "var(--glass-border)",
      }}
    >
      {pinnedLabel && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, fontWeight: 700, color: "var(--text-3)", marginBottom: 11, textTransform: "uppercase", letterSpacing: ".04em" }}>
          <PinGlyph /> {pinnedLabel}
        </div>
      )}
      <div style={{ display: "flex", gap: 13 }}>
        <span style={avatarWrap(42, true)} onClick={openAuthor}>
          <span style={avatarStyle(note.pubkey, 42, profile?.picture)}>{!profile?.picture && initials(name)}</span>
          {online !== undefined && <span style={statusDot(online)} />}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span onClick={openAuthor} style={{ fontWeight: 700, fontSize: 15, color: "var(--text)", cursor: "pointer" }}>{name}</span>
            {verified && <VerifiedSeal size={15} />}
            {isAgent && (
              <span title={agentOwner ? `AI agent operated by ${agentOwner}` : "AI agent"} style={{ display: "inline-flex", alignItems: "center", gap: 3, padding: "2px 7px", borderRadius: 6, background: "var(--accent-soft)", color: "var(--accent)", fontSize: 9.5, fontWeight: 800, letterSpacing: ".04em" }}>
                <AgentSpark /> AI AGENT
              </span>
            )}
            <span onClick={openAuthor} style={{ fontSize: 13.5, color: "var(--text-3)", fontFamily: "'JetBrains Mono',monospace", cursor: "pointer" }}>{handle}</span>
            <span style={{ fontSize: 13.5, color: "var(--text-3)" }}>· {timeAgo(note.createdAt)}</span>
          </div>
          {text && <p style={{ margin: "7px 0 0", fontSize: 15.5, lineHeight: 1.55, color: "var(--text)", whiteSpace: "pre-wrap", overflowWrap: "anywhere", textWrap: "pretty" }}>{text}</p>}
          {embeds.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 11 }}>
              {embeds.map((m) =>
                m.type === "image" ? (
                  <img key={m.url} src={m.url} alt="" loading="lazy" style={{ maxWidth: "100%", borderRadius: 12, border: "1px solid var(--glass-border)", display: "block" }} />
                ) : (
                  <video key={m.url} src={m.url} controls style={{ maxWidth: "100%", borderRadius: 12, border: "1px solid var(--glass-border)", display: "block" }} />
                ),
              )}
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 12, marginLeft: -6 }}>
            <button onClick={onReply} style={actionStyle(false, "var(--accent)")}>
              <ReplyGlyph />
              <span>{e && e.replies > 0 ? fmtCount(e.replies) : ""}</span>
            </button>
            <button onClick={handleRepost} style={actionStyle(Boolean(e?.reposted), "var(--success)")}>
              <span style={{ display: "flex" }} className={repostPop ? "verity-pop" : undefined}><RepostGlyph /></span>
              <span>{e && e.reposts > 0 ? fmtCount(e.reposts) : ""}</span>
            </button>
            <button onClick={handleLike} style={actionStyle(Boolean(e?.liked), "var(--danger)")}>
              <span style={{ display: "flex" }} className={likePop ? "verity-pop" : undefined}><HeartGlyph fill={e?.liked ? "var(--danger)" : "none"} /></span>
              <span>{e && e.likes > 0 ? fmtCount(e.likes) : ""}</span>
            </button>
            <div style={{ flex: 1 }} />
            <button onClick={onBookmark} style={actionStyle(Boolean(bookmarked), "var(--accent)")} title="Bookmark">
              <BookmarkGlyph fill={bookmarked ? "var(--accent)" : "none"} />
            </button>
            <button onClick={onShare} style={actionStyle(false, "var(--accent)")} title="Share">
              <ShareGlyph />
            </button>
            {isMine && onDelete && (
              <button onClick={onDelete} style={actionStyle(false, "var(--danger)")} title="Delete post" data-testid="post-delete">
                <TrashGlyph />
              </button>
            )}
          </div>
        </div>
      </div>
    </article>
  );
};
