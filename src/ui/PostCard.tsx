import { useEffect, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import type { Note } from "../nostr/types.ts";
import { useProfile, useStore } from "../state/store.tsx";
import { displayName, initials, avatarStyle, timeAgo, fmtCount } from "../lib/format.ts";
import { parseMedia, type Embed } from "../lib/media.ts";
import { actionStyle, avatarWrap, statusDot, postCardStyle } from "./styles.ts";
import { CloseIcon, ImageIcon, VerifiedSeal } from "./icons.tsx";
import type { Engagement } from "../state/hooks.ts";
import { BubblePop } from "./BubblePop.tsx";

type PostCardProps = {
  note: Note;
  engagement?: Engagement;
  bookmarked?: boolean;
  pinnedLabel?: string;
  isAgent?: boolean;
  agentOwner?: string;
  online?: boolean;
  onReply?: () => void;
  onRepost?: () => boolean | void;
  onLike?: () => void;
  onBookmark?: () => void;
  onShare?: () => void;
  onDelete?: () => void;
  onOpen?: () => void;
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

const GalleryArrowGlyph = ({ dir }: { dir: "left" | "right" }): ReactNode => (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.35" strokeLinecap="round" strokeLinejoin="round">
    {dir === "left" ? <path d="m15 18-6-6 6-6" /> : <path d="m9 18 6-6-6-6" />}
  </svg>
);

const galleryButtonStyle: CSSProperties = {
  position: "absolute",
  top: "50%",
  transform: "translateY(-50%)",
  zIndex: 4,
  width: 42,
  height: 42,
  borderRadius: "50%",
  border: "1px solid rgba(255,255,255,.22)",
  background: "rgba(10,10,25,.58)",
  color: "#fff",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
  boxShadow: "0 12px 34px rgba(0,0,0,.24)",
  backdropFilter: "blur(10px)",
  WebkitBackdropFilter: "blur(10px)",
};

const PhotoGallery = ({
  images,
  authorName,
}: {
  images: Embed[];
  authorName: string;
}): ReactNode => {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [stackHover, setStackHover] = useState(false);
  const [pressed, setPressed] = useState(false);
  const activeImage = images[activeIndex] ?? images[0];
  const imageCount = images.length;

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setOpen(false);
      } else if (event.key === "ArrowRight") {
        setActiveIndex((index) => (index + 1) % imageCount);
      } else if (event.key === "ArrowLeft") {
        setActiveIndex((index) => (index - 1 + imageCount) % imageCount);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [imageCount, open]);

  if (!activeImage) return null;

  const openAt = (index: number, event: MouseEvent<HTMLElement>): void => {
    event.stopPropagation();
    setActiveIndex(index);
    setOpen(true);
  };
  const move = (delta: number, event?: MouseEvent<HTMLButtonElement>): void => {
    event?.stopPropagation();
    setActiveIndex((index) => (index + delta + imageCount) % imageCount);
  };
  const close = (event?: MouseEvent<HTMLElement>): void => {
    event?.stopPropagation();
    setOpen(false);
  };
  const stackInset = imageCount > 1 ? "0 28px 22px 0" : 0;

  return (
    <>
      <div
        data-testid={imageCount > 1 ? "post-photo-stack" : "post-photo-single"}
        onMouseEnter={() => setStackHover(true)}
        onMouseLeave={() => {
          setStackHover(false);
          setPressed(false);
        }}
        style={{
          position: "relative",
          width: "100%",
          aspectRatio: "16 / 10",
          minHeight: 210,
          marginTop: 11,
          isolation: "isolate",
        }}
      >
        {imageCount > 1 &&
          images.slice(1, 3).map((image, index) => {
            const depth = index + 1;
            return (
              <span
                key={`${image.url}-${index}`}
                aria-hidden
                style={{
                  position: "absolute",
                  inset: `${10 + depth * 8}px ${10 - index * 4}px ${2 + index * 4}px ${18 + depth * 10}px`,
                  zIndex: depth,
                  borderRadius: 17,
                  overflow: "hidden",
                  border: "1px solid var(--glass-border)",
                  background: "var(--glass-2)",
                  boxShadow: "0 18px 36px -24px rgba(20,22,45,.55)",
                  opacity: 0.9 - index * 0.18,
                  transform: `rotate(${stackHover ? 2.6 + depth * 1.7 : 1.1 + depth * 0.9}deg) translate(${stackHover ? depth * 2 : 0}px, ${stackHover ? depth * 2 : 0}px)`,
                  transition: "transform .22s ease, opacity .22s ease",
                }}
              >
                <img src={image.url} alt="" loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", filter: "saturate(.9) contrast(.96)" }} />
              </span>
            );
          })}
        <button
          type="button"
          aria-label={imageCount > 1 ? `Open ${imageCount} photos` : "Open photo"}
          onClick={(event) => openAt(activeIndex, event)}
          onMouseDown={() => setPressed(true)}
          onMouseUp={() => setPressed(false)}
          style={{
            position: "absolute",
            inset: stackInset,
            zIndex: 3,
            padding: 0,
            overflow: "hidden",
            border: "1px solid var(--glass-border)",
            borderRadius: 17,
            background: "var(--glass-2)",
            color: "inherit",
            cursor: "zoom-in",
            boxShadow: stackHover ? "0 24px 52px -28px rgba(20,22,45,.72)" : "0 16px 34px -26px rgba(20,22,45,.55)",
            transform: pressed ? "translateY(1px) scale(.992)" : stackHover ? "translateY(-2px)" : "none",
            transition: "transform .18s ease, box-shadow .18s ease, border-color .18s ease",
          }}
        >
          <img
            src={activeImage.url}
            alt=""
            loading="lazy"
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", transform: stackHover ? "scale(1.025)" : "scale(1)", transition: "transform .28s ease" }}
          />
          <span
            aria-hidden
            style={{
              position: "absolute",
              inset: 0,
              background: stackHover ? "linear-gradient(180deg, rgba(0,0,0,0) 52%, rgba(0,0,0,.34) 100%)" : "linear-gradient(180deg, rgba(0,0,0,0) 64%, rgba(0,0,0,.22) 100%)",
              transition: "background .18s ease",
            }}
          />
        </button>
        {imageCount > 1 && (
          <span
            style={{
              position: "absolute",
              right: 40,
              bottom: 36,
              zIndex: 5,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 10px",
              borderRadius: 999,
              background: "rgba(10,10,25,.58)",
              color: "#fff",
              fontSize: 12.5,
              fontWeight: 800,
              boxShadow: "0 10px 24px rgba(0,0,0,.2)",
              backdropFilter: "blur(10px)",
              WebkitBackdropFilter: "blur(10px)",
              pointerEvents: "none",
            }}
          >
            <ImageIcon size={14} />
            {imageCount}
          </span>
        )}
      </div>

      {open && (
        <div
          data-testid="photo-gallery-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Photo gallery"
          onClick={close}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 90,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 18,
            padding: "28px 18px",
            background: "rgba(6,7,13,.78)",
            backdropFilter: "blur(18px)",
            WebkitBackdropFilter: "blur(18px)",
            animation: "verity-fade .16s ease",
          }}
        >
          <div
            onClick={(event) => event.stopPropagation()}
            style={{
              position: "relative",
              width: "min(1120px, 100%)",
              height: "min(74vh, 780px)",
              minHeight: "min(360px, 68vh)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <div
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                zIndex: 5,
                display: "flex",
                alignItems: "center",
                gap: 12,
                color: "#fff",
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 800, fontSize: 14 }}>{authorName}</div>
                <div style={{ color: "rgba(255,255,255,.62)", fontSize: 12.5, marginTop: 1 }}>
                  {activeIndex + 1} of {imageCount}
                </div>
              </div>
              <button
                type="button"
                aria-label="Close photo gallery"
                onClick={close}
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: "50%",
                  border: "1px solid rgba(255,255,255,.2)",
                  background: "rgba(255,255,255,.1)",
                  color: "#fff",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "pointer",
                }}
              >
                <CloseIcon size={20} />
              </button>
            </div>

            {imageCount > 1 && (
              <button
                type="button"
                aria-label="Previous photo"
                onClick={(event) => move(-1, event)}
                style={{ ...galleryButtonStyle, left: 0 }}
              >
                <GalleryArrowGlyph dir="left" />
              </button>
            )}
            <img
              key={activeImage.url}
              src={activeImage.url}
              alt=""
              style={{
                maxWidth: "100%",
                maxHeight: "100%",
                objectFit: "contain",
                borderRadius: 18,
                boxShadow: "0 28px 90px rgba(0,0,0,.42)",
                animation: "verity-scale .18s ease",
              }}
            />
            {imageCount > 1 && (
              <button
                type="button"
                aria-label="Next photo"
                onClick={(event) => move(1, event)}
                style={{ ...galleryButtonStyle, right: 0 }}
              >
                <GalleryArrowGlyph dir="right" />
              </button>
            )}
          </div>

          {imageCount > 1 && (
            <div
              onClick={(event) => event.stopPropagation()}
              style={{
                display: "flex",
                gap: 9,
                maxWidth: "min(760px, 100%)",
                overflowX: "auto",
                padding: "7px 9px",
                borderRadius: 16,
                background: "rgba(255,255,255,.1)",
                border: "1px solid rgba(255,255,255,.13)",
                boxShadow: "0 16px 36px rgba(0,0,0,.22)",
                backdropFilter: "blur(12px)",
                WebkitBackdropFilter: "blur(12px)",
              }}
            >
              {images.map((image, index) => {
                const selected = index === activeIndex;
                return (
                  <button
                    key={`${image.url}-thumb-${index}`}
                    type="button"
                    aria-label={`Show photo ${index + 1}`}
                    aria-current={selected}
                    onClick={(event) => {
                      event.stopPropagation();
                      setActiveIndex(index);
                    }}
                    style={{
                      width: 62,
                      height: 48,
                      minWidth: 62,
                      padding: 0,
                      borderRadius: 10,
                      border: selected ? "2px solid #fff" : "1px solid rgba(255,255,255,.18)",
                      background: "rgba(255,255,255,.08)",
                      overflow: "hidden",
                      cursor: "pointer",
                      opacity: selected ? 1 : 0.62,
                      transform: selected ? "translateY(-2px)" : "none",
                      boxShadow: selected ? "0 10px 20px rgba(0,0,0,.28)" : "none",
                      transition: "opacity .15s ease, transform .15s ease, border-color .15s ease",
                    }}
                  >
                    <img src={image.url} alt="" loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </>
  );
};

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
  onOpen,
}: PostCardProps): ReactNode => {
  const { navigate, state } = useStore();
  const profile = useProfile(note.pubkey);
  const [hover, setHover] = useState(false);
  const [likePop, setLikePop] = useState(false);
  const [repostPop, setRepostPop] = useState(false);
  const [unrepostBubbleKey, setUnrepostBubbleKey] = useState(0);

  const handleLike = (): void => {
    if (!e?.liked) {
      setLikePop(true);
      setTimeout(() => setLikePop(false), 450);
    }
    onLike?.();
  };
  const handleRepost = (): void => {
    const wasReposted = Boolean(e?.reposted);
    const handled = onRepost?.();
    if (handled === false) return;
    if (wasReposted) {
      setUnrepostBubbleKey((key) => key + 1);
    } else {
      setRepostPop(true);
      setTimeout(() => setRepostPop(false), 520);
    }
  };
  const name = displayName({ name: profile?.name, displayName: profile?.displayName, pubkey: note.pubkey });
  const handle = profile?.nip05 ?? `${note.pubkey.slice(0, 8)}…${note.pubkey.slice(-4)}`;
  const verified = Boolean(profile?.nip05);
  const isMine = note.pubkey === state.identity?.pubkey;
  const { text, embeds } = parseMedia(note.content);
  const images = embeds.filter((m) => m.type === "image");
  const videos = embeds.filter((m) => m.type === "video");
  const e = engagement;
  const openPost = (): void => {
    if (onOpen) onOpen();
    else navigate("postDetail", { id: note.id });
  };
  const openAuthor = (event: MouseEvent<HTMLElement>): void => {
    event.stopPropagation();
    navigate("profile", { pubkey: note.pubkey });
  };
  const runAction = (event: MouseEvent<HTMLButtonElement>, action: (() => void) | undefined): void => {
    event.stopPropagation();
    action?.();
  };

  return (
    <article
      data-testid="feed-post"
      role="button"
      tabIndex={0}
      onClick={openPost}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openPost();
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        ...postCardStyle,
        background: hover ? "var(--glass-2)" : "var(--glass)",
        borderColor: hover ? "var(--text-3)" : "var(--glass-border)",
        cursor: "pointer",
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
              {images.length > 0 && <PhotoGallery images={images} authorName={name} />}
              {videos.map((m) => (
                <video key={m.url} src={m.url} controls style={{ maxWidth: "100%", borderRadius: 12, border: "1px solid var(--glass-border)", display: "block" }} />
              ))}
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 12, marginLeft: -6 }}>
            <button onClick={(event) => runAction(event, onReply)} style={actionStyle(false, "var(--accent)")}>
              <ReplyGlyph />
              <span>{e && e.replies > 0 ? fmtCount(e.replies) : ""}</span>
            </button>
            <button onClick={(event) => runAction(event, handleRepost)} style={actionStyle(Boolean(e?.reposted), "var(--success)")}>
              <BubblePop activeKey={unrepostBubbleKey} message="Unreposted" tone="success">
                <span style={{ display: "flex" }} className={repostPop ? "verity-pop" : undefined}><RepostGlyph /></span>
              </BubblePop>
              <span>{e && e.reposts > 0 ? fmtCount(e.reposts) : ""}</span>
            </button>
            <button onClick={(event) => runAction(event, handleLike)} style={actionStyle(Boolean(e?.liked), "var(--danger)")}>
              <span style={{ display: "flex" }} className={likePop ? "verity-pop" : undefined}><HeartGlyph fill={e?.liked ? "var(--danger)" : "none"} /></span>
              <span>{e && e.likes > 0 ? fmtCount(e.likes) : ""}</span>
            </button>
            <div style={{ flex: 1 }} />
            <button onClick={(event) => runAction(event, onBookmark)} style={actionStyle(Boolean(bookmarked), "var(--accent)")} title="Bookmark">
              <BookmarkGlyph fill={bookmarked ? "var(--accent)" : "none"} />
            </button>
            <button onClick={(event) => runAction(event, onShare)} style={actionStyle(false, "var(--accent)")} title="Share">
              <ShareGlyph />
            </button>
            {isMine && onDelete && (
              <button onClick={(event) => runAction(event, onDelete)} style={actionStyle(false, "var(--danger)")} title="Delete post" data-testid="post-delete">
                <TrashGlyph />
              </button>
            )}
          </div>
        </div>
      </div>
    </article>
  );
};
