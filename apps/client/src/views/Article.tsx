import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { Filter } from "nostr-tools";
import { useStore, useProfile, routeToHash } from "@beamhop/state";
import { Kind, type LongForm } from "@beamhop/nostr";
import { decodeLongForm, buildLongForm } from "@beamhop/nostr";
import { renderMarkdown, countWords, readingMinutes } from "@beamhop/lib";
import { Avatar, Spinner } from "../ui/primitives.tsx";
import { VerifiedSeal } from "../ui/icons.tsx";
import { EventJsonButton } from "../ui/EventJsonModal.tsx";
import { timeAgo, fmtCount, displayName } from "@beamhop/lib";
import { PALETTES } from "@beamhop/lib";
import { segStyle } from "../ui/styles.ts";

// ---------------------------------------------------------------------------
// Module cache: resolved articles keyed by `pubkey:identifier`. The reader and
// editor read from here so opening straight from a list is instant, and a
// freshly-published article populates it for the reader.
// ---------------------------------------------------------------------------

const articleCache = new Map<string, LongForm>();
const cacheKey = (pubkey: string, identifier: string): string => `${pubkey}:${identifier}`;
const cacheArticle = (article: LongForm): void => {
  const key = cacheKey(article.pubkey, article.identifier);
  const prev = articleCache.get(key);
  if (!prev || article.updatedAt >= prev.updatedAt) articleCache.set(key, article);
};

const addressOf = (pubkey: string, identifier: string): string =>
  `${Kind.LongForm}:${pubkey}:${identifier}`;

const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "article";

const randomSuffix = (): string => Math.random().toString(36).slice(2, 8);

const coverIsImageString = (cover: string): boolean =>
  /^(url\(|https?:|data:)/i.test(cover.trim());

// ---------------------------------------------------------------------------
// Resolve an article from cache or the network (kind-agnostic, same as Docs).
// ---------------------------------------------------------------------------

const useResolveArticle = (
  pubkey: string | undefined,
  identifier: string | undefined,
): LongForm | null => {
  const { client, readRelayUrls } = useStore();
  const cached = pubkey && identifier ? articleCache.get(cacheKey(pubkey, identifier)) : undefined;
  const [article, setArticle] = useState<LongForm | null>(cached ?? null);

  useEffect(() => {
    if (!pubkey || !identifier) return;
    const hit = articleCache.get(cacheKey(pubkey, identifier));
    if (hit) {
      setArticle(hit);
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
      cacheArticle(resolved);
      setArticle(resolved);
    })();
    return () => {
      cancelled = true;
    };
  }, [client, readRelayUrls, pubkey, identifier]);

  return article;
};

// ---------------------------------------------------------------------------
// Article engagement: addressable reactions/replies via the `a`-tag, distinct
// from the note-flavored useEngagement which keys on `#e`.
// ---------------------------------------------------------------------------

type ArticleStats = { likes: number; liked: boolean; comments: number; likedEventId?: string };

const useArticleStats = (
  pubkey: string | undefined,
  identifier: string | undefined,
  optimistic: Partial<ArticleStats>,
): ArticleStats => {
  const { client, readRelayUrls, state } = useStore();
  const me = state.identity?.pubkey;
  const [stats, setStats] = useState<ArticleStats>({ likes: 0, liked: false, comments: 0 });
  const address = pubkey && identifier ? addressOf(pubkey, identifier) : undefined;

  useEffect(() => {
    if (!address || readRelayUrls.length === 0) return;
    let cancelled = false;
    void (async () => {
      const events = await client.list(readRelayUrls, {
        kinds: [Kind.Reaction, Kind.Note],
        "#a": [address],
      } satisfies Filter);
      if (cancelled) return;
      let likes = 0;
      let liked = false;
      let likedEventId: string | undefined;
      let comments = 0;
      for (const ev of events) {
        if (ev.kind === Kind.Reaction && ev.content !== "-") {
          likes++;
          if (ev.pubkey === me) {
            liked = true;
            likedEventId = ev.id;
          }
        } else if (ev.kind === Kind.Note) {
          comments++;
        }
      }
      setStats({ likes, liked, comments, likedEventId });
    })();
    return () => {
      cancelled = true;
    };
  }, [client, readRelayUrls, address, me]);

  return {
    likes: optimistic.likes ?? stats.likes,
    liked: optimistic.liked ?? stats.liked,
    comments: optimistic.comments ?? stats.comments,
    likedEventId: optimistic.likedEventId ?? stats.likedEventId,
  };
};

