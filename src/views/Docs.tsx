import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { Filter } from "nostr-tools";
import { useStore, useProfile, routeToHash } from "../state/store.tsx";
import { Kind, DOC_MARKER, type LongForm } from "../nostr/types.ts";
import { decodeLongForm, buildLongForm } from "../nostr/events.ts";
import { nowSeconds } from "../nostr/client.ts";
import { renderMarkdown, countWords, readingMinutes } from "../lib/markdown.ts";
import { Spinner } from "../ui/primitives.tsx";
import { avatarStyle, initials, displayName, timeAgo } from "../lib/format.ts";
import { VerifiedSeal } from "../ui/icons.tsx";

/**
 * Module-level cache of resolved docs keyed by `pubkey:identifier`. The reader
 * and editor read from here so opening a doc straight from the list is instant,
 * and a fetched doc populates it for the other screens.
 */
const docCache = new Map<string, LongForm>();
const cacheKey = (pubkey: string, identifier: string): string => `${pubkey}:${identifier}`;
const cacheDoc = (doc: LongForm): void => {
  const key = cacheKey(doc.pubkey, doc.identifier);
  const prev = docCache.get(key);
  if (!prev || doc.updatedAt >= prev.updatedAt) docCache.set(key, doc);
};

const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "doc";

const randomSuffix = (): string => Math.random().toString(36).slice(2, 8);

const readLabel = (body: string): string => `${readingMinutes(countWords(body))} min read`;

// ---------------------------------------------------------------------------
// Local SVG glyphs (design-exact; not in the shared icon set)
// ---------------------------------------------------------------------------

const SearchGlyph = (): ReactNode => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />
  </svg>
);
const CloseGlyph = ({ size }: { size: number }): ReactNode => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);
const PlusGlyph = (): ReactNode => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 5v14M5 12h14" />
  </svg>
);
const FileGlyph = ({ size }: { size: number }): ReactNode => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 4a2 2 0 0 1 2-2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
    <path d="M14 2v6h6" />
  </svg>
);
const EmptyFileGlyph = (): ReactNode => (
  <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 13, opacity: 0.55 }}>
    <path d="M4 4a2 2 0 0 1 2-2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
    <path d="M14 2v6h6M9 13h6M9 17h6" />
  </svg>
);
const ChevronRightGlyph = (): ReactNode => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 4 }}>
    <path d="m9 6 6 6-6 6" />
  </svg>
);
const ChevronLeftGlyph = (): ReactNode => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="m15 18-6-6 6-6" />
  </svg>
);
const ShareGlyph = (): ReactNode => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" />
    <path d="M16 6l-4-4-4 4M12 2v13" />
  </svg>
);
const PencilGlyph = ({ size }: { size: number }): ReactNode => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
  </svg>
);
const TrashGlyph = (): ReactNode => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
  </svg>
);
const EyeGlyph = (): ReactNode => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);
const TagGlyph = (): ReactNode => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
    <path d="M20.6 13.3 11.3 22a2 2 0 0 1-2.8 0l-5.7-5.7a2 2 0 0 1 0-2.8L12 4.3a2 2 0 0 1 1.6-.6l5.2.4a2 2 0 0 1 1.9 1.9l.4 5.2a2 2 0 0 1-.5 1.5z" />
    <circle cx="16" cy="8" r="1.2" fill="currentColor" />
  </svg>
);

// ---------------------------------------------------------------------------
// Shared: resolve a doc from cache or network
// ---------------------------------------------------------------------------

const useResolveDoc = (pubkey: string | undefined, identifier: string | undefined): LongForm | null => {
  const { client, readRelayUrls } = useStore();
  const cached = pubkey && identifier ? docCache.get(cacheKey(pubkey, identifier)) : undefined;
  const [doc, setDoc] = useState<LongForm | null>(cached ?? null);

  useEffect(() => {
    if (!pubkey || !identifier) return;
    const hit = docCache.get(cacheKey(pubkey, identifier));
    if (hit) {
      setDoc(hit);
      return;
    }
    let cancelled = false;
    void (async () => {
      const event = await client.get(readRelayUrls, {
        kinds: [Kind.LongForm],
        authors: [pubkey],
        "#d": [identifier],
      } satisfies Filter);
      if (cancelled || !event) return;
      const resolved = decodeLongForm(event);
      cacheDoc(resolved);
      setDoc(resolved);
    })();
    return () => {
      cancelled = true;
    };
  }, [client, readRelayUrls, pubkey, identifier]);

  return doc;
};

