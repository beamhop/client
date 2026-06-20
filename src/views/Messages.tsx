import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { nip19 } from "nostr-tools";
import { useStore, useProfile } from "../state/store.tsx";
import { decodeDm, encryptDm, buildDm } from "../nostr/dm.ts";
import { Kind, type DirectMessage } from "../nostr/types.ts";
import { AuthorChip, Avatar, EmptyState, Spinner, glass } from "../ui/primitives.tsx";
import { SendIcon, ChevronLeftIcon, MessagesIcon, PlusIcon } from "../ui/icons.tsx";
import { timeAgo, displayName } from "../lib/format.ts";

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

export const MessagesView = (): ReactNode => {
  const { state, client, readRelayUrls, publish, toast, navigate } = useStore();
  const identity = state.identity;
  const me = identity?.pubkey;
  const isMobile = useIsMobile();

  // Decoded messages keyed by event id (dedupes across both subscriptions).
  const [byId, setById] = useState<ReadonlyMap<string, DirectMessage>>(new Map());
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState<string | null>(state.nav.params.pubkey ?? null);
  const [text, setText] = useState("");
  const [composing, setComposing] = useState(false);
  const [newPeerInput, setNewPeerInput] = useState("");

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
    const convs = [...groups.entries()].map(([peer, msgs]) => {
      const messages = [...msgs].sort((a, b) => a.createdAt - b.createdAt);
      const last = messages[messages.length - 1];
      return { peer, messages, lastAt: last ? last.createdAt : 0 };
    });
    return convs.sort((a, b) => b.lastAt - a.lastAt);
  }, [byId]);

  const activeConv = useMemo<Conversation | null>(() => {
    if (!active) return null;
    return conversations.find((c) => c.peer === active) ?? { peer: active, messages: [], lastAt: 0 };
  }, [active, conversations]);

  if (!identity || !me) {
    return <EmptyState icon={<MessagesIcon size={34} />} title="Sign in to view messages" />;
  }

  const openThread = (peer: string): void => {
    setActive(peer);
    setComposing(false);
  };

  const startConversation = (): void => {
    const peer = resolvePeer(newPeerInput);
    if (!peer) {
      toast("Enter a valid npub or hex pubkey", "warn");
      return;
    }
    setNewPeerInput("");
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

  const showList = !isMobile || (active === null && !composing);
  const showThread = !isMobile || active !== null || composing;

  return (
    <div style={{ display: "flex", height: "calc(100vh - 74px)", minHeight: 0 }}>
      {showList && (
        <ConversationList
          conversations={conversations}
          active={active}
          loading={loading}
          fullWidth={isMobile}
          composing={composing}
          newPeerInput={newPeerInput}
          onNewPeerInput={setNewPeerInput}
          onStartCompose={() => {
            setComposing(true);
            setActive(null);
          }}
          onStartConversation={startConversation}
          onOpen={openThread}
        />
      )}

      {showThread &&
        (activeConv ? (
          <ThreadPane
            conv={activeConv}
            isMobile={isMobile}
            text={text}
            onText={setText}
            onSend={send}
            onBack={() => {
              setActive(null);
              setComposing(false);
            }}
            onOpenProfile={() => navigate("profile", { pubkey: activeConv.peer })}
          />
        ) : (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", minWidth: 0 }}>
            <EmptyState
              icon={<MessagesIcon size={34} />}
              title="Select a conversation"
              hint="Pick a thread on the left, or start a new encrypted message."
            />
          </div>
        ))}
    </div>
  );
};

// ---- conversation list ----------------------------------------------------