// ---------------------------------------------------------------------------
// Shared styles / glyphs
// ---------------------------------------------------------------------------

const topBarStyle: CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 9,
  display: "flex",
  alignItems: "center",
  gap: 12,
  flexWrap: "wrap",
  padding: "13px 22px",
  background: "color-mix(in srgb, var(--bg-base) 88%, transparent)",
  backdropFilter: "blur(8px)",
  WebkitBackdropFilter: "blur(8px)",
  borderBottom: "1px solid var(--hairline)",
};

const chevronButtonStyle: CSSProperties = {
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

const ChevronLeft = (): ReactNode => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="m15 18-6-6 6-6" />
  </svg>
);

const ShareTray = (): ReactNode => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" />
    <path d="M16 6l-4-4-4 4M12 2v13" />
  </svg>
);

// ---------------------------------------------------------------------------
// READER
// ---------------------------------------------------------------------------

const readerTagStyle: CSSProperties = {
  fontSize: 12.5,
  fontWeight: 700,
  color: "var(--accent)",
  background: "var(--accent-soft)",
  padding: "4px 11px",
  borderRadius: 999,
};

const ArticleReader = (): ReactNode => {
  const { state, navigate, goBack, publish, toast } = useStore();
  const { pubkey } = state.nav.params;
  const id = state.nav.params.id ?? state.nav.params.identifier;
  const article = useResolveArticle(pubkey, id);
  const profile = useProfile(pubkey);
  const [optimistic, setOptimistic] = useState<Partial<ArticleStats>>({});
  const stats = useArticleStats(pubkey, id, optimistic);

  const rendered = useMemo(() => renderMarkdown(article?.body ?? ""), [article?.body]);

  const copyShareLink = useCallback(() => {
    if (!article) return;
    const link = `${location.origin}${location.pathname}${location.search}${routeToHash({
      view: "articleReader",
      params: { id: article.identifier, pubkey: article.pubkey },
    })}`;
    void navigator.clipboard?.writeText(link);
    toast("Article link copied to clipboard", "copy");
  }, [article, toast]);

  if (!article) {
    return (
      <div style={{ display: "flex", justifyContent: "center", padding: "80px 0" }}>
        <Spinner />
      </div>
    );
  }

  const isMine = article.pubkey === state.identity?.pubkey;
  const authorName = displayName({
    name: profile?.name,
    displayName: profile?.displayName,
    pubkey: article.pubkey,
  });
  const verified = Boolean(profile?.nip05);
  const handle = profile?.nip05 ?? `${article.pubkey.slice(0, 12)}…`;
  const words = countWords(article.body);
  const readLabel = `${readingMinutes(words)} min read`;

  const onLike = (): void => {
    if (stats.liked) {
      const eventId = stats.likedEventId;
      if (!eventId) return;
      setOptimistic((o) => ({ ...o, liked: false, likes: Math.max(0, stats.likes - 1), likedEventId: undefined }));
      void publish({
        kind: 5,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["e", eventId]],
        content: "",
      })
        .then(() => toast("Unliked", "info"))
        .catch(() => {
          setOptimistic((o) => ({ ...o, liked: true, likes: stats.likes, likedEventId: eventId }));
          toast("Could not unlike article", "warn");
        });
      return;
    }
    setOptimistic((o) => ({ ...o, liked: true, likes: stats.likes + 1 }));
    void publish({
      kind: Kind.Reaction,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["a", addressOf(article.pubkey, article.identifier)],
        ["e", article.id],
        ["p", article.pubkey],
      ],
      content: "+",
    })
      .then((eventId) => {
        toast("Liked", "check");
        setOptimistic((o) => ({ ...o, likedEventId: eventId }));
      })
      .catch(() => {
        setOptimistic((o) => ({ ...o, liked: false, likes: stats.likes }));
        toast("Could not like article", "warn");
      });
  };

  const onDelete = (): void => {
    void publish({
      kind: 5,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["a", addressOf(article.pubkey, article.identifier)],
        ["e", article.id],
      ],
      content: "",
    })
      .then(() => {
        articleCache.delete(cacheKey(article.pubkey, article.identifier));
        toast("Article deleted", "info");
        navigate("home");
      })
      .catch(() => toast("Could not delete article", "warn"));
  };

  return (
    <div data-testid="view-article-reader">
      <div style={topBarStyle}>
        <button type="button" data-testid="reader-back" onClick={goBack} style={chevronButtonStyle}>
          <ChevronLeft />
          Back
        </button>
        <div style={{ flex: 1 }} />
        <EventJsonButton event={article.event} label="Original article event" />
        <button
          type="button"
          title="Copy link"
          onClick={copyShareLink}
          style={{
            display: "flex",
            padding: 9,
            border: "none",
            borderRadius: 9,
            background: "transparent",
            color: "var(--text-2)",
            cursor: "pointer",
            transition: "background .15s",
          }}
        >
          <ShareTray />
        </button>
        {isMine && (
          <>
            <button
              type="button"
              data-testid="reader-edit"
              onClick={() => navigate("articleEditor", { id: article.identifier })}
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
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
              </svg>
              Edit
            </button>
            <button
              type="button"
              data-testid="reader-delete"
              title="Delete article"
              onClick={onDelete}
              style={{
                display: "flex",
                padding: 9,
                border: "none",
                borderRadius: 9,
                background: "transparent",
                color: "var(--text-3)",
                cursor: "pointer",
                transition: "background .15s, color .15s",
              }}
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              </svg>
            </button>
          </>
        )}
      </div>

      <div style={{ maxWidth: 720, margin: "0 auto", padding: "34px 24px 130px" }}>
        {article.hashtags.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 18 }}>
            {article.hashtags.map((t) => (
              <span key={t} style={readerTagStyle}>
                #{t}
              </span>
            ))}
          </div>
        )}

        <h1
          data-testid="reader-title"
          style={{
            margin: 0,
            fontFamily: "'Geist',sans-serif",
            fontSize: 42,
            lineHeight: 1.14,
            fontWeight: 700,
            letterSpacing: "-.028em",
            color: "var(--text)",
            textWrap: "balance",
          }}
        >
          {article.title}
        </h1>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            margin: "26px 0 0",
            paddingBottom: 26,
            borderBottom: "1px solid var(--hairline)",
          }}
        >
          <Avatar
            pubkey={article.pubkey}
            size={44}
            name={authorName}
            picture={profile?.picture}
            onClick={() => navigate("profile", { pubkey: article.pubkey })}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontWeight: 700, fontSize: 15, color: "var(--text)" }}>{authorName}</span>
              {verified && <VerifiedSeal size={15} />}
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 13,
                color: "var(--text-3)",
                marginTop: 2,
              }}
            >
              <span style={{ fontFamily: "'Geist Mono',monospace" }}>{handle}</span>
              <span>·</span>
              <span>{timeAgo(article.publishedAt)}</span>
              <span>·</span>
              <span>{readLabel}</span>
            </div>
          </div>
        </div>

        <div style={{ marginTop: 30 }}>
          <div className="vy-prose" dangerouslySetInnerHTML={{ __html: rendered.html }} />
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            marginTop: 36,
            paddingTop: 22,
            borderTop: "1px solid var(--hairline)",
          }}
        >
          <button
            type="button"
            onClick={onLike}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              padding: "6px 10px",
              borderRadius: 10,
              border: "none",
              background: "transparent",
              cursor: "pointer",
              fontFamily: "inherit",
              fontSize: 13,
              fontWeight: 600,
              color: stats.liked ? "var(--danger)" : "var(--text-3)",
              transition: "color .18s, background .18s",
            }}
          >
            <span style={{ display: "flex" }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill={stats.liked ? "var(--danger)" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20.8 5.6a5.3 5.3 0 0 0-7.5 0L12 6.9l-1.3-1.3a5.3 5.3 0 1 0-7.5 7.5L12 22l8.8-8.9a5.3 5.3 0 0 0 0-7.5z" />
              </svg>
            </span>
            <span>{fmtCount(stats.likes)}</span>
          </button>

          <button
            type="button"
            onClick={copyShareLink}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              padding: "6px 12px",
              borderRadius: 10,
              border: "none",
              background: "transparent",
              color: "var(--text-3)",
              cursor: "pointer",
              fontFamily: "inherit",
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            <ShareTray />
            Share
          </button>

          <div style={{ flex: 1 }} />

          <span style={{ fontSize: 13, color: "var(--text-3)", fontVariantNumeric: "tabular-nums" }}>
            {words.toLocaleString()} words
          </span>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// EDITOR — draft state, live↔markdown bridge, toolbar, cover picker
// ---------------------------------------------------------------------------

type Mode = "live" | "markdown";

const COVER_OPTIONS: readonly string[] = [
  "linear-gradient(120deg,#e0563a,#f0913e 55%,#ef4d6b)",
  "#1b1c20",
  "linear-gradient(120deg,#e0335f,#f5617e 55%,#f59e0b)",
  "linear-gradient(120deg,#0e8f7e,#18b89a 55%,#2f7bd0)",
  "linear-gradient(120deg,#2f5fe0,#1f9be0 55%,#16c8d8)",
  "linear-gradient(120deg,#1b1c20,#3a3d4a)",
  "linear-gradient(120deg,#8b5cf6,#ec4899)",
];


const swatchStyle = (grad: string, sel: boolean): CSSProperties => ({
  width: 32,
  height: 32,
  borderRadius: 8,
  cursor: "pointer",
  flexShrink: 0,
  padding: 0,
  background: grad,
  border: sel ? "2px solid var(--accent)" : "2px solid transparent",
  boxShadow: sel
    ? "0 0 0 2px var(--bg-base) inset, 0 0 0 1px var(--glass-border)"
    : "inset 0 0 0 1px var(--glass-border)",
  transition: "transform .12s",
});

const tbBaseStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: 36,
  height: 34,
  border: "none",
  borderRadius: 8,
  background: "transparent",
  color: "var(--text-2)",
  cursor: "pointer",
};

const TbSep = (): ReactNode => (
  <span style={{ width: 1, height: 20, background: "var(--glass-border)", margin: "0 4px" }} />
);

/** Serialize the contentEditable DOM back to markdown for the markdown view + publish. */
const domToMd = (root: HTMLElement): string => {
  const inline = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const el = node as HTMLElement;
    const inner = Array.from(el.childNodes).map(inline).join("");
    switch (el.tagName) {
      case "STRONG":
      case "B":
        return `**${inner}**`;
      case "EM":
      case "I":
        return `*${inner}*`;
      case "CODE":
        return `\`${inner}\``;
      case "A":
        return `[${inner}](${el.getAttribute("href") ?? ""})`;
      case "BR":
        return "\n";
      default:
        return inner;
    }
  };

  const block = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = (node.textContent ?? "").trim();
      return t ? `${t}\n\n` : "";
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const el = node as HTMLElement;
    const inner = Array.from(el.childNodes).map(inline).join("").trim();
    switch (el.tagName) {
      case "H1":
        return `# ${inner}\n\n`;
      case "H2":
        return `## ${inner}\n\n`;
      case "H3":
        return `### ${inner}\n\n`;
      case "BLOCKQUOTE":
        return `${inner
          .split("\n")
          .map((l) => `> ${l}`)
          .join("\n")}\n\n`;
      case "PRE":
        return `\`\`\`\n${el.textContent ?? ""}\n\`\`\`\n\n`;
      case "UL":
        return `${Array.from(el.querySelectorAll(":scope > li"))
          .map((li) => `- ${Array.from(li.childNodes).map(inline).join("").trim()}`)
          .join("\n")}\n\n`;
      case "OL":
        return `${Array.from(el.querySelectorAll(":scope > li"))
          .map((li, n) => `${n + 1}. ${Array.from(li.childNodes).map(inline).join("").trim()}`)
          .join("\n")}\n\n`;
      case "DIV":
      case "P":
        return inner ? `${inner}\n\n` : "";
      default:
        return inner ? `${inner}\n\n` : "";
    }
  };

  return Array.from(root.childNodes).map(block).join("").trim();
};