// ---------------------------------------------------------------------------
// LIST screen
// ---------------------------------------------------------------------------

const tagChipStyle = (active: boolean): CSSProperties => ({
  padding: "7px 13px",
  border: `1px solid ${active ? "var(--accent)" : "var(--glass-border)"}`,
  borderRadius: 999,
  background: active ? "var(--accent-soft)" : "var(--glass)",
  color: active ? "var(--accent)" : "var(--text-2)",
  fontWeight: 700,
  fontSize: 13,
  fontFamily: "inherit",
  cursor: "pointer",
  transition: "all .15s",
});

const CardTagPill = ({ label }: { label: string }): ReactNode => (
  <span
    style={{
      fontSize: 11.5,
      fontWeight: 700,
      color: "var(--accent)",
      background: "var(--accent-soft)",
      padding: "3px 9px",
      borderRadius: 999,
    }}
  >
    #{label}
  </span>
);

const DocCard = ({ doc, onOpen }: { doc: LongForm; onOpen: () => void }): ReactNode => {
  const profile = useProfile(doc.pubkey);
  const [hover, setHover] = useState(false);
  const author = displayName({ name: profile?.name, displayName: profile?.displayName, pubkey: doc.pubkey });

  return (
    <div
      data-testid="doc-card"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        gap: 15,
        alignItems: "flex-start",
        textAlign: "left",
        width: "100%",
        padding: "17px 18px",
        border: `1px solid ${hover ? "var(--text-3)" : "var(--glass-border)"}`,
        borderRadius: 14,
        background: hover ? "var(--glass-2)" : "var(--glass)",
        cursor: "pointer",
        transition: "border-color .15s, background .15s, transform .15s",
        fontFamily: "inherit",
      }}
    >
      <span
        style={{
          width: 42,
          height: 42,
          minWidth: 42,
          borderRadius: 11,
          background: "var(--accent-soft)",
          color: "var(--accent)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <FileGlyph size={20} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <h3
          style={{
            margin: 0,
            fontFamily: "'Space Grotesk',sans-serif",
            fontSize: 17,
            lineHeight: 1.3,
            fontWeight: 700,
            letterSpacing: "-.012em",
            color: "var(--text)",
            textWrap: "pretty",
          }}
        >
          {doc.title}
        </h3>
        {doc.summary && (
          <p
            style={{
              margin: "5px 0 0",
              fontSize: 14,
              lineHeight: 1.5,
              color: "var(--text-2)",
              textWrap: "pretty",
            }}
          >
            {doc.summary}
          </p>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 12 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12.5, color: "var(--text-3)" }}>
            <span style={avatarStyle(doc.pubkey, 24, profile?.picture)}>
              {!profile?.picture && initials(author)}
            </span>
            {author}
          </span>
          <span style={{ fontSize: 12.5, color: "var(--text-3)" }}>· Updated {timeAgo(doc.updatedAt)}</span>
          {doc.hashtags.map((t) => (
            <CardTagPill key={t} label={t} />
          ))}
        </div>
      </div>
      <ChevronRightGlyph />
    </div>
  );
};

