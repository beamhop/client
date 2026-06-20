import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useProfile, useStore, type NotificationItem, type NotificationType } from "../state/store.tsx";
import { avatarStyle, displayName, initials, timeAgo } from "../lib/format.ts";
import { compileMutes, evaluateNotification } from "../lib/mute.ts";
import { BellIcon, HeartIcon, MessagesIcon, ReplyIcon } from "../ui/icons.tsx";
import { EmptyState } from "../ui/primitives.tsx";

type FilterId = "all" | "unread";

const rowStyle = (unread: boolean): CSSProperties => ({
  display: "flex",
  alignItems: "flex-start",
  gap: 13,
  width: "100%",
  padding: "15px 16px",
  border: `1px solid ${unread ? "var(--accent)" : "var(--glass-border)"}`,
  borderRadius: 12,
  background: unread ? "var(--accent-soft)" : "var(--glass)",
  boxShadow: "var(--glass-shadow)",
  textAlign: "left",
  color: "var(--text)",
  fontFamily: "inherit",
  cursor: "pointer",
});

const filterStyle = (active: boolean): CSSProperties => ({
  padding: "7px 13px",
  border: active ? "1px solid var(--accent)" : "1px solid var(--glass-border)",
  borderRadius: 999,
  background: active ? "var(--accent-soft)" : "var(--glass)",
  color: active ? "var(--accent)" : "var(--text-2)",
  fontWeight: 700,
  fontSize: 13,
  fontFamily: "inherit",
  cursor: "pointer",
});

const smallButtonStyle = (disabled?: boolean): CSSProperties => ({
  padding: "8px 13px",
  border: "1px solid var(--glass-border)",
  borderRadius: 9,
  background: "var(--glass)",
  color: disabled ? "var(--text-3)" : "var(--text)",
  fontWeight: 700,
  fontSize: 13,
  fontFamily: "inherit",
  cursor: disabled ? "default" : "pointer",
  opacity: disabled ? 0.6 : 1,
});

const ZapGlyph = (): ReactNode => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M13 2 4 14h7l-1 8 10-13h-7z" />
  </svg>
);

const iconFor = (type: NotificationType): ReactNode => {
  switch (type) {
    case "reply":
    case "mention":
      return <ReplyIcon size={17} />;
    case "reaction":
      return <HeartIcon size={17} filled />;
    case "zap":
      return <ZapGlyph />;
    case "dm":
      return <MessagesIcon size={17} />;
  }
};

const titleFor = (item: NotificationItem, name: string): string => {
  switch (item.type) {
    case "reply":
      return `${name} replied to you`;
    case "mention":
      return `${name} mentioned you`;
    case "reaction":
      return item.content === "+" ? `${name} liked your post` : `${name} reacted ${item.content}`;
    case "zap":
      return `${name} zapped you`;
    case "dm":
      return `${name} sent you a message`;
  }
};

const detailFor = (item: NotificationItem): string => {
  if (item.type === "dm") return "Encrypted direct message";
  if (item.type === "zap") return item.content ? `Lightning receipt · ${item.content}` : "Lightning payment receipt";
  if (item.type === "reaction") return item.targetId ? "Reaction on your post" : "Reaction";
  const trimmed = item.content.replace(/\s+/g, " ").trim();
  if (!trimmed) return item.type === "reply" ? "Reply" : "Mention";
  return trimmed.length > 160 ? `${trimmed.slice(0, 157)}...` : trimmed;
};

const looksLikeEventId = (value: string | undefined): value is string =>
  Boolean(value && /^[a-f0-9]{64}$/i.test(value));

const NotificationRow = ({
  item,
  onOpen,
}: {
  item: NotificationItem;
  onOpen: (item: NotificationItem) => void;
}): ReactNode => {
  const profile = useProfile(item.pubkey);
  const name = displayName({ name: profile?.name, displayName: profile?.displayName, pubkey: item.pubkey });

  return (
    <button type="button" data-testid="notification-row" onClick={() => onOpen(item)} style={rowStyle(!item.read)}>
      <span style={{ position: "relative", flexShrink: 0 }}>
        <span style={avatarStyle(item.pubkey, 42, profile?.picture)}>{!profile?.picture && initials(name)}</span>
        {!item.read && (
          <span
            style={{
              position: "absolute",
              right: -1,
              top: -1,
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: "var(--accent)",
              border: "2px solid var(--bg-base)",
            }}
          />
        )}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 7, color: item.read ? "var(--text-3)" : "var(--accent)", marginBottom: 3 }}>
          {iconFor(item.type)}
          <span style={{ color: "var(--text)", fontWeight: 800, fontSize: 14.5 }}>{titleFor(item, name)}</span>
        </span>
        <span style={{ display: "block", color: "var(--text-2)", fontSize: 13.5, lineHeight: 1.45, overflowWrap: "anywhere" }}>
          {detailFor(item)}
        </span>
        <span style={{ display: "block", marginTop: 7, color: "var(--text-3)", fontSize: 12.5 }}>
          {timeAgo(item.createdAt)}
        </span>
      </span>
    </button>
  );
};

export const NotificationsView = (): ReactNode => {
  const { state, navigate, markNotificationRead, markAllNotificationsRead } = useStore();
  const [filter, setFilter] = useState<FilterId>("all");

  // Filter muted sources at render so rules added mid-session hide existing
  // notifications and the unread count below reflects only visible items.
  const muted = useMemo(() => compileMutes(state.muteSettings.rules), [state.muteSettings.rules]);
  const visible = useMemo(
    () => state.notifications.filter((n) => !evaluateNotification(muted, { pubkey: n.pubkey, content: n.content })),
    [state.notifications, muted],
  );
  const unread = useMemo(() => visible.filter((n) => !n.read), [visible]);
  const items = filter === "unread" ? unread : visible;

  const openNotification = (item: NotificationItem): void => {
    markNotificationRead(item.eventId);
    if (item.type === "dm") {
      navigate("messages", { pubkey: item.pubkey });
      return;
    }
    if ((item.type === "reaction" || item.type === "zap") && looksLikeEventId(item.targetId)) {
      navigate("postDetail", { id: item.targetId });
      return;
    }
    if ((item.type === "reply" || item.type === "mention") && looksLikeEventId(item.eventId)) {
      navigate("postDetail", { id: item.eventId });
      return;
    }
    navigate("profile", { pubkey: item.pubkey });
  };

  return (
    <div data-testid="view-notifications" style={{ maxWidth: 720, margin: "0 auto", padding: "16px 18px 120px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button type="button" onClick={() => setFilter("all")} style={filterStyle(filter === "all")}>
            All
          </button>
          <button type="button" onClick={() => setFilter("unread")} style={filterStyle(filter === "unread")}>
            Unread {unread.length > 0 ? unread.length : ""}
          </button>
        </div>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          data-testid="notifications-mark-all-read"
          disabled={unread.length === 0}
          onClick={markAllNotificationsRead}
          style={smallButtonStyle(unread.length === 0)}
        >
          Mark all read
        </button>
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon={<BellIcon size={32} />}
          title={filter === "unread" ? "No unread notifications" : "No notifications yet"}
          hint={filter === "unread" ? "You're all caught up." : "Replies, mentions, reactions, zaps, and messages will appear here."}
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {items.map((item) => (
            <NotificationRow key={item.eventId} item={item} onOpen={openNotification} />
          ))}
        </div>
      )}
    </div>
  );
};
