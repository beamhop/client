import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useStore, useProfile } from "../state/store.tsx";
import { Kind, type Note, type Profile } from "../nostr/types.ts";
import { decodeNote, buildProfile } from "../nostr/events.ts";
import { npubOf, shortNpub } from "../nostr/keys.ts";
import { paletteBanner } from "../lib/theme.ts";
import { timeAgo, displayName, avatarStyle, initials, fmtCount } from "../lib/format.ts";
import { glass, Spinner, EmptyState, Modal } from "../ui/primitives.tsx";
import { VerifiedSeal, CopyIcon, ProfileIcon, CloseIcon } from "../ui/icons.tsx";

const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif)(\?[^\s]*)?$/i;
const VIDEO_RE = /\.(mp4|webm|mov)(\?[^\s]*)?$/i;
const URL_RE = /(https?:\/\/[^\s]+)/g;

type Split = { body: ReactNode; embeds: string[] };

/** Linkify URLs, strip media URLs out into the embeds list. */
const renderContent = (content: string): Split => {
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
      continue;
    }
    parts.push(
      <a
        key={`l${key++}`}
        href={url}
        target="_blank"
        rel="noreferrer"
        style={{ color: "var(--accent)", textDecoration: "none", wordBreak: "break-word" }}
      >
        {url}
      </a>,
    );
  }
  if (last < content.length) parts.push(content.slice(last));
  return { body: parts, embeds };
};

const hasMedia = (content: string): boolean => {
  for (const match of content.matchAll(URL_RE)) {
    if (IMAGE_RE.test(match[0]) || VIDEO_RE.test(match[0])) return true;
  }
  return false;
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

type TabId = "posts" | "replies" | "media";

const PostCard = ({ note, profile }: { note: Note; profile: Profile | null }): ReactNode => {
  const { body, embeds } = useMemo(() => renderContent(note.content), [note.content]);
  const name = displayName({ name: profile?.name, displayName: profile?.displayName, pubkey: note.pubkey });
  return (
    <article style={{ ...glass, borderRadius: 12, padding: 16 }}>
      <div style={{ display: "flex", gap: 13 }}>
        <span style={avatarStyle(note.pubkey, 38, profile?.picture)}>
          {!profile?.picture && initials(name)}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span style={{ fontWeight: 700, fontSize: 15 }}>{name}</span>
            <span style={{ fontSize: 13.5, color: "var(--text-3)" }}>· {timeAgo(note.createdAt)}</span>
          </div>
          {body && (
            <p
              style={{
                margin: "7px 0 0",
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
        </div>
      </div>
    </article>
  );
};

const tabStyle = (active: boolean): CSSProperties => ({
  padding: "11px 2px",
  border: "none",
  borderBottom: `2px solid ${active ? "var(--accent)" : "transparent"}`,
  background: "transparent",
  color: active ? "var(--text)" : "var(--text-3)",
  fontWeight: 700,
  fontSize: 14.5,
  fontFamily: "inherit",
  cursor: "pointer",
  marginBottom: -1,
  transition: "color .15s, border-color .15s",
});

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

  const field = (
    label: string,
    value: string,
    onChange: (v: string) => void,
    multiline = false,
  ): ReactNode => (
    <label style={{ display: "block" }}>
      <span style={fieldLabel}>{label}</span>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{ ...fieldInput, resize: "none", minHeight: 92, lineHeight: 1.5 }}
        />
      ) : (
        <input value={value} onChange={(e) => onChange(e.target.value)} style={fieldInput} />
      )}
    </label>
  );

  return (
    <Modal onClose={onClose} width={520}>
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
          <CloseIcon size={19} />
        </button>
      </div>
      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
        {field("Display name", name, setName)}
        {field("Bio", about, setAbout, true)}
        {field("Picture URL", picture, setPicture)}
        {field("Banner URL", banner, setBanner)}
        {field("NIP-05 identifier", nip05, setNip05)}
        {field("Website", website, setWebsite)}
      </div>
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
          }}
        >
          Cancel
        </button>
        <button
          type="button"
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
          }}
        >
          {busy ? "Publishing…" : "Save & publish"}
        </button>
      </div>
    </Modal>
  );
};