const DocsList = (): ReactNode => {
  const { client, readRelayUrls, navigate } = useStore();
  const [docs, setDocs] = useState<LongForm[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);

  useEffect(() => {
    if (readRelayUrls.length === 0) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const events = await client.list(readRelayUrls, {
        kinds: [Kind.LongForm],
        "#t": [DOC_MARKER],
        limit: 100,
      });
      if (cancelled) return;
      const byKey = new Map<string, LongForm>();
      for (const event of events) {
        const doc = decodeLongForm(event);
        const key = cacheKey(doc.pubkey, doc.identifier);
        const prev = byKey.get(key);
        if (!prev || doc.updatedAt > prev.updatedAt) byKey.set(key, doc);
      }
      const list = [...byKey.values()].sort((a, b) => b.updatedAt - a.updatedAt);
      for (const doc of list) cacheDoc(doc);
      setDocs(list);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [client, readRelayUrls]);

  const tags = useMemo(() => {
    const set = new Set<string>();
    for (const doc of docs) for (const t of doc.hashtags) set.add(t);
    return [...set].sort();
  }, [docs]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return docs.filter((doc) => {
      if (activeTag && !doc.hashtags.includes(activeTag)) return false;
      if (!q) return true;
      return (
        doc.title.toLowerCase().includes(q) ||
        doc.summary.toLowerCase().includes(q) ||
        doc.body.toLowerCase().includes(q)
      );
    });
  }, [docs, search, activeTag]);

  const searchActive = search.trim().length > 0;
  const isEmpty = !loading && filtered.length === 0;
  const emptyLabel = searchActive || activeTag ? "No matching documentation" : "No documentation yet";

  return (
    <div data-testid="view-docs" data-screen-label="Docs" style={{ maxWidth: 920, margin: "0 auto", padding: "6px 22px 120px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 16 }}>
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            gap: 11,
            padding: "12px 15px",
            background: "var(--glass)",
            border: "1px solid var(--glass-border)",
            borderRadius: 12,
            boxShadow: "var(--glass-shadow)",
          }}
        >
          <SearchGlyph />
          <input
            data-testid="doc-search-input"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search documentation…"
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
          {searchActive && (
            <button
              type="button"
              data-testid="doc-search-clear"
              onClick={() => setSearch("")}
              style={{
                display: "flex",
                padding: 3,
                border: "none",
                borderRadius: "50%",
                background: "var(--glass-2)",
                color: "var(--text-3)",
                cursor: "pointer",
                transition: "all .15s",
              }}
            >
              <CloseGlyph size={13} />
            </button>
          )}
        </div>
        <button
          type="button"
          data-testid="new-doc-button"
          onClick={() => navigate("docEditor")}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "12px 17px",
            border: "1px solid rgba(255,255,255,.3)",
            borderRadius: 12,
            background: "var(--accent)",
            color: "var(--on-accent)",
            fontWeight: 700,
            fontSize: 14,
            fontFamily: "inherit",
            cursor: "pointer",
            transition: "all .18s",
            whiteSpace: "nowrap",
          }}
        >
          <PlusGlyph />
          New doc
        </button>
      </div>

      {tags.length > 0 && (
        <div data-testid="doc-tag-filter" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 20 }}>
          <button type="button" data-testid="doc-tag-all" onClick={() => setActiveTag(null)} style={tagChipStyle(activeTag === null)}>
            All
          </button>
          {tags.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setActiveTag((cur) => (cur === t ? null : t))}
              style={tagChipStyle(activeTag === t)}
            >
              #{t}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div style={{ display: "flex", justifyContent: "center", padding: "60px 0" }}>
          <Spinner />
        </div>
      ) : isEmpty ? (
        <div data-testid="docs-empty" style={{ textAlign: "center", padding: "72px 20px", color: "var(--text-3)" }}>
          <EmptyFileGlyph />
          <p style={{ margin: 0, fontSize: 15.5, fontWeight: 700, color: "var(--text-2)", fontFamily: "'Space Grotesk',sans-serif" }}>
            {emptyLabel}
          </p>
          <p style={{ margin: "5px 0 0", fontSize: 13.5 }}>Try a different search, or start a new doc.</p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {filtered.map((doc) => (
            <DocCard
              key={cacheKey(doc.pubkey, doc.identifier)}
              doc={doc}
              onOpen={() => navigate("docReader", { id: doc.identifier, pubkey: doc.pubkey })}
            />
          ))}
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// READER screen
// ---------------------------------------------------------------------------

const toolbarStyle: CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 9,
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "13px 22px",
  background: "color-mix(in srgb, var(--bg-base) 88%, transparent)",
  backdropFilter: "blur(8px)",
  WebkitBackdropFilter: "blur(8px)",
  borderBottom: "1px solid var(--hairline)",
};

const backButtonStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 7,
  padding: "8px 12px",
  border: "none",
  borderRadius: 9,
  background: "transparent",
  color: "var(--text-2)",
  fontWeight: 700,
  fontSize: 13.5,
  fontFamily: "inherit",
  cursor: "pointer",
  transition: "background .15s",
};

const iconButtonStyle: CSSProperties = {
  display: "flex",
  padding: 9,
  border: "none",
  borderRadius: 9,
  background: "transparent",
  color: "var(--text-2)",
  cursor: "pointer",
};

const ReaderTagPill = ({ label }: { label: string }): ReactNode => (
  <span
    style={{
      fontSize: 12.5,
      fontWeight: 700,
      color: "var(--accent)",
      background: "var(--accent-soft)",
      padding: "4px 11px",
      borderRadius: 999,
    }}
  >
    #{label}
  </span>
);

const DocReader = (): ReactNode => {
  const { state, navigate, publish, toast } = useStore();
  const { id, pubkey } = state.nav.params;
  const doc = useResolveDoc(pubkey, id);
  const profile = useProfile(doc?.pubkey);

  const rendered = useMemo(() => renderMarkdown(doc?.body ?? ""), [doc?.body]);

  if (!doc) {
    return (
      <div style={{ display: "flex", justifyContent: "center", padding: "80px 0" }}>
        <Spinner />
      </div>
    );
  }

  const isMine = doc.pubkey === state.identity?.pubkey;
  const author = displayName({ name: profile?.name, displayName: profile?.displayName, pubkey: doc.pubkey });
  const verified = Boolean(profile?.nip05);

  const onShare = async (): Promise<void> => {
    const link = `${location.origin}${location.pathname}${location.search}${routeToHash({
      view: "docReader",
      params: { id: doc.identifier, pubkey: doc.pubkey },
    })}`;
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      // Clipboard may be unavailable; the toast still confirms intent.
    }
    toast("Doc link copied", "copy");
  };

  const onDelete = async (): Promise<void> => {
    try {
      await publish({
        kind: 5,
        created_at: nowSeconds(),
        tags: [["a", `${Kind.LongForm}:${doc.pubkey}:${doc.identifier}`]],
        content: "",
      });
      docCache.delete(cacheKey(doc.pubkey, doc.identifier));
      toast("Doc deleted", "check");
      navigate("docs");
    } catch {
      toast("Could not delete doc", "warn");
    }
  };

  return (
    <div data-testid="view-doc-reader">
      <div style={toolbarStyle}>
        <button type="button" data-testid="doc-reader-back" onClick={() => navigate("docs")} style={backButtonStyle}>
          <ChevronLeftGlyph />
          Docs
        </button>
        <div style={{ flex: 1 }} />
        <button type="button" onClick={() => void onShare()} title="Copy link" style={iconButtonStyle}>
          <ShareGlyph />
        </button>
        {isMine && (
          <>
            <button
              type="button"
              data-testid="doc-reader-edit"
              onClick={() => navigate("docEditor", { id: doc.identifier })}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                padding: "8px 14px",
                border: "1px solid var(--glass-border)",
                borderRadius: 9,
                background: "var(--glass)",
                color: "var(--text)",
                fontWeight: 700,
                fontSize: 13,
                fontFamily: "inherit",
                cursor: "pointer",
                transition: "background .15s",
              }}
            >
              <PencilGlyph size={14} />
              Edit
            </button>
            <button
              type="button"
              data-testid="doc-reader-delete"
              onClick={() => void onDelete()}
              title="Delete doc"
              style={{ ...iconButtonStyle, color: "var(--text-3)" }}
            >
              <TrashGlyph />
            </button>
          </>
        )}
      </div>

      <div
        style={{
          maxWidth: 1040,
          margin: "0 auto",
          padding: "34px 24px 130px",
          display: "flex",
          gap: 44,
          alignItems: "flex-start",
        }}
      >
        <article style={{ flex: 1, minWidth: 0, maxWidth: 720 }}>
          {doc.hashtags.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
              {doc.hashtags.map((t) => (
                <ReaderTagPill key={t} label={t} />
              ))}
            </div>
          )}
          <h1
            data-testid="doc-reader-title"
            style={{
              margin: 0,
              fontFamily: "'Space Grotesk',sans-serif",
              fontSize: 38,
              lineHeight: 1.15,
              fontWeight: 700,
              letterSpacing: "-.026em",
              color: "var(--text)",
              textWrap: "balance",
            }}
          >
            {doc.title}
          </h1>
          {doc.summary && (
            <p style={{ margin: "14px 0 0", fontSize: 18, lineHeight: 1.5, color: "var(--text-2)", textWrap: "pretty" }}>
              {doc.summary}
            </p>
          )}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              margin: "24px 0 0",
              paddingBottom: 24,
              borderBottom: "1px solid var(--hairline)",
            }}
          >
            <span style={avatarStyle(doc.pubkey, 40, profile?.picture)}>
              {!profile?.picture && initials(author)}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontWeight: 700, fontSize: 14.5, color: "var(--text)" }}>{author}</span>
                {verified && <VerifiedSeal size={14} />}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "var(--text-3)", marginTop: 2 }}>
                <span>Updated {timeAgo(doc.updatedAt)}</span>
                <span>·</span>
                <span>{readLabel(doc.body)}</span>
              </div>
            </div>
          </div>
          <div className="vy-prose" style={{ marginTop: 28 }} dangerouslySetInnerHTML={{ __html: rendered.html }} />
        </article>

        {rendered.toc.length > 0 && (
          <aside
            className="vy-doc-toc-aside"
            data-testid="doc-toc"
            style={{ position: "sticky", top: 96, alignSelf: "flex-start" }}
          >
            <div
              style={{
                fontSize: 11,
                fontWeight: 800,
                letterSpacing: ".07em",
                textTransform: "uppercase",
                color: "var(--text-3)",
                marginBottom: 11,
                paddingLeft: 14,
              }}
            >
              On this page
            </div>
            <nav style={{ display: "flex", flexDirection: "column", gap: 1, borderLeft: "1px solid var(--glass-border)" }}>
              {rendered.toc.map((h) => (
                <button
                  key={h.id}
                  type="button"
                  onClick={() => document.getElementById(h.id)?.scrollIntoView({ behavior: "smooth", block: "start" })}
                  style={{
                    textAlign: "left",
                    padding: "5px 12px",
                    paddingLeft: h.level >= 3 ? 24 : 14,
                    border: "none",
                    borderLeft: "2px solid transparent",
                    marginLeft: -1,
                    background: "transparent",
                    color: "var(--text-3)",
                    fontSize: 13,
                    fontFamily: "inherit",
                    cursor: "pointer",
                  }}
                >
                  {h.text}
                </button>
              ))}
            </nav>
          </aside>
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// EDITOR screen
// ---------------------------------------------------------------------------

const segStyle = (active: boolean): CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 12px",
  border: "none",
  borderRadius: 8,
  background: active ? "var(--glass)" : "transparent",
  color: active ? "var(--text)" : "var(--text-3)",
  fontWeight: 700,
  fontSize: 13,
  fontFamily: "inherit",
  cursor: "pointer",
  boxShadow: active ? "var(--glass-shadow)" : "none",
});

