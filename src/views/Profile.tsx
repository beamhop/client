import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useStore, useProfile } from "../state/store.tsx";
import { useEngagement, type Engagement } from "../state/hooks.ts";
import { Kind, type LongForm, type Note, type Profile } from "../nostr/types.ts";
import {
  decodeNote,
  decodeLongForm,
  buildProfile,
  buildReaction,
  buildRepost,
} from "../nostr/events.ts";
import { nowSeconds } from "../nostr/client.ts";
import { npubOf, shortNpub } from "../nostr/keys.ts";
import { paletteBanner } from "../lib/theme.ts";
import { parseMedia } from "../lib/media.ts";
import { countWords, readingMinutes } from "../lib/markdown.ts";
import { timeAgo, displayName, avatarStyle, initials, fmtCount } from "../lib/format.ts";
import { Modal, Spinner, EmptyState } from "../ui/primitives.tsx";
import { PostCard } from "../ui/PostCard.tsx";
import { followStyle, profileTabStyle, statusDot } from "../ui/styles.ts";
import { VerifiedSeal } from "../ui/icons.tsx";
import { Compose } from "../ui/Compose.tsx";

type TabId = "posts" | "articles" | "replies" | "media";

// ---------------------------------------------------------------------------
// small inline SVGs from the design (kept local — not part of the shared set)
// ---------------------------------------------------------------------------

const PencilIcon = ({ size = 15, stroke = 2 }: { size?: number; stroke?: number }): ReactNode => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
  </svg>
);

const CheckMini = (): ReactNode => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="m5 13 4 4L19 7" />
  </svg>
);

const KeyLinkIcon = (): ReactNode => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="9" cy="9" r="3" />
    <path d="M12 9h9M17 6l3 3-3 3" />
  </svg>
);

const CopyMini = (): ReactNode => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </svg>
);

const ChainIcon = (): ReactNode => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 17H7a4 4 0 0 1 0-8h2M15 7h2a4 4 0 0 1 0 8h-2" />
  </svg>
);

const CloseX = (): ReactNode => (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);

const CameraIcon = (): ReactNode => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3l2-3h8l2 3h3a2 2 0 0 1 2 2z" />
    <circle cx="12" cy="13" r="3.5" />
  </svg>
);

const UploadIcon = (): ReactNode => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="M17 8l-5-5-5 5M12 3v12" />
  </svg>
);

const BookIcon = (): ReactNode => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2zM22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
  </svg>
);

const TrashMini = (): ReactNode => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
  </svg>
);

// ---------------------------------------------------------------------------
// Edit-profile modal
// ---------------------------------------------------------------------------

const fieldLabel: CSSProperties = {
  display: "block",
  fontSize: 12.5,
  fontWeight: 700,
  color: "var(--text-2)",
  marginBottom: 6,
};

const fieldInput: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  border: "1px solid var(--glass-border)",
  borderRadius: 9,
  background: "var(--glass-2)",
  padding: "11px 14px",
  outline: "none",
  fontSize: 14.5,
  color: "var(--text)",
  fontFamily: "inherit",
};

const hiddenFileInput: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  opacity: 0,
  pointerEvents: "none",
};

