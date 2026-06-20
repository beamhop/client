import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { Filter } from "nostr-tools";
import { useStore, useProfile } from "../state/store.tsx";
import { Kind, DOC_MARKER, type LongForm } from "../nostr/types.ts";
import { decodeLongForm, buildLongForm } from "../nostr/events.ts";
import { renderMarkdown, countWords, readingMinutes } from "../lib/markdown.ts";
import { AuthorChip, EmptyState, Spinner, glass } from "../ui/primitives.tsx";
import { SearchIcon, PlusIcon, DocsIcon, ChevronLeftIcon, CloseIcon } from "../ui/icons.tsx";
import { timeAgo, displayName } from "../lib/format.ts";

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

const readingLabel = (body: string): string => {
  const mins = readingMinutes(countWords(body));
  return `${mins} min read`;
};

const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "doc";

const randomSuffix = (): string => Math.random().toString(36).slice(2, 8);

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

const TagPill = ({ label }: { label: string }): ReactNode => (
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
  const author = displayName({
    name: profile?.name,
    displayName: profile?.displayName,
    pubkey: doc.pubkey,
  });
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
      style={{
        display: "flex",
        gap: 15,
        alignItems: "flex-start",
        width: "100%",
        padding: "17px 18px",
        ...glass,
        borderRadius: 14,
        cursor: "pointer",
        transition: "border-color .15s, background .15s",
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
        <DocsIcon size={20} />
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
          }}
        >
          {doc.title}
        </h3>
        {doc.summary && (
          <p style={{ margin: "5px 0 0", fontSize: 14, lineHeight: 1.5, color: "var(--text-2)" }}>
            {doc.summary}
          </p>
        )}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
            marginTop: 12,
            fontSize: 12.5,
            color: "var(--text-3)",
          }}
        >
          <span>{author}</span>
          <span>· Updated {timeAgo(doc.updatedAt)}</span>
          <span>· {readingLabel(doc.body)}</span>
          {doc.hashtags.map((t) => (
            <TagPill key={t} label={t} />
          ))}
        </div>
      </div>
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
      // Dedupe by pubkey:identifier keeping the newest revision.
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

  return (
    <div data-testid="view-docs" style={{ maxWidth: 920, margin: "0 auto", padding: "6px 22px 120px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 16 }}>
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            gap: 11,
            padding: "12px 15px",
            ...glass,
            borderRadius: 12,
          }}
        >
          <span style={{ display: "flex", color: "var(--text-3)" }}>
            <SearchIcon size={18} />
          </span>
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
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              style={{
                display: "flex",
                padding: 3,
                border: "none",
                borderRadius: "50%",
                background: "var(--glass-2)",
                color: "var(--text-3)",
                cursor: "pointer",
              }}
            >
              <CloseIcon size={13} stroke={2.6} />
            </button>
          )}
        </div>
        <button
          type="button"
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
            whiteSpace: "nowrap",
          }}
        >
          <PlusIcon size={17} stroke={2.4} />
          Write documentation
        </button>
      </div>

      {tags.length > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
            marginBottom: 20,
          }}
        >
          <button type="button" onClick={() => setActiveTag(null)} style={tagChipStyle(activeTag === null)}>
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
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<DocsIcon size={36} stroke={1.6} />}
          title={search || activeTag ? "No matching documentation" : "No documentation yet"}
          hint="Try a different search, or start a new doc."
        />
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
// READER screen
// ---------------------------------------------------------------------------