const ArticleEditor = (): ReactNode => {
  const { state, navigate, publish, toast } = useStore();
  const own = state.identity?.pubkey;
  const editingId = state.nav.params.id;
  const existing = useResolveArticle(editingId ? own : undefined, editingId);

  const defaultCover = PALETTES[state.palette].banner;

  const [identifier, setIdentifier] = useState<string | null>(editingId ?? null);
  const [title, setTitle] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [body, setBody] = useState("");
  const [mode, setMode] = useState<Mode>("live");
  const [cover, setCover] = useState<string>(defaultCover);
  const [coverIsImage, setCoverIsImage] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [words, setWords] = useState(0);
  const [publishing, setPublishing] = useState(false);

  const liveRef = useRef<HTMLDivElement | null>(null);
  const titleRef = useRef<HTMLTextAreaElement | null>(null);
  const mdRef = useRef<HTMLTextAreaElement | null>(null);
  const prefilled = useRef(false);
  const needsLiveLoad = useRef(true);

  // Prefill once the existing article resolves (edit mode).
  useEffect(() => {
    if (!editingId || !existing || prefilled.current) return;
    prefilled.current = true;
    setIdentifier(existing.identifier);
    setTitle(existing.title);
    setSubtitle(existing.summary);
    setBody(existing.body);
    setCover(existing.image ?? defaultCover);
    setCoverIsImage(existing.image ? coverIsImageString(existing.image) : false);
    setTags(existing.hashtags);
    setWords(countWords(existing.body));
    needsLiveLoad.current = true;
  }, [editingId, existing, defaultCover]);

  // Fill the uncontrolled contentEditable from rendered markdown when entering
  // live mode (or after a prefill). React must not own its children.
  useEffect(() => {
    if (mode !== "live") return;
    const id = setTimeout(() => {
      const el = liveRef.current;
      if (el && needsLiveLoad.current) {
        el.innerHTML = renderMarkdown(body).html;
        needsLiveLoad.current = false;
        setWords(countWords(el.textContent ?? ""));
      }
    }, 0);
    return () => clearTimeout(id);
  }, [mode, body]);

  // Auto-grow the title textarea.
  const autoGrowTitle = useCallback(() => {
    const el = titleRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, []);
  useEffect(autoGrowTitle, [title, autoGrowTitle]);

  const titleOk = title.trim().length > 0;
  const readLabel = `${readingMinutes(words)} min read`;
  const publishLabel = editingId ? "Update" : "Publish";

  const toggleMode = (next: Mode): void => {
    if (next === mode) return;
    if (mode === "live" && liveRef.current) {
      const md = domToMd(liveRef.current);
      setBody(md);
      setWords(countWords(md));
    }
    if (next === "live") needsLiveLoad.current = true;
    setMode(next);
  };

  const onLiveInput = (): void => {
    const el = liveRef.current;
    if (!el) return;
    const next = countWords(el.textContent ?? "");
    setWords((prev) => (prev === next ? prev : next));
  };

  const onDraftBody = (value: string): void => {
    setBody(value);
    setWords(countWords(value));
  };

  // --- cover ---
  const applyCover = (value: string, isImage: boolean): void => {
    setCover(value);
    setCoverIsImage(isImage);
  };
  const onCoverUpload = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") applyCover(`url("${reader.result}")`, true);
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  // --- tags ---
  const onTagKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      const t = tagInput.trim().replace(/^#/, "").toLowerCase();
      if (t && !tags.includes(t) && tags.length < 6) setTags((cur) => [...cur, t]);
      setTagInput("");
    } else if (e.key === "Backspace" && !tagInput && tags.length > 0) {
      setTags((cur) => cur.slice(0, -1));
    }
  };

  // --- toolbar formatting ---
  const mdWrap = (before: string, after: string, placeholder: string): void => {
    const ta = mdRef.current;
    if (!ta) return;
    const { selectionStart: s, selectionEnd: en, value } = ta;
    const selected = value.slice(s, en) || placeholder;
    const next = value.slice(0, s) + before + selected + after + value.slice(en);
    onDraftBody(next);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(s + before.length, s + before.length + selected.length);
    });
  };
  const mdLinePrefix = (prefix: string): void => {
    const ta = mdRef.current;
    if (!ta) return;
    const { selectionStart: s, value } = ta;
    const lineStart = value.lastIndexOf("\n", s - 1) + 1;
    const next = value.slice(0, lineStart) + prefix + value.slice(lineStart);
    onDraftBody(next);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(s + prefix.length, s + prefix.length);
    });
  };

  const fmtMd = (kind: string): void => {
    switch (kind) {
      case "bold":
        return mdWrap("**", "**", "bold");
      case "italic":
        return mdWrap("*", "*", "italic");
      case "code":
        return mdWrap("\n```\n", "\n```\n", "code");
      case "link":
        return mdWrap("[", "](https://)", "text");
      case "h1":
        return mdLinePrefix("# ");
      case "h2":
        return mdLinePrefix("## ");
      case "quote":
        return mdLinePrefix("> ");
      case "list":
        return mdLinePrefix("- ");
    }
  };

  const fmtLive = (kind: string): void => {
    const el = liveRef.current;
    if (!el) return;
    el.focus();
    const sel = document.getSelection()?.toString() ?? "";
    switch (kind) {
      case "bold":
        document.execCommand("bold");
        break;
      case "italic":
        document.execCommand("italic");
        break;
      case "h1":
        document.execCommand("formatBlock", false, "h1");
        break;
      case "h2":
        document.execCommand("formatBlock", false, "h2");
        break;
      case "quote":
        document.execCommand("formatBlock", false, "blockquote");
        break;
      case "list":
        document.execCommand("insertUnorderedList");
        break;
      case "code":
        document.execCommand("insertHTML", false, `<code>${sel || "code"}</code>`);
        break;
      case "link":
        if (sel) {
          document.execCommand("createLink", false, "https://");
          toast("Link added — edit the URL in Markdown view", "info");
        } else {
          document.execCommand("insertHTML", false, '<a href="https://">link</a>');
        }
        break;
    }
    setWords(countWords(el.textContent ?? ""));
  };

  const tbFmt = (kind: string): void => (mode === "live" ? fmtLive(kind) : fmtMd(kind));

  const cancelEditor = (): void => {
    if (editingId && own) navigate("articleReader", { id: editingId, pubkey: own });
    else navigate("home");
  };

  const publishArticle = async (): Promise<void> => {
    if (!own) {
      toast("Sign in first", "warn");
      return;
    }
    const finalBody = mode === "live" && liveRef.current ? domToMd(liveRef.current) : body;
    const cleanTitle = title.trim();
    if (!cleanTitle) {
      toast("Add a title first", "warn");
      return;
    }
    if (!finalBody.trim()) {
      toast("Write something first", "warn");
      return;
    }
    const ident = identifier ?? `${slugify(cleanTitle)}-${randomSuffix()}`;
    const now = Math.floor(Date.now() / 1000);
    setPublishing(true);
    try {
      const eventId = await publish(
        buildLongForm({
          identifier: ident,
          title: cleanTitle,
          summary: subtitle.trim(),
          body: finalBody,
          image: cover || undefined,
          hashtags: tags,
          kind: "article",
          publishedAt: existing?.publishedAt,
        }),
      );
      cacheArticle({
        id: eventId,
        pubkey: own,
        identifier: ident,
        title: cleanTitle,
        summary: subtitle.trim(),
        image: cover || undefined,
        body: finalBody,
        publishedAt: existing?.publishedAt ?? now,
        updatedAt: now,
        hashtags: tags,
        kind: "article",
      });
      toast(editingId ? "Article updated" : "Article published", "check");
      navigate("articleReader", { id: ident, pubkey: own });
    } catch {
      toast("Could not publish article", "warn");
    } finally {
      setPublishing(false);
    }
  };

  const isLive = mode === "live";

  return (
    <div data-testid="view-article-editor" style={{ display: "flex", flexDirection: "column" }}>
      <div style={topBarStyle}>
        <button type="button" data-testid="editor-cancel" onClick={cancelEditor} style={chevronButtonStyle}>
          <ChevronLeft />
          Cancel
        </button>
        <div style={{ flex: 1 }} />
        <div
          role="tablist"
          style={{
            display: "flex",
            gap: 4,
            padding: 4,
            background: "var(--glass-2)",
            border: "1px solid var(--glass-border)",
            borderRadius: 11,
          }}
        >
          <button type="button" data-testid="editor-mode-live" onClick={() => toggleMode("live")} style={segStyle(isLive)}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            Live edit
          </button>
          <button type="button" data-testid="editor-mode-markdown" onClick={() => toggleMode("markdown")} style={segStyle(!isLive)}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m16 18 6-6-6-6M8 6l-6 6 6 6" />
            </svg>
            Markdown
          </button>
        </div>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 12.5, color: "var(--text-3)", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
          {readLabel}
        </span>
        <button
          type="button"
          data-testid="editor-publish"
          onClick={() => void publishArticle()}
          disabled={publishing || !titleOk}
          style={{
            padding: "9px 20px",
            borderRadius: 9,
            border: "1px solid rgba(255,255,255,.3)",
            background: titleOk ? "var(--accent)" : "var(--glass-2)",
            color: titleOk ? "var(--on-accent)" : "var(--text-3)",
            fontWeight: 700,
            fontSize: 13.5,
            fontFamily: "inherit",
            cursor: publishing ? "not-allowed" : titleOk ? "pointer" : "default",
            opacity: publishing ? 0.6 : 1,
            transition: "all .15s",
            whiteSpace: "nowrap",
          }}
        >
          {publishing ? "Publishing…" : publishLabel}
        </button>
      </div>

      <div style={{ maxWidth: 760, margin: "0 auto", width: "100%", padding: "26px 24px 160px", boxSizing: "border-box" }}>
        {cover && (
          <div
            data-testid="editor-cover"
            style={{
              height: 188,
              borderRadius: 14,
              marginBottom: 18,
              position: "relative",
              overflow: "hidden",
              border: "1px solid var(--glass-border)",
              background: cover || "var(--glass-2)",
              backgroundSize: "cover",
              backgroundPosition: "center",
            }}
          >
            <button
              type="button"
              onClick={() => {
                setCover("");
                setCoverIsImage(false);
              }}
              style={{
                position: "absolute",
                top: 11,
                right: 11,
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "7px 12px",
                border: "none",
                borderRadius: 9,
                background: "rgba(0,0,0,.4)",
                color: "#fff",
                fontWeight: 700,
                fontSize: 12,
                fontFamily: "inherit",
                cursor: "pointer",
                backdropFilter: "blur(4px)",
                WebkitBackdropFilter: "blur(4px)",
                transition: "background .15s",
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
              Remove cover
            </button>
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap", marginBottom: 20 }}>
          <span
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: "var(--text-3)",
              textTransform: "uppercase",
              letterSpacing: ".05em",
              marginRight: 2,
            }}
          >
            Cover
          </span>
          {COVER_OPTIONS.map((grad) => (
            <button
              key={grad}
              type="button"
              aria-label="Cover style"
              onClick={() => applyCover(grad, false)}
              style={swatchStyle(grad, cover === grad && !coverIsImage)}
            />
          ))}
          <label
            data-testid="editor-cover-upload"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "7px 12px",
              border: "1px solid var(--glass-border)",
              borderRadius: 9,
              background: "var(--glass-2)",
              color: "var(--text-2)",
              fontWeight: 700,
              fontSize: 12,
              fontFamily: "inherit",
              cursor: "pointer",
              transition: "background .15s",
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <path d="M17 8l-5-5-5 5M12 3v12" />
            </svg>
            Upload
            <input
              type="file"
              accept="image/*"
              onChange={onCoverUpload}
              style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
            />
          </label>
        </div>

        <textarea
          ref={titleRef}
          data-testid="editor-title"
          rows={1}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Article title"
          style={{
            width: "100%",
            border: "none",
            background: "transparent",
            resize: "none",
            outline: "none",
            fontFamily: "'Geist',sans-serif",
            fontSize: 38,
            lineHeight: 1.18,
            fontWeight: 700,
            letterSpacing: "-.025em",
            color: "var(--text)",
            padding: 0,
            margin: "0 0 18px",
            overflow: "hidden",
            boxSizing: "border-box",
          }}
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
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <path d="M20.6 13.3 11.3 22a2 2 0 0 1-2.8 0l-5.7-5.7a2 2 0 0 1 0-2.8L12 4.3a2 2 0 0 1 1.6-.6l5.2.4a2 2 0 0 1 1.9 1.9l.4 5.2a2 2 0 0 1-.5 1.5z" />
            <circle cx="16" cy="8" r="1.2" fill="var(--text-3)" stroke="none" />
          </svg>
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
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </span>
          ))}
          <input
            data-testid="editor-tag-input"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={onTagKey}
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

        <div
          data-testid="editor-toolbar"
          style={{
            position: "sticky",
            top: 60,
            zIndex: 6,
            display: "flex",
            alignItems: "center",
            gap: 3,
            margin: "14px 0 16px",
            padding: 6,
            background: "color-mix(in srgb, var(--bg-base) 90%, transparent)",
            backdropFilter: "blur(8px)",
            WebkitBackdropFilter: "blur(8px)",
            border: "1px solid var(--glass-border)",
            borderRadius: 11,
            boxShadow: "var(--glass-shadow)",
            overflowX: "auto",
          }}
        >
          <button type="button" title="Heading 1" onClick={() => tbFmt("h1")} style={{ ...tbBaseStyle, padding: "0 8px", fontFamily: "'Geist',sans-serif", fontWeight: 700, fontSize: 14 }}>
            H1
          </button>
          <button type="button" title="Heading 2" onClick={() => tbFmt("h2")} style={{ ...tbBaseStyle, padding: "0 8px", fontFamily: "'Geist',sans-serif", fontWeight: 700, fontSize: 13 }}>
            H2
          </button>
          <TbSep />
          <button type="button" title="Bold" onClick={() => tbFmt("bold")} style={{ ...tbBaseStyle, fontFamily: "'Geist',sans-serif", fontWeight: 800, fontSize: 15 }}>
            B
          </button>
          <button type="button" title="Italic" onClick={() => tbFmt("italic")} style={{ ...tbBaseStyle, fontFamily: "'Geist',sans-serif", fontStyle: "italic", fontWeight: 600, fontSize: 15 }}>
            I
          </button>
          <TbSep />
          <button type="button" title="Quote" onClick={() => tbFmt("quote")} style={tbBaseStyle}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor">
              <path d="M7 7h4v4c0 2.5-1.6 4.3-4 5l-.6-1.4c1.4-.5 2.1-1.3 2.3-2.6H7zm8 0h4v4c0 2.5-1.6 4.3-4 5l-.6-1.4c1.4-.5 2.1-1.3 2.3-2.6H15z" />
            </svg>
          </button>
          <button type="button" title="Bulleted list" onClick={() => tbFmt("list")} style={tbBaseStyle}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
            </svg>
          </button>
          <button type="button" title="Code" onClick={() => tbFmt("code")} style={tbBaseStyle}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m16 18 6-6-6-6M8 6l-6 6 6 6" />
            </svg>
          </button>
          <TbSep />
          <button type="button" title="Link" onClick={() => tbFmt("link")} style={tbBaseStyle}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5" />
              <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5" />
            </svg>
          </button>
        </div>

        {isLive ? (
          <div
            ref={liveRef}
            data-testid="editor-live"
            className="vy-prose vy-editor"
            contentEditable
            suppressContentEditableWarning
            onInput={onLiveInput}
            data-placeholder="Tell your story…"
            style={{ fontSize: 18 }}
          />
        ) : (
          <textarea
            ref={mdRef}
            data-testid="editor-markdown"
            value={body}
            onChange={(e) => onDraftBody(e.target.value)}
            placeholder="Write in Markdown…  # Heading, **bold**, *italic*, > quote, - list, `code`, [link](url)"
            style={{
              width: "100%",
              minHeight: 380,
              border: "none",
              background: "transparent",
              resize: "vertical",
              outline: "none",
              fontFamily: "'Geist Mono',monospace",
              fontSize: 14.5,
              lineHeight: 1.7,
              color: "var(--text)",
              padding: 0,
              boxSizing: "border-box",
            }}
          />
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Router — articleReader vs articleEditor
// ---------------------------------------------------------------------------

export const ArticleView = (): ReactNode => {
  const { state } = useStore();
  return state.nav.view === "articleEditor" ? <ArticleEditor /> : <ArticleReader />;
};