const EditProfileModal = ({
  me,
  pubkey,
  onClose,
}: {
  me: Profile;
  pubkey: string;
  onClose: () => void;
}): ReactNode => {
  const { publish, setMe, toast } = useStore();
  const [name, setName] = useState(me.displayName ?? me.name ?? "");
  const [about, setAbout] = useState(me.about ?? "");
  const [picture, setPicture] = useState(me.picture ?? "");
  const [banner, setBanner] = useState(me.banner ?? "");
  const [nip05, setNip05] = useState(me.nip05 ?? "");
  const [website, setWebsite] = useState(me.website ?? "");
  const [busy, setBusy] = useState(false);

  const meName = displayName({ name: me.name, displayName: me.displayName, pubkey });

  // Read a chosen image into a data URL (the design's local-preview path). Real
  // Nostr would upload to a media host; a Picture URL field is offered alongside.
  const onAvatarFile = useCallback(
    (file: File | undefined): void => {
      if (!file) return;
      if (!file.type.startsWith("image/")) {
        toast("Please choose an image file", "info");
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === "string") setPicture(reader.result);
      };
      reader.readAsDataURL(file);
    },
    [toast],
  );

  const removeAvatar = useCallback((): void => {
    setPicture("");
    toast("Reverted to default avatar", "info");
  }, [toast]);

  const save = async (): Promise<void> => {
    setBusy(true);
    const updated: Omit<Profile, "pubkey"> = {
      name: name.trim() || undefined,
      displayName: name.trim() || undefined,
      about: about.trim() || undefined,
      picture: picture.trim() || undefined,
      banner: banner.trim() || undefined,
      nip05: nip05.trim() || undefined,
      website: website.trim() || undefined,
    };
    try {
      await publish(buildProfile(updated));
      setMe({ ...updated, pubkey });
      toast("Profile published to relays", "check");
      onClose();
    } catch {
      toast("Could not publish profile — check your relays", "warn");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} width={520}>
      {/* header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "16px 20px",
          borderBottom: "1px solid var(--hairline)",
        }}
      >
        <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 17 }}>
          Edit profile
        </span>
        <button
          type="button"
          data-testid="edit-close"
          onClick={onClose}
          aria-label="Close"
          style={{
            display: "flex",
            padding: 7,
            border: "none",
            borderRadius: 10,
            background: "transparent",
            color: "var(--text-2)",
            cursor: "pointer",
          }}
        >
          <CloseX />
        </button>
      </div>

      {/* body */}
      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
        {/* avatar uploader */}
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <label
            data-testid="edit-avatar-upload"
            title="Upload a photo"
            style={{ position: "relative", flexShrink: 0, cursor: "pointer", display: "block" }}
          >
            <input
              type="file"
              accept="image/*"
              onChange={(e) => onAvatarFile(e.target.files?.[0])}
              style={hiddenFileInput}
            />
            <span style={{ ...avatarStyle(pubkey, 72, picture || undefined), borderRadius: 20 }}>
              {!picture && initials(meName)}
            </span>
            <span
              style={{
                position: "absolute",
                right: -3,
                bottom: -3,
                width: 24,
                height: 24,
                borderRadius: 8,
                background: "var(--accent)",
                border: "2.5px solid var(--glass-strong)",
                boxSizing: "border-box",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <CameraIcon />
            </span>
          </label>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <label
                data-testid="edit-avatar-button"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "8px 13px",
                  border: "1px solid var(--glass-border)",
                  borderRadius: 9,
                  background: "var(--glass-2)",
                  color: "var(--text)",
                  fontWeight: 700,
                  fontSize: 12.5,
                  cursor: "pointer",
                  transition: "background .15s",
                }}
              >
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => onAvatarFile(e.target.files?.[0])}
                  style={hiddenFileInput}
                />
                <UploadIcon />
                Upload photo
              </label>
              {picture && (
                <button
                  type="button"
                  data-testid="edit-avatar-remove"
                  onClick={removeAvatar}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "8px 13px",
                    border: "1px solid var(--glass-border)",
                    borderRadius: 9,
                    background: "transparent",
                    color: "var(--text-2)",
                    fontWeight: 700,
                    fontSize: 12.5,
                    fontFamily: "inherit",
                    cursor: "pointer",
                    transition: "background .15s",
                  }}
                >
                  Remove
                </button>
              )}
            </div>
            <div style={{ fontSize: 11.5, color: "var(--text-3)", lineHeight: 1.5, marginTop: 7 }}>
              PNG or JPG. Defaults to your generated identity avatar.
            </div>
          </div>
        </div>

        {/* picture URL (real-Nostr field — the host-uploaded image URL) */}
        <label style={{ display: "block" }}>
          <span style={fieldLabel}>Picture URL</span>
          <input
            value={picture}
            onChange={(e) => setPicture(e.target.value)}
            placeholder="https://…"
            style={fieldInput}
          />
        </label>

        {/* display name */}
        <label style={{ display: "block" }}>
          <span style={fieldLabel}>Display name</span>
          <input
            data-testid="edit-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={fieldInput}
          />
        </label>

        {/* NIP-05 (replaces the design's "Role") */}
        <label style={{ display: "block" }}>
          <span style={fieldLabel}>NIP-05 identifier</span>
          <input
            value={nip05}
            onChange={(e) => setNip05(e.target.value)}
            placeholder="you@domain.com"
            style={fieldInput}
          />
        </label>

        {/* website (the secondary identity line) */}
        <label style={{ display: "block" }}>
          <span style={fieldLabel}>Website</span>
          <input
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            placeholder="https://…"
            style={fieldInput}
          />
        </label>

        {/* banner URL */}
        <label style={{ display: "block" }}>
          <span style={fieldLabel}>Banner URL</span>
          <input
            value={banner}
            onChange={(e) => setBanner(e.target.value)}
            placeholder="https://…"
            style={fieldInput}
          />
        </label>

        {/* bio */}
        <label style={{ display: "block" }}>
          <span style={fieldLabel}>Bio</span>
          <textarea
            data-testid="edit-bio"
            value={about}
            onChange={(e) => setAbout(e.target.value)}
            style={{ ...fieldInput, resize: "none", minHeight: 92, lineHeight: 1.5 }}
          />
        </label>
      </div>

      {/* footer */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: 10,
          padding: "14px 20px",
          borderTop: "1px solid var(--hairline)",
        }}
      >
        <button
          type="button"
          data-testid="edit-cancel"
          onClick={onClose}
          style={{
            padding: "10px 18px",
            border: "1px solid var(--glass-border)",
            borderRadius: 9,
            background: "transparent",
            color: "var(--text)",
            fontWeight: 700,
            fontSize: 13.5,
            fontFamily: "inherit",
            cursor: "pointer",
            transition: "all .15s",
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          data-testid="edit-save"
          onClick={() => void save()}
          disabled={busy}
          style={{
            padding: "10px 20px",
            border: "1px solid rgba(255,255,255,.3)",
            borderRadius: 9,
            background: "var(--accent)",
            color: "var(--on-accent)",
            fontWeight: 700,
            fontSize: 13.5,
            fontFamily: "inherit",
            cursor: busy ? "not-allowed" : "pointer",
            opacity: busy ? 0.6 : 1,
            transition: "all .15s",
          }}
        >
          {busy ? "Publishing…" : "Save & publish"}
        </button>
      </div>
    </Modal>
  );
};