const ConversationList = ({
  conversations,
  active,
  loading,
  fullWidth,
  composing,
  newPeerInput,
  onNewPeerInput,
  onStartCompose,
  onStartConversation,
  onOpen,
}: {
  conversations: Conversation[];
  active: string | null;
  loading: boolean;
  fullWidth: boolean;
  composing: boolean;
  newPeerInput: string;
  onNewPeerInput: (v: string) => void;
  onStartCompose: () => void;
  onStartConversation: () => void;
  onOpen: (peer: string) => void;
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
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "14px 16px",
        borderBottom: "1px solid var(--hairline)",
      }}
    >
      <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 17, color: "var(--text)" }}>
        Messages
      </span>
      <button
        type="button"
        onClick={onStartCompose}
        title="New message"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 34,
          height: 34,
          borderRadius: 9,
          border: "1px solid var(--glass-border)",
          background: composing ? "var(--accent-soft)" : "var(--glass)",
          color: composing ? "var(--accent)" : "var(--text-2)",
          cursor: "pointer",
        }}
      >
        <PlusIcon size={18} />
      </button>
    </div>

    {composing && (
      <div style={{ display: "flex", gap: 8, padding: "12px 14px", borderBottom: "1px solid var(--hairline)" }}>
        <input
          value={newPeerInput}
          onChange={(e) => onNewPeerInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onStartConversation();
          }}
          placeholder="Paste npub or hex pubkey…"
          style={{
            flex: 1,
            minWidth: 0,
            border: "1px solid var(--glass-border)",
            borderRadius: 10,
            background: "var(--glass)",
            padding: "10px 12px",
            outline: "none",
            fontSize: 13.5,
            color: "var(--text)",
            fontFamily: "'JetBrains Mono',monospace",
          }}
        />
        <button
          type="button"
          onClick={onStartConversation}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "0 14px",
            borderRadius: 10,
            border: "1px solid rgba(255,255,255,.25)",
            background: "var(--accent)",
            color: "var(--on-accent)",
            fontWeight: 700,
            fontSize: 13.5,
            cursor: "pointer",
          }}
        >
          Go
        </button>
      </div>
    )}

    <div style={{ flex: 1, overflowY: "auto", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 4 }}>
      {loading && conversations.length === 0 ? (
        <div style={{ display: "flex", justifyContent: "center", padding: "40px 0" }}>
          <Spinner />
        </div>
      ) : conversations.length === 0 ? (
        <EmptyState
          icon={<MessagesIcon size={30} />}
          title="No conversations yet"
          hint="Start an encrypted message with the + button above."
        />
      ) : (
        conversations.map((c) => (
          <ConversationRow key={c.peer} conv={c} active={c.peer === active} onClick={() => onOpen(c.peer)} />
        ))
      )}
    </div>
  </div>
);

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

  return (
    <button
      type="button"
      data-testid="conversation-item"
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 11,
        width: "100%",
        padding: "10px 10px",
        borderRadius: 12,
        border: "none",
        background: active ? "var(--accent-soft)" : "transparent",
        cursor: "pointer",
        textAlign: "left",
      }}
    >
      <Avatar pubkey={conv.peer} size={42} name={name} picture={profile?.picture} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
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
          <span style={{ fontSize: 11.5, color: "var(--text-3)", flexShrink: 0 }}>
            {last ? timeAgo(last.createdAt) : ""}
          </span>
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
  conv: Conversation;
  isMobile: boolean;
  text: string;
  onText: (v: string) => void;
  onSend: () => Promise<void>;
  onBack: () => void;
  onOpenProfile: () => void;
}): ReactNode => {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conv.messages.length, conv.peer]);

  const handleSend = (): void => {
    void onSend();
  };

  return (
    <div
      data-testid="message-thread"
      style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0 }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "12px 18px",
          borderBottom: "1px solid var(--hairline)",
        }}
      >
        {isMobile && (
          <button
            type="button"
            onClick={onBack}
            title="Back"
            style={{
              display: "flex",
              padding: 6,
              border: "none",
              background: "transparent",
              color: "var(--text-2)",
              cursor: "pointer",
            }}
          >
            <ChevronLeftIcon size={22} />
          </button>
        )}
        <AuthorChip pubkey={conv.peer} size={40} onClick={onOpenProfile} />
        <span
          style={{
            marginLeft: "auto",
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            fontSize: 11.5,
            color: "var(--success)",
            fontWeight: 700,
          }}
        >
          Encrypted · NIP-04
        </span>
      </div>

      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "20px 18px",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        {conv.messages.length === 0 ? (
          <div style={{ margin: "auto" }}>
            <EmptyState title="No messages yet" hint="Say hello — your message is end-to-end encrypted." />
          </div>
        ) : (
          conv.messages.map((m) => <Bubble key={m.id} message={m} mine={m.fromMe} />)
        )}
      </div>

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
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder="Write an encrypted message…"
          style={{
            flex: 1,
            minWidth: 0,
            border: "1px solid var(--glass-border)",
            borderRadius: 10,
            background: "var(--glass)",
            padding: "12px 15px",
            outline: "none",
            fontSize: 14.5,
            color: "var(--text)",
            fontFamily: "inherit",
          }}
        />
        <button
          type="button"
          data-testid="dm-send"
          onClick={handleSend}
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
          }}
        >
          <SendIcon size={20} />
        </button>
      </div>
    </div>
  );
};

const Bubble = ({ message, mine }: { message: DirectMessage; mine: boolean }): ReactNode => {
  const row: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    alignItems: mine ? "flex-end" : "flex-start",
    maxWidth: "72%",
    alignSelf: mine ? "flex-end" : "flex-start",
  };
  const bubble: CSSProperties = mine
    ? {
        background: "var(--accent)",
        color: "var(--on-accent)",
        borderRadius: "16px 16px 4px 16px",
        padding: "11px 15px",
        fontSize: 14.5,
        lineHeight: 1.45,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }
    : {
        ...glass,
        borderRadius: "16px 16px 16px 4px",
        padding: "11px 15px",
        fontSize: 14.5,
        lineHeight: 1.45,
        color: "var(--text)",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      };
  return (
    <div style={row}>
      <div style={bubble}>{message.content}</div>
      <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 4, padding: "0 4px" }}>
        {timeAgo(message.createdAt)}
      </div>
    </div>
  );
};
