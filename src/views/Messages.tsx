import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { nip19 } from "nostr-tools";
import { useStore, useProfile } from "../state/store.tsx";
import { decodeDm, encryptDm, buildDm } from "../nostr/dm.ts";
import { Kind, type DirectMessage } from "../nostr/types.ts";
import { EmptyState, Spinner } from "../ui/primitives.tsx";
import { MessagesIcon } from "../ui/icons.tsx";
import { avatarStyle, initials, displayName } from "../lib/format.ts";
import { compileMutes, evaluateDm } from "../lib/mute.ts";
import { avatarWrap, statusDot } from "../ui/styles.ts";

const MOBILE_BREAKPOINT = 900;

const useIsMobile = (): boolean => {
  const [mobile, setMobile] = useState(() => window.innerWidth < MOBILE_BREAKPOINT);
  useEffect(() => {
    const onResize = (): void => setMobile(window.innerWidth < MOBILE_BREAKPOINT);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return mobile;
};

/** A conversation: a peer pubkey plus its decrypted, time-ordered messages. */
type Conversation = {
  peer: string;
  messages: DirectMessage[];
  lastAt: number;
};

/** Resolve a pasted npub or hex pubkey to a 64-char hex pubkey, or null. */
const resolvePeer = (raw: string): string | null => {
  const value = raw.trim();
  if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
  try {
    const decoded = nip19.decode(value);
    if (decoded.type === "npub") return decoded.data;
  } catch {
    // not a valid npub
  }
  return null;
};

/** Clock-style time for a message timestamp (matches the design's "9:24"). */
const clock = (seconds: number): string =>
  new Date(seconds * 1000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

// ---- verified seal at arbitrary size (design uses 13px in list, 14px in header) ----

const Seal = ({ size }: { size: number }): ReactNode => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="var(--accent)" aria-label="Verified" style={{ flexShrink: 0 }}>
    <path d="M12 2l2.4 1.8 3-.2 1 2.8 2.5 1.6-.8 2.9.8 2.9-2.5 1.6-1 2.8-3-.2L12 22l-2.4-1.8-3 .2-1-2.8L3.1 16l.8-2.9L3.1 10l2.5-1.6 1-2.8 3 .2L12 2z" />
    <path d="m8.5 12 2.2 2.2 4.8-4.8" stroke="#fff" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const LockIcon = ({ size }: { size: number }): ReactNode => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </svg>
);

const BannerLockIcon = (): ReactNode => (
  <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </svg>
);

const PlaneIcon = (): ReactNode => (
  <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="m22 2-7 20-4-9-9-4z" />
    <path d="M22 2 11 13" />
  </svg>
);

const ChevronLeft = (): ReactNode => (
  <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="m15 18-6-6 6-6" />
  </svg>
);

export const MessagesView = (): ReactNode => {
  const { state, client, readRelayUrls, publish, toast, navigate } = useStore();
  const identity = state.identity;
  const me = identity?.pubkey;
  const isMobile = useIsMobile();

  // Client-only soft mute: DMs honour account rules only (never keyword/regex).
  const muted = useMemo(() => compileMutes(state.muteSettings.rules), [state.muteSettings.rules]);

  // Decoded messages keyed by event id (dedupes across both subscriptions).
  const [byId, setById] = useState<ReadonlyMap<string, DirectMessage>>(new Map());
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState<string | null>(state.nav.params.pubkey ?? null);
  const [text, setText] = useState("");
  // Peers opened with no messages yet (new conversations) so they show a thread pane.
  const [pending, setPending] = useState<ReadonlyArray<string>>(() =>
    state.nav.params.pubkey ? [state.nav.params.pubkey] : [],
  );

  // Honor a pubkey arriving via navigation after mount.
  useEffect(() => {
    const target = state.nav.params.pubkey;
    if (!target) {
      setActive(null);
      return;
    }
    setActive(target);
    setPending((prev) => (prev.includes(target) ? prev : [...prev, target]));
  }, [state.nav.params.pubkey]);

  // ---- subscribe to DMs in both directions ----
  useEffect(() => {
    if (!identity || !me || readRelayUrls.length === 0) return;
    let cancelled = false;
    const ingest = (event: Parameters<Parameters<typeof client.subscribe>[2]>[0]): void => {
      void decodeDm(identity, me, event).then((dm) => {
        if (cancelled || !dm) return;
        setById((prev) => {
          if (prev.has(dm.id)) return prev;
          const next = new Map(prev);
          next.set(dm.id, dm);
          return next;
        });
      });
    };
    let eosed = 0;
    const onEose = (): void => {
      eosed += 1;
      if (eosed >= 2) setLoading(false);
    };
    const unsubSent = client.subscribe(readRelayUrls, { kinds: [Kind.EncryptedDM], authors: [me] }, ingest, onEose);
    const unsubRecv = client.subscribe(readRelayUrls, { kinds: [Kind.EncryptedDM], "#p": [me] }, ingest, onEose);
    return () => {
      cancelled = true;
      unsubSent();
      unsubRecv();
    };
  }, [identity, me, readRelayUrls, client]);

  // ---- group decoded messages into conversations, newest first ----
  const conversations = useMemo<Conversation[]>(() => {
    const groups = new Map<string, DirectMessage[]>();
    for (const dm of byId.values()) {
      const list = groups.get(dm.pubkey) ?? [];
      list.push(dm);
      groups.set(dm.pubkey, list);
    }
    for (const peer of pending) if (!groups.has(peer)) groups.set(peer, []);
    const convs = [...groups.entries()]
      // Drop account-muted peers up front so their unread/last-message never aggregates.
      .filter(([peer]) => !evaluateDm(muted, { pubkey: peer }))
      .map(([peer, msgs]) => {
        const messages = [...msgs].sort((a, b) => a.createdAt - b.createdAt);
        const last = messages[messages.length - 1];
        return { peer, messages, lastAt: last ? last.createdAt : 0 };
      });
    return convs.sort((a, b) => b.lastAt - a.lastAt);
  }, [byId, pending, muted]);

  const activeConv = useMemo<Conversation | null>(() => {
    if (!active) return null;
    return conversations.find((c) => c.peer === active) ?? { peer: active, messages: [], lastAt: 0 };
  }, [active, conversations]);

  if (!identity || !me) {
    return <EmptyState icon={<MessagesIcon size={34} />} title="Sign in to view messages" />;
  }

  const openThread = (peer: string): void => {
    setActive(peer);
    navigate("messages", { pubkey: peer });
  };

  const startConversation = (raw: string): void => {
    const peer = resolvePeer(raw);
    if (!peer) {
      toast("Enter a valid npub or hex pubkey", "warn");
      return;
    }
    setPending((prev) => (prev.includes(peer) ? prev : [...prev, peer]));
    openThread(peer);
  };

  const send = async (): Promise<void> => {
    const body = text.trim();
    if (!body || !active) return;
    const peer = active;
    setText("");
    try {
      const ct = await encryptDm(identity, peer, body);
      const id = await publish(buildDm(peer, ct));
      const optimistic: DirectMessage = {
        id,
        pubkey: peer,
        content: body,
        createdAt: Math.floor(Date.now() / 1000),
        fromMe: true,
      };
      setById((prev) => {
        if (prev.has(id)) return prev;
        const next = new Map(prev);
        next.set(id, optimistic);
        return next;
      });
    } catch {
      setText(body);
      toast("Could not send message", "warn");
    }
  };

  // Per spec §0: desktop always shows both panes; mobile shows exactly one.
  const showList = !isMobile || active === null;
  const showThread = !isMobile || active !== null;

  return (
    <div style={{ display: "flex", height: "calc(100vh - 74px)", minHeight: 0 }}>
      {showList && (
        <ConversationList
          conversations={conversations}
          active={active}
          loading={loading}
          fullWidth={isMobile}
          onOpen={openThread}
          onStartConversation={startConversation}
        />
      )}

      {showThread && (
        <ThreadPane
          conv={activeConv}
          isMobile={isMobile}
          text={text}
          onText={setText}
          onSend={send}
          onBack={() => {
            setActive(null);
            navigate("messages");
          }}
          onOpenProfile={(peer) => navigate("profile", { pubkey: peer })}
        />
      )}
    </div>
  );
};

// ---- conversation list ----------------------------------------------------

const ConversationList = ({
  conversations,
  active,
  loading,
  fullWidth,
  onOpen,
  onStartConversation,
}: {
  conversations: Conversation[];
  active: string | null;
  loading: boolean;
  fullWidth: boolean;
  onOpen: (peer: string) => void;
  onStartConversation: (raw: string) => void;
}): ReactNode => (
  <div
    data-testid="message-list"
    style={{
      width: fullWidth ? "100%" : 320,
      flexShrink: 0,
      borderRight: fullWidth ? "none" : "1px solid var(--hairline)",
      display: "flex",
      flexDirection: "column",
      minHeight: 0,
    }}
  >
    <div style={{ padding: "14px 14px", display: "flex", flexDirection: "column", gap: 5, overflowY: "auto" }}>
      {loading && conversations.length === 0 ? (
        <div style={{ display: "flex", justifyContent: "center", padding: "40px 0" }}>
          <Spinner />
        </div>
      ) : conversations.length === 0 ? (
        <NewConversation onStart={onStartConversation} />
      ) : (
        conversations.map((c) => (
          <ConversationRow key={c.peer} conv={c} active={c.peer === active} onClick={() => onOpen(c.peer)} />
        ))
      )}
    </div>
  </div>
);

const NewConversation = ({ onStart }: { onStart: (raw: string) => void }): ReactNode => {
  const [value, setValue] = useState("");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "24px 8px" }}>
      <EmptyState
        icon={<MessagesIcon size={30} />}
        title="No conversations yet"
        hint="Paste an npub or hex pubkey to start an end-to-end encrypted message."
      />
      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onStart(value);
          }}
          placeholder="npub1… or hex"
          style={{
            flex: 1,
            minWidth: 0,
            border: "1px solid var(--glass-border)",
            borderRadius: 10,
            background: "var(--glass)",
            padding: "10px 12px",
            outline: "none",
            fontSize: 13,
            color: "var(--text)",
            fontFamily: "'JetBrains Mono',monospace",
          }}
        />
        <button
          type="button"
          onClick={() => onStart(value)}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "0 14px",
            borderRadius: 10,
            border: "1px solid rgba(255,255,255,.3)",
            background: "var(--accent)",
            color: "var(--on-accent)",
            fontWeight: 700,
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          Go
        </button>
      </div>
    </div>
  );
};