// ---------------------------------------------------------------------------
// Article card (kind-30023)
// ---------------------------------------------------------------------------

const ArticleCard = ({
  article,
  authorName,
  authorPubkey,
  authorPicture,
  isMine,
  onOpen,
  onDelete,
}: {
  article: LongForm;
  authorName: string;
  authorPubkey: string;
  authorPicture?: string;
  isMine: boolean;
  onOpen: () => void;
  onDelete: () => void;
}): ReactNode => {
  const mins = readingMinutes(countWords(article.body));
  return (
    <div
      data-testid="article-card"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onOpen();
      }}
      style={{
        display: "flex",
        gap: 16,
        alignItems: "stretch",
        textAlign: "left",
        width: "100%",
        padding: 15,
        border: "1px solid var(--glass-border)",
        borderRadius: 14,
        background: "var(--glass)",
        cursor: "pointer",
        transition: "border-color .15s, background .15s",
        fontFamily: "inherit",
      }}
    >
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 8 }}>
          <span style={avatarStyle(authorPubkey, 24, authorPicture)}>
            {!authorPicture && initials(authorName)}
          </span>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-2)" }}>{authorName}</span>
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
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <BookIcon /> {mins} min read
          </span>
          <div style={{ flex: 1 }} />
          {isMine && (
            <button
              type="button"
              data-testid="article-delete"
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                border: "none",
                background: "transparent",
                color: "var(--text-3)",
                fontSize: 12.5,
                fontWeight: 600,
                fontFamily: "inherit",
                cursor: "pointer",
              }}
            >
              <TrashMini /> Delete
            </button>
          )}
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

// ---------------------------------------------------------------------------
// Profile view
// ---------------------------------------------------------------------------

