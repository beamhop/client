import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { Filter } from "nostr-tools";
import { nip19 } from "nostr-tools";
import { useStore } from "../state/store.tsx";
import { useFeed } from "../state/hooks.ts";
import type { Note } from "../nostr/types.ts";
import { Kind } from "../nostr/types.ts";
import { AuthorChip, EmptyState, Spinner, glass } from "../ui/primitives.tsx";
import { SearchIcon } from "../ui/icons.tsx";
import { timeAgo } from "../lib/format.ts";

const TOPICS = ["nostr", "bitcoin", "identity", "security", "design", "art", "dev"] as const;

const URL_RE = /(https?:\/\/[^\s]+)/gi;
const IMG_RE = /\.(png|jpe?g|gif|webp|avif)(\?[^\s]*)?$/i;

/** Linkify URLs and inline images inside note text. */
const renderContent = (text: string): ReactNode => {
  const parts = text.split(URL_RE);
  return parts.map((part, i) => {
    if (i % 2 === 0) return part || null;
    if (IMG_RE.test(part)) {
      return (
        <img
          key={i}
          src={part}
          alt=""
          loading="lazy"
          style={{
            display: "block",
            maxWidth: "100%",
            marginTop: 8,
            borderRadius: 12,
            border: "1px solid var(--glass-border)",
          }}
        />
      );
    }
    return (
      <a
        key={i}
        href={part}
        target="_blank"
        rel="noreferrer noopener"
        style={{ color: "var(--accent)", wordBreak: "break-all" }}
      >
        {part}
      </a>
    );
  });
};

const PostCard = ({ note, onAuthor }: { note: Note; onAuthor: () => void }): ReactNode => (
  <article style={{ ...glass, padding: 16 }}>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
      <AuthorChip pubkey={note.pubkey} size={40} onClick={onAuthor} />
      <span style={{ fontSize: 12.5, color: "var(--text-3)", flexShrink: 0 }}>
        {timeAgo(note.createdAt)}
      </span>
    </div>
    <div
      style={{
        marginTop: 11,
        fontSize: 14.5,
        lineHeight: 1.55,
        color: "var(--text)",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {renderContent(note.content)}
    </div>
  </article>
);

const chipStyle = (active: boolean): CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: 7,
  padding: "9px 15px",
  border: `1px solid ${active ? "var(--accent)" : "var(--glass-border)"}`,
  borderRadius: 999,
  background: active ? "var(--accent-soft)" : "var(--glass)",
  color: active ? "var(--accent)" : "var(--text)",
  fontWeight: 600,
  fontSize: 13.5,
  fontFamily: "inherit",
  cursor: "pointer",
  transition: "all .18s",
});

/** Resolve a NIP-05 `name@domain` to a hex pubkey via the well-known endpoint. */
const resolveNip05 = async (input: string): Promise<string | null> => {
  const [name, domain] = input.split("@");
  if (!name || !domain) return null;
  try {
    const res = await fetch(
      `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`,
    );
    if (!res.ok) return null;
    const json: unknown = await res.json();
    if (typeof json !== "object" || json === null || !("names" in json)) return null;
    const names = (json as { names: unknown }).names;
    if (typeof names !== "object" || names === null) return null;
    const pubkey = (names as Record<string, unknown>)[name];
    return typeof pubkey === "string" ? pubkey : null;
  } catch {
    return null;
  }
};

export const ExploreView = (): ReactNode => {
  const { navigate, toast } = useStore();
  const [topic, setTopic] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const filter = useMemo<Filter>(
    () =>
      topic
        ? { kinds: [Kind.Note], "#t": [topic], limit: 50 }
        : { kinds: [Kind.Note], limit: 50 },
    [topic],
  );
  const { notes, loading } = useFeed(filter, [topic]);

  const submit = async (): Promise<void> => {
    const value = query.trim();
    if (!value) return;

    if (/^npub1/.test(value)) {
      try {
        const decoded = nip19.decode(value);
        if (decoded.type === "npub") {
          navigate("profile", { pubkey: decoded.data });
          return;
        }
      } catch {
        // fall through to a toast below
      }
      toast(`Could not resolve ${value}`, "warn");
      return;
    }

    if (value.includes("@")) {
      toast(`Looking up ${value}…`, "info");
      const pubkey = await resolveNip05(value);
      if (pubkey) {
        navigate("profile", { pubkey });
      } else {
        toast(`Could not resolve ${value}`, "warn");
      }
      return;
    }

    const tag = value.replace(/^#/, "").toLowerCase();
    setTopic(tag);
  };

  return (
    <div style={{ maxWidth: 680, margin: "0 auto", padding: "18px 18px 120px" }}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 11,
          padding: "13px 16px",
          ...glass,
          borderRadius: 12,
          marginBottom: 24,
        }}
      >
        <span style={{ display: "flex", color: "var(--text-3)" }}>
          <SearchIcon size={19} />
        </span>
        <input
          data-testid="search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search a topic, npub, or name@domain…"
          style={{
            flex: 1,
            border: "none",
            background: "transparent",
            outline: "none",
            fontSize: 15,
            color: "var(--text)",
            fontFamily: "inherit",
          }}
        />
      </form>

      <div style={{ marginBottom: 24 }}>
        <h3
          style={{
            margin: "0 0 12px",
            fontFamily: "'Space Grotesk',sans-serif",
            fontSize: 15,
            fontWeight: 700,
            color: "var(--text)",
          }}
        >
          Curate by topic
        </h3>
        <div data-testid="topic-list" style={{ display: "flex", flexWrap: "wrap", gap: 9 }}>
          {TOPICS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTopic((cur) => (cur === t ? null : t))}
              style={chipStyle(topic === t)}
            >
              # {t}
            </button>
          ))}
        </div>
      </div>

      <h3
        style={{
          margin: "0 0 12px",
          fontFamily: "'Space Grotesk',sans-serif",
          fontSize: 15,
          fontWeight: 700,
          color: "var(--text)",
        }}
      >
        {topic ? `#${topic}` : "Recent on Nostr"}
      </h3>

      {loading && notes.length === 0 ? (
        <div style={{ display: "flex", justifyContent: "center", padding: "48px 0" }}>
          <Spinner />
        </div>
      ) : notes.length === 0 ? (
        <EmptyState
          icon={<SearchIcon size={28} />}
          title="Nothing here yet"
          hint={topic ? `No recent posts tagged #${topic}.` : "No recent notes found."}
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {notes.map((note) => (
            <PostCard
              key={note.id}
              note={note}
              onAuthor={() => navigate("profile", { pubkey: note.pubkey })}
            />
          ))}
        </div>
      )}
    </div>
  );
};