export const ProfileView = (): ReactNode => {
  const { state, client, readRelayUrls, toggleFollow, toast, navigate } = useStore();
  const myPubkey = state.identity?.pubkey;
  const paramPubkey = state.nav.params.pubkey;
  const pubkey = paramPubkey && paramPubkey !== myPubkey ? paramPubkey : myPubkey;
  const isMe = pubkey !== undefined && pubkey === myPubkey;

  const otherProfile = useProfile(isMe ? undefined : pubkey);
  const profile: Profile | null = isMe ? state.me : otherProfile;

  const [tab, setTab] = useState<TabId>("posts");
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!pubkey || readRelayUrls.length === 0) return;
    let cancelled = false;
    setLoading(true);
    setNotes([]);
    void (async () => {
      const events = await client.list(readRelayUrls, {
        kinds: [Kind.Note],
        authors: [pubkey],
        limit: 50,
      });
      if (cancelled) return;
      setNotes(events.map(decodeNote));
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [pubkey, readRelayUrls, client]);

  const posts = useMemo(() => notes.filter((n) => n.replyTo === undefined), [notes]);
  const replies = useMemo(() => notes.filter((n) => n.replyTo !== undefined), [notes]);
  const media = useMemo(() => notes.filter((n) => hasMedia(n.content)), [notes]);

  const copyNpub = useCallback((): void => {
    if (!pubkey) return;
    void navigator.clipboard.writeText(npubOf(pubkey)).then(() => toast("npub copied", "copy"));
  }, [pubkey, toast]);

  if (!pubkey) {
    return (
      <div style={{ maxWidth: 640, margin: "0 auto", padding: "40px 22px" }}>
        <EmptyState icon={<ProfileIcon size={32} />} title="No profile" hint="Sign in to view your profile." />
      </div>
    );
  }

  const name = displayName({ name: profile?.name, displayName: profile?.displayName, pubkey });
  const banner = profile?.banner;
  const following = state.contacts.includes(pubkey);
  const tabNotes = tab === "posts" ? posts : tab === "replies" ? replies : media;

  return (
    <div style={{ padding: "0 0 120px" }}>
      {/* banner */}
      <div
        data-testid="profile-banner"
        style={{
          height: 168,
          background: banner ? `center/cover no-repeat url("${banner}")` : paletteBanner(state.palette),
        }}
      />

      <div style={{ maxWidth: 640, margin: "0 auto", padding: "0 22px" }}>
        {/* avatar row + action */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            marginTop: -52,
          }}
        >
          <span
            style={{
              ...avatarStyle(pubkey, 104, profile?.picture),
              fontSize: 38,
              border: "4px solid var(--bg-base)",
              boxShadow: "var(--glass-shadow)",
            }}
          >
            {!profile?.picture && initials(name)}
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
                padding: "8px 16px",
                border: "1px solid var(--glass-border)",
                borderRadius: 8,
                background: "var(--glass)",
                color: "var(--text)",
                fontWeight: 700,
                fontSize: 13,
                fontFamily: "inherit",
                cursor: "pointer",
              }}
            >
              Edit profile
            </button>
          ) : (
            <button
              type="button"
              data-testid="profile-follow"
              onClick={() => void toggleFollow(pubkey)}
              style={{
                alignSelf: "flex-start",
                marginTop: 60,
                whiteSpace: "nowrap",
                padding: "9px 20px",
                border: `1px solid ${following ? "var(--glass-border)" : "transparent"}`,
                borderRadius: 999,
                background: following ? "var(--glass)" : "var(--accent)",
                color: following ? "var(--text)" : "var(--on-accent)",
                fontWeight: 700,
                fontSize: 13.5,
                fontFamily: "inherit",
                cursor: "pointer",
              }}
            >
              {following ? "Following" : "Follow"}
            </button>
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

          <div
            style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 5, flexWrap: "wrap" }}
          >
            {profile?.nip05 && (
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
                {profile.nip05}
              </span>
            )}
          </div>

          {profile?.about && (
            <p
              style={{
                margin: "14px 0 0",
                fontSize: 15,
                lineHeight: 1.55,
                color: "var(--text)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {profile.about}
            </p>
          )}

          {profile?.website && (
            <a
              href={/^https?:\/\//.test(profile.website) ? profile.website : `https://${profile.website}`}
              target="_blank"
              rel="noreferrer"
              style={{
                display: "inline-block",
                marginTop: 8,
                fontSize: 13.5,
                color: "var(--accent)",
                textDecoration: "none",
                wordBreak: "break-word",
              }}
            >
              {profile.website}
            </a>
          )}

          <div style={{ display: "flex", gap: 22, marginTop: 16 }}>
            {isMe && (
              <span style={{ fontSize: 14, color: "var(--text-2)" }}>
                <strong
                  style={{ color: "var(--text)", fontSize: 16, fontFamily: "'Space Grotesk',sans-serif" }}
                >
                  {fmtCount(state.contacts.length)}
                </strong>{" "}
                Following
              </span>
            )}
            <span style={{ fontSize: 14, color: "var(--text-2)" }}>
              <strong
                style={{ color: "var(--text)", fontSize: 16, fontFamily: "'Space Grotesk',sans-serif" }}
              >
                {fmtCount(posts.length)}
              </strong>{" "}
              Posts
            </span>
          </div>

          {/* npub copy */}
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
              cursor: "pointer",
            }}
          >
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
            <CopyIcon size={15} stroke={2} />
          </button>
        </div>

        {/* tabs */}
        <div
          role="tablist"
          style={{
            display: "flex",
            gap: 24,
            marginTop: 22,
            borderBottom: "1px solid var(--hairline)",
          }}
        >
          <button type="button" onClick={() => setTab("posts")} style={tabStyle(tab === "posts")}>
            Posts
          </button>
          <button type="button" onClick={() => setTab("replies")} style={tabStyle(tab === "replies")}>
            Replies
          </button>
          <button type="button" onClick={() => setTab("media")} style={tabStyle(tab === "media")}>
            Media
          </button>
        </div>

        {/* panel */}
        {loading && notes.length === 0 ? (
          <div style={{ display: "flex", justifyContent: "center", padding: "48px 0" }}>
            <Spinner size={24} />
          </div>
        ) : tabNotes.length === 0 ? (
          <EmptyState
            title={
              tab === "posts" ? "No posts yet" : tab === "replies" ? "No replies yet" : "No media yet"
            }
            hint={isMe ? "Share something — it'll show up here." : `Nothing from ${name} yet.`}
          />
        ) : tab === "media" ? (
          <div
            style={{
              marginTop: 16,
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 12,
            }}
          >
            {media.flatMap((n) => renderContent(n.content).embeds.map((url) => ({ id: n.id, url }))).map(
              ({ id, url }) => (
                <button
                  key={`${id}:${url}`}
                  type="button"
                  data-testid="profile-media-tile"
                  onClick={() => navigate("profile", { pubkey })}
                  style={{
                    padding: 0,
                    border: "1px solid var(--glass-border)",
                    borderRadius: 12,
                    overflow: "hidden",
                    cursor: "pointer",
                    background: "var(--glass-2)",
                    aspectRatio: "1 / 1",
                  }}
                >
                  <Embed url={url} />
                </button>
              ),
            )}
          </div>
        ) : (
          <div
            style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 14 }}
          >
            {tabNotes.map((note) => (
              <PostCard key={note.id} note={note} profile={profile} />
            ))}
          </div>
        )}
      </div>

      {editing && isMe && (
        <EditProfileModal
          me={profile ?? { pubkey }}
          pubkey={pubkey}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  );
};