export const ProfileView = (): ReactNode => {
  const { state, client, readRelayUrls, publish, toggleFollow, toast, navigate } = useStore();
  const myPubkey = state.identity?.pubkey;
  const paramPubkey = state.nav.params.pubkey;
  const pubkey = paramPubkey ?? myPubkey;
  const isMe = pubkey !== undefined && pubkey === myPubkey;

  const otherProfile = useProfile(isMe ? undefined : pubkey);
  const profile: Profile | null = isMe ? state.me : otherProfile;

  const [tab, setTab] = useState<TabId>("posts");
  const [notes, setNotes] = useState<Note[]>([]);
  const [articles, setArticles] = useState<LongForm[]>([]);
  const [followers, setFollowers] = useState<number | null>(null);
  const [theirFollowing, setTheirFollowing] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [replyTarget, setReplyTarget] = useState<Note | null>(null);
  const [optimistic, setOptimistic] = useState<Record<string, Partial<Engagement>>>({});
  const [deleted, setDeleted] = useState<Set<string>>(new Set());

  // ---- notes (kind 1) ----
  useEffect(() => {
    if (!pubkey || readRelayUrls.length === 0) return;
    let cancelled = false;
    setLoading(true);
    setNotes([]);
    void (async () => {
      const events = await client.list(readRelayUrls, {
        kinds: [Kind.Note],
        authors: [pubkey],
        limit: 60,
      });
      if (cancelled) return;
      setNotes(events.map(decodeNote));
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [pubkey, readRelayUrls, client]);

  // ---- articles (kind 30023) ----
  useEffect(() => {
    if (!pubkey || readRelayUrls.length === 0) return;
    let cancelled = false;
    void (async () => {
      const events = await client.list(readRelayUrls, {
        kinds: [Kind.LongForm],
        authors: [pubkey],
        limit: 30,
      });
      if (cancelled) return;
      setArticles(events.map(decodeLongForm).filter((a) => a.kind === "article"));
    })();
    return () => {
      cancelled = true;
    };
  }, [pubkey, readRelayUrls, client]);

  // ---- followers (distinct authors of kind-3 lists referencing this user) ----
  useEffect(() => {
    if (!pubkey || readRelayUrls.length === 0) return;
    let cancelled = false;
    setFollowers(null);
    void (async () => {
      const events = await client.list(readRelayUrls, {
        kinds: [Kind.Contacts],
        "#p": [pubkey],
        limit: 500,
      });
      if (cancelled) return;
      setFollowers(new Set(events.map((e) => e.pubkey)).size);
    })();
    return () => {
      cancelled = true;
    };
  }, [pubkey, readRelayUrls, client]);

  // ---- another user's following count (their own kind-3 p-tags) ----
  useEffect(() => {
    if (!pubkey || isMe || readRelayUrls.length === 0) {
      setTheirFollowing(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const event = await client.get(readRelayUrls, {
        kinds: [Kind.Contacts],
        authors: [pubkey],
      });
      if (cancelled) return;
      const count = event ? event.tags.filter((t) => t[0] === "p" && t[1]).length : 0;
      setTheirFollowing(count);
    })();
    return () => {
      cancelled = true;
    };
  }, [pubkey, isMe, readRelayUrls, client]);

  const live = useMemo(() => notes.filter((n) => !deleted.has(n.id)), [notes, deleted]);
  const posts = useMemo(() => live.filter((n) => n.replyTo === undefined), [live]);
  const replies = useMemo(() => live.filter((n) => n.replyTo !== undefined), [live]);
  const mediaTiles = useMemo(
    () =>
      live.flatMap((n) =>
        parseMedia(n.content).embeds.map((m) => ({ note: n, url: m.url, type: m.type })),
      ),
    [live],
  );

  // engagement for whichever notes can be on screen
  const visibleIds = useMemo(() => {
    const base = isMe ? (tab === "replies" ? replies : posts) : posts;
    return base.map((n) => n.id);
  }, [isMe, tab, posts, replies]);
  const engagement = useEngagement(visibleIds, optimistic);

  // ---- per-note actions ----
  const like = useCallback(
    (note: Note): void => {
      const cur = engagement.get(note.id);
      if (cur?.liked) return;
      setOptimistic((o) => ({
        ...o,
        [note.id]: { ...o[note.id], liked: true, likes: (cur?.likes ?? 0) + 1 },
      }));
      void publish(buildReaction(note, "+")).then(() => toast("Liked", "check"));
    },
    [engagement, publish, toast],
  );

  const repost = useCallback(
    (note: Note): void => {
      const cur = engagement.get(note.id);
      if (cur?.reposted) return;
      setOptimistic((o) => ({
        ...o,
        [note.id]: { ...o[note.id], reposted: true, reposts: (cur?.reposts ?? 0) + 1 },
      }));
      void publish(buildRepost(note)).then(() => toast("Reposted to your followers", "repost"));
    },
    [engagement, publish, toast],
  );

  const remove = useCallback(
    (note: Note): void => {
      setDeleted((d) => new Set(d).add(note.id));
      // NIP-09 deletion request (kind 5).
      void publish({
        kind: 5,
        created_at: nowSeconds(),
        tags: [["e", note.id]],
        content: "",
      }).then(
        () => toast("Post deleted", "info"),
        () => toast("Could not delete post", "warn"),
      );
    },
    [publish, toast],
  );

  const share = useCallback(
    (note: Note): void => {
      void navigator.clipboard
        .writeText(npubOf(note.pubkey))
        .then(() => toast("Link copied to clipboard", "copy"));
    },
    [toast],
  );

  const copyNpub = useCallback((): void => {
    if (!pubkey) return;
    void navigator.clipboard
      .writeText(npubOf(pubkey))
      .then(() => toast("npub copied to clipboard", "copy"));
  }, [pubkey, toast]);

  if (!pubkey) {
    return (
      <div style={{ maxWidth: 640, margin: "0 auto", padding: "40px 22px" }}>
        <EmptyState title="No profile" hint="Sign in to view your profile." />
      </div>
    );
  }

  const name = displayName({ name: profile?.name, displayName: profile?.displayName, pubkey });
  const banner = profile?.banner;
  const handle = profile?.nip05?.replace(/^_@/, "");
  const following = state.contacts.includes(pubkey);
  const followingCount = isMe ? state.contacts.length : theirFollowing;

  const renderNoteCard = (note: Note): ReactNode => {
    const e = engagement.get(note.id);
    return (
      <PostCard
        key={note.id}
        note={note}
        engagement={e}
        bookmarked={state.bookmarks.includes(note.id)}
        onReply={() => setReplyTarget(note)}
        onRepost={() => repost(note)}
        onLike={() => like(note)}
        onBookmark={() => {}}
        onShare={() => share(note)}
        onDelete={() => remove(note)}
      />
    );
  };

  return (
    <div style={{ padding: "0 0 120px" }}>
      {/* banner */}
      <div
        data-testid="profile-banner"
        style={{
          height: 168,
          background: banner
            ? `center/cover no-repeat url("${banner}")`
            : paletteBanner(state.palette),
        }}
      />

      <div style={{ maxWidth: 640, margin: "0 auto", padding: "0 22px" }}>
        {/* avatar + action */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            marginTop: -52,
          }}
        >
          <span
            data-testid="profile-avatar"
            style={{
              ...avatarStyle(pubkey, 104, profile?.picture),
              position: "relative",
              border: "4px solid var(--bg-base)",
              boxShadow: "var(--glass-shadow)",
            }}
          >
            {!profile?.picture && initials(name)}
            <span style={statusDot(false, true)} />
          </span>

          {isMe ? (
            <button
              type="button"
              data-testid="edit-profile-button"
              onClick={() => setEditing(true)}
              style={{
                alignSelf: "flex-start",
                marginTop: 60,
                whiteSpace: "nowrap",
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 16px",
                border: "1px solid var(--glass-border)",
                borderRadius: 8,
                background: "var(--glass)",
                color: "var(--text)",
                fontWeight: 700,
                fontSize: 13,
                fontFamily: "inherit",
                cursor: "pointer",
                transition: "background .15s, transform .12s",
              }}
            >
              <PencilIcon size={15} stroke={2} />
              Edit profile
            </button>
          ) : (
            <div style={{ alignSelf: "flex-start", marginTop: 60 }}>
              <button
                type="button"
                data-testid="profile-follow"
                onClick={() => void toggleFollow(pubkey)}
                style={followStyle(following)}
              >
                {following ? "Following" : "Follow"}
              </button>
            </div>
          )}
        </div>

        {/* identity */}
        <div style={{ marginTop: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <h2
              style={{
                margin: 0,
                fontFamily: "'Space Grotesk',sans-serif",
                fontSize: 24,
                fontWeight: 700,
                letterSpacing: "-.02em",
              }}
            >
              {name}
            </h2>
            {profile?.nip05 && <VerifiedSeal size={20} />}
          </div>

          {handle && (
            <div
              style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 5, flexWrap: "wrap" }}
            >
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  fontSize: 13.5,
                  color: "var(--success)",
                  fontWeight: 600,
                  background: "var(--success-soft)",
                  padding: "3px 9px",
                  borderRadius: 8,
                }}
              >
                <CheckMini />
                {handle}
              </span>
            </div>
          )}

          {profile?.about && (
            <p
              style={{
                margin: "14px 0 0",
                fontSize: 15,
                lineHeight: 1.55,
                color: "var(--text)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                textWrap: "pretty",
              }}
            >
              {profile.about}
            </p>
          )}

          {profile?.website && (
            <p style={{ margin: "8px 0 0", fontSize: 13.5, color: "var(--text-2)" }}>
              <a
                href={/^https?:\/\//.test(profile.website) ? profile.website : `https://${profile.website}`}
                target="_blank"
                rel="noreferrer"
                style={{ color: "var(--accent)", textDecoration: "none", wordBreak: "break-word" }}
              >
                {profile.website}
              </a>
            </p>
          )}

          {/* stats — Following · Followers · Posts */}
          <div style={{ display: "flex", gap: 22, marginTop: 16, flexWrap: "wrap" }}>
            <span style={{ fontSize: 14, color: "var(--text-2)" }}>
              <strong style={{ color: "var(--text)", fontSize: 16, fontFamily: "'Space Grotesk',sans-serif" }}>
                {followingCount === null ? "—" : fmtCount(followingCount)}
              </strong>{" "}
              Following
            </span>
            <span style={{ fontSize: 14, color: "var(--text-2)" }}>
              <strong style={{ color: "var(--text)", fontSize: 16, fontFamily: "'Space Grotesk',sans-serif" }}>
                {followers === null ? "—" : fmtCount(followers)}
              </strong>{" "}
              Followers
            </span>
            <span style={{ fontSize: 14, color: "var(--text-2)" }}>
              <strong style={{ color: "var(--text)", fontSize: 16, fontFamily: "'Space Grotesk',sans-serif" }}>
                {fmtCount(posts.length)}
              </strong>{" "}
              Posts
            </span>
          </div>

          {/* npub copy (me only) */}
          {isMe && (
            <button
              type="button"
              data-testid="profile-npub-copy"
              onClick={copyNpub}
              title={npubOf(pubkey)}
              style={{
                marginTop: 16,
                display: "flex",
                alignItems: "center",
                gap: 10,
                width: "100%",
                padding: "11px 14px",
                border: "1px solid var(--glass-border)",
                borderRadius: 9,
                background: "var(--glass)",
                boxShadow: "var(--glass-shadow)",
                cursor: "pointer",
                transition: "all .18s",
              }}
            >
              <KeyLinkIcon />
              <span
                style={{
                  flex: 1,
                  textAlign: "left",
                  fontFamily: "'JetBrains Mono',monospace",
                  fontSize: 12.5,
                  color: "var(--text-2)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {shortNpub(pubkey)}
              </span>
              <CopyMini />
            </button>
          )}
        </div>

        {/* tabs (me only) */}
        {isMe && (
          <div
            role="tablist"
            style={{
              display: "flex",
              gap: 24,
              marginTop: 22,
              borderBottom: "1px solid var(--hairline)",
            }}
          >
            <button type="button" data-testid="profile-tab-posts" onClick={() => setTab("posts")} style={profileTabStyle(tab === "posts")}>
              Posts
            </button>
            <button type="button" data-testid="profile-tab-articles" onClick={() => setTab("articles")} style={profileTabStyle(tab === "articles")}>
              Articles
            </button>
            <button type="button" data-testid="profile-tab-replies" onClick={() => setTab("replies")} style={profileTabStyle(tab === "replies")}>
              Replies
            </button>
            <button type="button" data-testid="profile-tab-media" onClick={() => setTab("media")} style={profileTabStyle(tab === "media")}>
              Media
            </button>
          </div>
        )}

        {/* panels */}
        {loading && notes.length === 0 ? (
          <div style={{ display: "flex", justifyContent: "center", padding: "48px 0" }}>
            <Spinner size={24} />
          </div>
        ) : !isMe ? (
          /* other-user panel: single list */
          <div
            data-testid="profile-panel-other"
            style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 14, animation: "fadeIn .2s ease" }}
          >
            {posts.length === 0 ? (
              <div
                style={{
                  padding: 30,
                  textAlign: "center",
                  color: "var(--text-3)",
                  fontSize: 14,
                  border: "1px dashed var(--glass-border)",
                  borderRadius: 12,
                }}
              >
                No posts from {name} yet.
              </div>
            ) : (
              posts.map(renderNoteCard)
            )}
          </div>
        ) : tab === "posts" ? (
          <div
            data-testid="profile-panel-posts"
            style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 14, animation: "fadeIn .2s ease" }}
          >
            {posts.length === 0 ? (
              <EmptyState title="No posts yet" hint="Share something — it'll show up here." />
            ) : (
              posts.map(renderNoteCard)
            )}
          </div>
        ) : tab === "articles" ? (
          <div data-testid="profile-panel-articles" style={{ marginTop: 16, animation: "fadeIn .2s ease" }}>
            <button
              type="button"
              data-testid="profile-new-article"
              onClick={() => navigate("articleEditor")}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 9,
                width: "100%",
                padding: 14,
                marginBottom: 14,
                border: "1px dashed var(--glass-border)",
                borderRadius: 13,
                background: "transparent",
                color: "var(--text-2)",
                fontWeight: 700,
                fontSize: 14,
                fontFamily: "inherit",
                cursor: "pointer",
                transition: "all .15s",
              }}
            >
              <PencilIcon size={18} stroke={2.2} />
              Write a new article
            </button>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {articles.map((a) => (
                <ArticleCard
                  key={a.id}
                  article={a}
                  authorName={name}
                  authorPubkey={pubkey}
                  authorPicture={profile?.picture}
                  isMine={isMe}
                  onOpen={() => navigate("articleReader", { pubkey, identifier: a.identifier })}
                  onDelete={() =>
                    void publish({
                      kind: 5,
                      created_at: nowSeconds(),
                      tags: [["e", a.id]],
                      content: "",
                    }).then(
                      () => {
                        setArticles((list) => list.filter((x) => x.id !== a.id));
                        toast("Article deleted", "info");
                      },
                      () => toast("Could not delete article", "warn"),
                    )
                  }
                />
              ))}
            </div>
          </div>
        ) : tab === "replies" ? (
          <div
            data-testid="profile-panel-replies"
            style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 14, animation: "fadeIn .2s ease" }}
          >
            {replies.length === 0 ? (
              <EmptyState title="No replies yet" hint="Your replies will show up here." />
            ) : (
              replies.map((note) => (
                <article
                  key={note.id}
                  data-testid="profile-reply"
                  style={{
                    background: "var(--glass)",
                    border: "1px solid var(--glass-border)",
                    borderRadius: 12,
                    padding: 16,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      fontSize: 12.5,
                      color: "var(--text-3)",
                      marginBottom: 10,
                    }}
                  >
                    <ChainIcon />
                    Replying to{" "}
                    <span
                      style={{
                        color: "var(--accent)",
                        fontWeight: 600,
                        fontFamily: "'JetBrains Mono',monospace",
                      }}
                    >
                      {note.replyTo ? `${note.replyTo.slice(0, 10)}…` : "a note"}
                    </span>
                  </div>
                  {renderNoteCard(note)}
                </article>
              ))
            )}
          </div>
        ) : (
          /* media */
          <div
            data-testid="profile-panel-media"
            style={{
              marginTop: 16,
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 12,
              animation: "fadeIn .2s ease",
            }}
          >
            {mediaTiles.length === 0 ? (
              <div style={{ gridColumn: "1 / -1" }}>
                <EmptyState title="No media yet" hint="Posts with images or video appear here." />
              </div>
            ) : (
              mediaTiles.map(({ note, url, type }) => {
                const label = url.split(/[?#]/)[0]?.split("/").pop() || timeAgo(note.createdAt);
                return (
                  <button
                    key={`${note.id}:${url}`}
                    type="button"
                    data-testid="profile-media-tile"
                    onClick={() => navigate("profile", { pubkey })}
                    style={{
                      aspectRatio: "1 / 1",
                      border: "none",
                      borderRadius: 12,
                      cursor: "pointer",
                      background:
                        type === "image"
                          ? `center/cover no-repeat url("${url}")`
                          : "var(--glass-2)",
                      display: "flex",
                      alignItems: "flex-end",
                      padding: 10,
                      overflow: "hidden",
                    }}
                  >
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: "#fff",
                        background: "rgba(0,0,0,.3)",
                        padding: "5px 9px",
                        borderRadius: 7,
                        maxWidth: "100%",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {label}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>

      {editing && isMe && (
        <EditProfileModal me={profile ?? { pubkey }} pubkey={pubkey} onClose={() => setEditing(false)} />
      )}
      {replyTarget && <Compose replyTo={replyTarget} onClose={() => setReplyTarget(null)} />}
    </div>
  );
};