const DocReader = (): ReactNode => {
  const { state, navigate } = useStore();
  const { id, pubkey } = state.nav.params;
  const doc = useResolveDoc(pubkey, id);

  const rendered = useMemo(() => renderMarkdown(doc?.body ?? ""), [doc?.body]);

  if (!doc) {
    return (
      <div style={{ display: "flex", justifyContent: "center", padding: "80px 0" }}>
        <Spinner />
      </div>
    );
  }

  const isMine = doc.pubkey === state.identity?.pubkey;

  return (
    <div data-testid="view-doc-reader">
      <div
        style={{
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
        }}
      >
        <button
          type="button"
          onClick={() => navigate("docs")}
          style={{
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
          }}
        >
          <ChevronLeftIcon size={17} />
          Docs
        </button>
        <div style={{ flex: 1 }} />
        {isMine && (
          <button
            type="button"
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
            }}
          >
            Edit
          </button>
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
                <TagPill key={t} label={t} />
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
            }}
          >
            {doc.title}
          </h1>
          {doc.summary && (
            <p style={{ margin: "14px 0 0", fontSize: 18, lineHeight: 1.5, color: "var(--text-2)" }}>
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
            <AuthorChip
              pubkey={doc.pubkey}
              size={40}
              subtitle={`Updated ${timeAgo(doc.updatedAt)} · ${readingLabel(doc.body)}`}
            />
          </div>
          <div
            className="vy-prose"
            style={{ marginTop: 28 }}
            dangerouslySetInnerHTML={{ __html: rendered.html }}
          />
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
            <nav
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 1,
                borderLeft: "1px solid var(--glass-border)",
              }}
            >
              {rendered.toc.map((h) => (
                <button
                  key={h.id}
                  type="button"
                  onClick={() =>
                    document.getElementById(h.id)?.scrollIntoView({ behavior: "smooth", block: "start" })
                  }
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

const fieldStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  border: "1px solid var(--glass-border)",
  borderRadius: 10,
  background: "var(--glass)",
  outline: "none",
  color: "var(--text)",
  fontFamily: "inherit",
  fontSize: 15,
  padding: "11px 14px",
};

const DocEditor = (): ReactNode => {
  const { state, navigate, publish, toast } = useStore();
  const own = state.identity?.pubkey;
  const editingId = state.nav.params.id;
  const existing = useResolveDoc(editingId ? own : undefined, editingId);

  const [identifier, setIdentifier] = useState<string | null>(editingId ?? null);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [body, setBody] = useState("");
  const [image, setImage] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [preview, setPreview] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const prefilled = useRef(false);

  // Prefill once the existing doc resolves (edit mode).
  useEffect(() => {
    if (!editingId || !existing || prefilled.current) return;
    prefilled.current = true;
    setIdentifier(existing.identifier);
    setTitle(existing.title);
    setSummary(existing.summary);
    setBody(existing.body);
    setImage(existing.image ?? "");
    setTags(existing.hashtags);
  }, [editingId, existing]);

  const rendered = useMemo(() => (preview ? renderMarkdown(body) : null), [preview, body]);
  const words = useMemo(() => countWords(body), [body]);
  const mins = readingMinutes(words);

  const addTag = (raw: string): void => {
    const t = raw.trim().replace(/^#/, "").toLowerCase();
    if (!t) return;
    setTags((cur) => (cur.includes(t) ? cur : [...cur, t]));
    setTagInput("");
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
    setPublishing(true);
    try {
      await publish(
        buildLongForm({
          identifier: ident,
          title: cleanTitle,
          summary: summary.trim(),
          body,
          image: image.trim() || undefined,
          hashtags: tags,
          kind: "doc",
        }),
      );
      // Refresh the cache so the reader shows the latest immediately.
      cacheDoc({
        id: ident,
        pubkey: own,
        identifier: ident,
        title: cleanTitle,
        summary: summary.trim(),
        image: image.trim() || undefined,
        body,
        publishedAt: Math.floor(Date.now() / 1000),
        updatedAt: Math.floor(Date.now() / 1000),
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

  return (
    <div data-testid="view-doc-editor" style={{ display: "flex", flexDirection: "column" }}>
      <div
        style={{
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
        }}
      >
        <button
          type="button"
          onClick={() => navigate("docs")}
          style={{
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
          }}
        >
          <ChevronLeftIcon size={17} />
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
          <button type="button" onClick={() => setPreview(false)} style={segStyle(!preview)}>
            Edit
          </button>
          <button
            type="button"
            data-testid="doc-mode-preview"
            onClick={() => setPreview(true)}
            style={segStyle(preview)}
          >
            Preview
          </button>
        </div>
        <div style={{ flex: 1 }} />
        <span
          style={{
            fontSize: 12.5,
            color: "var(--text-3)",
            fontVariantNumeric: "tabular-nums",
            whiteSpace: "nowrap",
          }}
        >
          {words} words · {mins} min
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

      <div
        style={{
          maxWidth: 820,
          margin: "0 auto",
          width: "100%",
          padding: "26px 24px 160px",
          boxSizing: "border-box",
        }}
      >
        <input
          data-testid="doc-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Document title"
          style={{
            width: "100%",
            boxSizing: "border-box",
            border: "none",
            background: "transparent",
            outline: "none",
            fontFamily: "'Space Grotesk',sans-serif",
            fontSize: 34,
            lineHeight: 1.2,
            fontWeight: 700,
            letterSpacing: "-.025em",
            color: "var(--text)",
            padding: 0,
            margin: "0 0 12px",
          }}
        />
        <input
          data-testid="doc-description"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="Short description — what this doc covers"
          style={{
            width: "100%",
            boxSizing: "border-box",
            border: "none",
            background: "transparent",
            outline: "none",
            fontFamily: "'Hanken Grotesk',sans-serif",
            fontSize: 16,
            lineHeight: 1.5,
            color: "var(--text-2)",
            padding: 0,
            margin: "0 0 16px",
          }}
        />

        <input
          data-testid="doc-cover"
          value={image}
          onChange={(e) => setImage(e.target.value)}
          placeholder="Cover image URL (optional)"
          style={{ ...fieldStyle, fontSize: 14, marginBottom: 14 }}
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
                <CloseIcon size={12} stroke={2.6} />
              </button>
            </span>
          ))}
          <input
            data-testid="doc-tag-input"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                addTag(tagInput);
              } else if (e.key === "Backspace" && !tagInput && tags.length > 0) {
                setTags((cur) => cur.slice(0, -1));
              }
            }}
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
              data-testid="doc-editor-input"
              className="vy-cm-ta"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              spellCheck={false}
              placeholder={
                "# Write documentation in Markdown\n\nUse ## headings to build the table of contents, **bold**, `code`, lists, > quotes, and tables."
              }
              style={{
                position: "static",
                width: "100%",
                minHeight: 440,
                color: "var(--text)",
                WebkitTextFillColor: "var(--text)",
                caretColor: "var(--accent)",
                background: "var(--glass)",
                borderColor: "var(--glass-border)",
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
