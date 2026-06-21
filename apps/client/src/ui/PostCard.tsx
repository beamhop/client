import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import type { Event as NostrEvent } from "nostr-tools";
import type { Note } from "@beamhop/nostr";
import { useProfile, useStore } from "@beamhop/state";
import { displayName, initials, avatarStyle, timeAgo, fmtCount } from "@beamhop/lib";
import { parseMedia, type Embed } from "@beamhop/lib";
import { actionStyle, avatarWrap, statusDot, postCardStyle, navStyle } from "./styles.ts";
import { CloseIcon, HeartIcon, ImageIcon, MoreIcon, RepostIcon, ShareIcon, TrashIcon, VerifiedSeal } from "./icons.tsx";
import type { Engagement } from "@beamhop/state";
import { BubblePop } from "./BubblePop.tsx";
import { EventJsonButton } from "./EventJsonModal.tsx";
import { PostContent } from "./PostContent.tsx";

type PostCardProps = {
  note: Note;
  engagement?: Engagement;
  bookmarked?: boolean;
  pinnedLabel?: string;
  repostedBy?: string;
  repostedAt?: number;
  repostEvent?: NostrEvent;
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
const BookmarkGlyph = ({ fill }: { fill: string }): ReactNode => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill={fill} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="m19 21-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
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
                  boxShadow: "0 18px 36px -24px rgba(0,0,0,.55)",
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
            boxShadow: stackHover ? "0 24px 52px -28px rgba(0,0,0,.72)" : "0 16px 34px -26px rgba(0,0,0,.55)",
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
            animation: "beamhop-fade .16s ease",
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
                animation: "beamhop-scale .18s ease",
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

/** Duration of the shrink-and-dissolve exit; kept in sync with the `beamhop-dissolve` keyframe. */
const EXIT_MS = 420;

const confirmPopoverStyle: CSSProperties = {
  position: "absolute",
  bottom: "calc(100% + 8px)",
  right: 0,
  zIndex: 12,
  display: "flex",
  flexDirection: "column",
  gap: 9,
  padding: "11px 12px",
  borderRadius: 13,
  border: "1px solid var(--glass-border)",
  background: "var(--glass-strong)",
  boxShadow: "0 18px 44px -22px rgba(0,0,0,.6)",
  backdropFilter: "blur(12px)",
  WebkitBackdropFilter: "blur(12px)",
  animation: "beamhop-scale .14s ease",
};

const confirmButtonBase: CSSProperties = {
  padding: "6px 12px",
  borderRadius: 9,
  fontSize: 12.5,
  fontWeight: 800,
  fontFamily: "inherit",
  cursor: "pointer",
  border: "1px solid var(--glass-border)",
};

/** The canonical feed post, faithful to the design (beamhop-glass.html ~271-323). */
export const PostCard = ({
  note,
  engagement,
  bookmarked,
  pinnedLabel,
  repostedBy,
  repostedAt,
  repostEvent,
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
  const { navigate, state, toggleMuteAccount, addMuteRule, toast } = useStore();
  const profile = useProfile(note.pubkey);
  const repostProfile = useProfile(repostedBy);
  const [hover, setHover] = useState(false);
  const [likePop, setLikePop] = useState(false);
  const [repostPop, setRepostPop] = useState(false);
  const [unrepostBubbleKey, setUnrepostBubbleKey] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [exiting, setExiting] = useState(false);
  const exitActionRef = useRef<(() => void) | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  // Inline "mute a word" capture; null means the input is collapsed.
  const [wordDraft, setWordDraft] = useState<string | null>(null);
  // Floating "mute this phrase" button anchored to the live text selection.
  const contentRef = useRef<HTMLParagraphElement | null>(null);
  const [phraseSel, setPhraseSel] = useState<{ value: string; x: number; y: number } | null>(null);

  // Shrink + dissolve the card, then run the destructive action so the row
  // stays mounted for the duration of the animation before its parent drops it.
  const beginExit = (action: () => void): void => {
    exitActionRef.current = action;
    setExiting(true);
  };

  useEffect(() => {
    if (!exiting) return;
    const timer = window.setTimeout(() => exitActionRef.current?.(), EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [exiting]);

  useEffect(() => {
    if (!confirmDelete) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setConfirmDelete(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmDelete]);

  // Close the overflow menu on Escape so it behaves like the delete popover.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        setWordDraft(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  // Show the floating "Mute this phrase" button while a non-empty selection
  // lives inside this card's content element; hide it otherwise.
  useEffect(() => {
    const onSelect = (): void => {
      const el = contentRef.current;
      const selection = window.getSelection();
      const value = selection?.toString().trim() ?? "";
      if (!el || !value || !selection || selection.rangeCount === 0) {
        setPhraseSel(null);
        return;
      }
      const range = selection.getRangeAt(0);
      // Only react to selections anchored within this card's text.
      if (!el.contains(range.commonAncestorContainer)) {
        setPhraseSel(null);
        return;
      }
      // The floating button is absolutely positioned within the <article>
      // (its position:relative ancestor), so measure offsets against that box,
      // not the inset content element, or it lands shifted by the avatar column.
      const cardBox = (el.closest("article") ?? el).getBoundingClientRect();
      const selBox = range.getBoundingClientRect();
      setPhraseSel({
        value,
        x: selBox.left - cardBox.left + selBox.width / 2,
        y: selBox.top - cardBox.top,
      });
    };
    document.addEventListener("selectionchange", onSelect);
    return () => document.removeEventListener("selectionchange", onSelect);
  }, []);

  const handleLike = (): void => {
    if (!e?.liked) {
      setLikePop(true);
      setTimeout(() => setLikePop(false), 450);
    }
    onLike?.();
  };
  const handleRepost = (): void => {
    const wasReposted = Boolean(e?.reposted);
    // Unreposting a repost row gets the same exit micro-interaction as a delete.
    if (wasReposted && repostedBy !== undefined) {
      beginExit(() => onRepost?.());
      return;
    }
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
  const repostActorName = repostedBy
    ? repostedBy === state.identity?.pubkey
      ? "You"
      : displayName({ name: repostProfile?.name, displayName: repostProfile?.displayName, pubkey: repostedBy })
    : undefined;
  const repostLabel = repostActorName ? `${repostActorName} reposted` : undefined;
  const verified = Boolean(profile?.nip05);
  const isMine = note.pubkey === state.identity?.pubkey;
  const { text, embeds } = parseMedia(note.content);
  const images = embeds.filter((m) => m.type === "image");
  const videos = embeds.filter((m) => m.type === "video");
  const e = engagement;
  const openPost = (): void => {
    if (confirmDelete) {
      setConfirmDelete(false);
      return;
    }
    if (menuOpen) {
      closeMenu();
      return;
    }
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

  const authorMuted = state.muteSettings.rules.some((r) => r.type === "account" && r.pubkey === note.pubkey);
  const closeMenu = (): void => {
    setMenuOpen(false);
    setWordDraft(null);
  };
  const submitWord = (): void => {
    const value = (wordDraft ?? "").trim();
    if (!value) return;
    addMuteRule({ type: "keyword", value });
    toast("Muted word", "check");
    closeMenu();
  };
  const mutePhrase = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    const value = phraseSel?.value.trim() ?? "";
    if (!value) return;
    addMuteRule({ type: "keyword", value });
    toast("Muted phrase", "check");
    window.getSelection()?.removeAllRanges();
    setPhraseSel(null);
  };

  return (
    <article
      data-testid="feed-post"
      data-exiting={exiting || undefined}
      aria-hidden={exiting || undefined}
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
        position: "relative",
        background: hover ? "var(--glass-2)" : "var(--glass)",
        borderColor: hover ? "var(--text-3)" : "var(--glass-border)",
        cursor: "pointer",
        ...(exiting
          ? { animation: `beamhop-dissolve ${EXIT_MS}ms ease forwards`, overflow: "hidden", pointerEvents: "none" }
          : null),
      }}
    >
      {repostLabel && (
        <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12.5, fontWeight: 700, color: "var(--text-3)", marginBottom: 10, paddingLeft: 54 }}>
          <RepostIcon size={16} />
          <span>{repostLabel}</span>
          {repostedAt !== undefined && <span style={{ fontWeight: 600 }}>· {timeAgo(repostedAt)}</span>}
          <EventJsonButton
            event={repostEvent}
            label="Original repost event"
            title="View raw repost event"
            style={{ width: 24, height: 24, minWidth: 24, borderRadius: 7 }}
          />
        </div>
      )}
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
            <span onClick={openAuthor} style={{ fontSize: 13.5, color: "var(--text-3)", fontFamily: "'Geist Mono',monospace", cursor: "pointer" }}>{handle}</span>
            <span style={{ fontSize: 13.5, color: "var(--text-3)" }}>· {timeAgo(note.createdAt)}</span>
          </div>
          {text && <p ref={contentRef} style={{ margin: "7px 0 0", fontSize: 15.5, lineHeight: 1.55, color: "var(--text)", whiteSpace: "pre-wrap", overflowWrap: "anywhere", textWrap: "pretty" }}><PostContent text={text} /></p>}
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
                <span style={{ display: "flex" }} className={repostPop ? "beamhop-pop" : undefined}><RepostIcon size={16} /></span>
              </BubblePop>
              <span>{e && e.reposts > 0 ? fmtCount(e.reposts) : ""}</span>
            </button>
            <button onClick={(event) => runAction(event, handleLike)} style={actionStyle(Boolean(e?.liked), "var(--danger)")}>
              <span style={{ display: "flex" }} className={likePop ? "beamhop-pop" : undefined}><HeartIcon size={16} filled={Boolean(e?.liked)} /></span>
              <span>{e && e.likes > 0 ? fmtCount(e.likes) : ""}</span>
            </button>
            <div style={{ flex: 1 }} />
            <button onClick={(event) => runAction(event, onBookmark)} style={actionStyle(Boolean(bookmarked), "var(--accent)")} title="Bookmark">
              <BookmarkGlyph fill={bookmarked ? "var(--accent)" : "none"} />
            </button>
            <button onClick={(event) => runAction(event, onShare)} style={actionStyle(false, "var(--accent)")} title="Share">
              <ShareIcon size={16} />
            </button>
            <EventJsonButton event={note.event} label="Original post event" style={actionStyle(false, "var(--accent)")} />
            {isMine && onDelete && (
              <span style={{ position: "relative", display: "inline-flex" }}>
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    setConfirmDelete((open) => !open);
                  }}
                  style={actionStyle(confirmDelete, "var(--danger)")}
                  title="Delete post"
                  data-testid="post-delete"
                >
                  <TrashIcon size={16} />
                </button>
                {confirmDelete && (
                  <span
                    role="dialog"
                    aria-label="Delete this post?"
                    onClick={(event) => event.stopPropagation()}
                    style={confirmPopoverStyle}
                  >
                    <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text)", whiteSpace: "nowrap" }}>Delete this post?</span>
                    <span style={{ display: "flex", gap: 6 }}>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          setConfirmDelete(false);
                        }}
                        style={{ ...confirmButtonBase, background: "transparent", color: "var(--text-2)" }}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        data-testid="post-delete-confirm"
                        onClick={(event) => {
                          event.stopPropagation();
                          setConfirmDelete(false);
                          beginExit(() => onDelete?.());
                        }}
                        style={{ ...confirmButtonBase, background: "var(--danger)", color: "#fff", borderColor: "var(--danger)" }}
                      >
                        Delete
                      </button>
                    </span>
                  </span>
                )}
              </span>
            )}
            <span style={{ position: "relative", display: "inline-flex" }}>
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  setMenuOpen((open) => !open);
                  setWordDraft(null);
                }}
                style={actionStyle(menuOpen, "var(--accent)")}
                title="More"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                data-testid="post-more"
              >
                <MoreIcon size={17} />
              </button>
              {menuOpen && (
                <span
                  role="menu"
                  aria-label="Post options"
                  onClick={(event) => event.stopPropagation()}
                  style={{ ...confirmPopoverStyle, minWidth: 184, padding: 6, gap: 2 }}
                >
                  {!isMine && (
                    <button
                      type="button"
                      role="menuitem"
                      data-testid="post-mute-author"
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleMuteAccount(note.pubkey);
                        closeMenu();
                      }}
                      style={navStyle(false)}
                    >
                      {authorMuted ? "Unmute author" : "Mute author"}
                    </button>
                  )}
                  {wordDraft === null ? (
                    <button
                      type="button"
                      role="menuitem"
                      data-testid="post-mute-word"
                      onClick={(event) => {
                        event.stopPropagation();
                        setWordDraft("");
                      }}
                      style={navStyle(false)}
                    >
                      Mute a word…
                    </button>
                  ) : (
                    <span style={{ display: "flex", gap: 6, padding: "4px 4px 2px" }}>
                      <input
                        autoFocus
                        value={wordDraft}
                        placeholder="word to mute"
                        data-testid="post-mute-word-input"
                        onChange={(event) => setWordDraft(event.target.value)}
                        onKeyDown={(event) => {
                          event.stopPropagation();
                          if (event.key === "Enter") {
                            event.preventDefault();
                            submitWord();
                          } else if (event.key === "Escape") {
                            setWordDraft(null);
                          }
                        }}
                        style={{
                          flex: 1,
                          minWidth: 0,
                          padding: "7px 10px",
                          borderRadius: 9,
                          border: "1px solid var(--glass-border)",
                          background: "var(--glass)",
                          color: "var(--text)",
                          fontSize: 13,
                          fontFamily: "inherit",
                          outline: "none",
                        }}
                      />
                      <button
                        type="button"
                        data-testid="post-mute-word-submit"
                        onClick={(event) => {
                          event.stopPropagation();
                          submitWord();
                        }}
                        style={{ ...confirmButtonBase, background: "var(--accent)", color: "var(--on-accent)", borderColor: "var(--accent)" }}
                      >
                        Mute
                      </button>
                    </span>
                  )}
                </span>
              )}
            </span>
          </div>
        </div>
      </div>
      {phraseSel && (
        <button
          type="button"
          data-testid="post-mute-phrase"
          onClick={mutePhrase}
          style={{
            position: "absolute",
            left: phraseSel.x,
            top: phraseSel.y,
            transform: "translate(-50%, calc(-100% - 8px))",
            zIndex: 12,
            whiteSpace: "nowrap",
            padding: "6px 12px",
            borderRadius: 9,
            border: "1px solid var(--glass-border)",
            background: "var(--glass-strong)",
            color: "var(--text)",
            fontSize: 12.5,
            fontWeight: 800,
            fontFamily: "inherit",
            cursor: "pointer",
            boxShadow: "0 18px 44px -22px rgba(0,0,0,.6)",
            backdropFilter: "blur(12px)",
            WebkitBackdropFilter: "blur(12px)",
            animation: "beamhop-scale .14s ease",
          }}
        >
          Mute this phrase
        </button>
      )}
    </article>
  );
};