const ConversationRow = ({
  conv,
  active,
  onClick,
}: {
  conv: Conversation;
  active: boolean;
  onClick: () => void;
}): ReactNode => {
  const profile = useProfile(conv.peer);
  const name = displayName({ name: profile?.name, displayName: profile?.displayName, pubkey: conv.peer });
  const last = conv.messages[conv.messages.length - 1];
  const preview = last ? `${last.fromMe ? "You: " : ""}${last.content}` : "No messages yet";
  // Best-effort unread: received messages (no read-state tracking yet) — show none here.
  const unread = 0;
  const [hover, setHover] = useState(false);

  return (
    <button
      type="button"
      data-testid="conversation-item"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 11,
        width: "100%",
        padding: "10px 10px",
        border: "none",
        borderRadius: 12,
        background: active ? "var(--accent-soft)" : hover ? "var(--glass)" : "transparent",
        cursor: "pointer",
        textAlign: "left",
      }}
    >
      <span style={avatarWrap(42, false)}>
        <span style={avatarStyle(conv.peer, 42, profile?.picture)}>{!profile?.picture && initials(name)}</span>
        <span style={statusDot(false, false)} />
      </span>
      <div style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span
            style={{
              fontWeight: 700,
              fontSize: 14,
              color: "var(--text)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {name}
          </span>
          {profile?.nip05 && <Seal size={13} />}
        </div>
        <span
          style={{
            display: "block",
            fontSize: 12.5,
            color: "var(--text-3)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {preview}
        </span>
      </div>
      {unread > 0 && (
        <span
          style={{
            background: "var(--accent)",
            color: "var(--on-accent)",
            fontSize: 11,
            fontWeight: 700,
            minWidth: 18,
            height: 18,
            padding: "0 5px",
            borderRadius: 9,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {unread}
        </span>
      )}
    </button>
  );
};

// ---- thread pane ----------------------------------------------------------

const ThreadPane = ({
  conv,
  isMobile,
  text,
  onText,
  onSend,
  onBack,
  onOpenProfile,
}: {
  conv: Conversation | null;
  isMobile: boolean;
  text: string;
  onText: (v: string) => void;
  onSend: () => Promise<void>;
  onBack: () => void;
  onOpenProfile: (peer: string) => void;
}): ReactNode => {
  if (!conv) {
    return (
      <div
        data-testid="message-thread"
        style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0, alignItems: "center", justifyContent: "center" }}
      >
        <EmptyState
          icon={<MessagesIcon size={34} />}
          title="Select a conversation"
          hint="Pick a thread on the left to read your encrypted messages."
        />
      </div>
    );
  }
  return (
    <ThreadBody
      conv={conv}
      isMobile={isMobile}
      text={text}
      onText={onText}
      onSend={onSend}
      onBack={onBack}
      onOpenProfile={onOpenProfile}
    />
  );
};

const ThreadBody = ({
  conv,
  isMobile,
  text,
  onText,
  onSend,
  onBack,
  onOpenProfile,
}: {
  conv: Conversation;
  isMobile: boolean;
  text: string;
  onText: (v: string) => void;
  onSend: () => Promise<void>;
  onBack: () => void;
  onOpenProfile: (peer: string) => void;
}): ReactNode => {
  const profile = useProfile(conv.peer);
  const name = displayName({ name: profile?.name, displayName: profile?.displayName, pubkey: conv.peer });
  const verified = Boolean(profile?.nip05);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [nameHover, setNameHover] = useState(false);
  const [avatarHover, setAvatarHover] = useState(false);
  const [inputFocus, setInputFocus] = useState(false);
  const [sendHover, setSendHover] = useState(false);
  const [sendActive, setSendActive] = useState(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conv.messages.length, conv.peer]);

  const handleSend = (): void => {
    void onSend();
  };

  return (
    <div data-testid="message-thread" style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0 }}>
      {/* header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "14px 18px",
          borderBottom: "1px solid var(--hairline)",
        }}
      >
        {isMobile && (
          <button
            type="button"
            onClick={onBack}
            title="Back"
            style={{ display: "flex", padding: 6, border: "none", background: "transparent", color: "var(--text-2)", cursor: "pointer" }}
          >
            <ChevronLeft />
          </button>
        )}
        <span
          style={{ ...avatarWrap(40, true), filter: avatarHover ? "brightness(.94)" : undefined }}
          onClick={() => onOpenProfile(conv.peer)}
          onMouseEnter={() => setAvatarHover(true)}
          onMouseLeave={() => setAvatarHover(false)}
        >
          <span style={avatarStyle(conv.peer, 40, profile?.picture)}>{!profile?.picture && initials(name)}</span>
          <span style={statusDot(false, false)} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span
              onClick={() => onOpenProfile(conv.peer)}
              onMouseEnter={() => setNameHover(true)}
              onMouseLeave={() => setNameHover(false)}
              style={{
                fontWeight: 700,
                fontSize: 15,
                cursor: "pointer",
                textDecoration: nameHover ? "underline" : "none",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {name}
            </span>
            {verified && <Seal size={14} />}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "var(--success)" }}>
            <LockIcon size={12} />
            Encrypted · NIP-04
          </div>
        </div>
      </div>

      {/* messages */}
      <div
        ref={scrollRef}
        style={{ flex: 1, overflowY: "auto", padding: "20px 18px", display: "flex", flexDirection: "column", gap: 10 }}
      >
        <div
          style={{
            alignSelf: "center",
            display: "flex",
            alignItems: "center",
            gap: 7,
            fontSize: 11.5,
            color: "var(--text-3)",
            background: "var(--glass)",
            WebkitBackdropFilter: "var(--blur)",
            backdropFilter: "var(--blur)",
            border: "1px solid var(--glass-border)",
            padding: "6px 12px",
            borderRadius: 999,
            marginBottom: 6,
            textAlign: "center",
          }}
        >
          <BannerLockIcon />
          {`Messages are end-to-end encrypted. Only you and ${name} can read them.`}
        </div>

        {conv.messages.map((m) => (
          <Bubble key={m.id} message={m} mine={m.fromMe} />
        ))}
      </div>

      {/* composer */}
      <div
        style={{
          padding: "14px 18px",
          borderTop: "1px solid var(--hairline)",
          display: "flex",
          alignItems: "flex-end",
          gap: 10,
        }}
      >
        <input
          data-testid="dm-input"
          value={text}
          onChange={(e) => onText(e.target.value)}
          onFocus={() => setInputFocus(true)}
          onBlur={() => setInputFocus(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && ((e.metaKey || e.ctrlKey) || !e.shiftKey)) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder="Write an encrypted message…"
          style={{
            flex: 1,
            minWidth: 0,
            border: `1px solid ${inputFocus ? "var(--accent)" : "var(--glass-border)"}`,
            borderRadius: 10,
            background: "var(--glass)",
            WebkitBackdropFilter: "var(--blur)",
            backdropFilter: "var(--blur)",
            padding: "12px 15px",
            outline: "none",
            fontSize: 14.5,
            color: "var(--text)",
          }}
        />
        <button
          type="button"
          data-testid="dm-send"
          onClick={handleSend}
          onMouseEnter={() => setSendHover(true)}
          onMouseLeave={() => {
            setSendHover(false);
            setSendActive(false);
          }}
          onMouseDown={() => setSendActive(true)}
          onMouseUp={() => setSendActive(false)}
          title="Send"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 44,
            height: 44,
            border: "1px solid rgba(255,255,255,.3)",
            borderRadius: 10,
            background: "var(--accent)",
            color: "var(--on-accent)",
            cursor: "pointer",
            flexShrink: 0,
            transition: "all .15s",
            filter: sendHover ? "brightness(1.08)" : undefined,
            transform: sendActive ? "scale(.94)" : undefined,
          }}
        >
          <PlaneIcon />
        </button>
      </div>
    </div>
  );
};

const Bubble = ({ message, mine }: { message: DirectMessage; mine: boolean }): ReactNode => {
  const row: CSSProperties = { display: "flex", justifyContent: mine ? "flex-end" : "flex-start" };
  const bubble: CSSProperties = mine
    ? {
        background: "var(--accent)",
        color: "var(--on-accent)",
        borderRadius: "16px 16px 4px 16px",
        padding: "11px 15px",
        fontSize: 14.5,
        lineHeight: 1.45,
        maxWidth: "72%",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }
    : {
        background: "var(--glass)",
        WebkitBackdropFilter: "var(--blur)",
        backdropFilter: "var(--blur)",
        border: "1px solid var(--glass-border)",
        color: "var(--text)",
        borderRadius: "16px 16px 16px 4px",
        padding: "11px 15px",
        fontSize: 14.5,
        lineHeight: 1.45,
        maxWidth: "72%",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      };
  return (
    <div style={row}>
      <div>
        <div style={bubble}>{message.content}</div>
        <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 4, padding: "0 4px", textAlign: mine ? "right" : "left" }}>
          {clock(message.createdAt)}
        </div>
      </div>
    </div>
  );
};