const DocEditor = (): ReactNode => {
  const { state, navigate, publish, toast } = useStore();
  const own = state.identity?.pubkey;
  const editingId = state.nav.params.id;
  const existing = useResolveDoc(editingId ? own : undefined, editingId);

  const [identifier, setIdentifier] = useState<string | null>(editingId ?? null);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [body, setBody] = useState("");
  const [image, setImage] = useState<string | undefined>(undefined);
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [preview, setPreview] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const prefilled = useRef(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // Prefill once the existing doc resolves (edit mode).
  useEffect(() => {
    if (!editingId || !existing || prefilled.current) return;
    prefilled.current = true;
    setIdentifier(existing.identifier);
    setTitle(existing.title);
    setSummary(existing.summary);
    setBody(existing.body);
    setImage(existing.image);
    setTags(existing.hashtags);
  }, [editingId, existing]);

  // Cmd/Ctrl+E toggles preview while on the editor.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "e") {
        e.preventDefault();
        setPreview((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const rendered = useMemo(() => (preview ? renderMarkdown(body) : null), [preview, body]);
  const words = useMemo(() => countWords(body), [body]);
  const mins = readingMinutes(words);

  const addTag = (raw: string): void => {
    const t = raw.trim().replace(/^#/, "").toLowerCase();
    if (!t) {
      setTagInput("");
      return;
    }
    setTags((cur) => (cur.includes(t) ? cur : [...cur, t]));
    setTagInput("");
  };

  const onTagKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTag(tagInput);
    } else if (e.key === "Backspace" && !tagInput && tags.length > 0) {
      setTags((cur) => cur.slice(0, -1));
    }
  };

  const onScroll = (): void => {
    // No syntax-highlight underlay is rendered; the textarea owns its own scroll.
  };

  const onPublish = async (): Promise<void> => {
    if (!own) {
      toast("Sign in first", "warn");
      return;
    }
    const cleanTitle = title.trim();
    if (!cleanTitle) {
      toast("Add a title first", "warn");
      return;
    }
    const ident = identifier ?? `${slugify(cleanTitle)}-${randomSuffix()}`;
    const trimmedImage = image?.trim() || undefined;
    setPublishing(true);
    try {
      await publish(
        buildLongForm({
          identifier: ident,
          title: cleanTitle,
          summary: summary.trim(),
          body,
          image: trimmedImage,
          hashtags: tags,
          kind: "doc",
        }),
      );
      cacheDoc({
        id: ident,
        pubkey: own,
        identifier: ident,
        title: cleanTitle,
        summary: summary.trim(),
        image: trimmedImage,
        body,
        publishedAt: nowSeconds(),
        updatedAt: nowSeconds(),
        hashtags: tags,
        kind: "doc",
      });
      toast("Documentation published", "check");
      navigate("docReader", { id: ident, pubkey: own });
    } catch {
      toast("Could not publish documentation", "warn");
    } finally {
      setPublishing(false);
    }
  };

  const fieldBase: CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    border: "none",
    background: "transparent",
    resize: "none",
    outline: "none",
    padding: 0,
    overflow: "hidden",
  };

  return (
    <div data-testid="view-doc-editor" data-screen-label="Doc editor" style={{ display: "flex", flexDirection: "column" }}>
      <div style={toolbarStyle}>
        <button type="button" data-testid="doc-editor-cancel" onClick={() => navigate("docs")} style={backButtonStyle}>
          <ChevronLeftGlyph />
          Cancel
        </button>
        <div style={{ flex: 1 }} />
        <div
          role="tablist"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            padding: 4,
            background: "var(--glass-2)",
            border: "1px solid var(--glass-border)",
            borderRadius: 11,
          }}
        >
          <button type="button" data-testid="doc-mode-edit" onClick={() => setPreview(false)} style={segStyle(!preview)}>
            <PencilGlyph size={15} />
            Edit
          </button>
          <button type="button" data-testid="doc-mode-preview" onClick={() => setPreview(true)} style={segStyle(preview)}>
            <EyeGlyph />
            Preview
          </button>
        </div>
        <span
          style={{
            fontSize: 11,
            color: "var(--text-3)",
            background: "var(--glass-2)",
            padding: "4px 8px",
            borderRadius: 7,
            fontFamily: "'JetBrains Mono',monospace",
            whiteSpace: "nowrap",
          }}
        >
          ⌘E
        </span>
        <div style={{ flex: 1 }} />
        <span
          style={{
            fontSize: 12.5,
            color: "var(--text-3)",
            fontVariantNumeric: "tabular-nums",
            whiteSpace: "nowrap",
          }}
        >
          {words.toLocaleString()} words · {mins} min
        </span>
        <button
          type="button"
          data-testid="doc-publish"
          onClick={() => void onPublish()}
          disabled={publishing}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            padding: "9px 16px",
            border: "1px solid rgba(255,255,255,.3)",
            borderRadius: 9,
            background: "var(--accent)",
            color: "var(--on-accent)",
            fontWeight: 700,
            fontSize: 13.5,
            fontFamily: "inherit",
            cursor: publishing ? "not-allowed" : "pointer",
            opacity: publishing ? 0.6 : 1,
            whiteSpace: "nowrap",
          }}
        >
          {publishing ? "Publishing…" : "Publish"}
        </button>
      </div>

      <div style={{ maxWidth: 820, margin: "0 auto", width: "100%", padding: "26px 24px 160px", boxSizing: "border-box" }}>
        <textarea
          data-testid="doc-title"
          rows={1}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Document title"
          style={{
            ...fieldBase,
            fontFamily: "'Space Grotesk',sans-serif",
            fontSize: 34,
            lineHeight: 1.2,
            fontWeight: 700,
            letterSpacing: "-.025em",
            color: "var(--text)",
            margin: "0 0 12px",
            fieldSizing: "content",
          } as CSSProperties}
        />
        <textarea
          data-testid="doc-description"
          rows={1}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="Short description — what this doc covers"
          style={{
            ...fieldBase,
            fontFamily: "'Hanken Grotesk',sans-serif",
            fontSize: 16,
            lineHeight: 1.5,
            color: "var(--text-2)",
            margin: "0 0 16px",
            fieldSizing: "content",
          } as CSSProperties}
        />

        <div
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 8,
            paddingBottom: 18,
            borderBottom: "1px solid var(--hairline)",
          }}
        >
          <TagGlyph />
          {tags.map((t) => (
            <span
              key={t}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "5px 6px 5px 11px",
                borderRadius: 999,
                background: "var(--accent-soft)",
                color: "var(--accent)",
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              #{t}
              <button
                type="button"
                onClick={() => setTags((cur) => cur.filter((x) => x !== t))}
                style={{
                  display: "flex",
                  padding: 2,
                  border: "none",
                  borderRadius: "50%",
                  background: "transparent",
                  color: "var(--accent)",
                  cursor: "pointer",
                  opacity: 0.7,
                }}
              >
                <CloseGlyph size={12} />
              </button>
            </span>
          ))}
          <input
            data-testid="doc-tag-input"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={onTagKey}
            onBlur={() => addTag(tagInput)}
            placeholder="Add a tag…"
            style={{
              flex: 1,
              minWidth: 120,
              border: "none",
              background: "transparent",
              outline: "none",
              fontSize: 14,
              color: "var(--text)",
              fontFamily: "inherit",
              padding: "5px 2px",
            }}
          />
        </div>

        {preview ? (
          <div
            data-testid="doc-preview"
            className="vy-prose"
            style={{
              marginTop: 18,
              padding: "24px 26px",
              border: "1px solid var(--glass-border)",
              borderRadius: 13,
              background: "var(--glass)",
            }}
            dangerouslySetInnerHTML={{ __html: rendered?.html ?? "" }}
          />
        ) : (
          <div className="vy-cm" style={{ marginTop: 18 }}>
            <textarea
              ref={taRef}
              data-testid="doc-editor-input"
              className="vy-cm-pre"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onScroll={onScroll}
              spellCheck={false}
              placeholder={
                "# Write documentation in Markdown\n\nUse ## headings to build the table of contents, **bold**, `code`, lists, > quotes, and tables."
              }
              style={{
                display: "block",
                width: "100%",
                resize: "none",
                outline: "none",
                fontFamily: "'JetBrains Mono',monospace",
                fontSize: 14,
                lineHeight: 1.7,
                whiteSpace: "pre-wrap",
                overflowWrap: "break-word",
                wordBreak: "break-word",
                tabSize: 2,
                caretColor: "var(--accent)",
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const DocsView = (): ReactNode => {
  const { state } = useStore();
  switch (state.nav.view) {
    case "docReader":
      return <DocReader />;
    case "docEditor":
      return <DocEditor />;
    default:
      return <DocsList />;
  }
};
